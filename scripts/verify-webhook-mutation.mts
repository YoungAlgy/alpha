// Verify checkout.session.completed never clobbers subscription-owned state on
// a re-delivered / out-of-order event. The core invariant: an UPDATE to an
// existing row must never carry topic_quota or cancelled_at.
// Local-only. Loads no environment file and contacts no external system.
// Run with the repository's installed tsx executable.
const {
  checkoutUserMutation,
  isFirstSubscription,
  deriveCancelledAt,
  isTerminalSubscriptionStatus,
  subscriptionStatusGrantsAccess,
} = await import("../lib/webhook-user-mutation.ts");

const idn = {
  userId: "u-123",
  email: "sub@example.com",
  firstName: "Sam",
  city: "Tampa, FL",
  customerId: "cus_ABC",
  subscriptionId: "sub_ALPHA",
  priorBindingReplaceable: false,
  nowIso: "2026-06-02T12:00:00.000Z",
  subscriptionLive: true, // genuine new/resubscribe checkout (subscription is live)
  suppressionCleared: true, // provider-side cleanup succeeded before DB mutation
};

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
};

// (1) No row yet → full insert with base quota + cleared cancel.
const m1 = checkoutUserMutation(null, idn);
console.log("(1) no existing row → insert:");
check("kind == insert", m1.kind === "insert");
if (m1.kind === "insert") {
  check("row.topic_quota === 5", m1.row.topic_quota === 5);
  check("row.cancelled_at === null", m1.row.cancelled_at === null);
  check("row.subscribed_at set", m1.row.subscribed_at === idn.nowIso);
  check("row.stripe_customer_id linked", m1.row.stripe_customer_id === "cus_ABC");
  check("row.stripe_subscription_id linked", m1.row.stripe_subscription_id === "sub_ALPHA");
  check("row identity present", m1.row.email === idn.email && m1.row.first_name === "Sam" && m1.row.city === "Tampa, FL");
}

// (2) Existing row, not yet marked subscribed (onboarding user) → update sets
//     customer + subscribed_at, but NEVER quota; cancelled_at untouched (null).
const m2 = checkoutUserMutation({ subscribed_at: null, cancelled_at: null }, idn);
console.log("(2) existing row, subscribed_at null → update:");
check("kind == update", m2.kind === "update");
if (m2.kind === "update") {
  check("patch has stripe_customer_id", m2.patch.stripe_customer_id === "cus_ABC");
  check("patch has stripe_subscription_id", m2.patch.stripe_subscription_id === "sub_ALPHA");
  check("patch sets subscribed_at (was null)", m2.patch.subscribed_at === idn.nowIso);
  check("patch has NO topic_quota", !("topic_quota" in m2.patch));
  check("patch has NO cancelled_at (existing was null)", !("cancelled_at" in m2.patch));
}

// (3) Re-delivered checkout for an established subscriber (already subscribed,
//     cancelled_at null) → update touches ONLY stripe_customer_id.
const m3 = checkoutUserMutation({ subscribed_at: "2026-05-01T00:00:00.000Z", cancelled_at: null }, idn);
console.log("(3) re-delivered for established sub → update:");
check("kind == update", m3.kind === "update");
if (m3.kind === "update") {
  check("patch has stripe_customer_id", m3.patch.stripe_customer_id === "cus_ABC");
  check("patch has stripe_subscription_id", m3.patch.stripe_subscription_id === "sub_ALPHA");
  check("patch does NOT re-stamp subscribed_at", !("subscribed_at" in m3.patch));
  check("patch has NO topic_quota (no clobber)", !("topic_quota" in m3.patch));
  check("patch has NO cancelled_at (nothing stale to clear)", !("cancelled_at" in m3.patch));
}

