// Fully local checkout-recovery checks with injected Stripe stubs. No env
// file, provider, database, or network call is made.
import { readFileSync } from "node:fs";
import type Stripe from "stripe";
import {
  CheckoutRecoveryFailure,
  classifyPriorRecoveryBinding,
  checkoutRecoveryRetryAt,
  cleanupCurrentCheckoutDuplicate,
  currentCheckoutDuplicateCancellationIdempotencyKey,
  reconcileOverdueCheckoutProfiles,
  resolveCurrentCheckoutCompletionConflict,
  type CurrentCheckoutBillingPair,
  type CurrentCheckoutDuplicateCleanupDependencies,
  type CurrentCheckoutDuplicateCleanupInput,
} from "../lib/checkout-recovery.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed += 1;
  else failed += 1;
}

function subscription(input: {
  id?: string;
  customer?: string;
  status: Stripe.Subscription.Status;
  alpha?: boolean;
}): Stripe.Subscription {
  return {
    id: input.id ?? "sub_old",
    customer: input.customer ?? "cus_old",
    status: input.status,
    items: {
      has_more: false,
      data: input.alpha === false
        ? [{ price: { id: "price_other" }, quantity: 1 }]
        : [{ price: { id: "price_1TWfeHAhrDpDN9sHC2Ay0w7h" }, quantity: 1 }],
    },
  } as never;
}

function stripeStub(options: {
  retrieved?: Stripe.Subscription;
  retrieveError?: unknown;
  listed?: Stripe.Subscription[];
}): Stripe {
  return {
    subscriptions: {
      retrieve: async () => {
        if (options.retrieveError) throw options.retrieveError;
        if (!options.retrieved) throw new Error("missing stub subscription");
        return options.retrieved;
      },
      list: async () => ({
        object: "list",
        url: "/v1/subscriptions",
        has_more: false,
        data: options.listed ?? [],
      }),
    },
  } as never;
}

async function rejects(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof CheckoutRecoveryFailure ? error.code : "unknown";
  }
}

function sqlFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`missing SQL function ${name}`);
  const bodyStart = source.indexOf("as $$", start);
  const end = source.indexOf("$$;", bodyStart + 5);
  if (bodyStart < 0 || end < 0) {
    throw new Error(`incomplete SQL function ${name}`);
  }
  return source.slice(start, end + 3);
}

const prior = { customerId: "cus_old", subscriptionId: "sub_old" };
const next = { customerId: "cus_new", subscriptionId: "sub_new" };

console.log("(1) prior exact billing replacement needs fresh terminal proof");
check(
  "(1a) a freshly terminal exact prior pair is replaceable",
  (await classifyPriorRecoveryBinding(
    stripeStub({ retrieved: subscription({ status: "canceled" }) }),
    prior,
    next
  )) === "replaceable"
);
check(
  "(1b) a complete Alpha-absent prior item list is replaceable",
  (await classifyPriorRecoveryBinding(
    stripeStub({
      retrieved: subscription({ status: "active", alpha: false }),
    }),
    prior,
    next
  )) === "replaceable"
);
for (const status of ["active", "incomplete", "paused", "unpaid"] as const) {
  check(
    `(1c) ${status} exact Alpha remains fail-closed`,
    await rejects(
      classifyPriorRecoveryBinding(
        stripeStub({ retrieved: subscription({ status }) }),
        prior,
        next
      )
    )
  );
}
check(
  "(1d) resource_missing needs complete Customer-level no-Alpha proof",
  (await classifyPriorRecoveryBinding(
    stripeStub({
      retrieveError: { code: "resource_missing" },
      listed: [],
    }),
    prior,
    next
  )) === "replaceable"
);
check(
  "(1e) a nonterminal Customer-level Alpha result blocks replacement",
  await rejects(
    classifyPriorRecoveryBinding(
      stripeStub({
        retrieveError: { code: "resource_missing" },
        listed: [subscription({ status: "unpaid" })],
      }),
      prior,
      next
    )
  )
);

