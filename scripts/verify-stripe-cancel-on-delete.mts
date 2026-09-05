// Local verification for exact Alpha cancellation during account deletion.
// Uses injected Stripe and Supabase stubs only. It does not load env files or
// call Stripe, Supabase, Resend, or any other external service.
// Run with the installed local tsx executable.
import { STRIPE_PRICE_ID } from "../lib/stripe.ts";

const { cancelCustomerSubscriptions, cleanUpStripeCustomerBeforeDelete } = await import(
  "../lib/stripe-cancel.ts"
);

type Sub = {
  id: string;
  status: string;
  customer: string;
  items: {
    data: Array<{
      id: string;
      price: { id: string };
      quantity: number;
    }>;
    has_more: boolean;
  };
};

function alphaSub(id: string, status = "active", quantity = 1): Sub {
  return {
    id,
    status,
    customer: "cus_test",
    items: {
      data: [{ id: `si_${id}`, price: { id: STRIPE_PRICE_ID }, quantity }],
      has_more: false,
    },
  };
}

function otherSub(id: string, status = "active"): Sub {
  return {
    id,
    status,
    customer: "cus_test",
    items: {
      data: [{ id: `si_${id}`, price: { id: "price_other_product" }, quantity: 1 }],
      has_more: false,
    },
  };
}

function stub(
  subs: Sub[],
  options: {
    throwOnCancel?: string[];
    pageHasMore?: boolean;
    listThrows?: boolean;
    customerDelThrows?: boolean;
  } = {}
) {
  const cancelledCalls: string[] = [];
  const customerDelCalls: string[] = [];
  const client = {
    cancelledCalls,
    customerDelCalls,
    subscriptions: {
      list: async () => {
        if (options.listThrows) throw new Error("simulated Stripe list failure");
        return { data: subs, has_more: options.pageHasMore ?? false };
      },
      cancel: async (id: string) => {
        if (options.throwOnCancel?.includes(id)) {
          throw new Error("simulated Stripe cancel failure");
        }
        cancelledCalls.push(id);
        return { id, status: "canceled" };
      },
    },
    customers: {
      del: async (id: string) => {
        if (options.customerDelThrows) throw new Error("simulated customer delete failure");
        customerDelCalls.push(id);
        return { id, deleted: true };
      },
    },
  };
  return client;
}

