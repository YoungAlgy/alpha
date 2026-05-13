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
  const secret = process.env.STRIPE_SECRET_KEY;
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

  const origin = new URL(req.url).origin;
  const basePath = "/alpha";

  try {
    const stripe = new Stripe(secret, {
      apiVersion: "2026-04-22.dahlia",
      httpClient: Stripe.createNodeHttpClient(),
      maxNetworkRetries: 0,
      timeout: 15000,
    });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: body.email,
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
    const err = e as { message?: string; type?: string; code?: string; statusCode?: number; cause?: unknown; stack?: string };
    const causeStr = err.cause ? String(err.cause) : null;
    const causeCode = (err.cause as { code?: string } | undefined)?.code;
    return NextResponse.json(
      {
        error: err.message || "Stripe error",
        _debug: {
          type: err.type,
          code: err.code,
          status: err.statusCode,
          causeStr,
          causeCode,
          stack: err.stack?.split("\n").slice(0, 6).join("\n"),
        },
      },
      { status: 500 }
    );
  }
}
