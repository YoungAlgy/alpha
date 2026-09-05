// Fully local legacy-fulfillment reconciliation checks with injected database
// and Stripe stubs. No env file, provider, database, or network call is made.
import { readFileSync } from "node:fs";
import type Stripe from "stripe";
import {
  countDeadLetteredLegacyCheckoutFulfillments,
  legacyDuplicateCancellationIdempotencyKey,
  reconcileStaleLegacyCheckoutFulfillments,
  resolveLegacyBillingWriteConflict,
} from "../lib/legacy-duplicate-reconciliation.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed += 1;
  else failed += 1;
}

const pending = {
  session_id: "cs_legacy_test",
  email_hash: "a".repeat(64),
  user_id: "11111111-1111-4111-8111-111111111111",
  stripe_customer_id: "cus_legacy_test",
  stripe_subscription_id: "sub_legacy_test",
  week_of: "2026-08-24",
  lease_expires_at: "2026-08-27T12:00:00.000Z",
  duplicate_refund_review: false,
  duplicate_winner_customer_id: null,
  duplicate_winner_subscription_id: null,
};
const nowIso = "2026-08-28T12:00:00.000Z";

function serviceStub(
  replies: Record<string, unknown[]>,
  calls: string[],
  canonical: {
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  } = {
    stripe_customer_id: pending.stripe_customer_id,
    stripe_subscription_id: pending.stripe_subscription_id,
  },
  rpcCalls: Array<{ name: string; args: Record<string, unknown> | undefined }> = []
) {
  const userQuery = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: canonical, error: null }; },
  };
  return {
    from: () => userQuery,
    rpc: async (name: string, args?: Record<string, unknown>) => {
      calls.push(name);
      rpcCalls.push({ name, args });
      const values = replies[name];
      if (
        name === "find_legacy_current_checkout_conflict" &&
        (!values || values.length === 0)
      ) {
        return { data: [{ decision: "no_conflict" }], error: null };
      }
      if (!values || values.length === 0) {
        throw new Error(`unexpected RPC ${name}`);
      }
      return { data: values.shift(), error: null };
    },
  } as never;
}

console.log("(1) ordinary stale fulfillment completes only from atomic DB proof");
{
  const calls: string[] = [];
  const result = await reconcileStaleLegacyCheckoutFulfillments(
    serviceStub(
      {
        list_stale_pending_legacy_fulfillments: [[pending]],
        claim_legacy_checkout_fulfillment: [[{ decision: "claimed" }]],
        complete_legacy_checkout_fulfillment: ["completed"],
        list_legacy_fulfillments_awaiting_issue: [[]],
      },
      calls
    ),
    { nowIso, limit: 1 }
  );
  check(
    "(1a) exact canonical access plus issue consumes and scrubs the row",
    result.completed === 1 && result.finalized === 1 && result.errors.length === 0
  );
  check(
    "(1b) the application delegates proof and mutation to token-gated RPCs",
    calls.join(",") ===
      [
        "list_stale_pending_legacy_fulfillments",
        "claim_legacy_checkout_fulfillment",
        "find_legacy_current_checkout_conflict",
        "complete_legacy_checkout_fulfillment",
        "list_legacy_fulfillments_awaiting_issue",
      ].join(",")
  );

  const crashCalls: string[] = [];
  const crashCancelCalls: string[] = [];
  const crashCandidate = { ...pending, duplicate_refund_review: false };
  const winner = {
    stripe_customer_id: "cus_winner",
    stripe_subscription_id: "sub_winner",
  };
  const crashStripe = {
    subscriptions: {
      retrieve: async (id: string) => ({
        id,
        customer:
          id === winner.stripe_subscription_id
            ? winner.stripe_customer_id
            : crashCandidate.stripe_customer_id,
        status: "active",
        items: {
          has_more: false,
          data: [{
            price: { id: "price_1TWfeHAhrDpDN9sHC2Ay0w7h" },
            quantity: 1,
          }],
        },
      }),
      cancel: async (id: string) => {
        crashCancelCalls.push(id);
        return {
          id,
          customer: crashCandidate.stripe_customer_id,
          status: "canceled",
        };
      },
    },
  } as never as Stripe;
  const crashRecovered = await reconcileStaleLegacyCheckoutFulfillments(
    serviceStub(
      {
        list_stale_pending_legacy_fulfillments: [[crashCandidate]],
        claim_legacy_checkout_fulfillment: [[{ decision: "claimed" }]],
        record_legacy_duplicate_refund_review: [true],
        abort_legacy_checkout_fulfillment: [true],
        list_legacy_fulfillments_awaiting_issue: [[]],
      },
      crashCalls,
      winner
    ),
    { nowIso, limit: 1, stripeClient: crashStripe }
  );
  check(
    "(4c) a crash before review is recovered by locked winner proof, durable review, exact cancel, and abort",
    crashRecovered.aborted === 1 && crashRecovered.errors.length === 0 &&
      crashCancelCalls.join(",") === crashCandidate.stripe_subscription_id &&
      crashCalls.indexOf("record_legacy_duplicate_refund_review") <
        crashCalls.indexOf("abort_legacy_checkout_fulfillment")
  );
}

