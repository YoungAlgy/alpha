import { NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Stripe webhooks need the raw body for signature verification.
// Next.js route handlers expose this via req.text(); do NOT parse JSON first.
export async function POST(req: Request) {
  const secret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !webhookSecret) {
    return NextResponse.json(
      { error: "Stripe webhook not configured (STRIPE_WEBHOOK_SECRET missing)" },
      { status: 503 }
    );
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  const rawBody = await req.text();
  const stripe = new Stripe(secret, {
    apiVersion: "2026-04-22.dahlia",
    httpClient: Stripe.createNodeHttpClient(),
  });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid signature";
    console.warn("[stripe-webhook] signature verification failed:", msg);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const sb = await supabaseServiceClient();

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const email = session.customer_details?.email || session.customer_email;
        const customerId =
          typeof session.customer === "string"
            ? session.customer
            : session.customer?.id;
        if (email) {
          await sb
            .from("users")
            .update({
              stripe_customer_id: customerId ?? null,
              subscribed_at: new Date().toISOString(),
              cancelled_at: null,
            })
            .eq("email", email);
        }
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        // If subscription is canceled-at-period-end, capture intent without
        // hard-cancelling access (user keeps reading until period_end).
        const cancellingAtPeriodEnd = sub.cancel_at_period_end;
        await sb
          .from("users")
          .update({
            cancelled_at: cancellingAtPeriodEnd
              ? new Date(sub.cancel_at! * 1000).toISOString()
              : null,
          })
          .eq("stripe_customer_id", customerId);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        await sb
          .from("users")
          .update({ cancelled_at: new Date().toISOString() })
          .eq("stripe_customer_id", customerId);
        break;
      }
      case "invoice.payment_failed": {
        // Best-effort — log for now. V1 hooks dunning email via Resend.
        const inv = event.data.object as Stripe.Invoice;
        console.warn(
          `[stripe-webhook] payment_failed for invoice ${inv.id}, customer ${inv.customer}`
        );
        break;
      }
      default:
        // Ignore other event types
        break;
    }
  } catch (e) {
    console.error("[stripe-webhook] handler error:", e instanceof Error ? e.message : e);
    // Return 200 so Stripe doesn't keep retrying for application errors —
    // we'll see them in logs. (Return 5xx only for transient infra failures.)
    return NextResponse.json({ received: true, error: "handler error" });
  }

  return NextResponse.json({ received: true });
}
