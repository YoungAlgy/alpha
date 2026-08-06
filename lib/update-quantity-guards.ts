import type Stripe from "stripe";
import { MAX_TOPIC_QUOTA, MIN_TOPIC_QUOTA, TOPICS_PER_BUNDLE } from "@/lib/types";

// Pulled out of app/api/stripe/update-quantity/route.ts as pure functions so
// a deterministic verify script (scripts/verify-update-quantity-guards.mts)
// can exercise both decisions with stubbed inputs -- matching the pattern
// lib/checkout-guards.ts already established for checkout's own money-
// guarding logic, which this route is the only OTHER billing-quantity-
// changing route without (found in review 2026-08-06). An inverted
// Math.min/Math.max here silently over/under-bills add-on units; a broken
// status-set lookup silently 400s a real paying subscriber trying to change
// tier. Neither had any coverage beyond "grep confirms the route is CSRF-
// guarded," which proves nothing about whether either decision is correct.

export const MAX_QTY = MAX_TOPIC_QUOTA / TOPICS_PER_BUNDLE; // 5 bundles = 25 topics
export const MIN_QTY = MIN_TOPIC_QUOTA / TOPICS_PER_BUNDLE; // 1 bundle = 5 topics

/** The next bundle quantity for a direction, clamped to [MIN_QTY, MAX_QTY].
 *  A no-op (nextQuantity === currentQty) means "already at that bound" --
 *  the route's own job to turn into the right user-facing message. */
export function nextQuantity(direction: "up" | "down", currentQty: number): number {
  return direction === "up" ? Math.min(MAX_QTY, currentQty + 1) : Math.max(MIN_QTY, currentQty - 1);
}

// status:"active" ONLY misses two real, reachable states: a 100%-off
// comp/trial checkout sits in "trialing", and a subscriber whose card just
// started failing sits in "past_due" for Stripe's multi-week Smart Retry
// window during which the webhook's invoice.payment_failed handler
// deliberately keeps their access live. Both are real, hasActiveAccess()
// -passing users who'd otherwise hit a false "no subscription" error just
// for trying to change their tier. Matches lib/stripe-cancel.ts's own
// status:"all" + explicit-status-set pattern rather than a single string.
const LIVE_FOR_MANAGEMENT: ReadonlySet<Stripe.Subscription.Status> = new Set([
  "active",
  "trialing",
  "past_due",
]);

/** True if a subscription in this Stripe status should be found/manageable
 *  by the quantity-change flow (as opposed to canceled/incomplete_expired/
 *  unpaid, which correctly fall through to "no active subscription"). */
export function isLiveForManagement(status: Stripe.Subscription.Status): boolean {
  return LIVE_FOR_MANAGEMENT.has(status);
}
