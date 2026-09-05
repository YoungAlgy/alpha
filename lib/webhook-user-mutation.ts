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
  subscriptionId: string;
  // Set only after the webhook freshly retrieves a different stored
  // subscription and proves it terminal, no longer Alpha, or incompatible
  // with the stored customer. Database cancellation timestamps alone are not
  // enough to authorize replacing an exact Stripe binding.
  priorBindingReplaceable: boolean;
  nowIso: string;
  // Immutable Stripe Session creation time. A replay may arrive days later,
  // so only suppression evidence older than this checkout may be cleared as
  // part of the reader's paid re-consent.
  checkoutStartedAtIso: string;
  // Whether the checkout session's subscription is LIVE right now (verified
  // against Stripe in the handler). Gates the entire mutation so a delayed
  // checkout for a since-ended subscription cannot create or reactivate access.
  subscriptionLive: boolean;
  // For callers that perform provider cleanup, local bounce/complaint flags may
  // only be cleared after it succeeds. When it has not, access is still
  // provisioned but delivery stays blocked through suppression_cleanup_pending_at.
  suppressionCleared: boolean;
  // Paid checkout deliberately does not perform provider suppression cleanup.
  // Preserve every existing local delivery-suppression field in that path,
  // while allowing the checkout to restore paid access and explicit unsubscribe
  // re-consent semantics.
  preserveSuppressionState?: boolean;
  // Immutable profile staged before redirecting to Stripe. A valid paid
  // checkout can therefore create a sendable subscriber even if the browser
  // never reaches the first-letter page.
  stagedProfile?: {
    firstName: string;
    city: string | null;
    jobBlurb: string | null;
    projectBlurb: string | null;
    funBlurb: string | null;
    birthday: string | null;
    gender: "male" | "female" | null;
    topics: string[];
    theme: string;
  };
}

export interface ExistingCheckoutUser {
  subscribed_at: string | null;
  cancelled_at: string | null;
  unsubscribed_at?: string | null;
  bounced_at?: string | null;
  complained_at?: string | null;
  suppression_cleanup_pending_at?: string | null;
  first_name?: string | null;
  city?: string | null;
  job_blurb?: string | null;
  project_blurb?: string | null;
  fun_blurb?: string | null;
  birthday?: string | null;
  gender?: string | null;
  topics?: string[] | null;
  theme?: string | null;
  stripe_subscription_id?: string | null;
}

export type UserMutation =
  | {
      kind: "skip";
      reason: "subscription-not-live" | "subscription-binding-conflict";
    }
  | { kind: "insert"; row: Record<string, unknown> }
  | { kind: "update"; patch: Record<string, unknown> };

function suppressionIsNewerThanCheckout(
  value: string | null | undefined,
  checkoutStartedAtIso: string
): boolean {
  if (!value) return false;
  const valueMs = new Date(value).getTime();
  const checkoutMs = new Date(checkoutStartedAtIso).getTime();
  // Invalid stored evidence or an invalid checkout clock must fail closed.
  return (
    !Number.isFinite(valueMs) ||
    !Number.isFinite(checkoutMs) ||
    valueMs > checkoutMs
  );
}

export function hasDeliverySuppressionAfterCheckout(
  existing: ExistingCheckoutUser | null,
  checkoutStartedAtIso: string
): boolean {
  return !!(
    existing &&
    (suppressionIsNewerThanCheckout(
      existing.unsubscribed_at,
      checkoutStartedAtIso
    ) ||
      suppressionIsNewerThanCheckout(
        existing.bounced_at,
        checkoutStartedAtIso
      ) ||
      suppressionIsNewerThanCheckout(
        existing.complained_at,
        checkoutStartedAtIso
      ))
  );
}

