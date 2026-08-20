import { NextResponse } from "next/server";
import { z } from "zod";
import Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe";
import { generateIssue } from "@/lib/engine/assemble";
import { persistIssueIfPossible } from "@/lib/engine/persist";
import { isValidTopicId, MAX_CUSTOM_TOPIC_LEN, CUSTOM_PREFIX } from "@/lib/topics";
import { sendLetterNotification, resendConfigured, sendOpsAlert } from "@/lib/email";
import { rateLimit, clientKeyFromRequest } from "@/lib/rate-limit";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { hasActiveAccess } from "@/lib/access";
import { letterUrl as buildLetterUrl } from "@/lib/letter-token";
import { withDeadline } from "@/lib/with-deadline";
import { parseBirthday, isValidCalendarDateString } from "@/lib/demographics";
import { coerceThemeId } from "@/lib/themes";
import { BLURB_CAPS } from "@/lib/types";
import { deliverLetterOnce, type DeliveryStore } from "@/lib/letter-delivery";

export const runtime = "nodejs";
export const maxDuration = 120;
// A deterministic deadline comfortably under maxDuration. generateIssue's I/O is
// self-bounded (Anthropic 60s, Brave 5s, deep-read 7s), but those are
// PER-ATTEMPT, and the SDK's one retry plus topic-blurb's parse-retry can stack
// past 120s in a pathological case. Failing fast here returns a clean 500 the
// /writing client absorbs (its retry hits the now-warm per-topic cache), instead
// of waiting for Cloudflare Workers' own hard timeout to kick in. Mirrors the
// cron's per-user deadline.
const GENERATE_DEADLINE_MS = 105_000;

const ProfileSchema = z.object({
  firstName: z.string().min(1).max(60),
  city: z.string().max(120).default(""),
  jobBlurb: z.string().max(BLURB_CAPS.jobBlurb).optional(),
  projectBlurb: z.string().max(BLURB_CAPS.projectBlurb).optional(),
  funBlurb: z.string().max(BLURB_CAPS.funBlurb).optional(),
  // Shape AND validity: a regex-valid but impossible/out-of-range date (e.g.
  // 2020-02-30, 1850-01-01) is rejected here too, so this write path agrees
  // with parseBirthday, which every reader of the field already gates on.
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => parseBirthday(s) !== null, "invalid birthday").optional(),
  gender: z.enum(["male", "female"]).optional(),
  // isValidTopicId, not just shape: this is the same users.topics column the
  // self-serve /api/account/topics route locks down against smuggled/garbage
  // ids (including Object.prototype names like "constructor" that a plain `in`
  // lookup would wrongly accept) -- this onboarding path needs the same gate.
  //
  // alpha-drift-r16-11 (found+fixed 2026-08-07): this refine used to skip
  // the duplicate-id check lib/account-topics-guards.ts's sibling route
  // enforces (`new Set(topics).size !== topics.length`), despite this same
  // file's own comment above claiming it needs "the same gate." A repeated
  // topic id written here isn't a one-time onboarding glitch -- it's
  // written verbatim to users.topics and re-read unmodified by every
  // future cron run, so it regenerates the exact same section twice in
  // every letter, permanently, burning two of the reader's paid slots on
  // one topic until they happen to re-touch that exact topic in the editor.
  topics: z.array(z.string().min(1).max(MAX_CUSTOM_TOPIC_LEN + CUSTOM_PREFIX.length)).min(1).max(25).refine(
    (arr) => arr.every(isValidTopicId),
    "unrecognized topic"
  ).refine(
    (arr) => new Set(arr).size === arr.length,
    "duplicate topic"
  ),
  theme: z.string().max(30).default("forest"),
  email: z.string().email().optional(),
});