console.log("(2) token-gated SQL preserves newer access revocation");
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260827000000_checkout_fulfillment_claims.sql",
    import.meta.url
  ),
  "utf8"
);
const recovery = readFileSync(
  new URL("../lib/checkout-recovery.ts", import.meta.url),
  "utf8"
);
const maintenanceMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260827030000_legacy_checkout_fulfillments.sql",
    import.meta.url
  ),
  "utf8"
);
const generateRoute = readFileSync(
  new URL("../app/api/generate/route.ts", import.meta.url),
  "utf8"
);
const failRecoveryBody = sqlFunctionBody(
  migration,
  "fail_checkout_profile_recovery"
);
const deferRecoveryBody = sqlFunctionBody(
  migration,
  "defer_checkout_profile_recovery_candidate"
);
const requeueRecoveryBody = sqlFunctionBody(
  migration,
  "requeue_checkout_profile_recovery"
);
const claimFulfillmentBody = sqlFunctionBody(
  migration,
  "claim_checkout_fulfillment"
);
const recordDuplicateBody = sqlFunctionBody(
  migration,
  "record_current_checkout_duplicate_refund_review"
);
const abortDuplicateBody = sqlFunctionBody(
  migration,
  "abort_current_checkout_duplicate_fulfillment"
);
check(
  "(2a) recovery compare-and-sets the exact prior pair under its lease",
  /recover_checkout_profile_provisioning[\s\S]*p_prior_binding_replaceable[\s\S]*u\.stripe_customer_id is not distinct from p_prior_customer_id[\s\S]*u\.stripe_subscription_id is not distinct from p_prior_subscription_id/.test(
    migration
  )
);
check(
  "(2f) pre-claim poison rows receive bounded coded deferrals",
  migration.includes("defer_checkout_profile_recovery_candidate") &&
    migration.includes(
      "p.owner_user_id is not distinct from p_expected_owner_user_id"
    ) &&
    migration.includes(
      "p.stripe_customer_id is not distinct from p_expected_customer_id"
    ) &&
    migration.includes(
      "p.stripe_subscription_id is not distinct from p_expected_subscription_id"
    ) &&
    migration.includes("recovery_lease_expires_at = p_retry_at") &&
    migration.includes("p_error_code text") &&
    migration.includes("recovery_attempt_count = v_next_attempt") &&
    recovery.includes("await deferRecoveryCandidate") &&
    recovery.includes(
      "const CHECKOUT_RECOVERY_RETRY_MINUTES = [5, 15, 60, 180, 360, 720, 1440]"
    ) &&
    /billing_state in \('open', 'paid'\)[\s\S]*recovery_lease_expires_at is null[\s\S]*recovery_lease_expires_at <= p_now/.test(
      maintenanceMigration
    )
);
check(
  "(2b) same-pair replay clears only revocations at or before immutable checkout start",
  /u\.cancelled_at <= v_profile\.session_creation_started_at then null/.test(
    migration
  ) &&
    /u\.cancelled_at <= p_checkout_started_at then null/.test(migration)
);
check(
  "(2c) incomplete, paused, and unpaid bind without granting access or cancellation",
  migration.includes("when not p_grant_access") &&
    migration.includes("'recovered_no_access'") &&
    recovery.includes("subscriptionStatusGrantsAccess(subscription.status)") &&
    !recovery.includes("exact unpaid Alpha cancellation")
);
check(
  "(2d) delayed old-pair cancellation cannot carry onto either replacement grant",
  /recover_checkout_profile_provisioning[\s\S]*cancelled_at = case[\s\S]*when p_prior_binding_replaceable[\s\S]*p_prior_customer_id is distinct from p_customer_id[\s\S]*p_prior_subscription_id is distinct from p_subscription_id[\s\S]*then null[\s\S]*u\.cancelled_at <= v_profile\.session_creation_started_at then null/.test(
    migration
  ) &&
    /complete_checkout_fulfillment[\s\S]*cancelled_at = case[\s\S]*when p_prior_binding_replaceable[\s\S]*p_prior_customer_id is distinct from p_customer_id[\s\S]*p_prior_subscription_id is distinct from p_subscription_id[\s\S]*then null[\s\S]*u\.cancelled_at <= p_checkout_started_at then null/.test(
      migration
    )
);
check(
  "(2e) failed recovery uses a bounded retry counter and dead-letter cap",
  /fail_checkout_profile_recovery[\s\S]*v_next_attempt := least\(8,[\s\S]*recovery_dead_lettered_at = now\(\)[\s\S]*recovery_lease_expires_at = p_retry_at/.test(
    migration
  ) &&
    recovery.includes("fail_checkout_profile_recovery") &&
    recovery.includes('p_error_code: errorCode') &&
    recovery.includes('.is("recovery_dead_lettered_at", null)') &&
    recovery.includes(
      "recovery_lease_expires_at.is.null,recovery_lease_expires_at.lte"
    )
);
check(
  "(2g) fail and defer RPC signatures are closed to service-role execution",
  migration.includes(
    "revoke all on function public.fail_checkout_profile_recovery(uuid, uuid, text, timestamptz)"
  ) &&
    migration.includes(
      "grant execute on function public.fail_checkout_profile_recovery(uuid, uuid, text, timestamptz)"
    ) &&
    migration.includes(
      "revoke all on function public.defer_checkout_profile_recovery_candidate(uuid, uuid, text, text, text, timestamptz, uuid, text, timestamptz)"
    ) &&
    migration.includes(
      "grant execute on function public.defer_checkout_profile_recovery_candidate(uuid, uuid, text, text, text, timestamptz, uuid, text, timestamptz)"
    ) &&
    deferRecoveryBody.includes("p_error_code text") &&
    deferRecoveryBody.includes("p_retry_at timestamptz") &&
    recovery.includes('p_error_code: errorCode') &&
    recovery.includes('p_retry_at: retryAtIso')
);
check(
  "(2h) every claimed failure consumes only a still-live recovery lease",
  failRecoveryBody.includes(
    "v_profile.recovery_lease_expires_at <= now()"
  ) &&
    /where p\.id = p_profile_id[\s\S]*p\.recovery_lease_token = p_lease_token[\s\S]*p\.recovery_lease_expires_at > now\(\)/.test(
      failRecoveryBody
    )
);
check(
  "(2i) dead-letter escalation scrubs fulfillment identity and requeue restores only retry eligibility",
  /status = 'aborted'[\s\S]*email_hash = null[\s\S]*user_id = null[\s\S]*identity_scrubbed_at/.test(
    failRecoveryBody
  ) &&
    requeueRecoveryBody.includes("recovery_attempt_count = 0") &&
    requeueRecoveryBody.includes("recovery_last_error_code = null") &&
    requeueRecoveryBody.includes("recovery_dead_lettered_at = null") &&
    requeueRecoveryBody.includes("expires_at = now()") &&
    !requeueRecoveryBody.includes("update public.checkout_fulfillments") &&
    migration.includes(
      "grant execute on function public.requeue_checkout_profile_recovery(uuid)"
    )
);
check(
  "(2j) browser replay cannot reclaim durable cleanup or dead-letter work",
  claimFulfillmentBody.includes("'cleanup_pending'::text") &&
    claimFulfillmentBody.includes("'manual_review'::text") &&
    generateRoute.includes('claim.decision === "cleanup_pending"') &&
    generateRoute.includes('claim.decision === "manual_review"') &&
    generateRoute.includes('error: "checkout_unavailable"')
);
check(
  "(2k) duplicate winner proof attaches without rewriting an existing refund reason",
  /on conflict \(session_id, subscription_id\) do update[\s\S]*winner_subscription_id = coalesce[\s\S]*winner_customer_id = coalesce/.test(
    recordDuplicateBody
  ) &&
    !/do update[\s\S]*set[\s\S]*reason\s*=/.test(recordDuplicateBody) &&
    recovery.includes(
      '"session_id, customer_id, subscription_id, reason, winner_customer_id, winner_subscription_id"'
    )
);
check(
  "(2l) operator requeue can finish cleanup from a scrubbed fulfillment without restoring PII",
  recordDuplicateBody.includes("v_fulfillment_scrubbed") &&
    recordDuplicateBody.includes("or v_fulfillment_scrubbed") &&
    abortDuplicateBody.includes("v_fulfillment_scrubbed") &&
    abortDuplicateBody.includes("or v_fulfillment_scrubbed")
);
check(
  "(2m) scheduled recovery can record and abort an exact duplicate when no fulfillment row ever existed",
  recordDuplicateBody.includes("v_fulfillment_found boolean := false") &&
    /v_recovery_mode := coalesce\([\s\S]*v_profile\.recovery_lease_expires_at > now\(\)[\s\S]*not v_fulfillment_found/.test(
      recordDuplicateBody
    ) &&
    abortDuplicateBody.includes("v_fulfillment_found boolean := false") &&
    /v_recovery_mode := coalesce\([\s\S]*v_profile\.recovery_lease_expires_at > now\(\)[\s\S]*not v_fulfillment_found/.test(
      abortDuplicateBody
    ) &&
    abortDuplicateBody.includes(
      "if v_fulfillment_found and not v_fulfillment_scrubbed then"
    )
);

console.log("(3) direct checkout completion reuses the same prior-pair proof");
check(
  "(3a) generation classifies the prior exact pair after taking the durable lease",
  /activeCheckoutClaim = claim;[\s\S]*activeCheckoutClaim = await authorizeCheckoutCompletionBinding\([\s\S]*paid,[\s\S]*claim[\s\S]*\)/.test(
    generateRoute
  ) &&
    generateRoute.includes("classifyPriorRecoveryBinding")
);
check(
  "(3b) the completion RPC receives both prior ids and the fresh replaceable decision",
  generateRoute.includes("p_prior_customer_id: claim.priorCustomerId") &&
    generateRoute.includes(
      "p_prior_subscription_id: claim.priorSubscriptionId"
    ) &&
    generateRoute.includes(
      "p_prior_binding_replaceable: claim.priorBindingReplaceable"
    )
);
check(
  "(3c) the atomic completion compares the exact old pair before installing the new one",
  /complete_checkout_fulfillment[\s\S]*p_prior_binding_replaceable boolean[\s\S]*u\.stripe_customer_id is not distinct from p_prior_customer_id[\s\S]*u\.stripe_subscription_id is not distinct from p_prior_subscription_id/.test(
    migration
  ) &&
    migration.includes(
      "complete_checkout_fulfillment(text, uuid, uuid, uuid, text, text, timestamptz, text, text, boolean)"
    )
);

console.log("(4) a legacy winner appearing after authorization cannot strand the current loser");
{
  const currentLoser = {
    customerId: "cus_current_loser",
    subscriptionId: "sub_current_loser",
  };
  const legacyWinner = {
    customerId: "cus_legacy_winner",
    subscriptionId: "sub_legacy_winner",
  };
  let canonical: typeof legacyWinner | null = null;
  const earlyAuthorizationSaw = canonical;
  canonical = legacyWinner;
  const cancelled: string[] = [];
  const duplicateStopped = new Error("duplicate stopped");
  let observedError: unknown;
  try {
    await resolveCurrentCheckoutCompletionConflict({
      loadWinner: async () => canonical,
      classifyWinner: async (winner) =>
        winner?.subscriptionId === legacyWinner.subscriptionId
          ? "duplicate_live_alpha"
          : "blocked",
      cancelLosing: async () => {
        cancelled.push(currentLoser.subscriptionId);
        throw duplicateStopped;
      },
      completionError: new Error("final billing CAS changed"),
    });
  } catch (error) {
    observedError = error;
  }
  check(
    "(4a) final-CAS recovery re-reads the winner and routes only the loser to cancellation",
    earlyAuthorizationSaw === null &&
      observedError === duplicateStopped &&
      cancelled.join(",") === currentLoser.subscriptionId &&
      cancelled[0] !== canonical?.subscriptionId
  );
  check(
    "(4b) the generate route invokes late conflict recovery inside the final completion catch",
    /try\s*\{[\s\S]*completeCheckoutFulfillment\([\s\S]*catch \(completionError\)[\s\S]*resolveLateCheckoutCompletionConflict\([\s\S]*completionError/.test(
      generateRoute
    ) &&
      generateRoute.includes("resolveCurrentCheckoutCompletionConflict") &&
      generateRoute.includes("cleanupCurrentCheckoutDuplicate") &&
      generateRoute.includes("currentCheckoutDuplicateCleanupDependencies")
  );
}

console.log("(5) shared duplicate cleanup fails closed across provider and binding drift");
{
  const loser: CurrentCheckoutBillingPair = {
    customerId: "cus_current_loser",
    subscriptionId: "sub_current_loser",
  };
  const winner: CurrentCheckoutBillingPair = {
    customerId: "cus_canonical_winner",
    subscriptionId: "sub_canonical_winner",
  };
  const input: CurrentCheckoutDuplicateCleanupInput = {
    sessionId: "cs_current_duplicate",
    profileId: "22222222-2222-4222-8222-222222222222",
    leaseToken: "33333333-3333-4333-8333-333333333333",
    userId: "11111111-1111-4111-8111-111111111111",
    loser,
  };
  type HarnessOptions = {
    review?: {
      sessionId: string;
      loser: CurrentCheckoutBillingPair;
      winner: CurrentCheckoutBillingPair | null;
    } | null;
    canonical?: { customerId: string | null; subscriptionId: string | null };
    winnerSubscription?: Stripe.Subscription;
    winnerError?: unknown;
    loserSubscription?: Stripe.Subscription;
    loserError?: unknown;
    cancelResult?: Stripe.Subscription;
  };
  function harness(options: HarnessOptions = {}): {
    dependencies: CurrentCheckoutDuplicateCleanupDependencies;
    calls: string[];
  } {
    const calls: string[] = [];
    let review =
      options.review === undefined
        ? { sessionId: input.sessionId, loser, winner }
        : options.review;
    const dependencies: CurrentCheckoutDuplicateCleanupDependencies = {
      async loadReview() {
        calls.push("load_review");
        return review;
      },
      async loadCanonical() {
        calls.push("load_canonical");
        return options.canonical ?? winner;
      },
      async recordReview(_cleanupInput, recordedWinner) {
        calls.push("record_review");
        if (!review) {
          review = {
            sessionId: input.sessionId,
            loser,
            winner: recordedWinner,
          };
        } else if (!review.winner) {
          review = { ...review, winner: recordedWinner };
        }
      },
      async retrieveSubscription(id) {
        calls.push(`retrieve:${id}`);
        if (id === winner.subscriptionId) {
          if (options.winnerError) throw options.winnerError;
          return (
            options.winnerSubscription ??
            subscription({
              id: winner.subscriptionId,
              customer: winner.customerId,
              status: "active",
            })
          );
        }
        if (options.loserError) throw options.loserError;
        return (
          options.loserSubscription ??
          subscription({
            id: loser.subscriptionId,
            customer: loser.customerId,
            status: "active",
          })
        );
      },
      async cancelSubscription(id, idempotencyKey) {
        calls.push(`cancel:${id}:${idempotencyKey}`);
        return (
          options.cancelResult ??
          subscription({
            id: loser.subscriptionId,
            customer: loser.customerId,
            status: "canceled",
          })
        );
      },
      async abort(_cleanupInput, abortWinner) {
        calls.push(`abort:${abortWinner.customerId}:${abortWinner.subscriptionId}`);
      },
    };
    return { dependencies, calls };
  }

  const success = harness();
  const successResult = await cleanupCurrentCheckoutDuplicate(
    input,
    success.dependencies
  );
  check(
    "(5a) exact durable winner is re-proved, replay-recorded, then the exact loser is cancelled and aborted",
    successResult.cancelled &&
      success.calls.join("|") ===
        [
          "load_review",
          `retrieve:${loser.subscriptionId}`,
          "load_canonical",
          `retrieve:${winner.subscriptionId}`,
          "record_review",
          `retrieve:${loser.subscriptionId}`,
          `cancel:${loser.subscriptionId}:${currentCheckoutDuplicateCancellationIdempotencyKey(
            input.sessionId,
            loser.subscriptionId
          )}`,
          `abort:${winner.customerId}:${winner.subscriptionId}`,
        ].join("|")
  );

  const terminal = harness({
    loserSubscription: subscription({
      id: loser.subscriptionId,
      customer: loser.customerId,
      status: "canceled",
    }),
    winnerError: { code: "resource_missing" },
  });
  const terminalResult = await cleanupCurrentCheckoutDuplicate(
    input,
    terminal.dependencies
  );
  check(
    "(5b) an exact terminal loser skips repeated provider mutation and still consumes the exact abort proof",
    !terminalResult.cancelled &&
      !terminal.calls.includes(`retrieve:${winner.subscriptionId}`) &&
      !terminal.calls.some((call) => call.startsWith("cancel:")) &&
      terminal.calls.at(-1) ===
        `abort:${winner.customerId}:${winner.subscriptionId}`
  );

  const winnerChanged = harness({
    canonical: {
      customerId: "cus_changed",
      subscriptionId: "sub_changed",
    },
  });
  check(
    "(5c) canonical winner drift blocks before cancellation or local abort",
    (await rejectionCode(
      cleanupCurrentCheckoutDuplicate(input, winnerChanged.dependencies)
    )) === "winner_binding_changed" &&
      !winnerChanged.calls.some(
        (call) => call.startsWith("cancel:") || call.startsWith("abort:")
      )
  );

  const winnerMissing = harness({ winnerError: { code: "resource_missing" } });
  check(
    "(5d) a missing winner blocks before cancellation or local abort",
    (await rejectionCode(
      cleanupCurrentCheckoutDuplicate(input, winnerMissing.dependencies)
    )) === "winner_missing" &&
      !winnerMissing.calls.some(
        (call) => call.startsWith("cancel:") || call.startsWith("abort:")
      )
  );

  for (const winnerSubscription of [
    subscription({
      id: winner.subscriptionId,
      customer: winner.customerId,
      status: "canceled",
    }),
    subscription({
      id: winner.subscriptionId,
      customer: winner.customerId,
      status: "active",
      alpha: false,
    }),
  ]) {
    const nonLiveWinner = harness({ winnerSubscription });
    check(
      `(5e) ${winnerSubscription.status}/${
        winnerSubscription.items.data[0]?.price.id ===
        "price_1TWfeHAhrDpDN9sHC2Ay0w7h"
          ? "terminal"
          : "non-Alpha"
      } winner blocks cleanup`,
      (await rejectionCode(
        cleanupCurrentCheckoutDuplicate(input, nonLiveWinner.dependencies)
      )) === "winner_not_live_exact_alpha" &&
        !nonLiveWinner.calls.some((call) => call.startsWith("cancel:"))
    );
  }

  const wrongLoserCustomer = harness({
    loserSubscription: subscription({
      id: loser.subscriptionId,
      customer: "cus_wrong",
      status: "active",
    }),
  });
  check(
    "(5f) loser Customer drift blocks cancellation and local abort",
    (await rejectionCode(
      cleanupCurrentCheckoutDuplicate(input, wrongLoserCustomer.dependencies)
    )) === "loser_binding_changed" &&
      !wrongLoserCustomer.calls.some(
        (call) => call.startsWith("cancel:") || call.startsWith("abort:")
      )
  );

  const loserShapeDrift = harness({
    loserSubscription: subscription({
      id: loser.subscriptionId,
      customer: loser.customerId,
      status: "active",
      alpha: false,
    }),
  });
  check(
    "(5g) loser item-shape drift blocks cancellation and local abort",
    (await rejectionCode(
      cleanupCurrentCheckoutDuplicate(input, loserShapeDrift.dependencies)
    )) === "loser_not_exact_alpha" &&
      !loserShapeDrift.calls.some(
        (call) => call.startsWith("cancel:") || call.startsWith("abort:")
      )
  );

  const nonterminalCancel = harness({
    cancelResult: subscription({
      id: loser.subscriptionId,
      customer: loser.customerId,
      status: "active",
    }),
  });
  check(
    "(5h) a nonterminal cancel result is retried only through the bounded failure lane",
    (await rejectionCode(
      cleanupCurrentCheckoutDuplicate(input, nonterminalCancel.dependencies)
    )) === "provider_unavailable" &&
      !nonterminalCancel.calls.some((call) => call.startsWith("abort:"))
  );

  const missingWinnerReview = harness({
    review: { sessionId: input.sessionId, loser, winner: null },
  });
  check(
    "(5i) a legacy duplicate review without a stored winner is manual-review only",
    (await rejectionCode(
      cleanupCurrentCheckoutDuplicate(input, missingWinnerReview.dependencies)
    )) === "review_winner_missing" &&
      missingWinnerReview.calls.join(",") === "load_review"
  );

  const attachWinner = harness({
    review: { sessionId: input.sessionId, loser, winner: null },
  });
  const attached = await cleanupCurrentCheckoutDuplicate(
    { ...input, initialWinner: winner },
    attachWinner.dependencies
  );
  check(
    "(5j) a pre-winner review attaches a freshly proved candidate and reloads it before cancellation",
    attached.cancelled &&
      attachWinner.calls.filter((call) => call === "load_review").length === 2 &&
      attachWinner.calls.filter((call) => call === "record_review").length === 2 &&
      attachWinner.calls.at(-1) ===
        `abort:${winner.customerId}:${winner.subscriptionId}`
  );

  check(
    "(5k) retry deadlines grow to one day and SQL dead-letters the eighth failure",
    checkoutRecoveryRetryAt(Date.parse("2026-08-29T12:00:00.000Z"), 0) ===
      "2026-08-29T12:05:00.000Z" &&
      checkoutRecoveryRetryAt(Date.parse("2026-08-29T12:00:00.000Z"), 6) ===
        "2026-08-30T12:00:00.000Z" &&
      /v_next_attempt := least\(8,[\s\S]*if v_permanent or v_next_attempt >= 8 then[\s\S]*recovery_attempt_count = 8[\s\S]*recovery_dead_lettered_at = now\(\)/.test(
        migration
      )
  );
}

console.log("(6) a crash after durable review is finished by scheduled recovery");
{
  const profile = {
    id: "22222222-2222-4222-8222-222222222222",
    owner_user_id: "11111111-1111-4111-8111-111111111111",
    stripe_session_id: "cs_current_duplicate",
    stripe_customer_id: "cus_current_duplicate",
    stripe_subscription_id: "sub_current_duplicate",
    billing_state: "paid" as const,
    recovery_lease_expires_at: null,
    recovery_attempt_count: 0,
    recovery_last_error_code: null,
    recovery_dead_lettered_at: null,
  };
  const durableWinnerPair = {
    customerId: "cus_current_winner",
    subscriptionId: "sub_current_winner",
  };
  const rpcCalls: string[] = [];
  const checkoutProfilesQuery = {
    select() { return this; },
    is() { return this; },
    in() { return this; },
    lt() { return this; },
    or() { return this; },
    order() { return this; },
    async limit() { return { data: [profile], error: null }; },
  };
  const refundReviewQuery = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() {
      return {
        data: {
          session_id: profile.stripe_session_id,
          customer_id: profile.stripe_customer_id,
          subscription_id: profile.stripe_subscription_id,
          winner_customer_id: durableWinnerPair.customerId,
          winner_subscription_id: durableWinnerPair.subscriptionId,
        },
        error: null,
      };
    },
  };
  const userQuery = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() {
      return {
        data: {
          stripe_customer_id: durableWinnerPair.customerId,
          stripe_subscription_id: durableWinnerPair.subscriptionId,
        },
        error: null,
      };
    },
  };
  const sb = {
    from(table: string) {
      if (table === "checkout_profiles") return checkoutProfilesQuery;
      if (table === "refund_reviews") return refundReviewQuery;
      if (table === "users") return userQuery;
      throw new Error(`unexpected table ${table}`);
    },
    async rpc(name: string) {
      rpcCalls.push(name);
      if (name === "claim_checkout_profile_recovery") {
        return {
          data: [{ decision: "claimed", recovered_user_id: profile.owner_user_id }],
          error: null,
        };
      }
      if (name === "record_current_checkout_duplicate_refund_review") {
        return { data: true, error: null };
      }
      if (name === "abort_current_checkout_duplicate_fulfillment") {
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  } as never;
  const cancelCalls: Array<{ id: string; idempotencyKey?: string }> = [];
  const exactItems = {
    has_more: false,
    data: [{
      price: { id: "price_1TWfeHAhrDpDN9sHC2Ay0w7h" },
      quantity: 1,
    }],
  };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: profile.stripe_session_id,
          metadata: { alpha_profile_id: profile.id },
          mode: "subscription",
          status: "complete",
          payment_status: "paid",
          customer: profile.stripe_customer_id,
          subscription: profile.stripe_subscription_id,
          line_items: exactItems,
        }),
      },
    },
    subscriptions: {
      retrieve: async (id: string) => ({
        id,
        customer:
          id === durableWinnerPair.subscriptionId
            ? durableWinnerPair.customerId
            : profile.stripe_customer_id,
        status: "active",
        items: exactItems,
      }),
      cancel: async (
        id: string,
        _params: unknown,
        options: { idempotencyKey?: string }
      ) => {
        cancelCalls.push({ id, idempotencyKey: options.idempotencyKey });
        return {
          id,
          customer: profile.stripe_customer_id,
          status: "canceled",
          items: exactItems,
        };
      },
    },
  } as never as Stripe;

  const recovered = await reconcileOverdueCheckoutProfiles(
    sb,
    "2026-08-29T12:00:00.000Z",
    1,
    stripe
  );
  check(
    "(5a) durable duplicate review drives exact cancel, terminal verification, and token abort",
    recovered.inspected === 1 &&
      recovered.cancelled === 1 &&
      recovered.terminallyScrubbed === 1 &&
      recovered.errors.length === 0 &&
      rpcCalls.join(",") ===
        "claim_checkout_profile_recovery,record_current_checkout_duplicate_refund_review,abort_current_checkout_duplicate_fulfillment"
  );
  check(
    "(5b) recovery reuses one stable Session/subscription cancellation key",
    cancelCalls.length === 1 &&
      cancelCalls[0]?.id === profile.stripe_subscription_id &&
      cancelCalls[0]?.idempotencyKey ===
        currentCheckoutDuplicateCancellationIdempotencyKey(
          profile.stripe_session_id,
          profile.stripe_subscription_id
        )
  );
  rpcCalls.length = 0;
  cancelCalls.length = 0;
  const alreadyTerminalStripe = {
    checkout: stripe.checkout,
    subscriptions: {
      retrieve: async (id: string) => {
        if (id === durableWinnerPair.subscriptionId) {
          throw { code: "resource_missing" };
        }
        return {
          id,
          customer: profile.stripe_customer_id,
          status: "canceled",
          items: exactItems,
        };
      },
      cancel: async () => {
        cancelCalls.push({ id: "unexpected" });
        throw new Error("terminal duplicate must not be cancelled twice");
      },
    },
  } as never as Stripe;
  const terminalRecovered = await reconcileOverdueCheckoutProfiles(
    sb,
    "2026-08-29T12:00:00.000Z",
    1,
    alreadyTerminalStripe
  );
  check(
    "(5g) a terminal loser skips a second mutation and aborts locally even after the winner ends",
    terminalRecovered.cancelled === 0 &&
      terminalRecovered.terminallyScrubbed === 1 &&
      terminalRecovered.errors.length === 0 &&
      cancelCalls.length === 0 &&
      rpcCalls.join(",") ===
        "claim_checkout_profile_recovery,record_current_checkout_duplicate_refund_review,abort_current_checkout_duplicate_fulfillment"
  );
  check(
    "(5c) SQL delays takeover to the original lease and accepts the recovery token only after it",
    /record_current_checkout_duplicate_refund_review[\s\S]*greatest\([\s\S]*v_fulfillment\.lease_expires_at/.test(
      migration
    ) &&
      /abort_current_checkout_duplicate_fulfillment[\s\S]*v_recovery_mode[\s\S]*recovery_lease_token = p_lease_token[\s\S]*v_fulfillment\.lease_expires_at <= now\(\)/.test(
        migration
      )
  );

  const winnerPair = {
    customerId: "cus_legacy_winner_after_crash",
    subscriptionId: "sub_legacy_winner_after_crash",
  };
  const preReviewRpcCalls: string[] = [];
  let attachedWinner: typeof winnerPair | null = null;
  const preReviewRefundQuery = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() {
      if (!attachedWinner) return { data: null, error: null };
      return {
        data: {
          session_id: profile.stripe_session_id,
          customer_id: profile.stripe_customer_id,
          subscription_id: profile.stripe_subscription_id,
          reason: "overdue_checkout",
          winner_customer_id: attachedWinner.customerId,
          winner_subscription_id: attachedWinner.subscriptionId,
        },
        error: null,
      };
    },
  };
  const preReviewUserQuery = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() {
      return {
        data: {
          stripe_customer_id: winnerPair.customerId,
          stripe_subscription_id: winnerPair.subscriptionId,
        },
        error: null,
      };
    },
  };
  const preReviewSb = {
    from(table: string) {
      if (table === "checkout_profiles") return checkoutProfilesQuery;
      if (table === "refund_reviews") return preReviewRefundQuery;
      if (table === "users") return preReviewUserQuery;
      throw new Error(`unexpected table ${table}`);
    },
    async rpc(name: string, args?: Record<string, unknown>) {
      preReviewRpcCalls.push(name);
      if (name === "claim_checkout_profile_recovery") {
        return {
          data: [{ decision: "claimed", recovered_user_id: profile.owner_user_id }],
          error: null,
        };
      }
      if (name === "record_current_checkout_duplicate_refund_review") {
        attachedWinner = {
          customerId: String(args?.p_winner_customer_id),
          subscriptionId: String(args?.p_winner_subscription_id),
        };
        return { data: true, error: null };
      }
      if (name === "abort_current_checkout_duplicate_fulfillment") {
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  } as never;
  const preReviewCancelCalls: string[] = [];
  const preReviewStripe = {
    checkout: stripe.checkout,
    subscriptions: {
      retrieve: async (id: string) => ({
        id,
        customer:
          id === winnerPair.subscriptionId
            ? winnerPair.customerId
            : profile.stripe_customer_id,
        status: "active",
        items: exactItems,
      }),
      cancel: async (id: string) => {
        preReviewCancelCalls.push(id);
        return {
          id,
          customer: profile.stripe_customer_id,
          status: "canceled",
          items: exactItems,
        };
      },
    },
  } as never as Stripe;
  const preReviewRecovered = await reconcileOverdueCheckoutProfiles(
    preReviewSb,
    "2026-08-29T12:00:00.000Z",
    1,
    preReviewStripe
  );
  check(
    "(5d) a crash after final CAS but before review re-proves the winner and records before cancel",
    preReviewRecovered.cancelled === 1 &&
      preReviewRecovered.terminallyScrubbed === 1 &&
      preReviewRecovered.errors.length === 0 &&
      preReviewCancelCalls.join(",") === profile.stripe_subscription_id &&
      preReviewRpcCalls.join(",") ===
        "claim_checkout_profile_recovery,record_current_checkout_duplicate_refund_review,record_current_checkout_duplicate_refund_review,abort_current_checkout_duplicate_fulfillment"
  );
  check(
    "(5e) the final database CAS commits a due marker instead of rolling it back",
    /complete_checkout_fulfillment[\s\S]*canonical checkout billing binding changed during completion[\s\S]*return false/.test(
      migration
    ) === false &&
      /complete_checkout_fulfillment[\s\S]*Commit a bounded recovery deadline[\s\S]*v_fulfillment\.lease_expires_at[\s\S]*return false/.test(
        migration
      )
  );
  check(
    "(5f) a recorded exact duplicate is cancelled even if its nonterminal status no longer grants access",
    recovery.includes("cleanupCurrentCheckoutDuplicate") &&
      /if \(!isTerminalSubscriptionStatus\(loser\.status\)\)[\s\S]*dependencies\.cancelSubscription/.test(
        recovery
      )
  );
}

console.log("(7) dead letters never enter automatic provider recovery");
{
  const deadLetteredProfile = {
    id: "77777777-7777-4777-8777-777777777777",
    owner_user_id: "11111111-1111-4111-8111-111111111111",
    stripe_session_id: "cs_dead_lettered",
    stripe_customer_id: "cus_dead_lettered",
    stripe_subscription_id: "sub_dead_lettered",
    billing_state: "paid" as const,
    recovery_lease_expires_at: null,
    recovery_attempt_count: 8,
    recovery_last_error_code: "provider_unavailable" as const,
    recovery_dead_lettered_at: "2026-08-29T11:00:00.000Z",
  };
  const query = {
    select() { return this; },
    is() { return this; },
    in() { return this; },
    lt() { return this; },
    or() { return this; },
    order() { return this; },
    async limit() { return { data: [deadLetteredProfile], error: null }; },
  };
  const sb = {
    from(table: string) {
      if (table !== "checkout_profiles") {
        throw new Error(`unexpected table ${table}`);
      }
      return query;
    },
  } as never;
  let providerCalls = 0;
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => {
          providerCalls += 1;
          throw new Error("dead letter reached Checkout");
        },
      },
    },
    subscriptions: {
      retrieve: async () => {
        providerCalls += 1;
        throw new Error("dead letter reached Subscription");
      },
      cancel: async () => {
        providerCalls += 1;
        throw new Error("dead letter reached cancellation");
      },
    },
  } as never as Stripe;
  const deadLettered = await reconcileOverdueCheckoutProfiles(
    sb,
    "2026-08-29T12:00:00.000Z",
    1,
    stripe
  );
  check(
    "(7a) query and in-memory gates exclude dead letters before every provider method",
    deadLettered.inspected === 0 &&
      deadLettered.errors.length === 0 &&
      providerCalls === 0 &&
      recovery.includes('.is("recovery_dead_lettered_at", null)')
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("CHECKOUT RECOVERY VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL CHECKOUT RECOVERY ASSERTIONS PASS");
