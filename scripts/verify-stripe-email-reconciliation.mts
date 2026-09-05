// Fully local Stripe-email reconciliation checks with injected database,
// Auth, and Stripe stubs. No env file, provider, database, or network call is
// made.
import { readFileSync } from "node:fs";
import type Stripe from "stripe";
import { reconcilePendingStripeEmails } from
  "../lib/stripe-email-reconciliation.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed += 1;
  else failed += 1;
}

const userId = "11111111-1111-4111-8111-111111111111";
const pendingAt = "2026-08-28T12:00:00.000Z";

function serviceStub(options: {
  claimDecision: string;
  authorize?: boolean;
  complete?: boolean;
  calls: string[];
}) {
  const query = {
    select() { return this; },
    not() { return this; },
    is() { return this; },
    or() { return this; },
    order() { return this; },
    async limit() { return { data: [{ id: userId }], error: null }; },
  };
  return {
    from: () => query,
    auth: {
      admin: {
        getUserById: async () => ({
          data: { user: { email: "reader@example.com" } },
          error: null,
        }),
      },
    },
    rpc: async (name: string) => {
      options.calls.push(name);
      if (name === "claim_stripe_email_sync") {
        return {
          data: [{
            decision: options.claimDecision,
            canonical_email:
              options.claimDecision === "claimed" ? "reader@example.com" : null,
            customer_id:
              options.claimDecision === "claimed" ? "cus_email_test" : null,
            pending_at:
              options.claimDecision === "claimed" ? pendingAt : null,
          }],
          error: null,
        };
      }
      if (name === "authorize_stripe_email_sync") {
        return { data: options.authorize ?? true, error: null };
      }
      if (name === "complete_stripe_email_sync") {
        return { data: options.complete ?? true, error: null };
      }
      if (name === "fail_stripe_email_sync") {
        return { data: "deferred", error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  } as never;
}

function stripeStub(providerCalls: string[]): Stripe {
  return {
    customers: {
      update: async (customerId: string, params: { email?: string }) => {
        providerCalls.push(`${customerId}:${params.email}`);
        return {
          id: customerId,
          email: params.email,
          deleted: false,
        };
      },
    },
  } as never;
}

console.log("(1) exact lease authorization encloses the provider mutation");
{
  const calls: string[] = [];
  const providerCalls: string[] = [];
  const result = await reconcilePendingStripeEmails(
    serviceStub({ claimDecision: "claimed", calls }),
    1,
    { stripeClient: stripeStub(providerCalls) }
  );
  check(
    "(1a) one exact Customer email sync completes",
    result.cleared === 1 && result.errors.length === 0 &&
      providerCalls[0] === "cus_email_test:reader@example.com"
  );
  check(
    "(1b) provider mutation is between durable authorize and completion",
    calls.join(",") === [
      "claim_stripe_email_sync",
      "authorize_stripe_email_sync",
      "complete_stripe_email_sync",
    ].join(",")
  );
}

console.log("(2) deletion or lost authorization makes no provider call");
{
  const deletionCalls: string[] = [];
  const deletionProviderCalls: string[] = [];
  const deletion = await reconcilePendingStripeEmails(
    serviceStub({ claimDecision: "deletion_pending", calls: deletionCalls }),
    1,
    { stripeClient: stripeStub(deletionProviderCalls) }
  );
  check(
    "(2a) a deletion tombstone defers before Stripe",
    deletion.deferred === 1 && deletionProviderCalls.length === 0 &&
      deletionCalls.join(",") === "claim_stripe_email_sync"
  );

  const lostCalls: string[] = [];
  const lostProviderCalls: string[] = [];
  const lost = await reconcilePendingStripeEmails(
    serviceStub({
      claimDecision: "claimed",
      authorize: false,
      calls: lostCalls,
    }),
    1,
    { stripeClient: stripeStub(lostProviderCalls) }
  );
  check(
    "(2b) a lost lease releases locally and never reaches Stripe",
      lost.errors.length === 1 && lostProviderCalls.length === 0 &&
      lostCalls.includes("fail_stripe_email_sync")
  );
}

console.log("(3) migration serializes deletion with the durable lease");
const deliveryMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260827020000_delivery_suppression_pending.sql",
    import.meta.url
  ),
  "utf8"
);
const checkoutMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260827000000_checkout_fulfillment_claims.sql",
    import.meta.url
  ),
  "utf8"
);
check(
  "(3a) claim and final authorization use the shared owner lock and saga guard",
  /claim_stripe_email_sync[\s\S]*80425080[\s\S]*account_deletion_sagas/.test(
    deliveryMigration
  ) &&
    /authorize_stripe_email_sync[\s\S]*80425080[\s\S]*account_deletion_sagas/.test(
      deliveryMigration
    )
);
check(
  "(3b) deletion blocks a live lease and only reclaims beyond the runtime ceiling",
  /prepare_account_deletion[\s\S]*v_email_sync_lease_expires_at > now\(\)[\s\S]*Stripe email reconciliation is still in progress/.test(
    checkoutMigration
  ) &&
    deliveryMigration.includes("interval '10 minutes'")
);
check(
  "(3c) every lease RPC is service-role only",
  [
    "claim_stripe_email_sync(uuid, uuid)",
    "authorize_stripe_email_sync(uuid, uuid, text, timestamptz, text)",
    "complete_stripe_email_sync(uuid, uuid, text, timestamptz, text)",
    "release_stripe_email_sync(uuid, uuid)",
  ].every((signature) =>
    deliveryMigration.includes(`grant execute on function public.${signature}`)
  )
);
check(
  "(3d) a failed oldest sync is deferred and discovery skips future retry leases",
  deliveryMigration.includes(
    "stripe_email_sync_next_attempt_at = now() + interval '5 minutes'"
  ) &&
    /stripe_email_sync_next_attempt_at\.is\.null,stripe_email_sync_next_attempt_at\.lte/.test(
      readFileSync(
        new URL("../lib/stripe-email-reconciliation.ts", import.meta.url),
        "utf8"
      )
    )
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("STRIPE EMAIL RECONCILIATION VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL STRIPE EMAIL RECONCILIATION ASSERTIONS PASS");
