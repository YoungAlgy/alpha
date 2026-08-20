// Verify cancelCustomerSubscriptions' logic (used by the account-deletion flow)
// against a STUBBED Stripe client — deterministic, no network, no live risk.
// (The only Stripe key in scope locally is LIVE; we never create/cancel real
// subscriptions. The real SDK method signatures are verified by `next build`
// typechecking the actual `stripe.subscriptions.cancel(...)` call.)
//
// Also verifies cleanUpStripeCustomerBeforeDelete -- the wrapper both real
// delete flows (account/delete, admin/users) actually call, which adds the
// Supabase stripe_customer_id lookup, cancels subscriptions, THEN deletes
// the Customer object itself (alpha-drift-r20-01, 2026-08-13 -- the function
// used to stop at cancelling subscriptions, leaving the Customer record,
// including a typically-saved default payment method, retrievable at Stripe
// forever after account deletion), and swallows every error so a Stripe
// hiccup never blocks account deletion. None of that lookup/error-swallowing
// logic was covered before this: a wrong column name, a broken maybeSingle()
// chain, or an exception path that isn't actually caught fails silently by
// design, and nothing but a billing complaint (or, for the customer-delete
// step, a privacy complaint) would surface it.
// Run: npx tsx scripts/verify-stripe-cancel-on-delete.mts
const { cancelCustomerSubscriptions, cleanUpStripeCustomerBeforeDelete } = await import("../lib/stripe-cancel.ts");

