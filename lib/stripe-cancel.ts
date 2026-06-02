import type Stripe from "stripe";

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

  for (const sub of subs.data) {
    if (TERMINAL.has(sub.status)) {
      skipped++;
      continue;
    }
    try {
      await stripe.subscriptions.cancel(sub.id);
      cancelled.push(sub.id);
    } catch {
      errors++;
    }
  }

  return { cancelled, skipped, errors };
}
