// Fully local verification for the durable account-deletion saga. Stripe and
// Supabase are injected in-memory stubs. No env file, network, provider, Auth,
// email, or subscriber data is touched.
import { readFileSync } from "node:fs";
import { STRIPE_PRICE_ID } from "../lib/stripe.ts";
import {
  AccountDeletionBlockedError,
  removeAccountAuthAndCompleteSaga,
  settleAccountDeletionBilling,
  settleAccountDeletionPrivacy,
} from "../lib/account-deletion.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed += 1;
  else failed += 1;
}

function alphaSubscription(
  id: string,
  customer = "cus_alpha",
  status = "active",
  quantity = 1
) {
  return {
    id,
    customer,
    status,
    items: {
      has_more: false,
      data: [
        {
          id: `si_${id}`,
          price: { id: STRIPE_PRICE_ID },
          quantity,
        },
      ],
    },
  };
}

function deletionStore(plan: Record<string, unknown>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "prepare_account_deletion") {
        return { data: plan, error: null };
      }
      return { data: true, error: null };
    },
  };
}

console.log("(1) a free account reaches a durable billing-clean state without Stripe");
{
  const store = deletionStore({
    decision: "ready",
    saga_state: "prepared",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    exclusive_customer_binding: true,
    profiles: [],
    legacy_profiles: [],
  });
  const state = await settleAccountDeletionBilling(
    store as never,
    "11111111-1111-4111-8111-111111111111"
  );
  check("(1a) result is billing_clean", state === "billing_clean");
  check(
    "(1b) only prepare and database confirmation run",
    store.calls.map((call) => call.name).join(",") ===
      "prepare_account_deletion,confirm_account_deletion_billing"
  );
}

console.log("(1c) the exact unresolved recovery preparation error stops before Stripe");
{
  const calls: string[] = [];
  let stripeCalls = 0;
  const store = {
    async rpc(name: string) {
      calls.push(name);
      if (name === "prepare_account_deletion") {
        return {
          data: null,
          error: {
            message: "account deletion blocked by unresolved suppression recovery",
          },
        };
      }
      throw new Error(`unexpected RPC after recovery block: ${name}`);
    },
  };
  const stripe = {
    subscriptions: {
      async list() {
        stripeCalls += 1;
        return { has_more: false, data: [] };
      },
    },
  };
  let error: unknown;
  try {
    await settleAccountDeletionBilling(
      store as never,
      "12121212-1212-4121-8121-121212121212",
      stripe as never
    );
  } catch (caught) {
    error = caught;
  }
  check(
    "(1c-a) exact SQL recovery block carries its narrow typed code",
    error instanceof AccountDeletionBlockedError &&
      error.code === "unresolved_suppression_recovery"
  );
  check("(1c-b) only prepare runs before the recovery block", calls.join(",") === "prepare_account_deletion");
  check("(1c-c) recovery block makes zero Stripe calls", stripeCalls === 0);
  const nearMissStore = {
    async rpc(name: string) {
      if (name !== "prepare_account_deletion") {
        throw new Error(`unexpected near-miss RPC: ${name}`);
      }
      return {
        data: null,
        error: {
          message: "account deletion blocked by unresolved suppression recovery, retry later",
        },
      };
    },
  };
  let nearMiss: unknown;
  try {
    await settleAccountDeletionBilling(
      nearMissStore as never,
      "13131313-1313-4131-8131-131313131313",
      stripe as never
    );
  } catch (caught) {
    nearMiss = caught;
  }
  check(
    "(1c-d) a similar but non-exact prepare message does not receive the recovery code",
    nearMiss instanceof AccountDeletionBlockedError && nearMiss.code === undefined
  );
}

