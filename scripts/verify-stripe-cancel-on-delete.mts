// Verify cancelCustomerSubscriptions' logic (used by the account-deletion flow)
// against a STUBBED Stripe client — deterministic, no network, no live risk.
// (The only Stripe key in scope locally is LIVE; we never create/cancel real
// subscriptions. The real SDK method signatures are verified by `next build`
// typechecking the actual `stripe.subscriptions.cancel(...)` call.)
// Run: npx tsx scripts/verify-stripe-cancel-on-delete.mts
const { cancelCustomerSubscriptions } = await import("../lib/stripe-cancel.ts");

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("STRIPE CANCEL-ON-DELETE LOGIC VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL STRIPE CANCEL-ON-DELETE LOGIC ASSERTIONS PASS");
