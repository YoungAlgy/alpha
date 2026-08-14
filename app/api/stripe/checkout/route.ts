import { NextResponse } from "next/server";
import { z } from "zod";
import { STRIPE_PRICE_ID, getStripeClient, describeStripeError } from "@/lib/stripe";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { rateLimit, clientKeyFromRequest } from "@/lib/rate-limit";
import { isProfileComplete, shouldBlockDoubleSubscription } from "@/lib/checkout-guards";

export const runtime = "nodejs";

// Same caps app/api/account/profile/route.ts's LIMITS already enforce for
// firstName/city -- this route is the OTHER write path into the same
// public.users columns (via Stripe metadata -> the webhook), and used to be
// the one place that didn't bound them. .max(25) on topics matches
// isProfileComplete's own bound one line below where it's enforced.
const CheckoutPayloadSchema = z.object({
  // 254, not 320 -- lib/validate-email.ts documents and enforces the real
  // RFC 5321 total-length bound (320 is the common local-part(64)+domain(255)
  // misconception). isProfileComplete() below already calls isValidEmail(),
  // which rejects anything over 254 -- a 255-320 char input used to pass
  // this schema cleanly and then fail there with a generic "finish your
  // profile" 400 instead of a specific length error, since the two caps
  // disagreed with each other one file apart.
  email: z.string().max(254).optional(),
  firstName: z.string().max(60).optional(),
  city: z.string().max(120).optional(),
  topics: z.array(z.string()).max(25).optional(),
});
type CheckoutPayload = z.infer<typeof CheckoutPayloadSchema>;