console.log("(2) an open Session completion race cancels its exact Alpha subscription");
{
  const userId = "22222222-2222-4222-8222-222222222222";
  const profileId = "33333333-3333-4333-8333-333333333333";
  const subscription = alphaSubscription("sub_alpha");
  const store = deletionStore({
    decision: "ready",
    saga_state: "prepared",
    stripe_customer_id: "cus_alpha",
    stripe_subscription_id: "sub_alpha",
    exclusive_customer_binding: true,
    profiles: [
      {
        id: profileId,
        stripe_session_id: "cs_alpha",
        stripe_customer_id: null,
        stripe_subscription_id: null,
      },
    ],
    legacy_profiles: [],
  });
  let sessionRead = 0;
  const cancelled: string[] = [];
  const listArgs: Array<Record<string, unknown>> = [];
  const stripe = {
    checkout: {
      sessions: {
        async retrieve() {
          sessionRead += 1;
          return {
            id: "cs_alpha",
            mode: "subscription",
            status: sessionRead === 1 ? "open" : "complete",
            metadata: { alpha_profile_id: profileId },
            customer: "cus_alpha",
            subscription,
            line_items: {
              has_more: false,
              data: [
                {
                  price: { id: STRIPE_PRICE_ID },
                  quantity: 1,
                },
              ],
            },
          };
        },
        async expire() {
          // Simulate Stripe reporting success just as payment completes. The
          // helper must still re-read and cancel the resulting subscription.
          return { id: "cs_alpha", status: "expired" };
        },
      },
    },
    subscriptions: {
      async retrieve() {
        return subscription;
      },
      async cancel(id: string) {
        cancelled.push(id);
        subscription.status = "canceled";
        return subscription;
      },
      async list(args: Record<string, unknown>) {
        listArgs.push(args);
        return { has_more: false, data: [subscription] };
      },
    },
  };
  const state = await settleAccountDeletionBilling(
    store as never,
    userId,
    stripe as never
  );
  check("(2a) the race still reaches billing_clean", state === "billing_clean");
  check("(2b) only the exact Alpha subscription is cancelled", cancelled.join(",") === "sub_alpha");
  check(
    "(2c) every customer scan is restricted to the exact Alpha price",
    listArgs.length === 1 &&
      listArgs.every(
        (args) =>
          args.customer === "cus_alpha" && args.price === STRIPE_PRICE_ID
      )
  );
  check(
    "(2d) the profile is settled only after exact cancellation",
    store.calls.some(
      (call) =>
        call.name === "settle_account_deletion_checkout_profile" &&
        call.args.p_terminal_state === "ended" &&
        call.args.p_subscription_id === "sub_alpha"
    )
  );
  check(
    "(2e) the terminal subscription status is durable",
    store.calls.some(
      (call) =>
        call.name === "record_account_deletion_subscription" &&
        call.args.p_status === "canceled"
    )
  );
}

console.log("(3) mixed-product or uncertain Stripe state leaves Auth blocked");
{
  const userId = "44444444-4444-4444-8444-444444444444";
  const store = deletionStore({
    decision: "ready",
    saga_state: "prepared",
    stripe_customer_id: "cus_shared",
    stripe_subscription_id: null,
    exclusive_customer_binding: false,
    profiles: [],
    legacy_profiles: [],
  });
  const mixed = alphaSubscription("sub_mixed", "cus_shared");
  mixed.items.data.push({
    id: "si_other",
    price: { id: "price_other_product" },
    quantity: 1,
  });
  const cancelled: string[] = [];
  const stripe = {
    subscriptions: {
      async list() {
        return { has_more: false, data: [mixed] };
      },
      async retrieve() {
        return mixed;
      },
      async cancel(id: string) {
        cancelled.push(id);
        return mixed;
      },
    },
  };
  let error: unknown;
  try {
    await settleAccountDeletionBilling(store as never, userId, stripe as never);
  } catch (caught) {
    error = caught;
  }
  check("(3a) the mixed subscription fails closed", error instanceof AccountDeletionBlockedError);
  check("(3b) no mixed subscription is cancelled", cancelled.length === 0);
  check(
    "(3c) billing clean is never recorded after uncertainty",
    !store.calls.some(
      (call) => call.name === "confirm_account_deletion_billing"
    )
  );
}