export function checkoutUserMutation(
  existing: ExistingCheckoutUser | null,
  id: CheckoutIdentity
): UserMutation {
  // No checkout event may create or reactivate access from an ended or
  // unverifiable subscription. This guard lives in the pure mutation helper
  // as a second line of defense behind the route's live Stripe lookup.
  if (!id.subscriptionLive) {
    return { kind: "skip", reason: "subscription-not-live" };
  }
  const replacingPriorBinding = !!(
    existing?.stripe_subscription_id &&
    existing.stripe_subscription_id !== id.subscriptionId
  );
  if (replacingPriorBinding) {
    if (!id.priorBindingReplaceable) {
      return { kind: "skip", reason: "subscription-binding-conflict" };
    }
  }
  const newerUnsubscribe = suppressionIsNewerThanCheckout(
    existing?.unsubscribed_at,
    id.checkoutStartedAtIso
  );
  const newerBounce = suppressionIsNewerThanCheckout(
    existing?.bounced_at,
    id.checkoutStartedAtIso
  );
  const newerComplaint = suppressionIsNewerThanCheckout(
    existing?.complained_at,
    id.checkoutStartedAtIso
  );
  const preserveNewerSuppression =
    newerUnsubscribe || newerBounce || newerComplaint;
  if (!existing) {
    // First contact — typically a direct-checkout user who skipped onboarding.
    // Create the full row. quota 5 = base bundle; a customer.subscription.*
    // event raises it if they bought add-ons.
    return {
      kind: "insert",
      row: {
        id: id.userId,
        email: id.email,
        first_name: id.stagedProfile?.firstName ?? id.firstName,
        city: id.stagedProfile?.city ?? id.city,
        job_blurb: id.stagedProfile?.jobBlurb ?? null,
        project_blurb: id.stagedProfile?.projectBlurb ?? null,
        fun_blurb: id.stagedProfile?.funBlurb ?? null,
        birthday: id.stagedProfile?.birthday ?? null,
        gender: id.stagedProfile?.gender ?? null,
        topics: id.stagedProfile?.topics ?? [],
        theme: id.stagedProfile?.theme ?? "forest",
        stripe_customer_id: id.customerId,
        stripe_subscription_id: id.subscriptionId,
        subscribed_at: id.nowIso,
        cancelled_at: null,
        topic_quota: 5,
        suppression_cleanup_pending_at: id.preserveSuppressionState
          ? null
          : id.suppressionCleared
            ? null
            : id.nowIso,
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
  // Bounce and complaint evidence is owned by the Resend webhook and is not
  // implicitly cleared by a paid checkout. Only a caller that has separately
  // confirmed provider cleanup may pass suppressionCleared=true. Checkout's
  // preserveSuppressionState mode leaves these fields, the pending marker, and
  // the causal watermark untouched.
  const patch: Record<string, unknown> = {
    // Auth is the canonical account identity. This also repairs the short
    // supported email-change window where auth already has the new address
    // while the public mirror still carries the old one.
    email: id.email,
    stripe_customer_id: id.customerId,
    stripe_subscription_id: id.subscriptionId,
  };
  if (!newerUnsubscribe) patch.unsubscribed_at = null;
  if (!id.preserveSuppressionState && !preserveNewerSuppression) {
    patch.suppression_cleanup_pending_at = id.suppressionCleared
      ? null
      : id.nowIso;
  }
  if (!id.preserveSuppressionState && id.suppressionCleared) {
    if (!newerBounce) patch.bounced_at = null;
    if (!newerComplaint) patch.complained_at = null;
  }
  const staged = id.stagedProfile;
  if (staged) {
    // generateLink's auth trigger usually creates a bare public.users row
    // before this lookup. Fill only fields that are still blank so a paid
    // checkout cannot remain an active subscriber with an empty topic pool,
    // while a returning reader's newer saved profile is never overwritten.
    if (!existing.first_name?.trim()) patch.first_name = staged.firstName;
    if (!existing.city?.trim() && staged.city) patch.city = staged.city;
    if (!existing.job_blurb?.trim() && staged.jobBlurb) patch.job_blurb = staged.jobBlurb;
    if (!existing.project_blurb?.trim() && staged.projectBlurb) {
      patch.project_blurb = staged.projectBlurb;
    }
    if (!existing.fun_blurb?.trim() && staged.funBlurb) patch.fun_blurb = staged.funBlurb;
    if (!existing.birthday && staged.birthday) patch.birthday = staged.birthday;
    if (!existing.gender && staged.gender) patch.gender = staged.gender;
    if (!Array.isArray(existing.topics) || existing.topics.length === 0) {
      patch.topics = staged.topics;
    }
    if (!existing.theme?.trim()) patch.theme = staged.theme;
  }
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
  if (replacingPriorBinding && id.priorBindingReplaceable) {
    // The fresh Stripe proof says this cancellation belongs to the prior exact
    // subscription. It must not carry onto the newly-paid replacement, even if
    // the old local timestamp was scheduled in the future.
    patch.cancelled_at = null;
  } else if (id.subscriptionLive && existing.cancelled_at) {
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

// What `cancelled_at` should be written as, from a customer.subscription.
// created/updated event. Pulled out of app/api/stripe/webhook/route.ts as a
// pure function (same reasoning as checkoutUserMutation above) so it can be
// exercised with stubbed Stripe statuses/timestamps without a real webhook.
//
// alpha-drift-r15-02 (found+fixed 2026-08-06): the inline version this
// replaced gated `cancel_at` behind `cancel_at_period_end` being true --
// but Stripe exposes those as two INDEPENDENT fields. A subscription
// scheduled to cancel on an arbitrary future date (the Dashboard's "cancel
// on a specific date", or the API's `cancel_at` param used without
// `cancel_at_period_end:true`) still gets a real `cancel_at`, just with
// `cancel_at_period_end` left false — that combination silently fell
// through to null (no scheduled cancellation recorded at all), so the app
// kept generating and sending real paid-API-cost letters right up to the
// real cancel_at moment with zero visibility anywhere. `cancel_at` alone is
// the correct signal for "when does access end," regardless of which flow
// set it.
//
// Only canceled and incomplete_expired are final enough to release an exact
// subscription identity. Stripe can later reopen and pay an `unpaid`
// subscription, so it must keep blocking a second checkout even though it no
// longer grants Alpha access.
// Exported on its own (not just inlined in deriveCancelledAt) because
// scripts/reconcile-stripe-vs-supabase.mts needs the same access decision.
// `incomplete`, `paused`, and `unpaid` keep their exact billing reservation
// because Stripe may later revive them, but none proves a currently paid
// Alpha entitlement. Only active, trialing, and past_due grant access.
export function isTerminalSubscriptionStatus(status: string): boolean {
  return status === "canceled" || status === "incomplete_expired";
}

export function subscriptionStatusGrantsAccess(status: string): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}

export function deriveCancelledAt(
  status: string,
  cancelAtUnixSeconds: number | null | undefined,
  nowIso: string = new Date().toISOString()
): string | null {
  if (!subscriptionStatusGrantsAccess(status)) return nowIso;
  if (typeof cancelAtUnixSeconds === "number" && cancelAtUnixSeconds > 0) {
    return new Date(cancelAtUnixSeconds * 1000).toISOString();
  }
  return null;
}
