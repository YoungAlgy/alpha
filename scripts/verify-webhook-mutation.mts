// Verify checkout.session.completed never clobbers subscription-owned state on
// a re-delivered / out-of-order event. The core invariant: an UPDATE to an
// existing row must never carry topic_quota or cancelled_at.
// Run: npx tsx scripts/verify-webhook-mutation.mts
const { checkoutUserMutation, isFirstSubscription } = await import("../lib/webhook-user-mutation.ts");

const idn = {
  userId: "u-123",
  email: "sub@example.com",
  firstName: "Sam",
  city: "Tampa, FL",
  customerId: "cus_ABC",
  nowIso: "2026-06-02T12:00:00.000Z",
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
//     customer + subscribed_at, but NEVER quota/cancelled_at.
const m2 = checkoutUserMutation({ subscribed_at: null }, idn);
console.log("(2) existing row, subscribed_at null → update:");
check("kind == update", m2.kind === "update");
if (m2.kind === "update") {
  check("patch has stripe_customer_id", m2.patch.stripe_customer_id === "cus_ABC");
  check("patch sets subscribed_at (was null)", m2.patch.subscribed_at === idn.nowIso);
  check("patch has NO topic_quota", !("topic_quota" in m2.patch));
  check("patch has NO cancelled_at", !("cancelled_at" in m2.patch));
}

// (3) Re-delivered checkout for an established subscriber (already subscribed,
//     maybe upgraded/cancelled) → update touches ONLY stripe_customer_id.
const m3 = checkoutUserMutation({ subscribed_at: "2026-05-01T00:00:00.000Z" }, idn);
console.log("(3) re-delivered for established sub → update:");
check("kind == update", m3.kind === "update");
if (m3.kind === "update") {
  check("patch has stripe_customer_id", m3.patch.stripe_customer_id === "cus_ABC");
  check("patch does NOT re-stamp subscribed_at", !("subscribed_at" in m3.patch));
  check("patch has NO topic_quota (no clobber)", !("topic_quota" in m3.patch));
  check("patch has NO cancelled_at (no un-cancel)", !("cancelled_at" in m3.patch));
}

// (4) Hard invariant across every update path: never the two clobber columns.
console.log("(4) invariant — updates never carry the clobber columns:");
for (const ex of [{ subscribed_at: null }, { subscribed_at: "2026-05-01T00:00:00.000Z" }]) {
  const m = checkoutUserMutation(ex, idn);
  const clean = m.kind === "update" && !("topic_quota" in m.patch) && !("cancelled_at" in m.patch);
  check(`existing subscribed_at=${JSON.stringify(ex.subscribed_at)} → clean update`, clean);
}

// (4c) Re-subscribe after one-click unsubscribe: checkout must CLEAR
//      unsubscribed_at (no subscription.* event owns it) or the cron skips a
//      PAYING subscriber forever.
console.log("(4c) unsubscribed_at clearing:");
for (const ex of [{ subscribed_at: null }, { subscribed_at: "2026-05-01T00:00:00.000Z" }]) {
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
  const { readFileSync } = await import("node:fs");
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("  -- no service creds; skipping live tie-in (pure tests already cover logic)");
  } else {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data: real } = await sb
      .from("users")
      .select("id, subscribed_at")
      .not("subscribed_at", "is", null)
      .limit(1)
      .maybeSingle();
    if (!real) {
      console.log("  -- no subscribed users in DB; skipping (nothing to clobber yet)");
    } else {
      const m = checkoutUserMutation({ subscribed_at: real.subscribed_at }, { ...idn, userId: real.id });
      const clean = m.kind === "update" && !("topic_quota" in m.patch) && !("cancelled_at" in m.patch);
      check("re-delivered checkout for a real subscriber → clean non-clobbering update", clean);
    }
  }
} catch (e) {
  console.log(`  -- live tie-in skipped (${e instanceof Error ? e.message : e})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("WEBHOOK MUTATION VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL WEBHOOK MUTATION ASSERTIONS PASS");
