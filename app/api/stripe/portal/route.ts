import { NextResponse } from "next/server";
import { getStripeClient, describeStripeError } from "@/lib/stripe";
import { supabaseServerClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// Creates a Stripe Billing Portal session for the authed user. They can
// update card, cancel, see invoices — all hosted by Stripe. Deliberately no
// "switch plans" here: quantity changes go through the app's own guarded
// /api/stripe/update-quantity flow (lib/update-quantity-guards.ts), not a
// second, unclamped path via the portal's subscription_update feature.
//
// alpha-drift-r15-01 (found live, 2026-08-06 -- NOT YET FIXED, needs Algy):
// this call requires the Stripe account to have a saved default Billing
// Portal configuration, or it throws and every real call here 500s. Live-
// checked via the Stripe API (GetBillingPortalConfigurations): this account
// currently has ZERO configurations of any kind -- meaning the "Update
// card, cancel, see invoices" button on /settings is dead for every real
// subscriber right now. This is the ONLY self-serve cancel/card-update path
// in the whole app; the only alternative today is the destructive
// "delete my account" flow. Fix is a one-time Stripe Dashboard action, not
// a code change: visit https://dashboard.stripe.com/settings/billing/portal
// and save a configuration (enabling at least payment_method_update,
// invoice_history, and customer cancellation -- leave subscription_update
// OFF per the comment above). Deliberately not created via the Stripe API
// from here: it's an account-wide setting real customers see immediately,
// and the Stripe MCP tool available this session doesn't expose portal-
// configuration writes at all (only GetBillingPortalConfigurations is
// searchable) -- a signal this is meant to be a deliberate human action on
// the dashboard, not something to script around.
export async function POST(req: Request) {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }

  // Auth: read the user's Supabase session and look up their stripe_customer_id
  const sb = await supabaseServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: row, error } = await sb
    .from("users")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !row?.stripe_customer_id) {
    return NextResponse.json(
      { error: "No Stripe customer on file. Subscribe first." },
      { status: 400 }
    );
  }

  // Rate limit per authed user. Each call is a live Stripe API request with
  // no functional benefit to repeating, so a scripted client could otherwise
  // hammer stripe.billingPortal.sessions.create for free. 20/hr is well past
  // any real user's need (they'd land on the portal and stay there).
  const limited = rateLimit(`portal:${user.id}`, { limit: 20, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  try {
    const stripe = getStripeClient();
    // alpha-drift-r49-04 (2026-08-20, docs-code-drift-round-5): same stale
    // "internal Vercel host" rationale as the checkout route's
    // alpha-drift-r49-03 -- fixed together. Prefer the public app URL — this
    // route runs on Cloudflare Workers, and req.url can still reflect a
    // Worker-internal or preview hostname, which would bounce the user to
    // the unrouted deployment after they finish in the Stripe portal.
    const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || new URL(req.url).origin;
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${origin}/settings`,
    });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    // Log the real Stripe error server-side only -- matches checkout/route.ts
    // and update-quantity/route.ts's established pattern. This is reachable
    // by any signed-in user just by triggering a Stripe error; the raw SDK
    // message can leak price/product IDs or account config.
    //
    // alpha-drift-r29-05 (2026-08-14): describeStripeError, see lib/stripe.ts.
    console.error("[stripe/portal] failed:", describeStripeError(e));
    // alpha-drift-r20-01 (found+fixed 2026-08-13): "Try again in a moment"
    // implied a transient blip, but the live, currently-known cause (no
    // saved Billing Portal configuration on this Stripe account -- see this
    // file's own top-of-file comment) is NOT transient; retrying changes
    // nothing until that one-time dashboard action happens. Since this is
    // the app's ONLY self-serve cancel/card-update path, leaving a user
    // with a dead-end "try again" message and no real next step is worse
    // than being upfront and pointing them at the one path that actually
    // works today.
    return NextResponse.json(
      { error: "Couldn't open billing portal right now. Email youngalgy@gmail.com and we'll update your card or cancel for you." },
      { status: 500 }
    );
  }
}
