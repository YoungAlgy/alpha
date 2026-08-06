// Verify cancelCustomerSubscriptions' logic (used by the account-deletion flow)
// against a STUBBED Stripe client — deterministic, no network, no live risk.
// (The only Stripe key in scope locally is LIVE; we never create/cancel real
// subscriptions. The real SDK method signatures are verified by `next build`
// typechecking the actual `stripe.subscriptions.cancel(...)` call.)
//
// Also verifies cancelStripeSubscriptionsBeforeDelete -- the wrapper both
// real delete flows (account/delete, admin/users) actually call, which adds
// the Supabase stripe_customer_id lookup and swallows every error so a
// Stripe hiccup never blocks account deletion. None of that lookup/
// error-swallowing logic was covered before this: a wrong column name, a
// broken maybeSingle() chain, or an exception path that isn't actually
// caught fails silently by design (a deleted user keeps getting billed with
// the account gone), and nothing but a billing complaint would surface it.
// Run: npx tsx scripts/verify-stripe-cancel-on-delete.mts
const { cancelCustomerSubscriptions, cancelStripeSubscriptionsBeforeDelete } = await import("../lib/stripe-cancel.ts");

type Sub = { id: string; status: string };
function stub(subs: Sub[], throwOn: string[] = []) {
  const cancelledCalls: string[] = [];
  const client = {
    cancelledCalls,
    subscriptions: {
      list: async (_args: unknown) => ({ data: subs }),
      cancel: async (id: string) => {
        if (throwOn.includes(id)) throw new Error("simulated stripe failure");
        cancelledCalls.push(id);
        return { id, status: "canceled" };
      },
    },
  };
  return client;
}

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// (1) Mixed statuses: cancel every non-terminal sub, skip terminal ones.
const mixed: Sub[] = [
  { id: "sub_active", status: "active" },
  { id: "sub_trial", status: "trialing" },
  { id: "sub_pastdue", status: "past_due" },
  { id: "sub_unpaid", status: "unpaid" },
  { id: "sub_incomplete", status: "incomplete" },
  { id: "sub_paused", status: "paused" },
  { id: "sub_canceled", status: "canceled" }, // terminal → skip
  { id: "sub_incexp", status: "incomplete_expired" }, // terminal → skip
];
const s1 = stub(mixed);
const r1 = await cancelCustomerSubscriptions(s1 as never, "cus_test");
console.log(`(1) mixed → ${JSON.stringify(r1)}`);
check("cancels 6 non-terminal subs", r1.cancelled.length === 6);
check("skips 2 terminal subs", r1.skipped === 2);
check("0 errors", r1.errors === 0);
check("did NOT cancel the already-canceled sub", !r1.cancelled.includes("sub_canceled"));
check("did NOT cancel the incomplete_expired sub", !r1.cancelled.includes("sub_incexp"));
check("cancel() actually invoked for each (call log matches result)", s1.cancelledCalls.length === 6);

// (2) Error isolation: one cancel throws → counted, the rest still cancel.
const s2 = stub(
  [
    { id: "sub_a", status: "active" },
    { id: "sub_b", status: "active" },
    { id: "sub_c", status: "active" },
  ],
  ["sub_b"]
);
const r2 = await cancelCustomerSubscriptions(s2 as never, "cus_test");
console.log(`(2) one failure → ${JSON.stringify(r2)}`);
check("cancels the 2 that succeed", r2.cancelled.length === 2);
check("counts the 1 failure", r2.errors === 1);
check("a failure does not abort the loop (sub_c still cancelled)", r2.cancelled.includes("sub_c"));

// (3) No subscriptions (free / admin-granted customer) → clean no-op.
const r3 = await cancelCustomerSubscriptions(stub([]) as never, "cus_test");
console.log(`(3) no subs → ${JSON.stringify(r3)}`);
check("cancelled 0, skipped 0, errors 0", r3.cancelled.length === 0 && r3.skipped === 0 && r3.errors === 0);

