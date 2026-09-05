// Fully local retry test for the scheduled deletion reconciler. Auth, database,
// support-ticket and Auth effects are in-memory stubs. It makes no provider call.
import { reconcileStaleAccountDeletions } from "../lib/account-deletion-reconciler.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed += 1;
  else failed += 1;
}

const userId = "11111111-1111-4111-8111-111111111111";
let state = "billing_clean";
let supportDeletedAt: string | null = null;
let deliveryPolicySettledAt: string | null = null;
let authExists = true;
let deleteAttempts = 0;
const calls: string[] = [];

function sagaRow() {
  return {
    user_id: userId,
    state,
    support_deleted_at: supportDeletedAt,
    delivery_policy_settled_at: deliveryPolicySettledAt,
    reconcile_attempt_count: 0,
    reconcile_dead_lettered_at: null,
  };
}

function sagaQuery() {
  return {
    select() {
      return this;
    },
    in() {
      return this;
    },
    lt() {
      return this;
    },
    lte() {
      return this;
    },
    order() {
      return this;
    },
    async limit() {
      return state === "complete"
        ? { data: [], error: null }
        : { data: [sagaRow()], error: null };
    },
    eq() {
      return this;
    },
    is() {
      return this;
    },
    async maybeSingle() {
      return { data: sagaRow(), error: null };
    },
  };
}

function mirrorQuery() {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    async maybeSingle() {
      return { data: { email: "Old@Example.com" }, error: null };
    },
  };
}

const sb = {
  auth: {
    admin: {
      async getUserById(id: string) {
        calls.push(`auth:get:${id}`);
        if (!authExists) {
          return {
            data: null,
            error: { status: 404, message: "User not found" },
          };
        }
        return {
          data: {
            user: {
              id,
              email: "Reader@Example.com",
              email_confirmed_at: "2026-08-01T00:00:00.000Z",
            },
          },
          error: null,
        };
      },
      async deleteUser(id: string) {
        deleteAttempts += 1;
        calls.push(`auth:delete:${id}:${deleteAttempts}`);
        if (deleteAttempts === 1) {
          return {
            data: null,
            error: { status: 503, message: "transient Auth failure" },
          };
        }
        authExists = false;
        return { data: {}, error: null };
      },
    },
  },
  from(table: string) {
    if (table === "account_deletion_sagas") return sagaQuery();
    if (table === "users") return mirrorQuery();
    if (table === "support_tickets") {
      return {
        delete() {
          return {
            async eq(column: string, value: string) {
              calls.push(`support:eq:${column}:${value}`);
              return { error: null };
            },
            is(column: string, value: null) {
              return {
                async ilike(emailColumn: string, valuePattern: string) {
                  calls.push(
                    `support:ilike:${column}:${String(value)}:${emailColumn}:${valuePattern}`
                  );
                  return { error: null };
                },
              };
            },
          };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  },
  async rpc(name: string) {
    calls.push(`rpc:${name}`);
    if (name === "mark_account_deletion_support_deleted") {
      supportDeletedAt = "2026-08-28T00:00:00.000Z";
    } else if (name === "mark_account_deletion_delivery_policy_settled") {
      deliveryPolicySettledAt = "2026-08-28T00:00:01.000Z";
    } else if (name === "begin_account_deletion_auth_removal") {
      state = "auth_delete_started";
    } else if (name === "complete_account_deletion") {
      state = "complete";
    } else if (name === "fail_account_deletion_reconciliation") {
      // The in-memory query intentionally ignores wall-clock eligibility so
      // this test can exercise the later Auth retry in the same process.
      return { data: "deferred", error: null };
    } else {
      throw new Error(`unexpected RPC ${name}`);
    }
    return { data: true, error: null };
  },
};

const options = {
  nowIso: "2026-08-28T01:00:00.000Z",
};

console.log("(1) billing-clean privacy work resumes from exact confirmed Auth");
const first = await reconcileStaleAccountDeletions(sb as never, options);
check("(1a) Auth and the stale public mirror are both normalized for support cleanup", calls.some((call) => call.includes("support:ilike:user_id:null:email:reader@example.com")) && calls.some((call) => call.includes("support:ilike:user_id:null:email:old@example.com")));
check("(1b) linked and both exact-email support tickets are deleted", calls.some((call) => call.startsWith("support:eq:user_id:")) && calls.some((call) => call.includes("support:ilike:user_id:null:email:reader@example.com")) && calls.some((call) => call.includes("support:ilike:user_id:null:email:old@example.com")));
check("(1c) support cleanup and delivery policy settlement become durable", !!supportDeletedAt && !!deliveryPolicySettledAt);
check("(1d) the first Auth failure leaves the durable retry state", first.errors.length === 1 && state === "auth_delete_started" && authExists);
check(
  "(1e) a failed oldest saga gets a durable retry deadline so later rows stay eligible",
  calls.includes("rpc:fail_account_deletion_reconciliation")
);

console.log("(2) the next bounded run retries Auth without repeating privacy work");
const privacyCallCount = calls.filter(
  (call) => call.startsWith("support:") || call.includes("mark_account_deletion_")
).length;
const second = await reconcileStaleAccountDeletions(sb as never, options);
const privacyCallCountAfter = calls.filter(
  (call) => call.startsWith("support:") || call.includes("mark_account_deletion_")
).length;
check("(2a) the second Auth attempt succeeds", deleteAttempts === 2 && !authExists);
check("(2b) settled privacy work is not repeated", privacyCallCountAfter === privacyCallCount);
check("(2c) the same saga reaches complete", state === "complete" && second.completed === 1 && second.errors.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("ACCOUNT-DELETION RECONCILER VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ACCOUNT-DELETION RECONCILER ASSERTIONS PASS");
