import { NextResponse } from "next/server";
import Stripe from "stripe";
import { STRIPE_PRICE_ID } from "@/lib/stripe";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { hasActiveAccess } from "@/lib/access";
import { rateLimit, clientKeyFromRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

interface CheckoutPayload {
  email?: string;
  firstName?: string;
  city?: string;
}

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
    body = await req.json();
  } catch {
    // Empty body is fine
  }

  // Double-subscription guard. Checkout creates a NEW Stripe subscription on
  // every call, so an already-active subscriber who lands back on /checkout (a
  // shared link, the browser back button, a direct-checkout user bounced
  // through onboarding, the /writing 402 redirect) and clicks Subscribe would
  // be charged a SECOND $5/mo. Refuse when this email already has LIVE access.
  // Fail OPEN on any lookup error (or no email) so a genuine new subscriber is
  // never blocked from paying — a missed double-charge guard is recoverable, a
  // blocked sale is lost revenue. A cancelled-and-ended subscriber (cancelled_at
  // in the past) is NOT blocked, so they can resubscribe.
  if (body.email) {
    try {
      const sb = await supabaseServiceClient();
      const { data: existing } = await sb
        .from("users")
        .select("subscribed_at, cancelled_at")
        .eq("email", body.email)
        .maybeSingle();
      if (existing?.subscribed_at && hasActiveAccess(existing.cancelled_at)) {
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

  // Prefer the public app URL (youngalgy.com) over the request origin —
  // when the request comes in through the youngalgy.com Vercel rewrite,
  // req.url's origin is the raw alpha-chi-five.vercel.app host, which would
  // send users back to the unrouted Vercel URL after Stripe success.
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || new URL(req.url).origin;
  const basePath = "/alpha";

  try {
    const stripe = new Stripe(secret, {
      apiVersion: "2026-04-22.dahlia",
      httpClient: Stripe.createNodeHttpClient(),
    });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: body.email,
      // Only ask for a card when payment is actually due. A 100%-off promo
      // code (our free-trial / comp codes) makes the first invoice $0, so
      // testers get in with NO card. Normal $5 signups still collect a card.
      payment_method_collection: "if_required",
      // Session-level metadata so the webhook can read it from the Session
      // event directly. (subscription_data.metadata also gets set on the
      // resulting Subscription for downstream sub events.)
      metadata: {
        alpha_first_name: body.firstName ?? "",
        alpha_city: body.city ?? "",
      },
      subscription_data: {
        metadata: {
          alpha_first_name: body.firstName ?? "",
          alpha_city: body.city ?? "",
        },
      },
      success_url: `${origin}${basePath}/writing?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}${basePath}/checkout`,
      allow_promotion_codes: true,
    });

    return NextResponse.json({ url: session.url });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Stripe error";
    console.error("[stripe/checkout] failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
