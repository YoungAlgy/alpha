import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripeClient } from "./stripe";

// Cancel every still-billable subscription for a Stripe customer. Used by the
// account-deletion flow: when a user deletes their account we delete the auth
// user (cascading away public.users, incl. their stripe_customer_id) — so we
// MUST cancel their Stripe subscription first, or they keep getting billed
// with no account left to manage it from.
//
// Best-effort + idempotent: already-terminal subscriptions are skipped, and a
// failure on one sub doesn't stop the others. Cancels IMMEDIATELY (the account
// is going away — there's no period left to honor). Returns what it did so the
// caller can log it.
const TERMINAL: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

export async function cancelCustomerSubscriptions(
  stripe: Stripe,
  customerId: string
): Promise<{ cancelled: string[]; skipped: number; errors: number }> {
  const cancelled: string[] = [];
  let skipped = 0;
  let errors = 0;

  // status: "all" so we see active, trialing, past_due, unpaid, paused, and
  // incomplete — anything that could still bill or be resurrected.
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });

  // Fire all cancels in parallel rather than one-at-a-time -- serially
  // awaiting each call means N subscriptions can inherit N x the SDK's
  // worst-case latency, blocking the account-deletion flow that awaits us.
  const toCancel = subs.data.filter((sub) => {
    if (TERMINAL.has(sub.status)) {
      skipped++;
      return false;
    }
    return true;
  });

  const results = await Promise.allSettled(
    toCancel.map((sub) => stripe.subscriptions.cancel(sub.id))
  );
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      cancelled.push(toCancel[i].id);
    } else {
      errors++;
    }
  });

  return { cancelled, skipped, errors };
}

// Shared entry point for both delete flows (self-serve account/delete and
// admin/users delete): looks up the target user's stripe_customer_id, builds
// a Stripe client, and cancels their subscriptions via the function above.
// Best-effort + swallows its own errors — a Stripe hiccup must never block
// either delete flow. logPrefix distinguishes the two call sites in logs
// (e.g. "[account/delete]" vs "[admin/delete]").
//
// stripeClient is injectable (defaults to the real getStripeClient()
// singleton, resolved lazily INSIDE the body below) purely so
// scripts/verify-stripe-cancel-on-delete.mts can pass a stub — every real
// caller (account/delete, admin/users) omits it and gets the real client
// exactly as before. Deliberately NOT a `= getStripeClient()` default
// parameter value: that form evaluates at call time, before the
// stripeSecret early-return below ever runs and before this function's own
// try/catch starts, so it would call (and let a throwing) getStripeClient()
// escape uncaught in exactly the "Stripe not configured" case the early
// return exists to short-circuit -- caught in review, not live.
export async function cancelStripeSubscriptionsBeforeDelete(
  svc: SupabaseClient,
  userId: string,
  logPrefix: string,
  stripeClient?: Stripe
): Promise<void> {
  const stripeSecret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!stripeSecret) return;
  try {
    const { data: row } = await svc
      .from("users")
      .select("stripe_customer_id")
      .eq("id", userId)
      .maybeSingle();
    const customerId = row?.stripe_customer_id;
    if (!customerId) return;
    const { cancelled, skipped, errors } = await cancelCustomerSubscriptions(stripeClient ?? getStripeClient(), customerId);
    console.log(
      `${logPrefix} stripe ${customerId}: cancelled ${cancelled.length}, skipped ${skipped}, errors ${errors}`
    );
  } catch (e) {
    console.warn(
      `${logPrefix} subscription cancel failed (proceeding with delete):`,
      e instanceof Error ? e.message : e
    );
  }
}
