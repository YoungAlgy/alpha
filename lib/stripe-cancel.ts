import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { STRIPE_PRICE_ID, getStripeClient, describeStripeError } from "./stripe";
import { sendOpsAlert } from "./email";

// Cancel every still-billable, exact Alpha subscription for a Stripe customer.
// Used by the account-deletion flow: when a user deletes their account we
// delete the auth user and must stop Alpha billing without touching a different
// product that may share the same Stripe Customer.
//
// Best-effort + idempotent: already-terminal subscriptions are skipped, and a
// failure on one sub doesn't stop the others. Cancels IMMEDIATELY (the account
// is going away — there's no period left to honor). Returns what it did so the
// caller can log it.
const TERMINAL: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

export async function cancelCustomerSubscriptions(
  stripe: Stripe,
  customerId: string
): Promise<{
  cancelled: string[];
  skipped: number;
  errors: number;
  hasNonAlphaSubscriptions: boolean;
}> {
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

  // Account deletion may run on a Stripe Customer that is shared with a
  // different product. Inspect the complete result before making any change.
  // If Stripe paginates, or if a subscription containing the Alpha price has
  // an unexpected shape, we cannot prove which object is safe to cancel.
  if (subs.has_more || !Array.isArray(subs.data)) {
    throw new Error("cannot safely isolate Alpha subscriptions from a paginated or malformed Stripe result");
  }

  let hasNonAlphaSubscriptions = false;
  const alphaSubscriptions: Stripe.Subscription[] = [];
  for (const sub of subs.data) {
    if (!sub.items || sub.items.has_more || !Array.isArray(sub.items.data)) {
      throw new Error(`cannot safely inspect all items for Stripe subscription ${sub.id}`);
    }

    const alphaItems = sub.items.data.filter((item) => {
      const priceId = typeof item.price === "string" ? item.price : item.price?.id;
      return priceId === STRIPE_PRICE_ID;
    });

    if (alphaItems.length === 0) {
      hasNonAlphaSubscriptions = true;
      continue;
    }

    const item = alphaItems[0];
    const quantity = item.quantity;
    if (
      sub.items.data.length !== 1 ||
      alphaItems.length !== 1 ||
      !Number.isInteger(quantity) ||
      (quantity as number) < 1 ||
      (quantity as number) > 5
    ) {
      throw new Error(`Stripe subscription ${sub.id} contains Alpha in an invalid or mixed line-item shape`);
    }
    alphaSubscriptions.push(sub);
  }

  // Fire exact Alpha cancels in parallel rather than one-at-a-time -- serially
  // awaiting each call means N subscriptions can inherit N x the SDK's
  // worst-case latency, blocking the account-deletion flow that awaits us.
  const toCancel = alphaSubscriptions.filter((sub) => {
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

  return { cancelled, skipped, errors, hasNonAlphaSubscriptions };
}

// Shared entry point for both delete flows (self-serve account/delete and
// admin/users delete): looks up the target user's stripe_customer_id, builds
// a Stripe client, and cancels exact Alpha subscriptions via the function
// above. Alpha never deletes the account-wide Stripe Customer object. A
// subscription list cannot prove that another product is not using that same
// Customer for one-time charges, invoices, or saved payment methods.
//
// alpha-drift-r20-01 (found+fixed 2026-08-13): this function used to stop at
// cancelling subscriptions -- it never called stripe.customers.del(). The
// Customer record (name, email, billing address, and typically a saved
// default payment method, since Checkout runs in subscription mode) then
// survived account deletion at Stripe indefinitely, directly contradicting
// app/privacy/page.tsx's "Delete your account and all associated data
// (irreversible)" promise. customers.del() is Stripe's own supported
// "delete this customer" operation: it detaches payment methods and makes
// the Customer record itself unretrievable, while (by Stripe's own design)
// past Charges/Invoices remain under the now-orphaned id for the legally
// required accounting trail -- the same "delete the profile, keep what
// compliance requires" balance this app already strikes for support_tickets
// (see deleteSupportTicketsBeforeDelete below). Renamed from
// cancelStripeSubscriptionsBeforeDelete to reflect the now-larger scope.
//
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
//
// preFetchedCustomerId (alpha-drift-r24-06, 2026-08-14): optional escape
// hatch for a caller that already has stripe_customer_id from a query it ran
// for its own reasons -- app/api/admin/users/route.ts's delete branch was
// separately selecting "email" (for the Resend suppression cleanup below)
// and this function was independently re-selecting stripe_customer_id for
// the SAME row on the SAME request, two queries where one would do.
// account/delete/route.ts still omits this param and gets the original
// self-contained lookup: it never needed stripe_customer_id for anything
// else, so there's nothing for it to pre-fetch. `=== undefined` (not a
// falsy check) distinguishes "caller didn't pass this, do the lookup" from
// "caller passed null, meaning their query found no stripe_customer_id" --
// collapsing those would turn a legitimate no-Stripe-customer signal back
// into a redundant lookup.
export async function cleanUpStripeCustomerBeforeDelete(
  svc: SupabaseClient,
  userId: string,
  logPrefix: string,
  stripeClient?: Stripe,
  preFetchedCustomerId?: string | null
): Promise<void> {
  const stripeSecret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!stripeSecret) return;
  try {
    let customerId = preFetchedCustomerId;
    if (customerId === undefined) {
      // alpha-drift-r60-06 (2026-08-20, silent-catch-audit-r6): `error` used
      // to be discarded entirely. This branch only runs when the caller's
      // OWN pre-fetch already failed (that's what makes preFetchedCustomerId
      // undefined in the first place) -- so a failure here is a SECOND
      // consecutive DB failure on the same request, and by this point in
      // account/delete/route.ts the auth user has already been irreversibly
      // deleted. Silently returning below with no trace would leave an
      // active Stripe subscription billing an account that no longer
      // exists, with nothing anywhere pointing at why. Logged and paged --
      // this is the one failure mode on this best-effort path a human
      // actually needs to know about, since there's no later reconciliation
      // pass that would ever catch it.
      const { data: row, error: rowErr } = await svc
        .from("users")
        .select("stripe_customer_id")
        .eq("id", userId)
        .maybeSingle();
      if (rowErr) {
        console.warn(`${logPrefix} stripe_customer_id re-lookup failed, cannot verify/cancel any Stripe subscription:`, rowErr.message);
        await sendOpsAlert(
          "alpha: possible orphaned Stripe subscription after account delete",
          `${logPrefix} user ${userId}'s account was deleted, but BOTH attempts to look up their stripe_customer_id failed (the caller's own pre-fetch, then this internal retry) -- error: ${rowErr.message}. If they had an active subscription, it may still be billing with no account left to manage it. Worth checking Stripe directly for this user's email/customer record.`
        ).catch(() => {});
      }
      customerId = row?.stripe_customer_id;
    }
    if (!customerId) return;
    const stripe = stripeClient ?? getStripeClient();
    // First prove which subscriptions belong to Alpha. A list failure,
    // pagination, or invalid Alpha line shape makes every mutation unsafe.
    let cancelFailed = false;
    let cancellationInspected = false;
    let hasNonAlphaSubscriptions = false;
    try {
      const result = await cancelCustomerSubscriptions(stripe, customerId);
      const { cancelled, skipped, errors } = result;
      cancellationInspected = true;
      hasNonAlphaSubscriptions = result.hasNonAlphaSubscriptions;
      cancelFailed = errors > 0;
      console.log(
        `${logPrefix} stripe ${customerId}: cancelled ${cancelled.length} Alpha subscriptions, skipped ${skipped}, errors ${errors}, other products ${hasNonAlphaSubscriptions ? "present" : "absent"}`
      );
    } catch (cancelErr) {
      cancelFailed = true;
      console.warn(
        `${logPrefix} stripe ${customerId}: could not safely isolate Alpha subscriptions, preserving the Stripe Customer:`,
        describeStripeError(cancelErr)
      );
    }

    if (!cancellationInspected || cancelFailed) {
      await sendOpsAlert(
        "alpha: possible orphaned Stripe subscription after account delete",
        `${logPrefix} user ${userId}'s account deletion could not fully confirm exact Alpha subscription cleanup for Stripe customer ${customerId}. The account-wide Customer was preserved. Check the exact Alpha subscription directly.`
      ).catch(() => {});
    }
    if (hasNonAlphaSubscriptions) {
      console.log(
        `${logPrefix} stripe ${customerId}: another product subscription is attached`
      );
    }
    console.log(
      `${logPrefix} stripe ${customerId}: customer object preserved; Alpha does not delete account-wide Stripe Customers automatically`
    );
  } catch (e) {
    console.warn(`${logPrefix} subscription cancel failed (proceeding with delete):`, describeStripeError(e));
  }
}

// Shared entry point for both delete flows, same reasoning as
// cleanUpStripeCustomerBeforeDelete above: support_tickets.user_id is ON
// DELETE SET NULL, not CASCADE, so deleting the auth user alone would just
// null out user_id and leave the ticket's name/email/message text sitting in
// the table with nothing tying it back to an account -- orphaned PII, not
// removed data. The self-serve account/delete route had this fix; the admin
// delete path (app/api/admin/users/route.ts) never did, leaving admin-
// initiated deletes silently short of the "all associated data" promise on
// the privacy page. Best-effort + swallows its own errors, same as the
// Stripe step: a failure here must never block either delete flow.
//
// alpha-drift-r28-08 (2026-08-15): user_id-only deletion has always missed
// a real, genuinely-identifiable population -- app/api/support/route.ts
// only attaches user_id when the submitter happens to be signed in at the
// moment they file a ticket; a ticket filed signed-out (using the same
// email later used to sign up), or anything filed before the 2026-08-06
// user_id fix, has user_id permanently NULL and was never linked to any
// account. app/api/account/export/route.ts's own comment already flagged
// this exact gap for the export side; the delete side had the identical
// gap with nobody having named it. `email`, when the caller has it, deletes
// those specific orphaned rows too -- scoped to `user_id is null` so this
// can NEVER touch another real account's own already-linked tickets, even
// in the (shouldn't-happen, given email uniqueness) case they share an
// email. Case-insensitive (support_tickets.email is stored exactly as
// typed, no normalization on insert) via ilike on a wildcard-escaped value
// (% and _ are ILIKE metacharacters -- escaped so a literal one in a real
// email can't be misread as a pattern).
export async function deleteSupportTicketsBeforeDelete(
  svc: SupabaseClient,
  userId: string,
  logPrefix: string,
  email?: string | null
): Promise<void> {
  const { error } = await svc.from("support_tickets").delete().eq("user_id", userId);
  if (error) {
    console.error(`${logPrefix} failed to delete support_tickets:`, error.message);
  }
  if (email) {
    const escapedEmail = email.replace(/[\\%_]/g, "\\$&");
    const { error: orphanErr } = await svc
      .from("support_tickets")
      .delete()
      .is("user_id", null)
      .ilike("email", escapedEmail);
    if (orphanErr) {
      console.error(`${logPrefix} failed to delete orphaned (signed-out) support_tickets:`, orphanErr.message);
    }
  }
}