function supabaseStub(row: { stripe_customer_id: string | null } | null) {
  const queriedIds: string[] = [];
  return {
    queriedIds,
    from() {
      return {
        select() {
          return {
            eq(_column: string, id: string) {
              queriedIds.push(id);
              return {
                async maybeSingle() {
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

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) pass++;
  else fail++;
}

async function rejects(label: string, fn: () => Promise<unknown>) {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  check(label, rejected);
}

console.log("(1) exact Alpha subscriptions only");
{
  const client = stub([
    alphaSub("sub_active"),
    alphaSub("sub_trial", "trialing", 5),
    alphaSub("sub_terminal", "canceled"),
  ]);
  const result = await cancelCustomerSubscriptions(client as never, "cus_test");
  check("(1a) cancels both non-terminal exact Alpha subscriptions", result.cancelled.length === 2);
  check("(1b) skips the terminal exact Alpha subscription", result.skipped === 1);
  check("(1c) reports no other product", result.hasNonAlphaSubscriptions === false);
  check("(1d) cancel calls contain only exact Alpha ids", client.cancelledCalls.join(",") === "sub_active,sub_trial");
}

console.log("(2) separate non-Alpha subscription is preserved");
{
  const client = stub([alphaSub("sub_alpha"), otherSub("sub_other")]);
  const result = await cancelCustomerSubscriptions(client as never, "cus_test");
  check("(2a) cancels the exact Alpha subscription", result.cancelled.includes("sub_alpha"));
  check("(2b) never cancels the other product", !client.cancelledCalls.includes("sub_other"));
  check("(2c) reports that another product exists", result.hasNonAlphaSubscriptions === true);
}

console.log("(3) invalid and mixed Alpha shapes fail before mutation");
{
  const mixed = alphaSub("sub_mixed");
  mixed.items.data.push({ id: "si_other", price: { id: "price_other_product" }, quantity: 1 });
  const mixedClient = stub([mixed]);
  await rejects("(3a) mixed Alpha and another price rejects", () =>
    cancelCustomerSubscriptions(mixedClient as never, "cus_test")
  );
  check("(3b) mixed subscription was not cancelled", mixedClient.cancelledCalls.length === 0);

  const badQtyClient = stub([alphaSub("sub_bad_qty", "active", 6)]);
  await rejects("(3c) Alpha quantity above five rejects", () =>
    cancelCustomerSubscriptions(badQtyClient as never, "cus_test")
  );
  check("(3d) invalid quantity was not cancelled", badQtyClient.cancelledCalls.length === 0);
}

console.log("(4) pagination fails closed before mutation");
{
  const pageClient = stub([alphaSub("sub_page")], { pageHasMore: true });
  await rejects("(4a) a paginated subscription result rejects", () =>
    cancelCustomerSubscriptions(pageClient as never, "cus_test")
  );
  check("(4b) paginated result did not cancel anything", pageClient.cancelledCalls.length === 0);

  const itemPage = alphaSub("sub_item_page");
  itemPage.items.has_more = true;
  const itemPageClient = stub([itemPage]);
  await rejects("(4c) paginated line items reject", () =>
    cancelCustomerSubscriptions(itemPageClient as never, "cus_test")
  );
  check("(4d) paginated line items did not cancel anything", itemPageClient.cancelledCalls.length === 0);
}

console.log("(5) one Alpha cancel failure does not target another product");
{
  const client = stub([alphaSub("sub_a"), alphaSub("sub_b"), otherSub("sub_other")], {
    throwOnCancel: ["sub_a"],
  });
  const result = await cancelCustomerSubscriptions(client as never, "cus_test");
  check("(5a) counts the exact Alpha cancel failure", result.errors === 1);
  check("(5b) still cancels the other exact Alpha subscription", result.cancelled.includes("sub_b"));
  check("(5c) still never calls cancel for the other product", !client.cancelledCalls.includes("sub_other"));
}

console.log("(6) cleanup cancels Alpha but preserves the account-wide Customer");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc = supabaseStub({ stripe_customer_id: "cus_test" });
  const client = stub([alphaSub("sub_only_alpha")]);
  await cleanUpStripeCustomerBeforeDelete(svc as never, "user_alpha", "[verify]", client as never);
  check("(6a) cancels the exact Alpha subscription", client.cancelledCalls.includes("sub_only_alpha"));
  check("(6b) never deletes the account-wide Customer", client.customerDelCalls.length === 0);
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

console.log("(7) cleanup preserves a Customer shared with another product");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc = supabaseStub({ stripe_customer_id: "cus_test" });
  const client = stub([alphaSub("sub_alpha_shared"), otherSub("sub_other_shared")]);
  await cleanUpStripeCustomerBeforeDelete(svc as never, "user_shared", "[verify]", client as never);
  check("(7a) cancels the exact Alpha subscription", client.cancelledCalls.includes("sub_alpha_shared"));
  check("(7b) does not cancel the other product", !client.cancelledCalls.includes("sub_other_shared"));
  check("(7c) does not delete the shared Customer", client.customerDelCalls.length === 0);
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

console.log("(8) an uncertain subscription list preserves the Customer");
process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc = supabaseStub({ stripe_customer_id: "cus_test" });
  const client = stub([], { listThrows: true });
  await cleanUpStripeCustomerBeforeDelete(
    svc as never,
    "user_uncertain",
    "[verify]",
    client as never
  );
  check("(8a) list failure does not attempt a cancellation", client.cancelledCalls.length === 0);
  check("(8b) list failure does not delete the Customer", client.customerDelCalls.length === 0);
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

console.log("(9) explicit null and missing Stripe configuration remain no-ops");
delete process.env.STRIPE_SECRET_KEY;
{
  const svc = supabaseStub({ stripe_customer_id: "cus_should_not_be_read" });
  let threw = false;
  try {
    await cleanUpStripeCustomerBeforeDelete(svc as never, "user_none", "[verify]");
  } catch {
    threw = true;
  }
  check("(9a) missing Stripe configuration does not throw", !threw);
  check("(9b) missing Stripe configuration does not query Supabase", svc.queriedIds.length === 0);
}

process.env.STRIPE_SECRET_KEY = "sk_test_verify_script_only";
try {
  const svc = supabaseStub({ stripe_customer_id: "cus_should_not_be_read" });
  const client = stub([alphaSub("sub_should_not_be_touched")]);
  await cleanUpStripeCustomerBeforeDelete(svc as never, "user_null", "[verify]", client as never, null);
  check("(9c) an explicit null customer id does not query Supabase", svc.queriedIds.length === 0);
  check("(9d) an explicit null customer id does not touch Stripe", client.cancelledCalls.length === 0 && client.customerDelCalls.length === 0);
} finally {
  delete process.env.STRIPE_SECRET_KEY;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("STRIPE CANCEL-ON-DELETE LOGIC VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL STRIPE CANCEL-ON-DELETE LOGIC ASSERTIONS PASS");