console.log("(2) missing issue drops billing and email identity immediately");
{
  const calls: string[] = [];
  const result = await reconcileStaleLegacyCheckoutFulfillments(
    serviceStub(
      {
        list_stale_pending_legacy_fulfillments: [[pending]],
        claim_legacy_checkout_fulfillment: [[{ decision: "claimed" }]],
        complete_legacy_checkout_fulfillment: ["not_ready"],
        defer_legacy_checkout_fulfillment: ["awaiting_issue"],
        // The database query can immediately return the row just deferred.
        // The worker must count that one identity once, not twice.
        list_legacy_fulfillments_awaiting_issue: [[
          {
            session_id: pending.session_id,
            user_id: pending.user_id,
            week_of: pending.week_of,
            awaiting_issue_until: "2026-08-29T12:00:00.000Z",
          },
        ]],
      },
      calls
    ),
    { nowIso, limit: 1 }
  );
  check(
    "(2a) one deferred row is reported once and remains visible",
    result.awaitingIssue === 1 && result.finalized === 0 && result.errors.length === 0
  );
  check(
    "(2b) a freshly deferred row is not redundantly settled in the same run",
    !calls.includes("settle_legacy_fulfillment_awaiting_issue")
  );
}

console.log("(3) an expired pseudonymous retry row is retired locally");
{
  const result = await reconcileStaleLegacyCheckoutFulfillments(
    serviceStub(
      {
        list_stale_pending_legacy_fulfillments: [[]],
        list_legacy_fulfillments_awaiting_issue: [[
          {
            session_id: "cs_awaiting_test",
            user_id: pending.user_id,
            week_of: pending.week_of,
            awaiting_issue_until: "2026-08-28T11:00:00.000Z",
          },
        ]],
        settle_legacy_fulfillment_awaiting_issue: ["retired"],
      },
      []
    ),
    { nowIso, limit: 1 }
  );
  check(
    "(3a) the bounded retry owner binding is scrubbed after its deadline",
    result.retired === 1 && result.finalized === 1 && result.errors.length === 0
  );
}

