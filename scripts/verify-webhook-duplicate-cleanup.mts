// Fully local webhook duplicate-cleanup checks. Provider and database calls are
// injected stubs. No environment file, network, provider, or database is used.
import { readFileSync } from "node:fs";
import {
  cancelWebhookDuplicateSubscription,
  webhookDuplicateCancellationIdempotencyKey,
  type WebhookDuplicateRefundReviewInput,
} from "../lib/refund-review.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed += 1;
  else failed += 1;
}

async function rejects(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return false;
  } catch {
    return true;
  }
}

function extractSqlFunctionBody(source: string, functionName: string): string {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${escapedName}\\s*\\(`,
    "i"
  ).exec(source);
  if (!declaration || declaration.index === undefined) {
    throw new Error(`SQL function ${functionName} was not found`);
  }
  const functionSource = source.slice(declaration.index);
  const bodyMarker = /\bas\s+\$\$/i.exec(functionSource);
  if (!bodyMarker || bodyMarker.index === undefined) {
    throw new Error(`SQL function ${functionName} has no body`);
  }
  const bodyStart = bodyMarker.index + bodyMarker[0].length;
  const bodyEnd = functionSource.indexOf("$$;", bodyStart);
  if (bodyEnd < 0) throw new Error(`SQL function ${functionName} has no end`);
  return functionSource
    .slice(bodyStart, bodyEnd)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");
}

type Snapshot = {
  id: string;
  customer: string | { id: string };
  status: string;
  exactAlpha: boolean;
};

const input: WebhookDuplicateRefundReviewInput = {
  sessionId: "cs_alpha_duplicate",
  userId: "11111111-1111-4111-8111-111111111111",
  emailHash: "a".repeat(64),
  weekOf: "2026-08-29",
  loser: {
    customerId: "cus_loser",
    subscriptionId: "sub_loser",
  },
  winner: {
    customerId: "cus_winner",
    subscriptionId: "sub_winner",
  },
};
const liveLoser: Snapshot = {
  id: input.loser.subscriptionId,
  customer: input.loser.customerId,
  status: "active",
  exactAlpha: true,
};
const terminalLoser: Snapshot = {
  ...liveLoser,
  customer: { id: input.loser.customerId },
  status: "canceled",
};
const isExactAlphaSubscription = (subscription: Snapshot) =>
  subscription.exactAlpha;
const isTerminalSubscriptionStatus = (status: string) =>
  status === "canceled" || status === "incomplete_expired";

console.log("(1) locked review precedes exact provider mutation");
const orderedEvents: string[] = [];
const rpcCalls: Array<{ name: string; args: unknown }> = [];
let happyCancellationKey = "";
const happyResult = await cancelWebhookDuplicateSubscription(
  {
    rpc: async (name: string, args: unknown) => {
      orderedEvents.push("review");
      rpcCalls.push({ name, args });
      return { data: true, error: null };
    },
  } as never,
  input,
  {
    retrieveSubscription: async () => {
      orderedEvents.push("retrieve");
      return liveLoser;
    },
    cancelSubscription: async (_subscriptionId, idempotencyKey) => {
      orderedEvents.push("cancel");
      happyCancellationKey = idempotencyKey;
      return terminalLoser;
    },
    isExactAlphaSubscription,
    isTerminalSubscriptionStatus,
  }
);
check(
  "(1a) winner-aware locked RPC is the first effect",
  orderedEvents.join(",") === "review,retrieve,cancel" &&
    rpcCalls[0]?.name === "record_webhook_duplicate_refund_review"
);
check(
  "(1b) RPC receives the exact owner, loser, and stored winner pairs",
  JSON.stringify(rpcCalls[0]?.args) ===
    JSON.stringify({
      p_session_id: input.sessionId,
      p_user_id: input.userId,
      p_email_hash: input.emailHash,
      p_week_of: input.weekOf,
      p_loser_customer_id: input.loser.customerId,
      p_loser_subscription_id: input.loser.subscriptionId,
      p_winner_customer_id: input.winner.customerId,
      p_winner_subscription_id: input.winner.subscriptionId,
    })
);
check(
  "(1c) exact terminal cancellation succeeds with the stable key",
  happyResult.cancelled &&
    happyResult.subscription === terminalLoser &&
    happyCancellationKey ===
      webhookDuplicateCancellationIdempotencyKey(
        input.sessionId,
        input.loser.subscriptionId
      )
);

console.log("(2) retries are stable and terminal replays do not mutate");
const stableKey = webhookDuplicateCancellationIdempotencyKey(
  input.sessionId,
  input.loser.subscriptionId
);
check(
  "(2a) Session/subscription identity produces one bounded deterministic key",
  stableKey ===
    webhookDuplicateCancellationIdempotencyKey(
      input.sessionId,
      input.loser.subscriptionId
    ) &&
    stableKey !==
      webhookDuplicateCancellationIdempotencyKey(
        `${input.sessionId}-other`,
        input.loser.subscriptionId
      ) &&
    stableKey.length <= 255
);
let terminalCancelCalls = 0;
const terminalReplay = await cancelWebhookDuplicateSubscription(
  { rpc: async () => ({ data: true, error: null }) } as never,
  input,
  {
    retrieveSubscription: async () => terminalLoser,
    cancelSubscription: async () => {
      terminalCancelCalls += 1;
      return terminalLoser;
    },
    isExactAlphaSubscription,
    isTerminalSubscriptionStatus,
  }
);
check(
  "(2b) an exact terminal loser skips a repeated provider cancellation",
  !terminalReplay.cancelled && terminalCancelCalls === 0
);
const retryKeys: string[] = [];
for (let attempt = 0; attempt < 2; attempt += 1) {
  await cancelWebhookDuplicateSubscription(
    { rpc: async () => ({ data: true, error: null }) } as never,
    input,
    {
      retrieveSubscription: async () => liveLoser,
      cancelSubscription: async (_subscriptionId, idempotencyKey) => {
        retryKeys.push(idempotencyKey);
        return terminalLoser;
      },
      isExactAlphaSubscription,
      isTerminalSubscriptionStatus,
    }
  );
}
check(
  "(2c) repeated webhook attempts reuse the same provider idempotency key",
  retryKeys.length === 2 && retryKeys[0] === retryKeys[1]
);

console.log("(3) authorization and exact-shape drift fail closed");
for (const rpcResult of [
  { data: false, error: null },
  { data: null, error: { message: "database unavailable" } },
]) {
  let providerCalls = 0;
  const rejected = await rejects(() =>
    cancelWebhookDuplicateSubscription(
      { rpc: async () => rpcResult } as never,
      input,
      {
        retrieveSubscription: async () => {
          providerCalls += 1;
          return liveLoser;
        },
        cancelSubscription: async () => {
          providerCalls += 1;
          return terminalLoser;
        },
        isExactAlphaSubscription,
        isTerminalSubscriptionStatus,
      }
    )
  );
  check(
    `(3${rpcResult.error ? "b" : "a"}) denied review cannot reach the provider`,
    rejected && providerCalls === 0
  );
}

const preCancelDrifts: Array<{ label: string; subscription: Snapshot }> = [
  {
    label: "loser subscription id drift",
    subscription: { ...liveLoser, id: "sub_other" },
  },
  {
    label: "loser Customer drift",
    subscription: { ...liveLoser, customer: "cus_other" },
  },
  {
    label: "loser Alpha item-shape drift",
    subscription: { ...liveLoser, exactAlpha: false },
  },
];
for (const [index, drift] of preCancelDrifts.entries()) {
  let cancelCalls = 0;
  const rejected = await rejects(() =>
    cancelWebhookDuplicateSubscription(
      { rpc: async () => ({ data: true, error: null }) } as never,
      input,
      {
        retrieveSubscription: async () => drift.subscription,
        cancelSubscription: async () => {
          cancelCalls += 1;
          return terminalLoser;
        },
        isExactAlphaSubscription,
        isTerminalSubscriptionStatus,
      }
    )
  );
  check(
    `(3${String.fromCharCode(99 + index)}) ${drift.label} blocks cancellation`,
    rejected && cancelCalls === 0
  );
}

const terminalResultDrifts: Array<{ label: string; subscription: Snapshot }> = [
  {
    label: "nonterminal cancellation result",
    subscription: liveLoser,
  },
  {
    label: "wrong cancellation Customer",
    subscription: { ...terminalLoser, customer: "cus_other" },
  },
  {
    label: "wrong cancellation subscription",
    subscription: { ...terminalLoser, id: "sub_other" },
  },
  {
    label: "changed cancellation item shape",
    subscription: { ...terminalLoser, exactAlpha: false },
  },
];
for (const [index, drift] of terminalResultDrifts.entries()) {
  const rejected = await rejects(() =>
    cancelWebhookDuplicateSubscription(
      { rpc: async () => ({ data: true, error: null }) } as never,
      input,
      {
        retrieveSubscription: async () => liveLoser,
        cancelSubscription: async () => drift.subscription,
        isExactAlphaSubscription,
        isTerminalSubscriptionStatus,
      }
    )
  );
  check(
    `(3${String.fromCharCode(102 + index)}) ${drift.label} is rejected`,
    rejected
  );
}

let malformedProviderCalls = 0;
const malformedRejected = await rejects(() =>
  cancelWebhookDuplicateSubscription(
    { rpc: async () => ({ data: true, error: null }) } as never,
    { ...input, winner: input.loser },
    {
      retrieveSubscription: async () => {
        malformedProviderCalls += 1;
        return liveLoser;
      },
      cancelSubscription: async () => {
        malformedProviderCalls += 1;
        return terminalLoser;
      },
      isExactAlphaSubscription,
      isTerminalSubscriptionStatus,
    }
  )
);
check(
  "(3j) a winner equal to the loser is rejected before provider work",
  malformedRejected && malformedProviderCalls === 0
);

console.log("(4) SQL and route retain the same exact authority");
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260827000000_checkout_fulfillment_claims.sql",
    import.meta.url
  ),
  "utf8"
);
const route = readFileSync(
  new URL("../app/api/stripe/webhook/route.ts", import.meta.url),
  "utf8"
);
const legacyMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260827030000_legacy_checkout_fulfillments.sql",
    import.meta.url
  ),
  "utf8"
);
const rpcBody = extractSqlFunctionBody(
  migration,
  "record_webhook_duplicate_refund_review"
);
const conflictBody = rpcBody.slice(rpcBody.indexOf("on conflict"));
const legacyAbortBody = extractSqlFunctionBody(
  legacyMigration,
  "abort_legacy_checkout_fulfillment"
);
check(
  "(4a) RPC locks the owner and both exact billing pairs before review insert",
  rpcBody.indexOf("hashtextextended(p_user_id::text, 80425080)") >= 0 &&
    rpcBody.indexOf("hashtextextended(v_customer_a, 80425082)") >= 0 &&
    rpcBody.indexOf("hashtextextended(v_pair_a, 80425081)") >= 0 &&
    rpcBody.indexOf("hashtextextended(v_pair_a, 80425081)") <
      rpcBody.indexOf("insert into public.refund_reviews")
);
check(
  "(4b) RPC re-reads and locks the exact stored canonical winner",
  /from public\.users u[\s\S]*where u\.id = p_user_id[\s\S]*for update/.test(
    rpcBody
  ) &&
    rpcBody.includes(
      "v_user.stripe_customer_id is distinct from p_winner_customer_id"
    ) &&
    rpcBody.includes(
      "v_user.stripe_subscription_id is distinct from p_winner_subscription_id"
    )
);
check(
  "(4c) existing review reasons survive winner attachment and exact replays",
  conflictBody.includes("winner_subscription_id = coalesce(") &&
    conflictBody.includes("winner_customer_id = coalesce(") &&
    !/\breason\s*=/.test(conflictBody)
);
check(
  "(4d) conflicting existing winner pairs cannot be overwritten",
  /winner_customer_id is null[\s\S]*winner_customer_id = excluded\.winner_customer_id[\s\S]*winner_subscription_id =[\s\S]*excluded\.winner_subscription_id/.test(
    conflictBody
  )
);
check(
  "(4e) deletion, any foreign owner, and an unowned loser deny authorization",
  rpcBody.includes("from public.account_deletion_sagas") &&
    rpcBody.includes("u.id <> p_user_id") &&
    rpcBody.includes("p.owner_user_id is not null") &&
    rpcBody.includes("p.owner_user_id <> p_user_id") &&
    rpcBody.includes("p.provisioned_user_id is not null") &&
    rpcBody.includes("p.provisioned_user_id <> p_user_id") &&
    rpcBody.includes("p.owner_user_id is distinct from p_user_id") &&
    rpcBody.includes("p.provisioned_user_id is distinct from p_user_id")
);
check(
  "(4f) RPC has only the exact service-role signature",
  /revoke all on function public\.record_webhook_duplicate_refund_review\(text, uuid, text, date, text, text, text, text\)[\s\S]*from public, anon, authenticated/.test(
    migration
  ) &&
    /grant execute on function public\.record_webhook_duplicate_refund_review\(text, uuid, text, date, text, text, text, text\)[\s\S]*to service_role/.test(
      migration
    )
);
const duplicateBranch = route.slice(
  route.indexOf("if (priorLiveExactAlphaBinding)"),
  route.indexOf("const checkoutStartedAtIso")
);
check(
  "(4g) route builds the winner only from the exact stored existing pair",
  route.includes("!existing.stripe_customer_id") &&
    route.includes("priorCustomerId !== existing.stripe_customer_id") &&
    route.includes("customerId: existing.stripe_customer_id") &&
    route.includes("subscriptionId: existing.stripe_subscription_id")
);
check(
  "(4h) duplicate branch uses the shared locked helper and no generic review",
  duplicateBranch.includes("cancelWebhookDuplicateSubscription(") &&
    duplicateBranch.includes("winner: priorLiveExactAlphaBinding") &&
    duplicateBranch.includes("emailHash: checkoutEmailBinding(accountEmail)") &&
    duplicateBranch.includes("weekOf: new Date(session.created * 1000)") &&
    duplicateBranch.includes("{ idempotencyKey }") &&
    !duplicateBranch.includes("recordRefundReview(") &&
    !duplicateBranch.includes("stripe.subscriptions.cancel(subId)")
);
check(
  "(4i) no-profile webhook duplicates atomically create a finalizer-owned exact row",
  rpcBody.includes("v_current_cleanup_owned") &&
    rpcBody.includes("insert into public.legacy_checkout_fulfillments") &&
    rpcBody.indexOf("insert into public.legacy_checkout_fulfillments") <
      rpcBody.indexOf("insert into public.refund_reviews") &&
    rpcBody.includes("l.session_id = p_session_id") &&
    rpcBody.includes("l.user_id = p_user_id") &&
    rpcBody.includes("l.stripe_customer_id = p_loser_customer_id") &&
    rpcBody.includes("l.stripe_subscription_id = p_loser_subscription_id") &&
    rpcBody.includes("raise exception 'webhook duplicate refund review conflict'")
);
check(
  "(4j) only unprovisioned staged duplicates stay in current recovery",
  /from public\.checkout_profiles p[\s\S]*p\.stripe_session_id = p_session_id[\s\S]*p\.stripe_customer_id = p_loser_customer_id[\s\S]*p\.stripe_subscription_id = p_loser_subscription_id[\s\S]*p\.billing_state in \('open', 'paid', 'recovering'\)/.test(
    rpcBody
  ) &&
    rpcBody.includes("p.owner_user_id = p_user_id") &&
    rpcBody.includes("p.provisioned_user_id is null") &&
    rpcBody.includes("if not v_current_cleanup_owned then")
);
check(
  "(4k) a provisioned loser is routed to the fallback row and atomically ended after terminal proof",
  rpcBody.includes("p.provisioned_user_id is null") &&
    /from public\.checkout_profiles p[\s\S]*p\.stripe_session_id = p_session_id[\s\S]*p\.stripe_customer_id = p_stripe_customer_id[\s\S]*p\.stripe_subscription_id = p_stripe_subscription_id[\s\S]*for update/.test(
      legacyAbortBody
    ) &&
    legacyAbortBody.includes(
      "v_current_profile.provisioned_user_id is distinct from v_user_id"
    ) &&
    /update public\.checkout_profiles p[\s\S]*billing_state = 'ended'[\s\S]*p\.provisioned_user_id = v_user_id[\s\S]*p\.billing_state in \('open', 'paid', 'recovering'\)/.test(
      legacyAbortBody
    ) &&
    legacyAbortBody.indexOf("update public.checkout_profiles p") <
      legacyAbortBody.indexOf("update public.legacy_checkout_fulfillments")
);
check(
  "(4l) adopted legacy obligation already has bounded finalization, freeze, deadletter, and requeue",
  legacyMigration.includes("create trigger users_block_legacy_duplicate_winner_mutation") &&
    legacyMigration.includes("create or replace function public.list_stale_pending_legacy_fulfillments") &&
    legacyMigration.includes("reconcile_attempt_count between 0 and 8") &&
    legacyMigration.includes("reconcile_dead_lettered_at") &&
    legacyMigration.includes("create or replace function public.requeue_legacy_checkout_fulfillment") &&
    legacyMigration.includes("create or replace function public.count_dead_lettered_legacy_checkout_fulfillments")
);

console.log("(5) nullable SQL inputs fail closed before state changes");
const stageCheckoutProfileBody = extractSqlFunctionBody(
  migration,
  "stage_checkout_profile"
);
const settleSessionReplayBody = extractSqlFunctionBody(
  migration,
  "settle_checkout_session_creation_replay"
);
const settleDeletionProfileBody = extractSqlFunctionBody(
  migration,
  "settle_account_deletion_checkout_profile"
);
const recordRefundReviewBody = extractSqlFunctionBody(
  migration,
  "record_refund_review"
);
const settleRecoveryBody = extractSqlFunctionBody(
  migration,
  "settle_checkout_profile_recovery"
);
const failRecoveryBody = extractSqlFunctionBody(
  migration,
  "fail_checkout_profile_recovery"
);
const deferRecoveryBody = extractSqlFunctionBody(
  migration,
  "defer_checkout_profile_recovery_candidate"
);
const claimFulfillmentBody = extractSqlFunctionBody(
  migration,
  "claim_checkout_fulfillment"
);
const prepareAccountDeletionBody = extractSqlFunctionBody(
  migration,
  "prepare_account_deletion"
);
const currentDeletionReviewStart = prepareAccountDeletionBody.indexOf(
  "insert into public.refund_reviews"
);
const currentDeletionReviewEnd = prepareAccountDeletionBody.indexOf(
  "insert into public.refund_reviews",
  currentDeletionReviewStart + 1
);
const currentDeletionReviewBody = prepareAccountDeletionBody.slice(
  currentDeletionReviewStart,
  currentDeletionReviewEnd
);
check(
  "(5a) staging requires a profile id and exact SHA-256 email and browser bindings",
  stageCheckoutProfileBody.includes("p_id is null") &&
    stageCheckoutProfileBody.includes("p_email_hash is null") &&
    stageCheckoutProfileBody.includes(
      "p_email_hash !~ '^[0-9a-f]{64}$'"
    ) &&
    stageCheckoutProfileBody.includes("p_browser_nonce_hash is null") &&
    stageCheckoutProfileBody.includes(
      "p_browser_nonce_hash !~ '^[0-9a-f]{64}$'"
    )
);
check(
  "(5b) session-replay terminal reason rejects NULL before comparison",
  settleSessionReplayBody.includes("p_terminal_reason is null") &&
    settleSessionReplayBody.indexOf("p_terminal_reason is null") <
      settleSessionReplayBody.indexOf(
        "p_terminal_reason <> 'provider_rejected_expired_params'"
      )
);
check(
  "(5c) deletion and recovery terminal states both reject NULL",
  settleDeletionProfileBody.includes("p_terminal_state is null") &&
    settleRecoveryBody.includes("p_terminal_state is null")
);
check(
  "(5d) generic refund reasons reject NULL before the allowlist",
  recordRefundReviewBody.includes("p_reason is null") &&
    recordRefundReviewBody.indexOf("p_reason is null") <
      recordRefundReviewBody.indexOf("p_reason not in")
);
check(
  "(5e) leased recovery errors reject NULL before the allowlist",
  failRecoveryBody.includes("p_error_code is null") &&
    failRecoveryBody.indexOf("p_error_code is null") <
      failRecoveryBody.indexOf("p_error_code not in")
);
check(
  "(5f) candidate deferral rejects NULL state and error decisions",
  deferRecoveryBody.includes("p_expected_billing_state is null") &&
    deferRecoveryBody.includes("p_error_code is null") &&
    deferRecoveryBody.indexOf("p_expected_billing_state is null") <
      deferRecoveryBody.indexOf("p_expected_billing_state not in") &&
    deferRecoveryBody.indexOf("p_error_code is null") <
      deferRecoveryBody.indexOf("p_error_code not in")
);
check(
  "(5g) checkout fulfillment claims reject a NULL email hash",
  claimFulfillmentBody.includes("p_email_hash is null") &&
    claimFulfillmentBody.indexOf("p_email_hash is null") <
      claimFulfillmentBody.indexOf("p_email_hash !~ '^[0-9a-f]{64}$'")
);
check(
  "(5h) deletion preserves review for an exact pending first-letter after webhook provisioning",
  currentDeletionReviewBody.includes("p.provisioned_user_id is null") &&
    currentDeletionReviewBody.includes("from public.checkout_fulfillments f") &&
    currentDeletionReviewBody.includes("f.profile_id = p.id") &&
    currentDeletionReviewBody.includes("f.session_id = p.stripe_session_id") &&
    currentDeletionReviewBody.includes("f.status = 'pending'") &&
    !currentDeletionReviewBody.includes("f.status = 'completed'") &&
    currentDeletionReviewBody.includes("p.stripe_customer_id is not null") &&
    currentDeletionReviewBody.includes("p.stripe_subscription_id is not null") &&
    currentDeletionReviewStart <
      prepareAccountDeletionBody.indexOf(
        "update public.checkout_fulfillments f"
      )
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("WEBHOOK DUPLICATE CLEANUP VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL WEBHOOK DUPLICATE CLEANUP ASSERTIONS PASS");