// (4) Hard invariant: an update NEVER carries topic_quota, and never carries
//     cancelled_at when the existing cancellation is null/future (only a STALE
//     past cancellation is cleared — see 4d).
console.log("(4) invariant — updates never carry topic_quota; cancelled_at only when stale:");
for (const ex of [
  { subscribed_at: null, cancelled_at: null },
  { subscribed_at: "2026-05-01T00:00:00.000Z", cancelled_at: null },
]) {
  const m = checkoutUserMutation(ex, idn);
  const clean = m.kind === "update" && !("topic_quota" in m.patch) && !("cancelled_at" in m.patch);
  check(`existing ${JSON.stringify(ex)} → no topic_quota, no cancelled_at`, clean);
}

// (4d) Resubscribe after a HARD (ended) cancellation: a fresh checkout is active
//      re-consent, so a STALE past cancelled_at must be CLEARED or the cron's
//      `cancelled_at <= now` filter silently excludes the new PAYING subscriber.
//      A FUTURE cancelled_at (a live cancel-at-period-end) must be PRESERVED so a
//      stray re-delivered checkout can't erase a scheduled cancellation.
console.log("(4d) stale-cancellation clearing on resubscribe (nowIso = 2026-06-02):");
// Genuine resubscribe (subscription LIVE) + stale PAST cancelled_at → cleared.
const mPast = checkoutUserMutation(
  { subscribed_at: "2026-05-01T00:00:00.000Z", cancelled_at: "2026-05-20T00:00:00.000Z" },
  idn
);
check(
  "PAST cancelled_at + subscription LIVE (resubscribe) → patch clears it (null)",
  mPast.kind === "update" && "cancelled_at" in mPast.patch && mPast.patch.cancelled_at === null
);
// FUTURE cancelled_at (a live cancel-at-period-end) → PRESERVED even when live.
const mFuture = checkoutUserMutation(
  { subscribed_at: "2026-05-01T00:00:00.000Z", cancelled_at: "2026-12-31T00:00:00.000Z" },
  idn
);
check(
  "FUTURE cancelled_at (cancel-at-period-end) → PRESERVED (absent from patch)",
  mFuture.kind === "update" && !("cancelled_at" in mFuture.patch)
);
// Re-delivered ORIGINAL checkout for a SINCE-ENDED sub is rejected before any
// mutation, including an INSERT when the old account row has already gone.
const mRedeliver = checkoutUserMutation(
  { subscribed_at: "2026-05-01T00:00:00.000Z", cancelled_at: "2026-05-20T00:00:00.000Z" },
  { ...idn, subscriptionLive: false }
);
check(
  "subscription NOT live (redelivery) → mutation skipped (no resurrect)",
  mRedeliver.kind === "skip" && mRedeliver.reason === "subscription-not-live"
);
const mMissingRowRedeliver = checkoutUserMutation(null, { ...idn, subscriptionLive: false });
check(
  "subscription NOT live + missing row → no active INSERT",
  mMissingRowRedeliver.kind === "skip" && mMissingRowRedeliver.reason === "subscription-not-live"
);

const mLiveBindingConflict = checkoutUserMutation(
  {
    subscribed_at: "2026-05-01T00:00:00.000Z",
    cancelled_at: null,
    stripe_subscription_id: "sub_OTHER_LIVE",
  },
  idn
);
check(
  "different still-live exact subscription binding → mutation skipped",
  mLiveBindingConflict.kind === "skip" &&
    mLiveBindingConflict.reason === "subscription-binding-conflict"
);
const mEndedBindingReplacement = checkoutUserMutation(
  {
    subscribed_at: "2026-05-01T00:00:00.000Z",
    cancelled_at: "2026-07-20T00:00:00.000Z",
    stripe_subscription_id: "sub_OLD_ENDED",
  },
  { ...idn, priorBindingReplaceable: true }
);
check(
  "fresh Stripe proof that the prior binding ended → verified new checkout replaces it",
  mEndedBindingReplacement.kind === "update" &&
    mEndedBindingReplacement.patch.stripe_subscription_id === "sub_ALPHA" &&
    mEndedBindingReplacement.patch.cancelled_at === null
);
const mStaleCancellationAlone = checkoutUserMutation(
  {
    subscribed_at: "2026-05-01T00:00:00.000Z",
    cancelled_at: "2026-05-20T00:00:00.000Z",
    stripe_subscription_id: "sub_UNVERIFIED_OLD",
  },
  idn
);
check(
  "stale local cancelled_at without fresh Stripe proof → binding stays blocked",
  mStaleCancellationAlone.kind === "skip" &&
    mStaleCancellationAlone.reason === "subscription-binding-conflict"
);