console.log("(4) duplicate finalization needs fresh terminal provider proof");
{
  const duplicate = {
    ...pending,
    duplicate_refund_review: true,
    duplicate_winner_customer_id: "cus_winner",
    duplicate_winner_subscription_id: "sub_winner",
  };
  const cancelCalls: Array<{ id: string; idempotencyKey?: string }> = [];
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => ({
        id,
        customer:
          id === duplicate.duplicate_winner_subscription_id
            ? duplicate.duplicate_winner_customer_id
            : duplicate.stripe_customer_id,
        status: "active",
        items: {
          has_more: false,
          data: [{
            price: { id: "price_1TWfeHAhrDpDN9sHC2Ay0w7h" },
            quantity: 1,
          }],
        },
      }),
      cancel: async (
        id: string,
        _params: unknown,
        options: { idempotencyKey?: string }
      ) => {
        cancelCalls.push({ id, idempotencyKey: options.idempotencyKey });
        return {
          id,
          customer: duplicate.stripe_customer_id,
          status: "canceled",
        };
      },
    },
  } as never as Stripe;
  const result = await reconcileStaleLegacyCheckoutFulfillments(
    serviceStub(
      {
        list_stale_pending_legacy_fulfillments: [[duplicate]],
        claim_legacy_checkout_fulfillment: [[{ decision: "claimed" }]],
        abort_legacy_checkout_fulfillment: [true],
        list_legacy_fulfillments_awaiting_issue: [[]],
      },
      []
    ),
    { nowIso, limit: 1, stripeClient: stripe }
  );
  check(
    "(4a) exact live Alpha proof is cancelled, terminally verified, then token-gated aborted",
    result.aborted === 1 && result.finalized === 1 &&
      result.errors.length === 0 && cancelCalls.length === 1
  );
  check(
    "(4b) provider retry uses one stable Session/subscription idempotency key",
    cancelCalls[0]?.id === duplicate.stripe_subscription_id &&
      cancelCalls[0]?.idempotencyKey ===
        legacyDuplicateCancellationIdempotencyKey(
          duplicate.session_id,
          duplicate.stripe_subscription_id
        ) &&
      legacyDuplicateCancellationIdempotencyKey(
        duplicate.session_id,
        duplicate.stripe_subscription_id
      ) ===
        legacyDuplicateCancellationIdempotencyKey(
          duplicate.session_id,
          duplicate.stripe_subscription_id
      )
  );

  const changedWinnerCalls: string[] = [];
  const changedWinnerRpcCalls: Array<{
    name: string;
    args: Record<string, unknown> | undefined;
  }> = [];
  let changedWinnerCancelCalls = 0;
  const changedWinnerStripe = {
    subscriptions: {
      retrieve: async (id: string) => ({
        id,
        customer:
          id === duplicate.duplicate_winner_subscription_id
            ? duplicate.duplicate_winner_customer_id
            : duplicate.stripe_customer_id,
        status:
          id === duplicate.duplicate_winner_subscription_id
            ? "canceled"
            : "active",
        items: {
          has_more: false,
          data: [{
            price: { id: "price_1TWfeHAhrDpDN9sHC2Ay0w7h" },
            quantity: 1,
          }],
        },
      }),
      cancel: async () => {
        changedWinnerCancelCalls += 1;
        throw new Error("a terminal winner must never authorize cancellation");
      },
    },
  } as never as Stripe;
  const changedWinner = await reconcileStaleLegacyCheckoutFulfillments(
    serviceStub(
      {
        list_stale_pending_legacy_fulfillments: [[duplicate]],
        claim_legacy_checkout_fulfillment: [[{ decision: "claimed" }]],
        fail_legacy_checkout_fulfillment: ["deferred"],
        list_legacy_fulfillments_awaiting_issue: [[]],
      },
      changedWinnerCalls,
      undefined,
      changedWinnerRpcCalls
    ),
    { nowIso, limit: 1, stripeClient: changedWinnerStripe }
  );
  const changedWinnerFailure = changedWinnerRpcCalls.find(
    (call) => call.name === "fail_legacy_checkout_fulfillment"
  );
  check(
    "(4c) a stored review cannot authorize another cancellation after its winner stops being live",
    changedWinner.unresolved === 1 && changedWinner.errors.length === 0 &&
      changedWinnerCancelCalls === 0 &&
      !changedWinnerCalls.includes("abort_legacy_checkout_fulfillment") &&
      changedWinnerFailure?.args?.p_error_code === "winner_not_live_exact"
  );
}

