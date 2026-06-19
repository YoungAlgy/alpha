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
  // Whether the checkout session's subscription is LIVE right now (verified
  // against Stripe in the handler). Gates the stale-cancellation clear below so
  // a re-delivered ORIGINAL checkout for a since-ended subscription can't
  // resurrect a churned reader.
  subscriptionLive: boolean;
}

export type UserMutation =
  | { kind: "insert"; row: Record<string, unknown> }
  | { kind: "update"; patch: Record<string, unknown> };

export function checkoutUserMutation(
  existing: { subscribed_at: string | null; cancelled_at: string | null } | null,
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
  // subscribed_at only if it isn't set yet, CLEAR unsubscribed_at, and clear a
  // STALE cancellation — WITHOUT clobbering topic_quota (subscription-owned) or
  // the user's own first_name / city.
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
  // cancelled_at: clear ONLY a stale (already past/now) cancellation, and ONLY
  // when the checkout's subscription is verified LIVE right now
  // (id.subscriptionLive). A fresh paid checkout for a live sub is active
  // re-consent, so a resubscribe after a HARD (ended) cancellation must not stay
  // excluded by the cron's `cancelled_at <= now` filter — otherwise the new
  // PAYING subscriber silently gets nothing, with no self-serve recovery. Two
  // guards keep this from over-clearing:
  //   - subscriptionLive: a RE-DELIVERED original checkout for a subscription
  //     that has since ENDED is not live, so its cancellation is left intact —
  //     no resurrecting a churned reader on a stray redelivery (the exact regression
  //     the old "never touch cancelled_at" rule guarded).
  //   - past/now only: a FUTURE cancelled_at (a live cancel-at-period-end) is
  //     PRESERVED, so a scheduled cancellation is never erased.
  // subscription.* events remain the authoritative mirror by customer id.
  if (id.subscriptionLive && existing.cancelled_at) {
    const endsMs = new Date(existing.cancelled_at).getTime();
    const nowMs = new Date(id.nowIso).getTime();
    if (Number.isNaN(endsMs) || endsMs <= nowMs) {
      patch.cancelled_at = null;
    }
  }
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