// (4c) Re-subscribe after one-click unsubscribe: checkout must CLEAR
//      unsubscribed_at (no subscription.* event owns it) or the cron skips a
//      PAYING subscriber forever.
console.log("(4c) unsubscribed_at clearing:");
for (const ex of [
  { subscribed_at: null, cancelled_at: null },
  { subscribed_at: "2026-05-01T00:00:00.000Z", cancelled_at: null },
]) {
  const m = checkoutUserMutation(ex, idn);
  check(
    `existing subscribed_at=${JSON.stringify(ex.subscribed_at)} → patch clears unsubscribed_at`,
    m.kind === "update" && "unsubscribed_at" in m.patch && m.patch.unsubscribed_at === null
  );
}

// (4b) Welcome-email gate: fires only on the FIRST subscription, so a
//      re-delivered / out-of-order checkout doesn't email an existing sub again.
console.log("(4b) isFirstSubscription gate:");
check("no row yet → first subscription (send welcome)", isFirstSubscription(null) === true);
check("row exists, not yet subscribed → first subscription", isFirstSubscription({ subscribed_at: null }) === true);
check("row already subscribed → NOT first (no resend)", isFirstSubscription({ subscribed_at: "2026-05-01T00:00:00.000Z" }) === false);

// (6) deriveCancelledAt — round 15 finding #2 (alpha-drift-r15-02): the
//     bug this replaced gated cancel_at behind cancel_at_period_end being
//     true, so a subscription scheduled to cancel on an ARBITRARY future
//     date (cancel_at set, cancel_at_period_end false) silently resolved to
//     null instead of the real end date.
console.log("(6) deriveCancelledAt:");
const NOW = "2026-06-02T12:00:00.000Z";
check(
  "active, no cancel_at → null (no scheduled cancellation)",
  deriveCancelledAt("active", null, NOW) === null
);
check(
  "active, cancel_at_period_end-style future cancel_at → that date",
  deriveCancelledAt("active", 1798800000, NOW) === new Date(1798800000 * 1000).toISOString()
);
// The actual bug: cancel_at set WITHOUT cancel_at_period_end (Dashboard's
// "cancel on a specific date", or the API's cancel_at param used alone) --
// deriveCancelledAt takes only status + cancel_at now, so this is
// structurally identical to the case above; the fix is that the caller no
// longer has a cancel_at_period_end gate to accidentally apply.
check(
  "arbitrary scheduled cancel_at (not tied to period end) → that date, NOT null",
  deriveCancelledAt("active", 1798800000, NOW) !== null
);
check(
  "cancel_at = 0 (Stripe's unset sentinel) → null",
  deriveCancelledAt("active", 0, NOW) === null
);
check(
  "canceled status → now, even with no cancel_at",
  deriveCancelledAt("canceled", null, NOW) === NOW
);
check(
  "incomplete_expired status → now",
  deriveCancelledAt("incomplete_expired", null, NOW) === NOW
);
check(
  "unpaid status → now",
  deriveCancelledAt("unpaid", null, NOW) === NOW
);
check(
  "unpaid revokes access but remains revivable for billing identity",
  !subscriptionStatusGrantsAccess("unpaid") &&
    !isTerminalSubscriptionStatus("unpaid")
);
for (const status of ["incomplete", "paused"] as const) {
  check(
    `${status} revokes access but keeps the exact billing reservation`,
    deriveCancelledAt(status, null, NOW) === NOW &&
      !subscriptionStatusGrantsAccess(status) &&
      !isTerminalSubscriptionStatus(status)
  );
}
for (const status of ["active", "trialing", "past_due"] as const) {
  check(
    `${status} remains an access-granting billing status`,
    subscriptionStatusGrantsAccess(status)
  );
}
check(
  "terminal status wins even if a stale future cancel_at is also present",
  deriveCancelledAt("canceled", 9999999999, NOW) === NOW
);
check(
  "trialing (non-terminal, non-cancelling) → null",
  deriveCancelledAt("trialing", null, NOW) === null
);