console.log("(4) exact terminal and no-longer-Alpha refs never mutate another product");
{
  for (const [label, status] of [
    ["terminal", "canceled"],
    ["migrated", "active"],
  ] as const) {
    const subscription = {
      ...alphaSubscription(`sub_${label}`, "cus_exact", status),
      items: {
        has_more: false,
        data: [
          {
            id: `si_${label}`,
            price: { id: "price_other_product" },
            quantity: 1,
          },
        ],
      },
    };
    const store = deletionStore({
      decision: "ready",
      saga_state: "prepared",
      stripe_customer_id: "cus_exact",
      stripe_subscription_id: subscription.id,
      exclusive_customer_binding: true,
      profiles: [],
      legacy_profiles: [],
    });
    const cancelled: string[] = [];
    const stripe = {
      subscriptions: {
        async retrieve() {
          return subscription;
        },
        async cancel(id: string) {
          cancelled.push(id);
          return subscription;
        },
        async list() {
          return { has_more: false, data: [] };
        },
      },
    };
    const state = await settleAccountDeletionBilling(
      store as never,
      `55555555-5555-4555-8555-55555555555${label === "terminal" ? "5" : "6"}`,
      stripe as never
    );
    check(`(4${label === "terminal" ? "a" : "c"}) ${label} exact ref reaches billing_clean`, state === "billing_clean");
    check(`(4${label === "terminal" ? "b" : "d"}) ${label} exact ref is never cancelled`, cancelled.length === 0);
    if (label === "migrated") {
      check(
        "(4e) a nonterminal ref whose Alpha price is gone is recorded as no_longer_alpha",
        store.calls.some(
          (call) =>
            call.name === "record_account_deletion_subscription" &&
            call.args.p_status === "no_longer_alpha"
        )
      );
    }
  }
}

console.log("(5) legacy exact bindings are durable before cancellation");
{
  const subscription = alphaSubscription("sub_legacy", "cus_legacy");
  const store = deletionStore({
    decision: "ready",
    saga_state: "prepared",
    stripe_customer_id: "cus_legacy",
    stripe_subscription_id: null,
    exclusive_customer_binding: true,
    profiles: [],
    legacy_profiles: [],
  });
  const cancelled: string[] = [];
  const stripe = {
    subscriptions: {
      async list() {
        return { has_more: false, data: [subscription] };
      },
      async retrieve() {
        return subscription;
      },
      async cancel(id: string) {
        cancelled.push(id);
        subscription.status = "canceled";
        return subscription;
      },
    },
  };
  const state = await settleAccountDeletionBilling(
    store as never,
    "66666666-6666-4666-8666-666666666666",
    stripe as never
  );
  const bindIndex = store.calls.findIndex(
    (call) => call.name === "bind_account_deletion_subscription"
  );
  const terminalIndex = store.calls.findIndex(
    (call) =>
      call.name === "record_account_deletion_subscription" &&
      call.args.p_status === "canceled"
  );
  check("(5a) unique legacy candidate reaches billing_clean", state === "billing_clean");
  check("(5b) only its exact id is cancelled", cancelled.join(",") === "sub_legacy");
  check(
    "(5c) the atomic ownership RPC binds the candidate before terminal status",
    bindIndex >= 0 && terminalIndex > bindIndex
  );
}