export async function POST(req: Request) {
  // Rate limit (same in-memory limiter the sibling generate/support routes use).
  // Caps casual abuse AND bulk probing of the already-subscribed guard below —
  // that guard returns a distinguishable 409 for active subscribers vs a 200 for
  // everyone else, a subscriber-enumeration oracle if left unthrottled. 10/hr/IP
  // leaves ample room for a real user's checkout retries while making any
  // list-sweep of "who is a paying subscriber" useless.
  const ip = clientKeyFromRequest(req);
  const limited = rateLimit(`checkout:${ip}`, { limit: 10, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  // Trim — env var paste from clipboards can include trailing \r or whitespace,
  // which Node's HTTP layer rejects when setting the Authorization header.
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "Stripe not configured. Set STRIPE_SECRET_KEY in .env.local." },
      { status: 503 }
    );
  }

  let body: CheckoutPayload = {};
  try {
    const raw = await req.json();
    body = CheckoutPayloadSchema.parse(raw);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: `Invalid input: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` },
        { status: 400 }
      );
    }
    // Empty/malformed JSON body -- fine, treated as no profile data.
  }
  // Canonicalize the email to lowercase so the double-charge guard's lookup, the
  // Stripe customer_email, and the row the webhook later writes all key on one
  // form (emails are case-insensitive in practice; Supabase auth lowercases too).
  if (body.email) body.email = body.email.toLowerCase().trim();

  // Profile-completeness gate — see lib/checkout-guards.ts's isProfileComplete
  // for why this exists and what it checks.
  if (!isProfileComplete(body)) {
    return NextResponse.json(
      { error: "Please finish setting up your profile before subscribing." },
      { status: 400 }
    );
  }

  // Double-subscription guard — see lib/checkout-guards.ts's
  // shouldBlockDoubleSubscription for the full decision. Fail OPEN on any
  // lookup error (or no email) so a genuine new subscriber is never blocked
  // from paying — a missed double-charge guard is recoverable, a blocked
  // sale is lost revenue.
  if (body.email) {
    try {
      const sb = await supabaseServiceClient();
      const { data: existing } = await sb
        .from("users")
        .select("subscribed_at, cancelled_at, stripe_customer_id")
        .eq("email", body.email)
        .maybeSingle();
      if (shouldBlockDoubleSubscription(existing)) {
        return NextResponse.json(
          {
            error: "already_subscribed",
            message:
              "You already have an active subscription. Sign in to read your letters or manage it.",
          },
          { status: 409 }
        );
      }
    } catch (e) {
      console.warn(
        "[stripe/checkout] active-subscription pre-check failed, allowing checkout:",
        e instanceof Error ? e.message : e
      );
    }
  }

  // Prefer the public app URL (alpha.everyday.report) over the request origin —
  // a request that arrives through a proxy/rewrite carries the raw internal
  // Vercel host in req.url, which would send users back to an unrouted URL
  // after Stripe success.
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || new URL(req.url).origin;

  try {
    const stripe = getStripeClient();

    // Idempotency key so two near-simultaneous requests for the same signup
    // (a double-click that slips past the client's disabled-state guard, a
    // second tab, a client-side retry) collapse to ONE Checkout Session
    // instead of two. Without this, shouldBlockDoubleSubscription's own
    // pre-check above is a real TOCTOU race: both requests read
    // subscribed_at as still-null (it's only set later by the
    // checkout.session.completed webhook) and both pass, producing two
    // sessions whose webhooks both resolve to the same auth user and race to
    // write stripe_customer_id -- the loser's subscription becomes invisible
    // to the billing portal and to account/delete's cancellation lookup,
    // both of which key off that same column. 30s bucket mirrors
    // update-quantity/route.ts's identical pattern: scopes the dedup to
    // rapid retries of the same submit, not a subscriber's genuine later
    // resubscribe attempt.
    const idemKey = body.email ? `alpha-checkout-${body.email}-${Math.floor(Date.now() / 30000)}` : undefined;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: body.email,
      // Turn OFF adaptive pricing. It runs IP-based geolocation + currency
      // conversion on Stripe's hosted page, which is a known trigger for the
      // iOS Safari "a problem repeatedly occurred" reload loop when the buyer is
      // on iCloud Private Relay / a VPN / ambiguous geo (Apple's relay masks the
      // real IP). This is a single USD $5/mo product with a US audience, so
      // adaptive pricing adds zero value and only risk. Everyone pays USD.
      adaptive_pricing: { enabled: false },
      // Only ask for a card when payment is actually due. A 100%-off promo
      // code (our free-trial / comp codes) makes the first invoice $0, so
      // testers get in with NO card. Normal $5 signups still collect a card.
      payment_method_collection: "if_required",
      // Session-level metadata so the webhook can read it from the Session
      // event directly.
      //
      // alpha-drift-r28-07 (2026-08-15): this used to ALSO duplicate the
      // same two fields onto subscription_data.metadata, "for downstream
      // sub events" -- but grepped the whole codebase and nothing anywhere
      // ever reads a Subscription's metadata; the webhook's only read of
      // either field is `session.metadata` at checkout.session.completed
      // (app/api/stripe/webhook/route.ts). The Subscription copy was pure
      // dead weight that existed for a "downstream" use case that was never
      // built, while adding real exposure: lib/stripe-cancel.ts's account-
      // deletion cleanup never scrubbed it, so a deleted reader's real name
      // and city stayed attached to their (canceled but still retrievable)
      // Subscription object forever. Removed -- the Checkout Session's own
      // copy below is unavoidable (Stripe Checkout Sessions have no
      // metadata-update endpoint, confirmed against the SDK's own
      // SessionUpdateParams type: no `metadata` field exists there), so
      // that one genuinely can't be cleared on delete and is now disclosed
      // in app/privacy/page.tsx instead of silently left unmentioned.
      metadata: {
        alpha_first_name: body.firstName ?? "",
        alpha_city: body.city ?? "",
      },
      success_url: `${origin}/writing?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout`,
      allow_promotion_codes: true,
      // Keep a bounced session recoverable. "A problem repeatedly occurred" is
      // iOS Safari hitting its per-tab memory limit on Stripe's hosted page, a
      // device issue we lower the odds of (adaptive pricing off) but can't fully
      // prevent. On expiry Stripe fires checkout.session.expired with a fresh
      // recovery URL and the incomplete session stays queryable, so a bounce can
      // be followed up on. NOTE: Stripe does NOT auto-email the customer for an
      // API-built checkout. Doing that would need an expired-session webhook plus
      // a promo-consent checkbox (recovery emails count as "promotional"), which
      // at this scale isn't worth the friction + compliance, so recovery is
      // MANUAL (watch incomplete sessions, follow up). Flag is harmless and
      // forward-compatible if we ever wire the webhook.
      after_expiration: {
        recovery: { enabled: true, allow_promotion_codes: true },
      },
    }, idemKey ? { idempotencyKey: idemKey } : undefined);

    return NextResponse.json({ url: session.url });
  } catch (e) {
    // Log the real Stripe error server-side only. This endpoint has no auth
    // (just a rate limit), so the raw SDK message must never reach the
    // caller — it can leak price/product IDs or account config.
    //
    // alpha-drift-r29-05 (2026-08-14): describeStripeError (not a bare
    // e.message) so a rate limit, an auth failure, and a genuine outage are
    // distinguishable in logs -- see lib/stripe.ts's own comment.
    console.error("[stripe/checkout] failed:", describeStripeError(e));
    return NextResponse.json(
      { error: "Couldn't start checkout. Try again in a moment." },
      { status: 500 }
    );
  }
}