type Sub = { id: string; status: string };
function stub(subs: Sub[], throwOn: string[] = [], customerDelThrows = false, listThrows = false) {
  const cancelledCalls: string[] = [];
  const customerDelCalls: string[] = [];
  const client = {
    cancelledCalls,
    customerDelCalls,
    subscriptions: {
      list: async (_args: unknown) => {
        if (listThrows) throw new Error("simulated stripe list failure");
        return { data: subs };
      },
      cancel: async (id: string) => {
        if (throwOn.includes(id)) throw new Error("simulated stripe failure");
        cancelledCalls.push(id);
        return { id, status: "canceled" };
      },
    },
    customers: {
      del: async (id: string) => {
        if (customerDelThrows) throw new Error("No such customer: simulated already-deleted");
        customerDelCalls.push(id);
        return { id, deleted: true };
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

// ---- cleanUpStripeCustomerBeforeDelete: the wrapper both real delete
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

// (5) Customer id exists -> looks up the right user, cancels subscriptions,
// AND deletes the Customer object (via the injected stub client, never the
// real getStripeClient()).
console.log("(5) customer id exists -- looks up the right user, cancels subs, deletes the Customer object");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc5 = supabaseStub({ stripe_customer_id: "cus_delete_me" });
  const stripe5 = stub([{ id: "sub_live", status: "active" }]);
  await cleanUpStripeCustomerBeforeDelete(svc5 as never, "user_123", "[verify]", stripe5 as never);
  check("(5) looked up exactly the requested userId", svc5.queriedIds.length === 1 && svc5.queriedIds[0] === "user_123");
  check("(5) called through to the injected Stripe client, not the real singleton", stripe5.cancelledCalls.includes("sub_live"));
  check("(5) alpha-drift-r20-01: also deletes the Customer object itself, not just its subscriptions", stripe5.customerDelCalls.includes("cus_delete_me"));
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

// (6) No stripe_customer_id on the row -> clean no-op, Stripe never touched.
console.log("(6) no stripe_customer_id -- no-ops without touching Stripe");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc6 = supabaseStub({ stripe_customer_id: null });
  const stripe6 = stub([{ id: "sub_should_not_be_touched", status: "active" }]);
  await cleanUpStripeCustomerBeforeDelete(svc6 as never, "user_456", "[verify]", stripe6 as never);
  check("(6) did not cancel anything (Stripe client never reached)", stripe6.cancelledCalls.length === 0);
  check("(6) did not attempt a customer delete either", stripe6.customerDelCalls.length === 0);
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
    await cleanUpStripeCustomerBeforeDelete(svc7 as never, "user_789", "[verify]", stripe7 as never);
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
    await cleanUpStripeCustomerBeforeDelete(svc8 as never, "user_000", "[verify]");
  } catch {
    threw = true;
  }
  check("(8) did not throw", !threw);
  check("(8) never even reached the Supabase lookup (early return)", svc8.queriedIds.length === 0);
}

// (9) alpha-drift-r20-01: customers.del() itself throws (e.g. a race with a
// second delete click already having removed the Customer, or a genuine API
// hiccup) -- must be swallowed independently of the subscription-cancel
// step, and must never throw out of the wrapper (best-effort, same as every
// other failure mode this function already tolerates).
console.log("(9) customers.del() throws -- swallowed, subscriptions were still cancelled first, does not throw");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc9 = supabaseStub({ stripe_customer_id: "cus_already_gone" });
  const stripe9 = stub([{ id: "sub_live_9", status: "active" }], [], true);
  let threw = false;
  try {
    await cleanUpStripeCustomerBeforeDelete(svc9 as never, "user_999", "[verify]", stripe9 as never);
  } catch {
    threw = true;
  }
  check("(9) did not throw despite customers.del() rejecting", !threw);
  check("(9) subscription cancel still ran first (independent of the customer-delete outcome)", stripe9.cancelledCalls.includes("sub_live_9"));
  check("(9) the failed delete attempt is not recorded as a successful call", stripe9.customerDelCalls.length === 0);
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

// (10) alpha-drift-r24-06 (2026-08-14): preFetchedCustomerId lets a caller
// that already queried stripe_customer_id (app/api/admin/users/route.ts's
// delete branch, which also needs "email" from the same row for the Resend
// suppression cleanup) skip this function's own redundant re-lookup of the
// identical column on the identical row.
console.log("(10) preFetchedCustomerId provided -- skips the Supabase lookup entirely, still cancels via the passed-in id");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc10 = supabaseStub({ stripe_customer_id: "cus_should_not_be_queried" });
  const stripe10 = stub([{ id: "sub_live_10", status: "active" }]);
  await cleanUpStripeCustomerBeforeDelete(svc10 as never, "user_010", "[verify]", stripe10 as never, "cus_prefetched");
  check("(10a) never queried Supabase at all (customerId came from the param)", svc10.queriedIds.length === 0);
  check("(10b) cancelled subscriptions on the PRE-FETCHED customer id, not the (unused) row's id", stripe10.cancelledCalls.includes("sub_live_10"));
  check("(10c) deleted the pre-fetched customer id", stripe10.customerDelCalls.includes("cus_prefetched"));
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

// (11) preFetchedCustomerId explicitly null (caller's own query found no
// stripe_customer_id on the row) -- must be treated as "no customer, skip,"
// NOT as "not provided, fall back to this function's own lookup." A `!==
// undefined` check gets this right; a plain falsy/truthy check would not.
console.log("(11) preFetchedCustomerId explicitly null -- treated as no-customer, does NOT fall back to its own lookup");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc11 = supabaseStub({ stripe_customer_id: "cus_should_never_be_reached" });
  const stripe11 = stub([{ id: "sub_should_not_be_touched_11", status: "active" }]);
  await cleanUpStripeCustomerBeforeDelete(svc11 as never, "user_011", "[verify]", stripe11 as never, null);
  check("(11a) never queried Supabase (null was treated as a real answer, not a missing argument)", svc11.queriedIds.length === 0);
  check("(11b) never touched Stripe at all", stripe11.cancelledCalls.length === 0 && stripe11.customerDelCalls.length === 0);
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

// (12) preFetchedCustomerId omitted entirely (account/delete/route.ts's real
// call shape) -- falls back to this function's own lookup exactly as before,
// unchanged by adding the new parameter.
console.log("(12) preFetchedCustomerId omitted -- unchanged behavior, still does its own lookup");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc12 = supabaseStub({ stripe_customer_id: "cus_from_own_lookup" });
  const stripe12 = stub([{ id: "sub_live_12", status: "active" }]);
  await cleanUpStripeCustomerBeforeDelete(svc12 as never, "user_012", "[verify]", stripe12 as never);
  check("(12a) did its own Supabase lookup (5th arg omitted)", svc12.queriedIds.length === 1 && svc12.queriedIds[0] === "user_012");
  check("(12b) cancelled subscriptions on the id from its own lookup", stripe12.cancelledCalls.includes("sub_live_12"));
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

// (13) alpha-drift-r65-05 (2026-08-21, silent-catch-audit-r11):
// subscriptions.list() itself throws (a network blip, a timeout, a one-off
// 5xx) -- the subscription-cancel step and the customer-delete step used to
// share one try, so this used to skip customers.del() entirely, and per
// Stripe's own documented behavior, deleting the Customer is what actually
// cancels a still-live subscription in that case. Must still attempt
// customers.del(), and must never throw out of the wrapper.
console.log("(13) subscriptions.list() throws -- customers.del() is still attempted (it also cancels any live subscription)");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc13 = supabaseStub({ stripe_customer_id: "cus_list_throws" });
  const stripe13 = stub([], [], false, true);
  let threw = false;
  try {
    await cleanUpStripeCustomerBeforeDelete(svc13 as never, "user_013", "[verify]", stripe13 as never);
  } catch {
    threw = true;
  }
  check("(13a) did not throw despite subscriptions.list() rejecting", !threw);
  check("(13b) customers.del() was still attempted (the fix's whole point)", stripe13.customerDelCalls.includes("cus_list_throws"));
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

// (14) Both steps fail (subscriptions.list() throws AND customers.del()
// throws) -- the worst case, with no fallback left to cancel the
// subscription or delete the Customer. Must still never throw out of the
// wrapper (sendOpsAlert is itself .catch(() => {})-guarded, matching the
// r60-06 sibling alert above).
console.log("(14) both subscriptions.list() and customers.del() throw -- still swallowed, does not throw");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc14 = supabaseStub({ stripe_customer_id: "cus_both_fail" });
  const stripe14 = stub([], [], true, true);
  let threw = false;
  try {
    await cleanUpStripeCustomerBeforeDelete(svc14 as never, "user_014", "[verify]", stripe14 as never);
  } catch {
    threw = true;
  }
  check("(14) did not throw despite both steps failing", !threw);
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("STRIPE CANCEL-ON-DELETE LOGIC VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL STRIPE CANCEL-ON-DELETE LOGIC ASSERTIONS PASS");