console.log("(5) two concurrent paid Sessions cannot leave an untracked loser");
{
  let canonical: string | null = null;
  const cancelled: string[] = [];
  async function attempt(subscriptionId: string): Promise<string> {
    const observed = canonical;
    await Promise.resolve();
    if (canonical === observed) {
      canonical = subscriptionId;
      return "won";
    }
    try {
      await resolveLegacyBillingWriteConflict({
        loadWinner: async () => canonical,
        classifyWinner: async (winner) =>
          winner && winner !== subscriptionId
            ? "duplicate_live_alpha"
            : "same",
        cancelLosing: async () => {
          cancelled.push(subscriptionId);
          throw new Error("duplicate cancelled");
        },
        errorMessage: "billing CAS changed",
      });
    } catch {
      return "lost";
    }
  }
  const outcomes = await Promise.all([attempt("sub_race_a"), attempt("sub_race_b")]);
  check(
    "(5a) one canonical winner and one cancellation-authorized loser remain",
    outcomes.filter((value) => value === "won").length === 1 &&
      outcomes.filter((value) => value === "lost").length === 1 &&
      cancelled.length === 1 &&
      cancelled[0] !== canonical
  );
  const generateRoute = readFileSync(
    new URL("../app/api/generate/route.ts", import.meta.url),
    "utf8"
  );
  check(
    "(5b) both insert and update CAS losses re-read and classify the canonical winner",
    generateRoute.includes("handleLegacySubscriberWriteConflict") &&
      generateRoute.includes("resolveLegacyBillingWriteConflict") &&
      /legacy subscriber insert failed[\s\S]*handleLegacySubscriberWriteConflict|handleLegacySubscriberWriteConflict[\s\S]*legacy subscriber insert failed/.test(
        generateRoute
      ) &&
      generateRoute.includes("legacy subscriber update failed")
  );

  const currentRaceCalls: string[] = [];
  const currentRaceCancelled: string[] = [];
  const currentWinner = {
    customerId: "cus_current_winner",
    subscriptionId: "sub_current_winner",
  };
  const currentRaceStripe = {
    subscriptions: {
      retrieve: async (id: string) => ({
        id,
        customer:
          id === currentWinner.subscriptionId
            ? currentWinner.customerId
            : pending.stripe_customer_id,
        status: "active",
        items: {
          has_more: false,
          data: [{
            price: { id: "price_1TWfeHAhrDpDN9sHC2Ay0w7h" },
            quantity: 1,
          }],
        },
      }),
      cancel: async (id: string) => {
        currentRaceCancelled.push(id);
        return {
          id,
          customer: pending.stripe_customer_id,
          status: "canceled",
        };
      },
    },
  } as never as Stripe;
  const currentRace = await reconcileStaleLegacyCheckoutFulfillments(
    serviceStub(
      {
        list_stale_pending_legacy_fulfillments: [[pending]],
        claim_legacy_checkout_fulfillment: [[{ decision: "claimed" }]],
        find_legacy_current_checkout_conflict: [[{
          decision: "candidate",
          winner_customer_id: currentWinner.customerId,
          winner_subscription_id: currentWinner.subscriptionId,
        }]],
        record_legacy_current_checkout_conflict_refund_review: [true],
        abort_legacy_checkout_fulfillment: [true],
        list_legacy_fulfillments_awaiting_issue: [[]],
      },
      currentRaceCalls,
      { stripe_customer_id: null, stripe_subscription_id: null }
    ),
    { nowIso, limit: 1, stripeClient: currentRaceStripe }
  );
  check(
    "(5c) a current paid reservation wins before canonical mirror and the legacy loser is durably cancelled",
    currentRace.aborted === 1 && currentRace.errors.length === 0 &&
      currentRaceCancelled.join(",") === pending.stripe_subscription_id &&
      currentRaceCalls.includes(
        "record_legacy_current_checkout_conflict_refund_review"
      ) &&
      currentRaceCalls.indexOf("find_legacy_current_checkout_conflict") <
        currentRaceCalls.indexOf(
          "record_legacy_current_checkout_conflict_refund_review"
      )
  );

  const invalidWinnerCalls: string[] = [];
  const invalidWinnerRpcCalls: Array<{
    name: string;
    args: Record<string, unknown> | undefined;
  }> = [];
  let invalidWinnerCancelCalls = 0;
  const invalidWinnerStripe = {
    subscriptions: {
      retrieve: async (id: string) => ({
        id,
        customer: currentWinner.customerId,
        status: "canceled",
        items: {
          has_more: false,
          data: [{
            price: { id: "price_1TWfeHAhrDpDN9sHC2Ay0w7h" },
            quantity: 1,
          }],
        },
      }),
      cancel: async () => {
        invalidWinnerCancelCalls += 1;
        throw new Error("invalid winner must never authorize cancellation");
      },
    },
  } as never as Stripe;
  const invalidWinner = await reconcileStaleLegacyCheckoutFulfillments(
    serviceStub(
      {
        list_stale_pending_legacy_fulfillments: [[pending]],
        claim_legacy_checkout_fulfillment: [[{ decision: "claimed" }]],
        find_legacy_current_checkout_conflict: [[{
          decision: "candidate",
          winner_customer_id: currentWinner.customerId,
          winner_subscription_id: currentWinner.subscriptionId,
        }]],
        fail_legacy_checkout_fulfillment: ["deferred"],
        list_legacy_fulfillments_awaiting_issue: [[]],
      },
      invalidWinnerCalls,
      { stripe_customer_id: null, stripe_subscription_id: null },
      invalidWinnerRpcCalls
    ),
    { nowIso, limit: 1, stripeClient: invalidWinnerStripe }
  );
  const failedClaim = invalidWinnerRpcCalls.find(
    (call) => call.name === "fail_legacy_checkout_fulfillment"
  );
  check(
    "(5d) a provider-invalid current winner writes no review, performs no cancellation, and settles with one closed retry code",
    invalidWinner.unresolved === 1 && invalidWinner.errors.length === 0 &&
      invalidWinnerCancelCalls === 0 &&
      !invalidWinnerCalls.includes(
        "record_legacy_current_checkout_conflict_refund_review"
      ) &&
      failedClaim?.args?.p_error_code === "winner_not_live_exact" &&
      typeof failedClaim.args.p_retry_at === "string"
  );

  let manualProviderCalls = 0;
  const manualReview = await reconcileStaleLegacyCheckoutFulfillments(
    serviceStub(
      {
        list_stale_pending_legacy_fulfillments: [[pending]],
        claim_legacy_checkout_fulfillment: [[{ decision: "manual_review" }]],
        list_legacy_fulfillments_awaiting_issue: [[]],
      },
      []
    ),
    {
      nowIso,
      limit: 1,
      stripeClient: {
        subscriptions: {
          retrieve: async () => {
            manualProviderCalls += 1;
            throw new Error("manual review must stay local");
          },
          cancel: async () => {
            manualProviderCalls += 1;
            throw new Error("manual review must stay local");
          },
        },
      } as never as Stripe,
    }
  );
  check(
    "(5e) a dead-lettered claim remains manual review and makes no provider call",
    manualReview.unresolved === 1 && manualReview.errors.length === 0 &&
      manualProviderCalls === 0
  );

  let rejectedNullDeadLetterCount = false;
  try {
    await countDeadLetteredLegacyCheckoutFulfillments({
      rpc: async () => ({ data: null, error: null }),
    } as never);
  } catch {
    rejectedNullDeadLetterCount = true;
  }
  check(
    "(5f) a null dead-letter count is rejected instead of becoming zero",
    rejectedNullDeadLetterCount
  );
}

