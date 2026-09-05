import { NextResponse } from "next/server";
import { getStripeClient, describeStripeError } from "@/lib/stripe";
import { supabaseServerClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { isInviteOnly } from "@/lib/access-mode";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (isInviteOnly(true)) {
    return NextResponse.json(
      { error: "Alpha is invite-only. Billing changes are closed." },
      { status: 410, headers: { "Cache-Control": "no-store" } }
    );
  }

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

  // alpha-drift-r59-08 (2026-08-20, silent-catch-audit-r5): `error` used to
  // be OR'd directly into the same "no customer on file" branch below, with
  // no logging -- a genuine Supabase failure (connection blip, RLS hiccup)
  // on this SELECT produced the identical, misleading "Subscribe first" 400
  // as a real paying user hitting the app's only self-serve cancel/update-
  // card path. Split to match the pattern already established at every
  // sibling site (update-quantity/route.ts, admin/users/route.ts): log and
  // return a distinct, honest, retryable 500.
  if (error) {
    console.error("[stripe/portal] customer lookup failed:", error.message);
    return NextResponse.json({ error: "Couldn't load your subscription. Try again." }, { status: 500 });
  }
  if (!row?.stripe_customer_id) {
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
