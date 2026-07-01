import { NextResponse } from "next/server";
import { z } from "zod";
import Stripe from "stripe";
import { generateIssue } from "@/lib/engine/assemble";
import { persistIssueIfPossible } from "@/lib/engine/persist";
import { isValidTopicId } from "@/lib/topics";
import { sendLetterNotification, resendConfigured } from "@/lib/email";
import { rateLimit, clientKeyFromRequest } from "@/lib/rate-limit";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { hasActiveAccess } from "@/lib/access";
import { letterUrl as buildLetterUrl } from "@/lib/letter-token";
import { withDeadline } from "@/lib/with-deadline";
import { parseBirthday } from "@/lib/demographics";
import { BLURB_CAPS } from "@/lib/types";
import { deliverLetterOnce, type DeliveryStore } from "@/lib/letter-delivery";

export const runtime = "nodejs";
export const maxDuration = 120;
// A deterministic deadline comfortably under maxDuration. generateIssue's I/O is
// self-bounded (Anthropic 60s, Brave 5s, deep-read 7s), but those are
// PER-ATTEMPT, and the SDK's one retry plus topic-blurb's parse-retry can stack
// past 120s in a pathological case. Failing fast here returns a clean 500 the
// /writing client absorbs (its retry hits the now-warm per-topic cache), instead
// of waiting for Vercel's hard 504. Mirrors the cron's per-user deadline.
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
  topics: z.array(z.string().min(1).max(60)).min(1).max(25).refine(
    (arr) => arr.every(isValidTopicId),
    "unrecognized topic"
  ),
  theme: z.string().max(30).default("forest"),
  email: z.string().email().optional(),
});

const BodySchema = z.object({
  profile: ProfileSchema,
  weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
// Fail OPEN on a genuine Stripe infra blip (real session exists, API hiccuped)
// so a paying customer's first letter is never blocked. Fail CLOSED on a
// missing / fabricated / unpaid session.
async function verifyPaid(
  sessionId: string | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) return { ok: true }; // dev / Stripe-less stub flow

  // Already-subscribed authed user (future re-generate path)
  try {
    const sb = await supabaseServerClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (user) {
      const svc = await supabaseServiceClient();
      const { data } = await svc
        .from("users")
        .select("subscribed_at, cancelled_at")
        .eq("id", user.id)
        .maybeSingle();
      // Access runs through the paid period — a future cancelled_at (cancel-
      // at-period-end) still counts as active. See lib/access.hasActiveAccess.
      if (data?.subscribed_at && hasActiveAccess(data.cancelled_at)) return { ok: true };
    }
  } catch {
    // ignore — fall through to session check
  }

  if (!sessionId) {
    return { ok: false, error: "Payment required. Subscribe to receive your letter." };
  }

  try {
    const stripe = new Stripe(secret, {
      apiVersion: "2026-04-22.dahlia",
      httpClient: Stripe.createNodeHttpClient(),
    });
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required"
    ) {
      return { ok: true };
    }
    return { ok: false, error: "Payment not completed. Subscribe to receive your letter." };
  } catch (e) {
    // resource_missing = fabricated / nonexistent session → definitively not paid.
    if (e instanceof Stripe.errors.StripeInvalidRequestError) {
      return { ok: false, error: "Couldn't verify payment. Subscribe to receive your letter." };
    }
    // Genuine Stripe infra error → fail open so a real payer isn't blocked.
    console.warn("[generate] stripe verify blip, allowing:", e instanceof Error ? e.message : e);
    return { ok: true };
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

  try {
    const weekOf = body.weekOf || defaultWeekOf();
    // Cast: zod's refine (above) already rejected any topic id that isn't a
    // real catalog id, "zodiac", or well-formed custom:<text> -- so this
    // narrowing to TopicId is backed by real validation, not just the shape.
    const profile = body.profile as Parameters<typeof generateIssue>[0];
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

    // Best-effort persistence (doesn't block on failure)
    const persistence = await persistIssueIfPossible(profile, issue, weekOf);

    // Best-effort email send (doesn't block on failure either — letter still
    // renders on /inbox even if email delivery hiccups)
    //
    // Idempotency: if a delivered_at stamp already exists for this (user,
    // week) we DO NOT re-send. Protects against /writing remounts, double-
    // submits, retries that succeeded the first time but the client never
    // saw the response, etc. The cron uses the same gate via delivered_at.
    // NEVER derive this from req.url: behind the youngalgy.com rewrite the
    // request origin is the internal Vercel hostname, and these URLs go into
    // the subscriber's EMAIL — links to the internal host land on a domain
    // where their session cookie doesn't exist ("No letter yet" dead end; a
    // real subscriber hit exactly this). Same canonical fallback as the cron.
    const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://youngalgy.com";
    const inboxUrl = `${origin}/alpha/inbox`;
    let emailSent = false;
    if (profile.email && resendConfigured()) {
      const toEmail = profile.email;
      let issueNumber = 1; // this reader's Nth letter (drives "Issue N" subject)
      let store: DeliveryStore | null = null;
      if (persistence?.userId) {
        const sb = await supabaseServiceClient();
        store = deliveryStoreFor(sb);
        try {
          // Issue number = prior DELIVERED letters (weeks before this one) + 1.
          // delivered_at NOT NULL so a generated-but-unsent row doesn't inflate it.
          const { data: priors } = await sb
            .from("issues")
            .select("week_of")
            .eq("user_id", persistence.userId)
            .lt("week_of", weekOf)
            .not("delivered_at", "is", null);
          issueNumber = (priors?.length ?? 0) + 1;
        } catch (e) {
          console.warn(
            "[generate] issue-number lookup failed (will still attempt send):",
            e instanceof Error ? e.message : e
          );
        }
      }
      // Idempotent send via an ATOMIC delivered_at claim, the same compare-and-
      // swap the weekly cron uses (lib/letter-delivery.ts). A signup can land
      // within ~a minute of a Sun/Tue/Thu cron tick and both paths target the
      // same (user, week_of) row, so claiming before the send means exactly one
      // of them wins and the other skips. No persisted row → best-effort send.
      const result = await deliverLetterOnce({
        store,
        userId: persistence?.userId ?? null,
        weekOf,
        stamp: new Date().toISOString(),
        send: async () => {
          await sendLetterNotification({
            to: toEmail,
            firstName: profile.firstName,
            issue,
            inboxUrl,
            // Tokenized view-in-browser CTA. Opens the letter with no session.
            letterUrl: persistence?.userId ? buildLetterUrl(persistence.userId, origin) : null,
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
          `[generate] skipped letter email for ${toEmail}, already delivered for ${weekOf}`
        );
      }
    }

    return NextResponse.json({
      issue,
      userId: persistence?.userId ?? null,
      magicLink: persistence?.magicLink ?? null,
      emailSent,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Adapt a Supabase service client to the DeliveryStore atomic-claim contract.
// `claim` is the compare-and-swap: stamp delivered_at only where it is still
// NULL (Postgres row-locks the UPDATE, so one concurrent caller wins). A 0-row
// result is disambiguated with a read — row present means already delivered, no
// row means best-effort persist never wrote one. `release` is guarded on our
// exact stamp so a rollback can't clear another invocation's claim.
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
      const { data: check } = await sb
        .from("issues")
        .select("delivered_at")
        .eq("user_id", userId)
        .eq("week_of", weekOf)
        .maybeSingle();
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
  // between the onboarding first-letter path and the Sun/Tue/Thu cron, so a
  // first letter and a same-day cron send share one period instead of two keys.
  return new Date().toISOString().slice(0, 10);
}
