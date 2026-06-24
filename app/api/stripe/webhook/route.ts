import { NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { checkoutUserMutation, isFirstSubscription } from "@/lib/webhook-user-mutation";
import { sendWelcomeEmail, resendConfigured } from "@/lib/email";
import { clampQuota, TOPICS_PER_BUNDLE } from "@/lib/types";

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
        const rawEmail = session.customer_details?.email || session.customer_email;
        // Normalize to lowercase so the public.users row, the auth user (Supabase
        // auth lowercases anyway), and the checkout double-charge guard's email
        // lookup all key on ONE canonical form (email addresses are treated
        // case-insensitively in practice).
        const email = rawEmail ? rawEmail.toLowerCase().trim() : null;
        // A subscription-mode Checkout always attaches a Customer, so
        // session.customer is non-null here; the ?? null fallback is only for
        // type-narrowing. If a customer-less checkout path is ever added, the
        // out-of-order subscription-mirror self-heal would break (it keys on
        // stripe_customer_id), so guard that path rather than writing a null id.
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
            // THROW so the outer catch returns 5xx and Stripe retries (#35).
            // Swallowing this stranded a paid user with no users row and no
            // retry — the exact failure the 5xx-on-error change exists for.
            throw new Error(`generateLink failed: ${linkErr?.message ?? "no user returned"}`);
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
              .select("subscribed_at, cancelled_at")
              .eq("id", userId)
              .maybeSingle();
            // Is this checkout's subscription LIVE right now? A genuine new or
            // resubscribe checkout has an active sub; a re-delivered ORIGINAL
            // checkout for a since-ended subscription does not. Gates the
            // stale-cancellation clear in checkoutUserMutation so a stray
            // redelivery can't resurrect a churned reader. Best-effort: on a
            // retrieve failure we leave subscriptionLive=false (DON'T clear) —
            // a later subscription.* event re-mirrors the truth by customer id.
            let subscriptionLive = false;
            const subId =
              typeof session.subscription === "string"
                ? session.subscription
                : session.subscription?.id ?? null;
            if (subId) {
              try {
                const sub = await stripe.subscriptions.retrieve(subId);
                subscriptionLive = sub.status === "active" || sub.status === "trialing";
              } catch (e) {
                console.warn(
                  "[stripe-webhook] subscription status check failed; leaving cancelled_at untouched:",
                  e instanceof Error ? e.message : e
                );
              }
            }
            const mut = checkoutUserMutation(existing ?? null, {
              userId,
              email,
              firstName,
              city,
              customerId: customerId ?? null,
              nowIso: new Date().toISOString(),
              subscriptionLive,
            });
            // A failed user write must THROW (-> 5xx -> Stripe retry, #35).
            // It must also happen BEFORE the welcome email: sending the welcome
            // after a failed write would double-send it on the retry (the
            // isFirstSubscription gate reads the PRE-write row).
            if (mut.kind === "insert") {
              const { error: insErr } = await sb.from("users").insert(mut.row);
              if (insErr) throw new Error(`user insert failed: ${insErr.message}`);
            } else {
              const { error: updErr } = await sb
                .from("users")
                .update(mut.patch)
                .eq("id", userId);
              if (updErr) throw new Error(`user update failed: ${updErr.message}`);
            }
            // One-time welcome email on first subscription. Best-effort — its
            // own try/catch, never blocks or retries the webhook. The
            // isFirstSubscription gate (pre-write row) keeps retries from
            // resending it once the write above has succeeded.
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
        const topicQuota = clampQuota(quantity * TOPICS_PER_BUNDLE);
        // Throw on failure -> 5xx -> Stripe retries (#35). Set-to-current, so
        // a retry is idempotent. Silently losing this write desyncs paid quota
        // / cancellation state from Stripe with no recovery.
        // Guard the cancelled_at derivation. The old `sub.cancel_at!` non-null
        // assertion was a double trap: if cancel_at is null/undefined,
        // `new Date(NaN).toISOString()` THROWS (→ outer catch → 5xx →
        // Stripe retries forever, throw-looping the quota mirror too), and
        // `new Date(0).toISOString()` would write a 1970 PAST date that the
        // cron's `cancelled_at.gt.now` filter reads as "access ended" — silently
        // DROPPING a cancel-at-period-end subscriber who is still paid up. Only
        // write a real future end date; otherwise leave null (keep serving the
        // paid-up reader — subscription.deleted will set the real end later).
        const cancelledAt =
          cancellingAtPeriodEnd && typeof sub.cancel_at === "number" && sub.cancel_at > 0
            ? new Date(sub.cancel_at * 1000).toISOString()
            : null;
        const { data: subRows, error: subErr } = await sb
          .from("users")
          .update({
            cancelled_at: cancelledAt,
            topic_quota: topicQuota,
          })
          .eq("stripe_customer_id", customerId)
          .select("id");
        if (subErr) throw new Error(`subscription mirror failed: ${subErr.message}`);
        // A Supabase .update() does NOT error on 0 matched rows, so a missed
        // mirror would be SILENTLY lost. 0 rows means one of two things,
        // distinguished by the subscription status:
        //   - active/trialing/etc → out-of-order: the event beat checkout linking
        //     stripe_customer_id. THROW so Stripe retries (#35); by retry time the
        //     row exists and the mirror lands.
        //   - terminal (canceled/expired/unpaid) → the account was already
        //     deleted (delete cancels the sub, cascading the row away, then this
        //     event lands). Nothing to mirror — absorb with 200 like
        //     subscription.deleted, so a normal delete flow doesn't churn ~3d of
        //     futile retries.
        if ((subRows?.length ?? 0) === 0) {
          const terminal =
            sub.status === "canceled" ||
            sub.status === "incomplete_expired" ||
            sub.status === "unpaid";
          if (terminal) {
            console.warn(
              `[stripe-webhook] subscription mirror matched 0 rows for customer ${customerId} (status=${sub.status}, account deleted?) — no-op`
            );
          } else {
            throw new Error(
              `subscription mirror matched 0 rows for customer ${customerId} (status=${sub.status}, out-of-order? will retry)`
            );
          }
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        // Throw on failure -> 5xx -> Stripe retries (#35). Losing this write
        // would keep sending letters to (and granting access for) an ended
        // subscription forever.
        const { data: delRows, error: delErr } = await sb
          .from("users")
          .update({ cancelled_at: new Date().toISOString() })
          .eq("stripe_customer_id", customerId)
          .select("id");
        if (delErr) throw new Error(`cancellation mirror failed: ${delErr.message}`);
        // 0 rows here almost always means the account was ALREADY deleted: both
        // self-serve (account/delete) and admin delete cancel the Stripe sub and
        // then delete the auth user, which cascades public.users away — so THIS
        // event arrives on a vanished row. There's nothing left to mirror, so
        // absorb it with a 200. (Throwing would make Stripe retry an
        // unrecoverable event for ~3 days, pure noise.) A true out-of-order
        // delete-before-the-row-exists is vanishingly rare and self-corrects via
        // the later checkout/subscription.* mirror anyway.
        if ((delRows?.length ?? 0) === 0) {
          console.warn(
            `[stripe-webhook] subscription.deleted matched 0 rows for customer ${customerId} (account already deleted?) — no-op`
          );
        }
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