const BodySchema = z.object({
  profile: ProfileSchema,
  // This is the onboarding first-letter endpoint -- the client never sends
  // weekOf (it always defaults to today, see defaultWeekOf()). Bounded to a
  // couple days of slop for timezone/clock skew rather than left open: an
  // unbounded weekOf keys the issues upsert below, so it could overwrite any
  // already-delivered issue (past or future) in a reader's archive.
  // alpha-drift-r26-06 (2026-08-14): the old refine only checked
  // Number.isNaN, which JS's Date parser never trips for an impossible
  // day-of-month -- it silently rolls over instead (2026-04-31 becomes
  // May 1), letting the raw, still-invalid string reach persistIssueIfPossible's
  // upsert into public.issues.week_of, a strict Postgres `date` column that
  // rejects it outright. That upsert failure was only console.warned, not
  // surfaced, so the reader got a real letter that silently never saved to
  // their archive. isValidCalendarDateString does the same real round-trip
  // check ProfileSchema.birthday already relies on via parseBirthday, just
  // above in this same schema.
  weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
    if (!isValidCalendarDateString(s)) return false;
    const d = new Date(`${s}T00:00:00Z`).getTime();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return Math.abs(today.getTime() - d) <= 2 * 24 * 60 * 60 * 1000;
  }, "weekOf must be close to today").optional(),
  // Stripe Checkout session id, threaded through from the success_url
  // (/writing?session_id=...). Proves the first letter was paid for.
  sessionId: z.string().max(200).optional(),
});

// Payment gate. Letter generation costs real money (Claude + Brave) and the
// first letter is the paid hook — without this, anyone could complete the free
// onboarding, skip the Stripe button, and POST here directly for a free letter.
// (Matches the "no free trial — exploitation risk" product decision.)
//
// Allow when ANY of:
//   - Stripe isn't configured (local dev / the checkout 503 stub path)
//   - the caller is an authenticated, currently-subscribed user
//   - a Stripe Checkout session id is supplied AND Stripe says it's paid
// Fail CLOSED on every unverified path, including a genuine Stripe infra
// blip -- ok:true is only ever returned with a real verifiedEmail attached.
// A Stripe outage means the customer retries in a moment (the checkout
// session itself doesn't expire quickly); it does NOT mean falling back to
// trusting the caller's own profile.email, which is exactly how this
// endpoint had an account-takeover bug (see the POST handler's comment).
// verifiedEmail is the identity this request is ACTUALLY entitled to act as --
// the signed-in user's own email, or the email Stripe collected for the paid
// checkout session. The caller's profile.email must never be trusted for this:
// see the POST handler, which overwrites profile.email with verifiedEmail
// before it reaches persistIssueIfPossible (magic-link minting) or the
// notification send. Without that override, either payment-gate branch below
// would let a caller pass an arbitrary victim email in profile.email, and this
// endpoint would mint THAT victim a sign-in link and overwrite their profile.
async function verifyPaid(
  sessionId: string | undefined
): Promise<
  | { ok: true; verifiedEmail: string | null; verifiedUserId?: string }
  | { ok: false; error: string }