console.log("(6) support cleanup and delivery-policy settlement are required saga steps");
{
  function privacyStore() {
    const calls: string[] = [];
    return {
      calls,
      from(table: string) {
        calls.push(`from:${table}`);
        return {
          delete() {
            calls.push("delete");
            return {
              async eq() {
                calls.push("eq:user_id");
                return { error: null };
              },
              is() {
                calls.push("is:user_id:null");
                return {
                  async ilike() {
                    calls.push("ilike:email");
                    return { error: null };
                  },
                };
              },
            };
          },
        };
      },
      async rpc(name: string) {
        calls.push(`rpc:${name}`);
        return { data: true, error: null };
      },
    };
  }
  const successful = privacyStore();
  await settleAccountDeletionPrivacy(
    successful as never,
    "77777777-7777-4777-8777-777777777777",
    "Reader@Example.com"
  );
  check(
    "(6a) both support-ticket scopes are deleted",
    successful.calls.includes("eq:user_id") &&
      successful.calls.includes("ilike:email")
  );
  check(
    "(6b) both durable privacy markers are recorded without a provider call",
    successful.calls.includes("rpc:mark_account_deletion_support_deleted") &&
      successful.calls.includes(
        "rpc:mark_account_deletion_delivery_policy_settled"
      ) &&
      !successful.calls.some((call) => call.includes("suppression"))
  );
}

console.log("(7) an Auth provider failure resumes from the durable retry marker");
{
  const userId = "99999999-9999-4999-8999-999999999999";
  let sagaState = "billing_clean";
  let deleteAttempts = 0;
  const calls: string[] = [];
  const store = {
    async rpc(name: string) {
      calls.push(`${sagaState}:${name}`);
      if (name === "prepare_account_deletion") {
        return {
          data: {
            decision: "ready",
            saga_state: sagaState,
            stripe_customer_id: null,
            stripe_subscription_id: null,
            exclusive_customer_binding: true,
            profiles: [],
            legacy_profiles: [],
          },
          error: null,
        };
      }
      if (name === "begin_account_deletion_auth_removal") {
        if (sagaState !== "billing_clean" && sagaState !== "auth_delete_started") {
          return { data: false, error: null };
        }
        sagaState = "auth_delete_started";
        return { data: true, error: null };
      }
      if (name === "complete_account_deletion") {
        if (sagaState !== "auth_delete_started") {
          return { data: false, error: null };
        }
        sagaState = "complete";
        return { data: true, error: null };
      }
      return { data: true, error: null };
    },
  };
  const deleteUser = async () => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) throw new Error("transient Auth provider failure");
  };
  let firstFailed = false;
  try {
    await removeAccountAuthAndCompleteSaga(store as never, userId, deleteUser);
  } catch {
    firstFailed = true;
  }
  check(
    "(7a) first failure leaves auth_delete_started durable",
    firstFailed && sagaState === "auth_delete_started"
  );
  const resumedState = await settleAccountDeletionBilling(store as never, userId);
  check(
    "(7b) retry resumes without repeating billing or privacy work",
    resumedState === "auth_delete_started" &&
      !calls.some((call) => call.includes("confirm_account_deletion_billing"))
  );
  await removeAccountAuthAndCompleteSaga(store as never, userId, deleteUser);
  check(
    "(7c) second Auth attempt completes the same saga",
    deleteAttempts === 2 && sagaState === "complete"
  );
}

console.log("(8) an unbound live Alpha charge blocks completion without mutation");
{
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const exact = alphaSubscription("sub_exact", "cus_shared");
  const unbound = alphaSubscription("sub_unbound", "cus_shared");
  const store = deletionStore({
    decision: "ready",
    saga_state: "prepared",
    stripe_customer_id: "cus_shared",
    stripe_subscription_id: "sub_exact",
    exclusive_customer_binding: true,
    profiles: [],
    legacy_profiles: [],
  });
  const cancelled: string[] = [];
  const stripe = {
    subscriptions: {
      async retrieve(id: string) {
        return id === exact.id ? exact : unbound;
      },
      async cancel(id: string) {
        cancelled.push(id);
        exact.status = "canceled";
        return exact;
      },
      async list() {
        return { has_more: false, data: [exact, unbound] };
      },
    },
  };
  let error: unknown;
  try {
    await settleAccountDeletionBilling(store as never, userId, stripe as never);
  } catch (caught) {
    error = caught;
  }
  check("(8a) only the stored exact subscription is cancelled", cancelled.join(",") === "sub_exact");
  check("(8b) the unbound live charge blocks Auth deletion", error instanceof AccountDeletionBlockedError);
  check(
    "(8c) the unbound id and status are retained for manual repair",
    store.calls.some(
      (call) =>
        call.name === "record_account_deletion_subscription" &&
        call.args.p_subscription_id === "sub_unbound" &&
        call.args.p_status === "active"
    )
  );
  check(
    "(8d) billing_clean is never written while the charge remains",
    !store.calls.some((call) => call.name === "confirm_account_deletion_billing")
  );
}

