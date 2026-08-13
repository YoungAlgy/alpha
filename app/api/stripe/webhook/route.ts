import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { checkoutUserMutation, isFirstSubscription, deriveCancelledAt, isTerminalSubscriptionStatus } from "@/lib/webhook-user-mutation";
import { sendWelcomeEmail, resendConfigured, sendOpsAlert, removeResendSuppression } from "@/lib/email";
import { clampQuota, TOPICS_PER_BUNDLE } from "@/lib/types";
import { cancelCustomerSubscriptions } from "@/lib/stripe-cancel";

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
  const stripe = getStripeClient();

  let event: Stripe.Event;
  try {
    // Timestamp-tolerance (replay window) is intentionally left at the
    // Stripe SDK's default (300s, Stripe's own recommendation) rather than
    // passed explicitly here -- reinforced by the stripe_webhook_events
    // dedup table below, which structurally prevents a within-window replay
    // from double-processing regardless of the exact tolerance value.
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid signature";
    console.warn("[stripe-webhook] signature verification failed:", msg);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const sb = await supabaseServiceClient();

  // Structural redelivery guard: Stripe delivers at-least-once, so any event
  // can arrive twice. Record event.id before touching anything else -- if
  // it's already here, this is a redelivery of an event we've already
  // started (or finished) handling, so short-circuit with 200 rather than
  // re-running a handler that might not tolerate a second run. Without this
  // table, idempotency was emergent (every handler below happens to do a
  // careful read-then-non-destructive-write), not structurally enforced --
  // see the stripe_webhook_events migration. ignoreDuplicates makes this an
  // INSERT ... ON CONFLICT DO NOTHING: 0 rows back means the id was already
  // present. Best-effort: a genuine Supabase error here (table hiccup, not
  // a real dup) shouldn't block processing, so fall through to the switch.
  const { data: dedupRows, error: dedupErr } = await sb
    .from("stripe_webhook_events")
    .upsert({ id: event.id, type: event.type }, { onConflict: "id", ignoreDuplicates: true })
    .select("id");
  if (dedupErr) {
    console.warn("[stripe-webhook] dedup insert failed, processing without guard:", dedupErr.message);
  } else if ((dedupRows?.length ?? 0) === 0) {
    console.warn(`[stripe-webhook] duplicate delivery of event ${event.id} (${event.type}) -- skipping`);
    return NextResponse.json({ received: true });
  }
  // Only THIS request freshly inserted the row (dedupRows.length > 0) is a
  // durable "done" marker worth keeping if the handler below throws -- see
  // the catch block's cleanup. If dedupErr was set there's nothing to clean
  // up (the insert never happened); if a duplicate was detected we already
  // returned above and never reach the catch at all.
  const insertedDedupRow = !dedupErr && (dedupRows?.length ?? 0) > 0;

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
              // alpha-drift-r17-06: this app's own bounced_at/complained_at
              // columns are only half the fix -- Resend maintains its own
              // separate account-level suppression list that also has to be
              // cleared, or the cron would keep calling sendLetterNotification
              // for an "active" subscriber Resend silently keeps skipping.
              // AWAITED, not fire-and-forget: an unawaited call here can be
              // silently abandoned once this handler returns and the
              // platform tears the invocation down (the exact bug class
              // already found+fixed once in assemble.ts's blurb-cache write
              // -- see that comment). Best-effort in the sense that a
              // failure never throws/retries the WEBHOOK (removeResend
              // Suppression already swallows and logs its own errors), just
              // awaited so it actually gets a chance to complete.
              if (mut.patch.bounced_at === null || mut.patch.complained_at === null) {
                await removeResendSuppression(email);
              }
            }
            // One-time welcome email on first subscription. Best-effort — its
            // own try/catch, never blocks or retries the webhook. The
            // isFirstSubscription gate (pre-write row) keeps retries from
            // resending it once the write above has succeeded.
            if (isFirstSubscription(existing ?? null) && resendConfigured()) {
              try {
                const origin =
                  process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://alpha.everyday.report";
                await sendWelcomeEmail({
                  to: email,
                  firstName,
                  inboxUrl: `${origin}/inbox`,
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
        // Mirror subscription quantity → topic_quota. Single subscription
        // item assumed (one Alpha price). Defaults to 1 → quota 5 if for
        // any reason the items list is empty. Cap at 25 (5 add-ons max).
        const firstItem = sub.items?.data?.[0];
        const snapshotQuantity = firstItem?.quantity ?? 1;
        // Stripe delivers webhooks at-least-once and NOT in order. Rapidly
        // clicking "add topic bundle" fires back-to-back subscription.updated
        // events (update-quantity/route.ts's own write-through already set
        // topic_quota from the LATEST click); if an earlier event's delivery
        // is delayed/retried and lands after a later one, trusting ITS
        // embedded snapshot would overwrite topic_quota back down to a stale
        // quantity forever (nothing else self-heals it). Re-reading the LIVE
        // subscription at handler time means every delivery, in whatever
        // order it lands, converges on Stripe's actual current quantity
        // instead of freezing whichever snapshot happened to arrive last.
        // Best-effort: on a retrieve failure, fall back to this event's own
        // snapshot rather than dropping the mirror entirely.
        let quantity = snapshotQuantity;
        try {
          const liveSub = await stripe.subscriptions.retrieve(sub.id);
          quantity = liveSub.items?.data?.[0]?.quantity ?? snapshotQuantity;
        } catch (e) {
          console.warn(
            "[stripe-webhook] live subscription retrieve failed; using event snapshot:",
            e instanceof Error ? e.message : e
          );
        }
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
        //
        // alpha-drift-r15-02 (found+fixed 2026-08-06): this used to also
        // require `sub.cancel_at_period_end` before trusting `sub.cancel_at`.
        // Stripe exposes those as two INDEPENDENT fields (confirmed via the
        // API schema): cancel_at_period_end is true only for the common
        // "cancel at the end of what I already paid for" case, but a
        // subscription can also be scheduled to cancel on an arbitrary
        // future date (e.g. the Dashboard's "cancel on a specific date"
        // action, or the API's own `cancel_at` param used without
        // `cancel_at_period_end:true`) -- Stripe still populates cancel_at
        // in that case, just with cancel_at_period_end left false. Gating on
        // the boolean meant that combination fell through to null: the app
        // recorded NO scheduled cancellation at all, kept generating and
        // sending real paid-API-cost letters right up to the real cancel_at
        // moment, with zero visibility anywhere that a cancellation was
        // already scheduled. cancel_at alone is the correct signal for
        // "when does access end" regardless of which flow set it.
        //
        // TERMINAL STATUS must never resolve to null. A `subscription.deleted`
        // event correctly sets cancelled_at=now() when the sub ends. But Stripe
        // retries a failed `updated`/`created` delivery for ~3 days -- if that
        // retry lands AFTER `deleted` has already processed, this snapshot's
        // cancel_at may be unset (a terminal sub isn't "canceling", it already
        // ended), so an un-guarded derivation would write cancelled_at=null and
        // silently resurrect a churned subscriber's paid access indefinitely.
        // Once a sub is in a terminal status, this handler must agree with
        // subscription.deleted, not undo it. See deriveCancelledAt's own
        // comment for the full reasoning (pulled out for testability).
        const cancelledAt = deriveCancelledAt(sub.status, sub.cancel_at);
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
          // alpha-drift-r16-16 (found+fixed 2026-08-07): this used to hand-
          // duplicate isTerminalSubscriptionStatus's exact 3-status list
          // inline -- the same file's own deriveCancelledAt call above
          // already goes through the real function. Reusing it here means
          // this retry-vs-absorb decision can never silently drift from
          // the canonical definition the way a second hand-copy could.
          if (isTerminalSubscriptionStatus(sub.status)) {
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
        const inv = event.data.object as Stripe.Invoice;
        console.warn(
          `[stripe-webhook] payment_failed for invoice ${inv.id}, customer ${inv.customer}`
        );
        // A declining card doesn't revoke access on its own -- hasActiveAccess
        // only flips on cancelled_at, which stays null through Stripe's whole
        // Smart Retry window (commonly 2-4 weeks). Without this, the only
        // signal is a log line nobody's watching, so a subscriber can keep
        // reading (and getting sent) paid content for weeks on a dead card
        // with no one noticing. Best-effort: sendOpsAlert never throws.
        await sendOpsAlert(
          "alpha. payment failed",
          `Invoice ${inv.id} failed for customer ${inv.customer}. Stripe will retry automatically over the next couple weeks; check the customer in the Stripe dashboard if it keeps failing.`,
          `alpha-ops-alert-${inv.id}`
        );
        break;
      }
      // alpha-drift-r14-01 (review 2026-08-06): before this, the switch had
      // NO case for any dispute/refund/radar event -- they fell to default
      // and were silently dropped. cancelled_at (the only column
      // hasActiveAccess()/the cron's own filter checks) is written
      // exclusively by checkout.session.completed and
      // customer.subscription.updated/deleted, so a disputed charge never
      // touched it: the subscriber kept passing hasActiveAccess() forever,
      // and the daily cron kept generating (real paid Anthropic/Gemini/Groq/
      // DeepSeek/Brave calls) and emailing them a letter indefinitely with
      // zero revenue behind it -- the exact failure mode a webhook handler
      // exists to prevent.
      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
        // Disputes don't carry a customer id directly -- retrieve the charge
        // to get it. A retrieve failure here can't be fixed by Stripe
        // retrying the SAME dispute event (the charge id itself isn't
        // wrong), so this alerts and moves on rather than throwing --
        // matches invoice.payment_failed's own no-throw judgment call just
        // above.
        let customerId: string | null = null;
        try {
          const charge = await stripe.charges.retrieve(chargeId);
          customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id ?? null;
        } catch (e) {
          console.error(
            `[stripe-webhook] dispute ${dispute.id}: charge retrieve failed:`,
            e instanceof Error ? e.message : e
          );
        }
        if (!customerId) {
          await sendOpsAlert(
            "alpha. dispute opened -- couldn't identify the subscriber",
            `Dispute ${dispute.id} on charge ${chargeId} (${dispute.reason}, $${(dispute.amount / 100).toFixed(2)}) but the charge lookup failed or had no customer attached. Access was NOT revoked -- check the Stripe dashboard directly.`,
            `alpha-dispute-unresolved-${dispute.id}`
          );
          break;
        }
        // A dispute means the customer is already contesting the charge
        // through their bank -- keep serving them (real per-day generation
        // spend) while that's unresolved is money paid twice: once disputed
        // away, once spent generating content nobody's paying for anymore.
        // Cancel the underlying subscription too (best-effort, not the
        // primary defense -- our own cancelled_at write below is what
        // actually stops the cron, this just stops a FUTURE renewal charge
        // on the same subscription). Idempotent on a Stripe-side retry:
        // cancelCustomerSubscriptions skips already-terminal subs.
        const cancelResult = await cancelCustomerSubscriptions(stripe, customerId).catch((e) => {
          console.warn(
            `[stripe-webhook] dispute ${dispute.id}: subscription cancel threw:`,
            e instanceof Error ? e.message : e
          );
          return { cancelled: [] as string[], skipped: 0, errors: 1 };
        });
        const { error: disputeErr } = await sb
          .from("users")
          .update({ cancelled_at: new Date().toISOString() })
          .eq("stripe_customer_id", customerId);
        // Throw so Stripe retries (#35 pattern) -- a failed access-revoke
        // here means real ongoing spend on a disputed subscriber, the exact
        // outcome this handler exists to prevent.
        if (disputeErr) throw new Error(`dispute access-revoke failed: ${disputeErr.message}`);
        await sendOpsAlert(
          "alpha. dispute opened -- access revoked",
          `Dispute ${dispute.id} on charge ${chargeId} for customer ${customerId} (${dispute.reason}, $${(dispute.amount / 100).toFixed(2)}). Access revoked immediately. Subscription cancel: ${cancelResult.cancelled.length} cancelled, ${cancelResult.skipped} skipped, ${cancelResult.errors} errors. Review in the Stripe dashboard.`,
          `alpha-dispute-${dispute.id}`
        );
        break;
      }
      case "charge.dispute.closed": {
        // Visibility only -- deliberately does NOT auto-restore access on a
        // won dispute. Whether a customer who already disputed once should
        // keep reading is a judgment call for Algy (comp them via the admin
        // panel, or let them re-subscribe), not something this handler
        // should decide unattended.
        const dispute = event.data.object as Stripe.Dispute;
        await sendOpsAlert(
          "alpha. dispute closed",
          `Dispute ${dispute.id} closed with status "${dispute.status}". Access was revoked when it opened and is NOT automatically restored -- if this was won and the customer should keep reading, comp them via the admin panel or have them re-subscribe.`,
          `alpha-dispute-closed-${dispute.id}`
        );
        break;
      }
      case "charge.refunded": {
        // Visibility only, deliberately -- unlike a dispute, a refund alone
        // is ambiguous: it could be Algy's own "we'll make it right"
        // goodwill gesture (terms page's own promise) while deliberately
        // KEEPING the subscriber, or it could be a real cancellation that
        // should also end access. Auto-cancelling here would break the
        // goodwill-refund case; auto-ignoring it would repeat
        // alpha-drift-r14-01's own mistake for a different event. Alerting
        // (mirrors invoice.payment_failed's own no-throw pattern) puts the
        // decision where it belongs -- a human who knows which case this is.
        const charge = event.data.object as Stripe.Charge;
        const customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id ?? null;
        const full = charge.amount_refunded >= charge.amount;
        await sendOpsAlert(
          "alpha. charge refunded",
          `Charge ${charge.id} refunded (${full ? "full" : "partial"}: $${(charge.amount_refunded / 100).toFixed(2)} of $${(charge.amount / 100).toFixed(2)})${customerId ? ` for customer ${customerId}` : ""}. Access was NOT automatically revoked -- a refund alone doesn't cancel the subscription. If this should also end their access, cancel their subscription in Stripe or via the admin panel.`,
          `alpha-refund-${charge.id}`
        );
        break;
      }
      default:
        // Ignore other event types
        break;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[stripe-webhook] handler error:", msg);
    // The dedup row above was inserted BEFORE the switch ran, marking this
    // event "seen" regardless of whether the handler actually succeeded. If
    // we don't undo that here, the retry Stripe is about to send (via the
    // 5xx below) hits the dedup guard's short-circuit on arrival and never
    // re-enters the switch at all -- silently swallowing every future retry
    // of an event whose handler never actually completed. Best-effort: a
    // failed delete here must not change the response Stripe sees (a real
    // dup-processing risk on a THIS-specific transient failure is far
    // cheaper than a permanently stranded paying customer).
    if (insertedDedupRow) {
      const { error: cleanupErr } = await sb.from("stripe_webhook_events").delete().eq("id", event.id);
      if (cleanupErr) {
        console.warn(`[stripe-webhook] failed to clear dedup row for ${event.id} after handler error -- retries of this event will be silently skipped:`, cleanupErr.message);
      }
    }
    // Return 5xx so Stripe RETRIES (webhooks are at-least-once). The handlers are
    // idempotent — checkoutUserMutation does a non-clobbering update on an existing
    // row, the welcome email is gated on isFirstSubscription (reads the pre-write
    // row), and the subscription.* paths set columns to their current value — so a
    // retry safely recovers a transient Supabase/Stripe blip instead of silently
    // losing the user-row state-write (which would strand a paid user with no
    // access). A genuinely-unprocessable event just retries ~3d then Stripe stops
    // (log noise, no harm). (#35 — audit S27)
    //
    // But "retries ~3d then stops" is also the failure mode: if it keeps failing
    // past the retry window (schema drift, an RLS change, a real bug), Stripe's
    // dashboard shows it, but nothing here is watching that dashboard, so a paying
    // customer is left with no users row / no quota / no welcome email and no one
    // finds out. event.id keys the alert so Stripe's own retries of the same event
    // don't re-page repeatedly. Best-effort: sendOpsAlert never throws.
    await sendOpsAlert(
      "alpha. webhook processing failed",
      `event ${event.id} (${event.type}): ${msg}`,
      `alpha-webhook-fail-${event.id}`
    );
    return NextResponse.json({ received: false, error: "handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