> {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) return { ok: true, verifiedEmail: null }; // dev / Stripe-less stub flow

  // Already-subscribed authed user (future re-generate path)
  try {
    const sb = await supabaseServerClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (user) {
      const svc = await supabaseServiceClient();
      // alpha-drift-r62-09 (2026-08-20, silent-catch-audit-r8): used to
      // discard `error` -- supabase-js resolves rather than throws on a
      // query error, so the catch below (its own comment: "fall through to
      // session check") was structurally blind to this exact failure mode.
      // On a blip, this branch silently skipped rather than throwing, and a
      // signed-in subscriber with no sessionId (the reload/Try-Again path,
      // which deliberately preserves it -- see r32-03) got a false 402 with
      // zero trace, unlike the Stripe-side equivalent 60 lines below which
      // already logs "stripe verify blip, failing closed." Logged only --
      // this already fails closed by design (see this function's own header
      // comment), so no behavior change.
      const { data, error: subErr } = await svc
        .from("users")
        .select("subscribed_at, cancelled_at")
        .eq("id", user.id)
        .maybeSingle();
      if (subErr) console.warn("[generate] verifyPaid subscription lookup failed:", subErr.message);
      // Access runs through the paid period — a future cancelled_at (cancel-
      // at-period-end) still counts as active. See lib/access.hasActiveAccess.
      if (data?.subscribed_at && hasActiveAccess(data.cancelled_at)) {
        // verifiedUserId: this IS an existing account, unlike the Stripe-
        // session branch below (a true first-time signup with nothing to
        // race against) -- lets persistIssueIfPossible re-check this exact
        // user still exists right before it would otherwise create a new
        // one for the same email if this account got deleted mid-request
        // (alpha-drift-r17-03).
        return {
          ok: true,
          verifiedEmail: user.email?.toLowerCase().trim() ?? null,
          verifiedUserId: user.id,
        };
      }
    }
  } catch (e) {
    // alpha-drift-r62-09: logged, not silent -- a thrown failure here (e.g.
    // supabaseServerClient() throwing on missing env vars) used to leave
    // zero trace before falling through to the sessionId check below.
    console.warn("[generate] verifyPaid already-subscribed check threw, falling through to session check:", e instanceof Error ? e.message : e);
  }

  if (!sessionId) {
    return { ok: false, error: "Payment required. Subscribe to receive your letter." };
  }

  try {
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required"
    ) {
      // customer_details.email (post-payment, Stripe-collected) over
      // customer_email (the pre-fill we sent at session creation) -- same
      // precedence the webhook already uses (see stripe/webhook/route.ts).
      const verifiedEmail =
        (session.customer_details?.email || session.customer_email || "")
          .toLowerCase()
          .trim() || null;
      return { ok: true, verifiedEmail };
    }
    return { ok: false, error: "Payment not completed. Subscribe to receive your letter." };
  } catch (e) {
    // resource_missing = fabricated / nonexistent session → definitively not paid.
    if (e instanceof Stripe.errors.StripeInvalidRequestError) {
      return { ok: false, error: "Couldn't verify payment. Subscribe to receive your letter." };
    }
    // Genuine Stripe infra error -- fail CLOSED. Failing open here returned
    // { ok: true, verifiedEmail: null }, which downstream only skips
    // overwriting profile.email on a falsy verifiedEmail -- so any caller
    // could trigger this branch (any non-StripeInvalidRequestError, e.g. a
    // rate-limit or connection error) with an arbitrary session id and
    // profile.email, and get a magic link minted for that unverified
    // address. Reopened the exact account-takeover class this file's own
    // POST handler comment describes fixing. A transient Stripe blip is
    // retry-able; an unverified identity being trusted for a magic link is
    // not an acceptable trade for that convenience.
    console.warn("[generate] stripe verify blip, failing closed:", e instanceof Error ? e.message : e);
    return { ok: false, error: "Couldn't verify payment right now. Please try again in a moment." };
  }
}

