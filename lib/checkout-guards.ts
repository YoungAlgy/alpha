import { isValidTopicId } from "@/lib/topics";
import { hasActiveAccess } from "@/lib/access";
import type { TopicId } from "@/lib/types";

// Pulled out of app/api/stripe/checkout/route.ts as pure functions so a
// deterministic verify script (scripts/verify-checkout-guards.mts) can
// exercise both decisions with stubbed inputs -- neither was covered by any
// verify script despite guarding real money: an inverted condition, a
// loosened topics.length check, or a broken hasActiveAccess call would
// compile clean and pass lint, surfacing only via a real double-charge
// complaint or a paying subscriber stuck unable to generate a letter.

export interface CheckoutProfileInput {
  firstName?: string;
  topics?: unknown;
}

// Profile-completeness gate. The client already redirects an incomplete
// profile back to /welcome before this endpoint is ever hit, but that's UI
// only -- a direct POST would otherwise sail straight through to a real
// Stripe session with no name and no topics. /api/generate requires the
// exact same two fields (via ProfileSchema, including the max(25) bound)
// before it will write a letter, so an unblocked checkout here would
// produce a paying subscriber who can never actually generate one. Enforce
// the same bar before the charge instead of after.
export function isProfileComplete(body: CheckoutProfileInput): boolean {
  return (
    !!body.firstName?.trim() &&
    Array.isArray(body.topics) &&
    body.topics.length > 0 &&
    body.topics.length <= 25 &&
    body.topics.every((t) => typeof t === "string" && isValidTopicId(t as TopicId))
  );
}

export interface ExistingSubscriberRow {
  subscribed_at: string | null;
  cancelled_at: string | null;
  stripe_customer_id: string | null;
}

// Double-subscription guard. Checkout creates a NEW Stripe subscription on
// every call, so an already-active subscriber who lands back on /checkout
// (a shared link, the browser back button, the /writing 402 redirect) and
// clicks Subscribe would be charged a SECOND $5/mo. Block only a real
// PAYING subscriber (has a Stripe customer + live access) -- that's the
// actual double-charge case. A COMP user (admin-granted, no
// stripe_customer_id) checking out is CONVERTING to paid, not double-paying,
// so they're let through; the webhook just links their Stripe customer onto
// the existing row. A cancelled-and-ended subscriber (cancelled_at in the
// past, hasActiveAccess false) is NOT blocked either, so they can
// resubscribe. `existing` is null for a brand-new email (no row at all) or
// when the pre-check lookup itself failed -- both correctly fall through to
// "don't block."
export function shouldBlockDoubleSubscription(existing: ExistingSubscriberRow | null): boolean {
  if (!existing) return false;
  return !!(existing.subscribed_at && existing.stripe_customer_id && hasActiveAccess(existing.cancelled_at));
}
