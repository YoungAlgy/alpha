import { NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { checkoutUserMutation, isFirstSubscription } from "@/lib/webhook-user-mutation";
import { sendWelcomeEmail, resendConfigured } from "@/lib/email";

export const runtime = "nodejs";

// Stripe webhooks need the raw body for signature verification.
// Next.js route handlers expose this via req.text(); do NOT parse JSON first.
export async function POST(req: Request) {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
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
          // Ensure the auth user exists (creates if missing) and grab their id.
          // Without this, direct-checkout users (who bypass the onboarding
          // funnel) have no public.users row when the webhook fires, and an
          // UPDATE-by-email would silently no-op.
          const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
            type: "magiclink",
            email,
          });
          if (linkErr || !linkData?.user) {
            console.warn("[stripe-webhook] generateLink failed:", linkErr?.message);
          } else {
            const meta = (session.metadata || {}) as Record<string, string>;
            const firstName = meta.alpha_first_name || meta.first_name || "friend";
            const city = meta.alpha_city || meta.city || null;
            const userId = linkData.user.id;
            // Look up the existing row so we don't clobber subscription-owned
            // state (topic_quota / cancelled_at) on a re-delivered or
            // out-of-order checkout event. See lib/webhook-user-mutation.
            const { data: existing } = await sb
              .from("users")
              .select("subscribed_at")
              .eq("id", userId)
              .maybeSingle();
            const mut = checkoutUserMutation(existing ?? null, {
              userId,
              email,
              firstName,
              city,
              customerId: customerId ?? null,
              nowIso: new Date().toISOString(),
            });
            if (mut.kind === "insert") {
              const { error: insErr } = await sb.from("users").insert(mut.row);
              if (insErr) console.warn("[stripe-webhook] user insert failed:", insErr.message);
            } else {
              const { error: updErr } = await sb
                .from("users")
                .update(mut.patch)
                .eq("id", userId);
              if (updErr) console.warn("[stripe-webhook] user update failed:", updErr.message);
            }
            // One-time welcome email on first subscription. Best-effort — never
            // block the webhook. isFirstSubscription reads the PRE-write row, so
            // a re-delivered / out-of-order checkout won't resend it.
            if (isFirstSubscription(existing ?? null) && resendConfigured()) {
              try {
                const origin =
                  process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://youngalgy.com";
                await sendWelcomeEmail({
                  to: email,
                  firstName,
                  inboxUrl: `${origin}/alpha/inbox`,
                  userId, // adds List-Unsubscribe headers (deliverability)
                });
              } catch (e) {
                console.warn(
                  "[stripe-webhook] welcome email failed:",
                  e instanceof Error ? e.message : e
                );
              }
            }
          }
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        // If subscription is canceled-at-period-end, capture intent without
        // hard-cancelling access (user keeps reading until period_end).
        const cancellingAtPeriodEnd = sub.cancel_at_period_end;
        // Mirror subscription quantity → topic_quota. Single subscription
        // item assumed (one Alpha price). Defaults to 1 → quota 5 if for
        // any reason the items list is empty. Cap at 25 (5 add-ons max).
        const firstItem = sub.items?.data?.[0];
        const quantity = firstItem?.quantity ?? 1;
        const topicQuota = Math.max(5, Math.min(25, quantity * 5));
        await sb
          .from("users")
          .update({
            cancelled_at: cancellingAtPeriodEnd
              ? new Date(sub.cancel_at! * 1000).toISOString()
              : null,
            topic_quota: topicQuota,
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
    // Return 5xx so Stripe RETRIES (webhooks are at-least-once). The handlers are
    // idempotent — checkoutUserMutation does a non-clobbering update on an existing
    // row, the welcome email is gated on isFirstSubscription (reads the pre-write
    // row), and the subscription.* paths set columns to their current value — so a
    // retry safely recovers a transient Supabase/Stripe blip instead of silently
    // losing the user-row state-write (which would strand a paid user with no
    // access). A genuinely-unprocessable event just retries ~3d then Stripe stops
    // (log noise, no harm). (#35 — audit S27)
    return NextResponse.json({ received: false, error: "handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