export async function POST(req: Request) {
  // Rate limit: 3 generations per IP per hour. Resets on cold start.
  // Authenticated users could get a higher cap once we wire it; V0 is anon.
  const ip = clientKeyFromRequest(req);
  const limited = rateLimit(`generate:${ip}`, { limit: 3, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await req.json();
    body = BodySchema.parse(raw);
  } catch (e) {
    const message =
      e instanceof z.ZodError
        ? `Invalid input: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        : "Invalid JSON";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Payment gate — see verifyPaid(). 402 = subscribe first.
  const paid = await verifyPaid(body.sessionId);
  if (!paid.ok) {
    return NextResponse.json({ error: paid.error }, { status: 402 });
  }

  // alpha-drift-r18-01 (found+fixed 2026-08-07): the IP-keyed limit above is
  // the only throttle on this route, but verifyPaid()'s authenticated branch
  // (an "already-subscribed" re-generate call) needs no Stripe sessionId at
  // all -- an attacker with ONE valid paid account and many source IPs (or a
  // shared/rotating proxy) could drive real, metered Anthropic/Gemini/Brave
  // generation spend past the intended 3/hour cap indefinitely, since the IP
  // key resets per address. Every sibling account-mutation route (admin
  // actions, update-quantity) keys its limit on the resolved user id for
  // exactly this reason. Keyed separately from the IP limit (not instead of
  // it) so a legitimate subscriber behind a shared office/NAT IP is never
  // penalized by other unrelated traffic on that same address.
  if (paid.verifiedUserId) {
    const userLimited = rateLimit(`generate-user:${paid.verifiedUserId}`, {
      limit: 3,
      windowMs: 60 * 60 * 1000,
    });
    if (!userLimited.ok) {
      return NextResponse.json(
        { error: `Too many requests. Try again in ${Math.ceil(userLimited.retryAfterSec / 60)} minutes.` },
        { status: 429, headers: { "Retry-After": String(userLimited.retryAfterSec) } }
      );
    }
  } else if (body.sessionId) {
    // alpha-drift-r28-04 (2026-08-15): the r18-01 fix above only closed the
    // gap for the AUTHENTICATED branch (an existing subscriber re-generating).
    // The first-time/not-signed-in sessionId branch never sets verifiedUserId
    // at all, so it had NO per-session or per-payment cap whatsoever -- just
    // the IP-keyed limit above, trivially defeated by rotating source IPs
    // (a fresh IP gets a fresh 3/hour allowance). Stripe Checkout Sessions
    // stay retrievable with payment_status:"paid" forever once paid, and
    // nothing anywhere (this route, persist.ts, letter-delivery.ts) dedupes
    // or caps usage by sessionId -- so a single $5 payment's sessionId could
    // be replayed indefinitely for real, separately-billed AI generations.
    // Keyed on the sessionId itself (not IP, not a user id -- there isn't
    // one yet) so every attempt against the SAME payment shares one bucket
    // regardless of which IP it comes from. 5/hour, not 3: a genuine
    // first-time caller can hit this path multiple times via /writing's own
    // client-side retry-on-failure behavior, and unlike the recurring
    // per-user cap above, this session is spent after one real letter, so
    // there's no legitimate reason for repeat traffic beyond retries.
    const sessionLimited = rateLimit(`generate-session:${body.sessionId}`, {
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    if (!sessionLimited.ok) {
      return NextResponse.json(
        { error: `Too many requests. Try again in ${Math.ceil(sessionLimited.retryAfterSec / 60)} minutes.` },
        { status: 429, headers: { "Retry-After": String(sessionLimited.retryAfterSec) } }
      );
    }
  }

  try {
    const weekOf = body.weekOf || defaultWeekOf();
    // Cast: zod's refine (above) already rejected any topic id that isn't a
    // real catalog id, "zodiac", or well-formed custom:<text> -- so this
    // narrowing to TopicId is backed by real validation, not just the shape.
    const profile = body.profile as Parameters<typeof generateIssue>[0];
    // ProfileSchema only bounds theme's length, not its catalog membership --
    // unlike topics (isValidTopicId, above) and gender (coerceGender, in
    // persist.ts), theme reached the DB unchecked. coerceThemeId is "the
    // single allow-list check for a theme value coming from an untrusted
    // source" per its own comment, tied to a real past incident (a removed
    // theme id shipping wrong on the emailed letter view).
    profile.theme = coerceThemeId(profile.theme) ?? "forest";
    // Never trust the caller-supplied profile.email for identity. Overwrite it
    // with the email verifyPaid() actually confirmed this request as (the
    // signed-in user's own email, or the email Stripe collected at checkout).
    // See verifyPaid's comment -- this is the fix for a real account-takeover
    // bug where profile.email flowed straight into magic-link generation.
    if (paid.verifiedEmail) {
      profile.email = paid.verifiedEmail;
    }
    // No letterSize passed on purpose: this is the onboarding first letter,
    // where the reader picked exactly their quota of topics (pool == quota), so
    // generating the whole pool == generating their letterSize. If a future
    // re-generate path lets an existing reader with a DEEPER ranked pool hit
    // this endpoint, pass their topic_quota as letterSize here (as the cron
    // does) so it respects favorites/backups instead of generating the pool.
    const issue = await withDeadline(
      generateIssue(profile, weekOf),
      GENERATE_DEADLINE_MS,
      "onboarding generateIssue"
    );

    // Best-effort persistence (doesn't block on failure). verifiedUserId is
    // only set for an already-authenticated re-generate call -- see
    // verifyPaid's comment and persist.ts's expectedUserId param for why
    // this closes a real deleted-account-resurrection race.
    const persistence = await persistIssueIfPossible(
      profile,
      issue,
      weekOf,
      "verifiedUserId" in paid ? paid.verifiedUserId : undefined
    );

    // Establish the session server-side instead of shipping a bearer link to
    // the client (found in review 2026-08-06 -- see persist.ts's hashedToken
    // comment for the full exposure this closes). verifyOtp runs on the
    // SAME @supabase/ssr server client verifyPaid() above already used,
    // which writes the resulting Set-Cookie straight onto this route's own
    // response via lib/supabase/server.ts's cookies().set() wiring -- no
    // token ever needs to leave the server. Best-effort: a verification
    // hiccup must never fail the request, the reader still gets their
    // letter and can sign in normally (the auth user + magic-link-eligible
    // account both still exist either way).
    let signedIn = false;
    if (persistence?.hashedToken) {
      try {
        const sb = await supabaseServerClient();
        const { error: verifyErr } = await sb.auth.verifyOtp({
          token_hash: persistence.hashedToken,
          // NOT always "magiclink" -- see persist.ts's verificationType
          // comment. A brand-new reader's token is actually type "signup"
          // (generateLink implicitly creates the user); only a RETURNING
          // reader gets a true "magiclink" token back.
          type: persistence.verificationType,
        });
        if (verifyErr) {
          console.warn("[generate] verifyOtp failed:", verifyErr.message);
        } else {
          signedIn = true;
        }
      } catch (e) {
        console.warn("[generate] verifyOtp threw:", e instanceof Error ? e.message : e);
      }
    }

    // Best-effort email send (doesn't block on failure either — letter still
    // renders on /inbox even if email delivery hiccups)
    //
    // Idempotency: if a delivered_at stamp already exists for this (user,
    // week) we DO NOT re-send. Protects against /writing remounts, double-
    // submits, retries that succeeded the first time but the client never
    // saw the response, etc. The cron uses the same gate via delivered_at.
    // alpha-drift-r49-02 (2026-08-20, docs-code-drift-round-5): this used to
    // blame req.url on "the youngalgy.com rewrite" landing on "the internal
    // Vercel hostname" -- that proxy/rewrite doesn't exist anymore
    // (youngalgy.com now 301-redirects rather than proxying, per
    // next.config.ts's own 2026-08-05 correction) and this app hasn't run on
    // Vercel since the same date. NEVER derive this from req.url: this route
    // runs on Cloudflare Workers behind alpha's own domain, and req.url can
    // still reflect a Worker-internal or preview hostname depending on how
    // the request arrived -- these URLs go into the subscriber's EMAIL, so
    // an unrouted host would land on a domain where their session cookie
    // doesn't exist ("No letter yet" dead end; a real subscriber hit exactly
    // this). Same canonical fallback as the cron.
    const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://alpha.everyday.report";
    const inboxUrl = `${origin}/inbox`;
    let emailSent = false;
    // alpha-deliverability-03: sendLetterNotification's List-Unsubscribe
    // header + in-body unsubscribe link both require a real userId (the
    // unsubscribe token is HMAC(userId) -- see lib/unsubscribe.ts). Without
    // persistence.userId (a rare generateLink/Supabase hiccup on this exact
    // signup, per persist.ts's own try/catch), sending anyway would ship a
    // commercial email with NO unsubscribe mechanism at all -- a CAN-SPAM
    // violation and a spam-filter risk that outlives this one reader. Skip
    // the send instead: they already saw their letter rendered live on this
    // page regardless, and the alert below makes the gap visible rather
    // than a silent, permanent loss of their first email.
    if (profile.email && resendConfigured() && !persistence?.userId) {
      console.warn(
        `[generate] skipping onboarding email for ${profile.email} -- no persisted userId, would ship with no unsubscribe mechanism`
      );
      await sendOpsAlert(
        "alpha. onboarding email skipped (no unsubscribe mechanism)",
        `${profile.email} generated a first letter but persistIssueIfPossible didn't return a userId, so the onboarding email was skipped rather than sent without List-Unsubscribe. They still saw the letter live on /writing. Check Supabase Auth admin API health.`,
        `alpha-onboarding-email-skipped-${profile.email}-${weekOf}`
      );
    }
    if (profile.email && resendConfigured() && persistence?.userId) {
      const toEmail = profile.email;
      let issueNumber = 1; // this reader's Nth letter (drives "Issue N" subject)
      let store: DeliveryStore | null = null;
      if (persistence?.userId) {
        const sb = await supabaseServiceClient();
        store = deliveryStoreFor(sb);
        try {
          // Issue number = prior DELIVERED letters (weeks before this one) + 1.
          // delivered_at NOT NULL so a generated-but-unsent row doesn't inflate it.
          // alpha-drift-r62-09: `error` used to be discarded here too -- the
          // catch above only fires on a THROWN failure, but supabase-js
          // resolves rather than throws on a query error, so a genuine
          // failure silently left issueNumber at its default of 1 (a wrong
          // "Issue 1" subject line for an existing reader) with the exact
          // console.warn below never actually firing for that failure mode.
          const { count, error: countErr } = await sb
            .from("issues")
            .select("*", { count: "exact", head: true })
            .eq("user_id", persistence.userId)
            .lt("week_of", weekOf)
            .not("delivered_at", "is", null);
          if (countErr) throw countErr;
          issueNumber = (count ?? 0) + 1;
        } catch (e) {
          console.warn(
            "[generate] issue-number lookup failed (will still attempt send):",
            e instanceof Error ? e.message : e
          );
        }
      }
      // Idempotent send via an ATOMIC delivered_at claim, the same compare-and-
      // swap the weekly cron uses (lib/letter-delivery.ts). A signup can land
      // within ~a minute of a daily cron tick and both paths target the
      // same (user, week_of) row, so claiming before the send means exactly one
      // of them wins and the other skips. No persisted row → best-effort send.
      const result = await deliverLetterOnce({
        store,
        userId: persistence?.userId ?? null,
        weekOf,
        stamp: new Date().toISOString(),
        send: async () => {
          return sendLetterNotification({
            to: toEmail,
            firstName: profile.firstName,
            issue,
            inboxUrl,
            // Tokenized view-in-browser CTA. Opens the letter with no session.
            letterUrl: persistence?.userId ? buildLetterUrl(persistence.userId, origin, weekOf) : null,
            issueNumber,
            userId: persistence?.userId ?? null,
          });
        },
        onError: (e) =>
          console.warn("[generate] letter email:", e instanceof Error ? e.message : e),
      });
      emailSent = result.sent;
      if (!result.sent && result.reason === "already-delivered") {
        console.log(
          `[generate] skipped letter email for user ${persistence?.userId}, already delivered for ${weekOf}`
        );
      }
      // Proof of send -- same pattern as the cron (weekly-send/route.ts).
      // Without this column, watchdog_delivery_check() can't tell a genuine
      // success from a stuck claim and, past its grandfather cutoff, would
      // eventually null this row's delivered_at back out and put it back in
      // the send queue even though the email already went out. Best-effort:
      // the email already sent, so a failure to record this must never fail
      // the request.
      if (result.sent && result.messageId && persistence?.userId) {
        const sb = await supabaseServiceClient();
        const { error: proofErr } = await sb
          .from("issues")
          .update({ resend_message_id: result.messageId })
          .eq("user_id", persistence.userId)
          .eq("week_of", weekOf);
        if (proofErr) {
          console.warn(
            `[generate] sent OK but proof-of-send write failed for user ${persistence.userId}: ${proofErr.message}`
          );
        }
      }
    }

    return NextResponse.json({
      issue,
      userId: persistence?.userId ?? null,
      signedIn,
      emailSent,
    });
  } catch (err) {
    // Log the real error server-side only. This endpoint is unauthenticated
    // (rate limit + payment check are the only gates), and the try block
    // above spans the Anthropic/Brave/Gemini/Groq/DeepSeek SDKs, Supabase,
    // and Resend — any of those throwing must never put a raw internal
    // message in front of an anonymous caller (same class of leak already
    // fixed in app/api/support/route.ts).
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[generate] failed:", message);
    return NextResponse.json(
      { error: "Couldn't generate your letter. Try again in a moment." },
      { status: 500 }
    );
  }
}