console.log("(9) route ordering and migration privacy guarantees");
{
  const selfRoute = readFileSync(
    new URL("../app/api/account/delete/route.ts", import.meta.url),
    "utf8"
  );
  const adminRoute = readFileSync(
    new URL("../app/api/admin/users/route.ts", import.meta.url),
    "utf8"
  );
  const checkoutRoute = readFileSync(
    new URL("../app/api/stripe/checkout/route.ts", import.meta.url),
    "utf8"
  );
  const generateRoute = readFileSync(
    new URL("../app/api/generate/route.ts", import.meta.url),
    "utf8"
  );
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260827000000_checkout_fulfillment_claims.sql",
      import.meta.url
    ),
    "utf8"
  );
  const legacyMigration = readFileSync(
    new URL(
      "../supabase/migrations/20260827030000_legacy_checkout_fulfillments.sql",
      import.meta.url
    ),
    "utf8"
  );
  const accountDeletionHelper = readFileSync(
    new URL("../lib/account-deletion.ts", import.meta.url),
    "utf8"
  );
  const deletionReconciler = readFileSync(
    new URL("../lib/account-deletion-reconciler.ts", import.meta.url),
    "utf8"
  );
  for (const [label, source] of [
    ["self", selfRoute],
    ["admin", adminRoute],
  ] as const) {
    check(
      `(9${label === "self" ? "a" : "b"}) ${label} deletion confirms billing before Auth`,
      source.lastIndexOf("settleAccountDeletionBilling") <
        source.lastIndexOf("const deleteAuthUser") &&
        accountDeletionHelper.lastIndexOf("beginAccountDeletionAuthRemoval") <
          accountDeletionHelper.lastIndexOf("await deleteAuthUser()") &&
        accountDeletionHelper.lastIndexOf("await deleteAuthUser()") <
          accountDeletionHelper.lastIndexOf("completeAccountDeletion")
    );
  }
  check(
    "(9c) staged raw profile fields are nulled during atomic preparation",
    /prepare_account_deletion[\s\S]*email = null,[\s\S]*first_name = null,[\s\S]*topics = null,[\s\S]*theme = null/.test(
      migration
    )
  );
  check(
    "(9d) deleting profiles stay owner-bound until terminal cleanup and block fulfillment",
    migration.includes("owner_user_id   uuid,") &&
      migration.includes("'open', 'creating', 'paid', 'recovering', 'deleting', 'ended', 'expired'") &&
      migration.includes("block_checkout_for_deleting_owner")
  );
  check(
    "(9e) sessionless open profiles become locally expired",
    migration.includes("and p.stripe_session_id is null then 'expired'")
  );
  check(
    "(9f) a signed-in checkout reads the durable deletion tombstone",
    checkoutRoute.includes('.from("account_deletion_sagas")') &&
      checkoutRoute.includes('error: "account_deletion_in_progress"')
  );
  check(
    "(9g) only service_role can call the deletion RPCs",
    migration.includes("revoke all on function public.prepare_account_deletion(uuid)") &&
      migration.includes("grant execute on function public.prepare_account_deletion(uuid)") &&
      migration.includes("to service_role;")
  );
  check(
    "(9h) both routes require durable privacy cleanup and policy settlement before Auth removal",
    [selfRoute, adminRoute].every(
      (source) =>
        source.lastIndexOf("settleAccountDeletionPrivacy") <
          source.lastIndexOf("const deleteAuthUser") &&
        source.includes('deletionState !== "auth_delete_started"') &&
        source.includes('deletionState !== "complete"')
    ) &&
      migration.includes("support_deleted_at is not null") &&
      migration.includes("delivery_policy_settled_at is not null")
  );
  check(
    "(9h2) deletion clears both provider-mirror queues under the owner lock",
    /prepare_account_deletion[\s\S]*pg_advisory_xact_lock\(hashtextextended\(p_user_id::text, 80425080\)\)[\s\S]*Stripe email reconciliation is still in progress[\s\S]*suppression_cleanup_pending_at = null,[\s\S]*suppression_cleanup_next_attempt_at = null,[\s\S]*stripe_email_sync_pending_at = null,[\s\S]*stripe_email_sync_next_attempt_at = null,[\s\S]*stripe_email_sync_lease_token = null,[\s\S]*stripe_email_sync_lease_expires_at = null[\s\S]*insert into public.account_deletion_sagas/.test(
      migration
    )
  );
  check(
    "(9i) completed deletion clears checkout and fulfillment identity",
    /complete_account_deletion[\s\S]*email_hash = null,[\s\S]*browser_nonce_hash = null,[\s\S]*owner_user_id = null,[\s\S]*provisioned_user_id = null/.test(
      migration
    ) &&
      /checkout_fulfillments[\s\S]*email_hash = null,[\s\S]*user_id = null/.test(
        migration
      )
  );
  check(
    "(9j) checkout create, bind, and delete use durable serialization plus a bounded lease",
    migration.includes("stage_checkout_profile") &&
      migration.includes("begin_checkout_session_creation") &&
      migration.includes("bind_checkout_session") &&
      migration.includes("session_creation_lease_expires_at") &&
      migration.includes("interval '23 hours'") &&
      migration.includes("interval '31 minutes'") &&
      checkoutRoute.includes('"begin_checkout_session_creation"') &&
      checkoutRoute.includes('"bind_checkout_session"')
  );
  check(
    "(9k) claim locks the exact profile and completion is one atomic RPC",
    /claim_checkout_fulfillment[\s\S]*from public\.checkout_profiles p[\s\S]*for update/.test(
      migration
    ) &&
      migration.includes("complete_checkout_fulfillment") &&
      generateRoute.includes('.rpc("complete_checkout_fulfillment"')
  );
  check(
    "(9l) legacy resolver authorization checks every local identity table",
    /bind_account_deletion_subscription[\s\S]*public\.users[\s\S]*public\.checkout_profiles[\s\S]*public\.legacy_checkout_fulfillments[\s\S]*public\.account_deletion_sagas[\s\S]*public\.account_deletion_alpha_subscriptions/.test(
      migration
    )
  );
  check(
    "(9m) legacy leases stop first, awaiting rows keep their saga identity, and completion scrubs every exact ref",
    legacyMigration.includes("pg_advisory_xact_lock") &&
      /abort_legacy_checkout_for_account_deletion[\s\S]*when status = 'awaiting_issue' then 'deleting'[\s\S]*lease_token = null[\s\S]*awaiting_issue_until = null[\s\S]*where user_id = new\.user_id/.test(
        legacyMigration
      ) &&
      /scrub_legacy_checkout_after_account_deletion[\s\S]*new\.state = 'complete'[\s\S]*email_hash = null[\s\S]*stripe_customer_id = null[\s\S]*stripe_subscription_id = null[\s\S]*identity_scrubbed_at/.test(
        legacyMigration
      )
  );
  check(
    "(9n) current staging writes the canonical owner and stores no raw profile copy",
    /stage_checkout_profile[\s\S]*update public\.users[\s\S]*insert into public\.checkout_profiles[\s\S]*raw_profile_scrubbed_at[\s\S]*now\(\)/.test(
      migration
    ) &&
      checkoutRoute.includes('stagedInsert === "staged"')
  );
  check(
    "(9o) generation binds the Stripe email separately from the confirmed Auth owner",
    generateRoute.includes("checkoutEmail: verifiedEmail") &&
      generateRoute.includes("data.owner_user_id !== verifiedUserId") &&
      generateRoute.includes("checkoutEmailBinding(checkoutEmail)") &&
      generateRoute.includes("p_user_id: paid.verifiedUserId")
  );
  check(
    "(9p) terminal checkout recovery ends only the canonical user's exact stored pair",
    /settle_checkout_profile_recovery[\s\S]*update public\.users u[\s\S]*cancelled_at = least[\s\S]*u\.stripe_customer_id = p_customer_id[\s\S]*u\.stripe_subscription_id = p_subscription_id/.test(
      migration
    )
  );
  check(
    "(9q) the stale saga worker resumes local privacy cleanup from the exact confirmed Auth identity without provider unsuppression",
    deletionReconciler.includes("settleAccountDeletionPrivacy") &&
    deletionReconciler.includes("auth.admin.getUserById(userId)") &&
    deletionReconciler.includes("data.user.email_confirmed_at") &&
      !deletionReconciler.includes("removeResendSuppression") &&
      !deletionReconciler.includes("clearSuppression")
  );
  check(
    "(9r) duplicate legacy checkout cancellation is refund-first and lease-gated",
    /cancelDuplicateLegacyCheckout[\s\S]*record_legacy_duplicate_refund_review[\s\S]*stripe\.subscriptions\.cancel[\s\S]*abortLegacyCheckoutFulfillment/.test(
      generateRoute
    ) &&
      generateRoute.includes('"abort_legacy_checkout_fulfillment"') &&
      generateRoute.includes("p_winner_customer_id: winner.customerId") &&
      generateRoute.includes("p_winner_subscription_id: winner.subscriptionId") &&
      /abort_legacy_checkout_fulfillment[\s\S]*v_row\.status <> 'pending'[\s\S]*v_row\.lease_token is distinct from p_lease_token[\s\S]*public\.refund_reviews/.test(
        legacyMigration
      ) &&
      legacyMigration.includes(
        "grant execute on function public.abort_legacy_checkout_fulfillment(text, uuid, text, text, text, text)"
      )
  );
  check(
    "(9s) deletion preserves exact current and legacy charge reviews before scrubbing fulfillment identity",
    /prepare_account_deletion[\s\S]*insert into public\.refund_reviews \([\s\S]*select p\.stripe_session_id,[\s\S]*p\.stripe_subscription_id,[\s\S]*p\.stripe_customer_id,[\s\S]*'unfulfillable_checkout'[\s\S]*p\.billing_state in \('open', 'paid', 'recovering'\)[\s\S]*p\.stripe_session_id is not null[\s\S]*p\.stripe_customer_id is not null[\s\S]*p\.stripe_subscription_id is not null[\s\S]*on conflict \(session_id, subscription_id\) do nothing/.test(
      migration
    ) &&
      /prepare_account_deletion[\s\S]*insert into public\.refund_reviews \([\s\S]*select l\.session_id,[\s\S]*l\.stripe_subscription_id,[\s\S]*l\.stripe_customer_id,[\s\S]*'unfulfillable_checkout'[\s\S]*l\.status in \('pending', 'deleting', 'aborted'\)[\s\S]*l\.session_id is not null[\s\S]*l\.stripe_customer_id is not null[\s\S]*l\.stripe_subscription_id is not null[\s\S]*on conflict \(session_id, subscription_id\) do nothing/.test(
        migration
      ) &&
      /prepare_account_deletion[\s\S]*update public\.checkout_profiles[\s\S]*update public\.checkout_fulfillments f[\s\S]*status = 'aborted'[\s\S]*email_hash = null[\s\S]*user_id = null[\s\S]*identity_scrubbed_at/.test(
        migration
      )
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("ACCOUNT-DELETION SAGA VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ACCOUNT-DELETION SAGA ASSERTIONS PASS");
