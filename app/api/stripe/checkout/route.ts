import { NextResponse } from "next/server";
import Stripe from "stripe";
import { STRIPE_PRICE_ID } from "@/lib/stripe";

export const runtime = "nodejs";

interface CheckoutPayload {
  email?: string;
  firstName?: string;
  city?: string;
}

export async function POST(req: Request) {
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
