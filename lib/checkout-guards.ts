import { isValidTopicId } from "@/lib/topics";
import { hasActiveAccess } from "@/lib/access";
import { isValidEmail } from "@/lib/validate-email";
import { MIN_TOPIC_QUOTA, type TopicId } from "@/lib/types";

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
  email?: string;
}

// Profile-completeness gate. The client already redirects an incomplete
// profile back to /welcome before this endpoint is ever hit, but that's UI
// only -- a direct POST would otherwise sail straight through to a real
// Stripe session with no name and no topics. The unsigned onboarding picker
// requires exactly the five topics included in the base subscription. Enforce
// that paid quantity boundary here before the charge.
//
// email is checked here too -- firstName+topics alone let a visitor who
// skipped straight from /topics to /checkout (direct URL, or resuming a
// days-old partial session) reach a real Stripe session with no address on
// file. Stripe's hosted checkout page happens to force an email today, but
// that's an implicit backstop this app doesn't control, not a substitute
// for the gate actually enforcing its own name. isValidEmail is the same
// check the /email step itself uses, so this can't reject an address the
// funnel already accepted.
export function isProfileComplete(body: CheckoutProfileInput): boolean {
  return (
    !!body.firstName?.trim() &&
    Array.isArray(body.topics) &&
    // Checkout always creates one base bundle. Larger pools are available only
    // after Stripe quantity has been increased through the authenticated
    // settings flow. A direct POST must not buy one bundle and stage 25 topics.
    body.topics.length === MIN_TOPIC_QUOTA &&
    new Set(body.topics).size === body.topics.length &&
    body.topics.every((t) => typeof t === "string" && isValidTopicId(t as TopicId)) &&
    !!body.email &&
    isValidEmail(body.email)
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
// resubscribe. `existing` is null only for a confirmed brand-new email. The
// route now handles lookup errors separately and fails checkout closed.
export function shouldBlockDoubleSubscription(existing: ExistingSubscriberRow | null): boolean {
  if (!existing) return false;
  return !!(existing.subscribed_at && existing.stripe_customer_id && hasActiveAccess(existing.cancelled_at));
}