// Adapt a Supabase service client to the DeliveryStore atomic-claim contract.
// `claim` is the compare-and-swap: stamp delivered_at only where it is still
// NULL (Postgres row-locks the UPDATE, so one concurrent caller wins). A 0-row
// result is disambiguated with a read — row present means already delivered, no
// row means best-effort persist never wrote one. `release` is guarded on our
// exact stamp so a rollback can't clear another invocation's claim.
//
// NOT shared with app/api/cron/weekly-send/route.ts's own inline claim —
// that one deliberately isn't built on this same DeliveryStore, since it
// bundles content (volume/number/editor_intro/sections) into the SAME atomic
// UPDATE this interface has no way to express (see that file's "Content
// fields ride along in THIS same atomic UPDATE now" comment). Both still
// share the identical `.eq(user_id).eq(week_of).is("delivered_at", null)`
// compare-and-swap predicate below — keep that predicate in sync if either
// changes. The cron's stuck-claim reclaim step is NOT cron-specific despite
// living in that file: it queries by week_of alone with no caller filter, so
// a claim stuck here (a hard crash between claim and release) is swept up
// and retried by the next cron tick for that same period, same as a cron-
// created stuck claim would be.
function deliveryStoreFor(
  sb: Awaited<ReturnType<typeof supabaseServiceClient>>
): DeliveryStore {
  return {
    async claim(userId, weekOf, stamp) {
      const { data: claimRows, error } = await sb
        .from("issues")
        .update({ delivered_at: stamp })
        .eq("user_id", userId)
        .eq("week_of", weekOf)
        .is("delivered_at", null)
        .select("user_id");
      if (error) throw new Error(error.message);
      if ((claimRows?.length ?? 0) > 0) return { won: true, exists: true };
      const { data: check, error: checkError } = await sb
        .from("issues")
        .select("delivered_at")
        .eq("user_id", userId)
        .eq("week_of", weekOf)
        .maybeSingle();
      // alpha-drift-r58-05 (2026-08-20, silent-catch-audit-r4): this read's
      // own `error` used to be discarded entirely, unlike this function's
      // other two Supabase calls (both throw on error). A genuine read
      // failure here is NOT the double-send risk the comment below
      // describes, though -- personally traced deliverLetterOnce
      // (lib/letter-delivery.ts): its "no-row" branch (what a swallowed
      // error here falls into today) and its "claim-error" branch (what
      // throwing here would route into via the outer catch) both call the
      // identical trySend() and fail open by explicit design ("never block
      // [the paid first letter] on an infra hiccup") -- so a thrown error
      // here changes NEITHER path's send behavior, only observability
      // (onError fires, the returned `reason` is the more accurate
      // "claim-error" instead of a misleading "no-row"). Logged, not
      // thrown, to keep that observability gain without claiming a
      // correctness fix this read genuinely doesn't provide.
      if (checkError) console.warn("[generate] claim() disambiguation read failed:", checkError.message);
      // exists keys on ROW PRESENCE, not on delivered_at being set, on purpose.
      // If a concurrent run claimed this row then released it (its send failed)
      // in the sliver between our UPDATE and this read, we treat the present row
      // as already-handled and SKIP. That is deliberate: best-effort sending a
      // present-but-null row holds NO claim, so the cron could claim and send it
      // too — the exact double-send this guards against. A skipped letter is
      // re-delivered by the next cron tick; a duplicate is not recoverable.
      return { won: false, exists: !!check };
    },
    async release(userId, weekOf, stamp) {
      const { error } = await sb
        .from("issues")
        .update({ delivered_at: null })
        .eq("user_id", userId)
        .eq("week_of", weekOf)
        .eq("delivered_at", stamp);
      if (error) throw new Error(error.message);
    },
  };
}

function defaultWeekOf(): string {
  // The first letter's period key = TODAY's UTC date (the send date), matching
  // the cron's currentPeriodIso() under the multi-send cadence. This keeps the
  // (user, week_of) idempotency key and the (topic, week_of) blurb cache aligned
  // between the onboarding first-letter path and the daily cron, so a
  // first letter and a same-day cron send share one period instead of two keys.
  return new Date().toISOString().slice(0, 10);
}
