import { NextResponse } from "next/server";
import { z } from "zod";
import Stripe from "stripe";
import { generateIssue } from "@/lib/engine/assemble";
import { persistIssueIfPossible } from "@/lib/engine/persist";
import { sendLetterNotification, resendConfigured } from "@/lib/email";
import { rateLimit, clientKeyFromRequest } from "@/lib/rate-limit";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { hasActiveAccess } from "@/lib/access";
import { letterUrl as buildLetterUrl } from "@/lib/letter-token";
import { withDeadline } from "@/lib/with-deadline";

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
  jobBlurb: z.string().max(500).optional(),
  projectBlurb: z.string().max(600).optional(),
  funBlurb: z.string().max(500).optional(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gender: z.enum(["male", "female"]).optional(),
  topics: z.array(z.string().min(1).max(60)).min(1).max(25),
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
    // Cast: zod validated structure, the type narrowing for TopicId / ThemeId
    // happens implicitly via the engine's TOPIC_BY_ID lookup (unknown topics
    // throw clearly inside resolveTopicSignal).
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
      let alreadyDelivered = false;
      let issueNumber = 1; // this reader's Nth letter (drives "Issue N" subject)
      if (persistence?.userId) {
        try {
          const sb = await supabaseServiceClient();
          const { data: existing } = await sb
            .from("issues")
            .select("delivered_at")
            .eq("user_id", persistence.userId)
            .eq("week_of", weekOf)
            .maybeSingle();
          alreadyDelivered = !!existing?.delivered_at;
          // Issue number = prior letters (weeks before this one) + 1.
          const { data: priors } = await sb
            .from("issues")
            .select("week_of")
            .eq("user_id", persistence.userId)
            .lt("week_of", weekOf);
          issueNumber = (priors?.length ?? 0) + 1;
        } catch (e) {
          console.warn(
            "[generate] delivered_at/issue-number lookup failed (will attempt send):",
            e instanceof Error ? e.message : e
          );
        }
      }
      if (alreadyDelivered) {
        console.log(
          `[generate] skipped letter email for ${profile.email} — already delivered for ${weekOf}`
        );
      } else {
        try {
          await sendLetterNotification({
            to: profile.email,
            firstName: profile.firstName,
            issue,
            inboxUrl,
            // Tokenized view-in-browser CTA — opens the letter with no session.
            letterUrl: persistence?.userId
              ? buildLetterUrl(persistence.userId, inboxUrl.replace(/\/alpha\/inbox$/, ""))
              : null,
            issueNumber,
            userId: persistence?.userId ?? null,
          });
          emailSent = true;
          // Stamp delivered_at so subsequent re-triggers short-circuit.
          if (persistence?.userId) {
            try {
              const sb = await supabaseServiceClient();
              await sb
                .from("issues")
                .update({ delivered_at: new Date().toISOString() })
                .eq("user_id", persistence.userId)
                .eq("week_of", weekOf);
            } catch (e) {
              console.warn(
                "[generate] delivered_at stamp failed:",
                e instanceof Error ? e.message : e
              );
            }
          }
        } catch (e) {
          console.warn("[generate] letter email failed:", e instanceof Error ? e.message : e);
        }
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

function defaultWeekOf(): string {
  // The first letter's period key = TODAY's UTC date (the send date), matching
  // the cron's currentPeriodIso() under the multi-send cadence. This keeps the
  // (user, week_of) idempotency key and the (topic, week_of) blurb cache aligned
  // between the onboarding first-letter path and the Sun/Tue/Thu cron, so a
  // first letter and a same-day cron send share one period instead of two keys.
  return new Date().toISOString().slice(0, 10);
}