// (4) All terminal → nothing cancelled, all skipped.
const r4 = await cancelCustomerSubscriptions(
  stub([
    { id: "x", status: "canceled" },
    { id: "y", status: "incomplete_expired" },
  ]) as never,
  "cus_test"
);
console.log(`(4) all terminal → ${JSON.stringify(r4)}`);
check("cancelled 0, skipped 2", r4.cancelled.length === 0 && r4.skipped === 2);

// ---- cancelStripeSubscriptionsBeforeDelete: the wrapper both real delete
// flows call, with the Supabase lookup + error-swallowing stubbed out ----

// Minimal stub of the .from("users").select(...).eq("id", userId).maybeSingle()
// chain the wrapper actually calls. Records the userId it was queried with so
// tests can confirm it looked up the RIGHT user, not just *a* user.
function supabaseStub(row: { stripe_customer_id: string | null } | null, rejectWith?: Error) {
  const queriedIds: string[] = [];
  return {
    queriedIds,
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, id: string) {
              queriedIds.push(id);
              return {
                async maybeSingle() {
                  if (rejectWith) throw rejectWith;
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

// (5) Customer id exists -> looks up the right user AND calls the Stripe
// cancel path (via the injected stub client, never the real getStripeClient()).
console.log("(5) customer id exists -- looks up the right user, calls Stripe cancel");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc5 = supabaseStub({ stripe_customer_id: "cus_delete_me" });
  const stripe5 = stub([{ id: "sub_live", status: "active" }]);
  await cancelStripeSubscriptionsBeforeDelete(svc5 as never, "user_123", "[verify]", stripe5 as never);
  check("(5) looked up exactly the requested userId", svc5.queriedIds.length === 1 && svc5.queriedIds[0] === "user_123");
  check("(5) called through to the injected Stripe client, not the real singleton", stripe5.cancelledCalls.includes("sub_live"));
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

// (6) No stripe_customer_id on the row -> clean no-op, Stripe never touched.
console.log("(6) no stripe_customer_id -- no-ops without touching Stripe");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc6 = supabaseStub({ stripe_customer_id: null });
  const stripe6 = stub([{ id: "sub_should_not_be_touched", status: "active" }]);
  await cancelStripeSubscriptionsBeforeDelete(svc6 as never, "user_456", "[verify]", stripe6 as never);
  check("(6) did not cancel anything (Stripe client never reached)", stripe6.cancelledCalls.length === 0);
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

// (7) The Supabase lookup itself rejects -- must never throw (best-effort:
// a Stripe/Supabase hiccup must never block account deletion).
console.log("(7) Supabase lookup rejects -- swallowed, does not throw");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc7 = supabaseStub(null, new Error("simulated Supabase outage"));
  const stripe7 = stub([]);
  let threw = false;
  try {
    await cancelStripeSubscriptionsBeforeDelete(svc7 as never, "user_789", "[verify]", stripe7 as never);
  } catch {
    threw = true;
  }
  check("(7) did not throw despite the Supabase rejection", !threw);
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

// (8) STRIPE_SECRET_KEY unset -- clean no-op with NO stripeClient argument at
// all (real caller shape). This is the exact regression caught in review
// while adding this test: an earlier version of the injectable-client change
// used a `= getStripeClient()` default parameter, which evaluates at call
// time -- before this function's own stripeSecret early-return and before
// its try/catch even start -- so it would have called (and let a throwing)
// getStripeClient() escape uncaught in precisely this case. Omitting the 4th
// argument here, the same way every real caller does, is what actually
// exercises that path.
console.log("(8) STRIPE_SECRET_KEY unset, no stripeClient arg -- no-ops, never calls getStripeClient()");
delete process.env.STRIPE_SECRET_KEY;
{
  const svc8 = supabaseStub({ stripe_customer_id: "cus_should_not_be_reached" });
  let threw = false;
  try {
    await cancelStripeSubscriptionsBeforeDelete(svc8 as never, "user_000", "[verify]");
  } catch {
    threw = true;
  }
  check("(8) did not throw", !threw);
  check("(8) never even reached the Supabase lookup (early return)", svc8.queriedIds.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("STRIPE CANCEL-ON-DELETE LOGIC VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL STRIPE CANCEL-ON-DELETE LOGIC ASSERTIONS PASS");
