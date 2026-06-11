// How checkout.session.completed should write the public.users row.
//
// Stripe delivers webhooks at-least-once and NOT necessarily in order, so the
// same checkout.session.completed can arrive again after a subscriber has
// upgraded (topic_quota raised by a customer.subscription.updated event) or
// cancelled. The previous handler did a blind `upsert(... onConflict: id)` with
// `topic_quota: 5, cancelled_at: null, subscribed_at: now` — so a re-delivered
// or out-of-order event RESET an upgraded subscriber back to 5 topics and
// un-cancelled them. That's silent billing/value corruption.
//
// Rule: checkout owns only identity + "is subscribed" + the Stripe customer
// link. topic_quota and cancelled_at are owned by customer.subscription.*
// events and must never be touched on a row that already exists. This decision
// is pure so it can be unit-tested without Stripe or Supabase.

export interface CheckoutIdentity {
  userId: string;
  email: string;
  firstName: string;
  city: string | null;
  customerId: string | null;
  nowIso: string;
}

export type UserMutation =
  | { kind: "insert"; row: Record<string, unknown> }
  | { kind: "update"; patch: Record<string, unknown> };

export function checkoutUserMutation(
  existing: { subscribed_at: string | null } | null,
  id: CheckoutIdentity
): UserMutation {
  if (!existing) {
    // First contact — typically a direct-checkout user who skipped onboarding.
    // Create the full row. quota 5 = base bundle; a customer.subscription.*
    // event raises it if they bought add-ons.
    return {
      kind: "insert",
      row: {
        id: id.userId,
        email: id.email,
        first_name: id.firstName,
        city: id.city,
        stripe_customer_id: id.customerId,
        subscribed_at: id.nowIso,
        cancelled_at: null,
        topic_quota: 5,
      },
    };
  }
  // Row already exists (an onboarding user whose row was created during the
  // funnel, OR a re-delivered / out-of-order checkout event). Affirm only what
  // checkout is authoritative for — link the Stripe customer, mark
  // subscribed_at only if it isn't set yet, and CLEAR unsubscribed_at —
  // WITHOUT clobbering topic_quota / cancelled_at (subscription-owned) or the
  // user's own first_name / city.
  //
  // unsubscribed_at: paying at checkout is explicit re-consent to receive the
  // letters (the letters ARE the product). No subscription.* event owns this
  // column, so if checkout doesn't clear it, a previously-unsubscribed user
  // who pays again is silently skipped by the weekly cron forever — a paying
  // subscriber receiving nothing.
  const patch: Record<string, unknown> = {
    stripe_customer_id: id.customerId,
    unsubscribed_at: null,
  };
  if (!existing.subscribed_at) patch.subscribed_at = id.nowIso;
  return { kind: "update", patch };
}

// True only the FIRST time a customer subscribes — i.e. no row yet, or a row
// that wasn't marked subscribed. Used to gate the one-time welcome email so a
// re-delivered / out-of-order checkout.session.completed (Stripe is
// at-least-once) doesn't email an established subscriber again.
export function isFirstSubscription(
  existing: { subscribed_at: string | null } | null
): boolean {
  return !existing?.subscribed_at;
}