// (11) generic cleanup callers may clear bounce/complaint only after provider
// success, while paid checkout explicitly preserves all suppression state.
console.log("(11) suppression state changes require verified cleanup or explicit preservation:");
const mSuppressionClear = checkoutUserMutation(
  { subscribed_at: "2026-05-01T00:00:00.000Z", cancelled_at: null },
  idn
);
check(
  "verified-live + provider cleanup succeeded → patch clears bounced_at",
  mSuppressionClear.kind === "update" && mSuppressionClear.patch.bounced_at === null
);
check(
  "verified-live + provider cleanup succeeded → patch clears complained_at",
  mSuppressionClear.kind === "update" && mSuppressionClear.patch.complained_at === null
);
const mSuppressionFailed = checkoutUserMutation(
  { subscribed_at: "2026-05-01T00:00:00.000Z", cancelled_at: null },
  { ...idn, suppressionCleared: false }
);
check(
  "provider cleanup failed → access persists behind a delivery block",
  mSuppressionFailed.kind === "update" &&
    mSuppressionFailed.patch.suppression_cleanup_pending_at === idn.nowIso &&
    !("bounced_at" in mSuppressionFailed.patch) &&
    !("complained_at" in mSuppressionFailed.patch)
);
const mCheckoutPreservesSuppression = checkoutUserMutation(
  {
    subscribed_at: "2026-05-01T00:00:00.000Z",
    cancelled_at: null,
    unsubscribed_at: "2026-05-01T00:00:00.000Z",
    bounced_at: "2026-05-02T00:00:00.000Z",
    complained_at: "2026-05-03T00:00:00.000Z",
    suppression_cleanup_pending_at: "2026-05-04T00:00:00.000Z",
    delivery_suppression_cleared_at: "2026-05-05T00:00:00.000Z",
  },
  {
    ...idn,
    checkoutStartedAtIso: "2026-06-01T00:00:00.000Z",
    suppressionCleared: false,
    preserveSuppressionState: true,
  }
);
check(
  "paid checkout preserves provider suppression evidence, pending marker, and causal watermark",
  mCheckoutPreservesSuppression.kind === "update" &&
    !("bounced_at" in mCheckoutPreservesSuppression.patch) &&
    !("complained_at" in mCheckoutPreservesSuppression.patch) &&
    !("suppression_cleanup_pending_at" in mCheckoutPreservesSuppression.patch) &&
    !("delivery_suppression_cleared_at" in mCheckoutPreservesSuppression.patch)
);
check(
  "paid checkout still clears an older explicit unsubscribe as re-consent",
  mCheckoutPreservesSuppression.kind === "update" &&
    mCheckoutPreservesSuppression.patch.unsubscribed_at === null
);
// Insert path (brand-new row) starts clean by construction -- no suppression
// columns to clear, but confirm the row itself has no stray suppression value.
{
  const m = checkoutUserMutation(null, {
    ...idn,
    preserveSuppressionState: true,
  });
  check(
    "paid checkout insert path creates no new suppression-pending marker",
    m.kind === "insert" &&
      !("bounced_at" in m.row) &&
      !("complained_at" in m.row) &&
      m.row.suppression_cleanup_pending_at === null
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("WEBHOOK MUTATION VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL WEBHOOK MUTATION ASSERTIONS PASS");