console.log("(6) migration keeps the privacy and deletion invariants atomic");
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260827030000_legacy_checkout_fulfillments.sql",
    import.meta.url
  ),
  "utf8"
);
const reconciler = readFileSync(
  new URL("../lib/legacy-duplicate-reconciliation.ts", import.meta.url),
  "utf8"
);
const generateRouteSource = readFileSync(
  new URL("../app/api/generate/route.ts", import.meta.url),
  "utf8"
);
check(
  "(6a) awaiting-issue keeps no email or billing identifiers and is bounded",
  /defer_legacy_checkout_fulfillment[\s\S]*email_hash = null[\s\S]*stripe_customer_id = null[\s\S]*stripe_subscription_id = null[\s\S]*status = 'awaiting_issue'[\s\S]*awaiting_issue_until = now\(\) \+ interval '24 hours'/.test(
    migration
  )
);
check(
  "(6b) account deletion keeps the pseudonymous owner until billing confirmation, then scrubs it",
  /abort_legacy_checkout_for_account_deletion[\s\S]*when status = 'awaiting_issue' then 'deleting'[\s\S]*awaiting_issue_until = null/.test(
    migration
  ) &&
    /prepare_account_deletion[\s\S]*update public\.legacy_checkout_fulfillments[\s\S]*when l\.status = 'deleting' then 'deleting'/.test(
      readFileSync(
        new URL(
          "../supabase/migrations/20260827000000_checkout_fulfillment_claims.sql",
          import.meta.url
        ),
        "utf8"
      )
    ) &&
    /scrub_legacy_checkout_after_account_deletion[\s\S]*user_id = null[\s\S]*stripe_customer_id = null[\s\S]*stripe_subscription_id = null/.test(
      migration
    )
);
check(
  "(6c) stale pending, awaiting, and refund-linked rows all keep maintenance due",
  /alpha_scheduled_maintenance_due[\s\S]*l\.status = 'awaiting_issue'[\s\S]*l\.status = 'pending'[\s\S]*join public\.refund_reviews/.test(
    migration
  )
);
check(
  "(6d) failed pending and waiting rows receive bounded retry deadlines",
  reconciler.includes("Date.now() + 5 * 60_000") &&
    /fail_legacy_checkout_fulfillment[\s\S]*p_retry_at < now\(\) \+ interval '1 minute'[\s\S]*p_retry_at > now\(\) \+ interval '25 hours'[\s\S]*when 1 then interval '5 minutes'[\s\S]*when 6 then interval '12 hours'[\s\S]*else interval '24 hours'/.test(
      migration
    ) &&
    /list_legacy_fulfillments_awaiting_issue[\s\S]*coalesce\(l\.lease_expires_at, l\.created_at\) <= p_now/.test(
      migration
    ) &&
    /settle_legacy_fulfillment_awaiting_issue[\s\S]*p_now \+ interval '5 minutes'/.test(
      migration
    )
);
check(
  "(6e) owner-locked current checkout reservations reject a conflicting legacy canonical write",
  /active current checkout owns this account billing transition/.test(
    readFileSync(
      new URL(
        "../supabase/migrations/20260827000000_checkout_fulfillment_claims.sql",
        import.meta.url
      ),
      "utf8"
    )
  ) &&
    /find_legacy_current_checkout_conflict[\s\S]*return query select 'candidate'[\s\S]*record_legacy_current_checkout_conflict_refund_review[\s\S]*80425080[\s\S]*checkout_profiles[\s\S]*insert into public\.refund_reviews[\s\S]*winner_customer_id/.test(
      migration
    )
);
check(
  "(6f) both legacy duplicate recorders preserve the charge-review reason and attach one exact winner",
  (migration.match(/insert into public\.refund_reviews \(/g) ?? []).length >= 2 &&
    (migration.match(/on conflict \(session_id, subscription_id\) do update/g) ?? [])
      .length >= 2 &&
    /record_legacy_duplicate_refund_review[\s\S]*winner_subscription_id[\s\S]*winner_customer_id[\s\S]*public\.refund_reviews\.winner_customer_id is null/.test(
      migration
    ) &&
    /record_legacy_current_checkout_conflict_refund_review[\s\S]*winner_subscription_id[\s\S]*winner_customer_id[\s\S]*public\.refund_reviews\.winner_customer_id is null/.test(
      migration
    ) &&
    !migration.includes("reason = 'duplicate_checkout'")
);
check(
  "(6g) terminal abort proves the stored loser and winner and receives both pairs from every caller",
  /abort_legacy_checkout_fulfillment\([\s\S]*p_winner_customer_id text[\s\S]*p_winner_subscription_id text[\s\S]*r\.winner_customer_id = p_winner_customer_id[\s\S]*r\.winner_subscription_id = p_winner_subscription_id/.test(
    migration
  ) &&
    migration.includes(
      "grant execute on function public.abort_legacy_checkout_fulfillment(text, uuid, text, text, text, text)"
    ) &&
    reconciler.includes("p_winner_customer_id: duplicateWinner.customerId") &&
    reconciler.includes(
      "p_winner_subscription_id: duplicateWinner.subscriptionId"
    )
);
check(
  "(6h) replay discovery returns the immutable winner and freezes canonical rebind until terminal abort",
  /list_stale_pending_legacy_fulfillments[\s\S]*duplicate_winner_customer_id text[\s\S]*duplicate_winner_subscription_id text[\s\S]*r\.winner_customer_id as duplicate_winner_customer_id[\s\S]*r\.winner_subscription_id as duplicate_winner_subscription_id/.test(
    migration
  ) &&
    /block_user_legacy_duplicate_winner_mutation[\s\S]*l\.status = 'pending'[\s\S]*new\.stripe_customer_id is distinct from r\.winner_customer_id[\s\S]*legacy duplicate cleanup freezes the canonical winner/.test(
      migration
    )
);
check(
  "(6i) the final maintenance gate keeps a winner-backed legacy cleanup visible after refund resolution",
  /legacy_checkout_fulfillments l[\s\S]*join public\.refund_reviews r[\s\S]*r\.winner_customer_id is not null[\s\S]*r\.winner_subscription_id is not null[\s\S]*l\.status = 'pending'/.test(
    readFileSync(
      new URL(
        "../supabase/migrations/20260828000000_alpha_renewal_cancellation.sql",
        import.meta.url
      ),
      "utf8"
    )
  )
);
check(
  "(6j) the eighth reconciliation failure dead-letters the row and clears its lease",
  /fail_legacy_checkout_fulfillment[\s\S]*v_attempt := least\(8,[\s\S]*if v_attempt = 8 then[\s\S]*lease_token = null[\s\S]*lease_expires_at = null[\s\S]*reconcile_attempt_count = 8[\s\S]*reconcile_dead_lettered_at = coalesce/.test(
    migration
  ) &&
    /claim_legacy_checkout_fulfillment[\s\S]*reconcile_dead_lettered_at is not null[\s\S]*'manual_review'/.test(
      migration
    )
);
check(
  "(6k) automatic legacy queues exclude dead letters before any provider work",
  /list_pending_legacy_duplicate_finalizations[\s\S]*l\.reconcile_dead_lettered_at is null/.test(
    migration
  ) &&
    /list_stale_pending_legacy_fulfillments[\s\S]*l\.reconcile_dead_lettered_at is null/.test(
      migration
    )
);
check(
  "(6l) explicit service-only requeue resets retry eligibility without provider mutation",
  /requeue_legacy_checkout_fulfillment[\s\S]*reconcile_attempt_count <> 8[\s\S]*reconcile_attempt_count = 0[\s\S]*reconcile_last_error_code = null[\s\S]*reconcile_dead_lettered_at = null/.test(
    migration
  ) &&
    migration.includes(
      "revoke all on function public.requeue_legacy_checkout_fulfillment(text)"
    ) &&
    migration.includes(
      "grant execute on function public.requeue_legacy_checkout_fulfillment(text)"
    ) &&
    !/requeue_legacy_checkout_fulfillment[\s\S]{0,1800}stripe/i.test(migration)
);
check(
  "(6m) direct legacy replay returns review-required without treating a dead letter as a live lease",
  /type LegacyCheckoutClaimDecision = Exclude<[\s\S]*"cleanup_pending"[\s\S]*>/.test(
    generateRouteSource
  ) &&
    !/type LegacyCheckoutClaimDecision = Exclude<[\s\S]{0,120}"manual_review"/.test(
      generateRouteSource
    ) &&
    generateRouteSource.includes('if (claim.decision === "manual_review")') &&
    generateRouteSource.includes('error: "checkout_review_required"') &&
    generateRouteSource.indexOf('if (claim.decision === "manual_review")') <
      generateRouteSource.indexOf("activeLegacyCheckoutClaim = claim")
);
check(
  "(6n) terminal abort ends an exact provisioned current loser before consuming its fallback row",
  /abort_legacy_checkout_fulfillment[\s\S]*from public\.checkout_profiles p[\s\S]*p\.stripe_session_id = p_session_id[\s\S]*p\.stripe_customer_id = p_stripe_customer_id[\s\S]*p\.stripe_subscription_id = p_stripe_subscription_id[\s\S]*for update[\s\S]*v_current_profile\.provisioned_user_id is distinct from v_user_id[\s\S]*update public\.checkout_profiles p[\s\S]*billing_state = 'ended'[\s\S]*p\.provisioned_user_id = v_user_id[\s\S]*update public\.legacy_checkout_fulfillments/.test(
    migration
  )
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("LEGACY FULFILLMENT RECONCILIATION VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL LEGACY FULFILLMENT RECONCILIATION ASSERTIONS PASS");
