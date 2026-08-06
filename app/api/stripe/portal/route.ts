import { NextResponse } from "next/server";
import { getStripeClient } from "@/lib/stripe";
import { supabaseServerClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// Creates a Stripe Billing Portal session for the authed user. They can
// update card, cancel, switch plans, see invoices — all hosted by Stripe.
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
    // Prefer the public app URL — behind the youngalgy.com rewrite, req.url's
    // origin is the internal Vercel hostname, which would bounce the user to
    // the unrouted deployment after they finish in the Stripe portal. Same
    // pattern as the checkout route.
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
    const msg = e instanceof Error ? e.message : "Stripe error";
    console.error("[stripe/portal] failed:", msg);
    return NextResponse.json({ error: "Couldn't open billing portal. Try again in a moment." }, { status: 500 });
  }
}
