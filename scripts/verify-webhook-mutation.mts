// Verify checkout.session.completed never clobbers subscription-owned state on
// a re-delivered / out-of-order event. The core invariant: an UPDATE to an
// existing row must never carry topic_quota or cancelled_at.
// Run: npx tsx scripts/verify-webhook-mutation.mts
import { loadEnvLocal } from "./_load-env.mts";
const { checkoutUserMutation, isFirstSubscription, deriveCancelledAt } = await import("../lib/webhook-user-mutation.ts");

const idn = {
  userId: "u-123",
  email: "sub@example.com",
  firstName: "Sam",
  city: "Tampa, FL",
  customerId: "cus_ABC",
  nowIso: "2026-06-02T12:00:00.000Z",
  subscriptionLive: true, // genuine new/resubscribe checkout (subscription is live)
};

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
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
  check("row identity present", m1.row.email === idn.email && m1.row.first_name === "Sam" && m1.row.city === "Tampa, FL");
}

// (2) Existing row, not yet marked subscribed (onboarding user) → update sets
//     customer + subscribed_at, but NEVER quota; cancelled_at untouched (null).
const m2 = checkoutUserMutation({ subscribed_at: null, cancelled_at: null }, idn);
console.log("(2) existing row, subscribed_at null → update:");
check("kind == update", m2.kind === "update");
if (m2.kind === "update") {
  check("patch has stripe_customer_id", m2.patch.stripe_customer_id === "cus_ABC");
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
// Re-delivered ORIGINAL checkout for a SINCE-ENDED sub (subscription NOT live) +
// past cancelled_at → PRESERVED (must not resurrect a churned reader).
const mRedeliver = checkoutUserMutation(
  { subscribed_at: "2026-05-01T00:00:00.000Z", cancelled_at: "2026-05-20T00:00:00.000Z" },
  { ...idn, subscriptionLive: false }
);
check(
  "PAST cancelled_at + subscription NOT live (redelivery) → PRESERVED (no resurrect)",
  mRedeliver.kind === "update" && !("cancelled_at" in mRedeliver.patch)
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

// (5) Live, READ-ONLY: against a REAL subscribed user, a re-delivered checkout
//     must resolve to a clean update (no quota/cancel clobber). Proves the
//     SELECT shape + branch hold against the actual schema. No writes.
console.log("(5) live read-only tie-in (real subscribed user):");
try {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("  -- no service creds; skipping live tie-in (pure tests already cover logic)");
  } else {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data: real } = await sb
      .from("users")
      .select("id, subscribed_at, cancelled_at")
      .not("subscribed_at", "is", null)
      .limit(1)
      .maybeSingle();
    if (!real) {
      console.log("  -- no subscribed users in DB; skipping (nothing to clobber yet)");
    } else {
      const m = checkoutUserMutation(
        { subscribed_at: real.subscribed_at, cancelled_at: real.cancelled_at },
        { ...idn, userId: real.id }
      );
      // topic_quota is the hard never-clobber invariant; cancelled_at is cleared
      // only for a stale past date, so assert just the quota invariant here.
      const clean = m.kind === "update" && !("topic_quota" in m.patch);
      check("re-delivered checkout for a real subscriber → no topic_quota clobber", clean);
    }
  }
} catch (e) {
  console.log(`  -- live tie-in skipped (${e instanceof Error ? e.message : e})`);
}

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
  "terminal status wins even if a stale future cancel_at is also present",
  deriveCancelledAt("canceled", 9999999999, NOW) === NOW
);
check(
  "trialing (non-terminal, non-cancelling) → null",
  deriveCancelledAt("trialing", null, NOW) === null
);

// (11) alpha-drift-r17-05: bounced_at/complained_at must be cleared on every
// checkout completion (paid re-consent), regardless of whether the
// subscription happens to be live right now -- unlike cancelled_at, this
// isn't a billing-access decision, so it isn't gated by subscriptionLive.
console.log("(11) bounced_at/complained_at cleared on checkout re-consent:");
for (const live of [true, false]) {
  const m = checkoutUserMutation(
    { subscribed_at: "2026-05-01T00:00:00.000Z", cancelled_at: null },
    { ...idn, subscriptionLive: live }
  );
  check(
    `subscriptionLive=${live} → patch clears bounced_at`,
    m.kind === "update" && "bounced_at" in m.patch && m.patch.bounced_at === null
  );
  check(
    `subscriptionLive=${live} → patch clears complained_at`,
    m.kind === "update" && "complained_at" in m.patch && m.patch.complained_at === null
  );
}
// Insert path (brand-new row) starts clean by construction -- no suppression
// columns to clear, but confirm the row itself has no stray suppression value.
{
  const m = checkoutUserMutation(null, idn);
  check(
    "insert path: no bounced_at/complained_at set on a fresh row",
    m.kind === "insert" && !("bounced_at" in m.row) && !("complained_at" in m.row)
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("WEBHOOK MUTATION VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL WEBHOOK MUTATION ASSERTIONS PASS");
