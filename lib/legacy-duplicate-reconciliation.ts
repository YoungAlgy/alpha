import { createHash, randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { getStripeClient, STRIPE_PRICE_ID } from "@/lib/stripe";
import type { supabaseServiceClient } from "@/lib/supabase/server";

type ServiceClient = Awaited<ReturnType<typeof supabaseServiceClient>>;

type LegacyCandidate = {
  session_id: string;
  email_hash: string;
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  week_of: string;
  lease_expires_at: string | null;
  duplicate_refund_review: boolean;
  duplicate_winner_customer_id: string | null;
  duplicate_winner_subscription_id: string | null;
};

export interface LegacyFulfillmentReconciliationResult {
  inspected: number;
  inProgress: number;
  finalized: number;
  completed: number;
  aborted: number;
  awaitingIssue: number;
  retired: number;
  unresolved: number;
  deadLettered: number;
  errors: string[];
}

type LegacyReconcileErrorCode =
  | "provider_unavailable"
  | "winner_state_unresolved"
  | "winner_not_live_exact"
  | "winner_binding_incomplete"
  | "loser_binding_changed"
  | "loser_not_exact_alpha"
  | "cancellation_not_terminal"
  | "database_transient"
  | "state_changed";

function customerIdOf(subscription: Stripe.Subscription): string {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
}

function isFinal(status: Stripe.Subscription.Status): boolean {
  // `unpaid` revokes access but can still be retried or changed by Stripe. It
  // is not final enough to replace a billing binding or scrub the replay lock.
  return status === "canceled" || status === "incomplete_expired";
}

function exactAlphaItem(subscription: Stripe.Subscription): boolean {
  if (
    !subscription.items ||
    subscription.items.has_more ||
    !Array.isArray(subscription.items.data) ||
    subscription.items.data.length !== 1
  ) {
    return false;
  }
  const item = subscription.items.data[0];
  const priceId =
    typeof item.price === "string" ? item.price : item.price?.id;
  const quantity = item.quantity ?? 1;
  return (
    priceId === STRIPE_PRICE_ID &&
    Number.isInteger(quantity) &&
    quantity >= 1 &&
    quantity <= 5
  );
}

export function legacyDuplicateCancellationIdempotencyKey(
  sessionId: string,
  subscriptionId: string
): string {
  if (!sessionId || !subscriptionId) {
    throw new Error("legacy duplicate cancellation identity is incomplete");
  }
  const digest = createHash("sha256")
    .update(`alpha-legacy-duplicate-v1:${sessionId}:${subscriptionId}`)
    .digest("hex");
  return `alpha-legacy-duplicate-cancel-${digest}`;
}

/**
 * Resolve the losing side of a canonical legacy-billing CAS. The caller must
 * freshly load and classify the winner. Only an exact live Alpha winner makes
 * the losing paid Session a cancellation-authorized duplicate.
 */
export async function resolveLegacyBillingWriteConflict<T>(input: {
  loadWinner: () => Promise<T>;
  classifyWinner: (
    winner: T
  ) => Promise<"same" | "replaceable" | "duplicate_live_alpha" | "blocked">;
  cancelLosing: (winner: T) => Promise<never>;
  errorMessage: string;
}): Promise<never> {
  const winner = await input.loadWinner();
  const decision = await input.classifyWinner(winner);
  if (decision === "duplicate_live_alpha") {
    return input.cancelLosing(winner);
  }
  throw new Error(input.errorMessage);
}

async function failClaim(
  sb: ServiceClient,
  candidate: LegacyCandidate,
  leaseToken: string,
  errorCode: LegacyReconcileErrorCode
): Promise<"deferred" | "dead_lettered" | "lease_lost" | "state_changed" | "manual_review"> {
  const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const { data, error } = await sb.rpc("fail_legacy_checkout_fulfillment", {
    p_session_id: candidate.session_id,
    p_lease_token: leaseToken,
    p_error_code: errorCode,
    p_retry_at: retryAt,
  });
  if (
    error ||
    !["deferred", "dead_lettered", "lease_lost", "state_changed", "manual_review"].includes(
      String(data)
    )
  ) {
    throw new Error(
      `legacy duplicate reconciliation failure settlement failed: ${
        error?.message ?? String(data)
      }`
    );
  }
  return data as
    | "deferred"
    | "dead_lettered"
    | "lease_lost"
    | "state_changed"
    | "manual_review";
}

export async function countDeadLetteredLegacyCheckoutFulfillments(
  sb: ServiceClient
): Promise<number> {
  const { data, error } = await sb.rpc(
    "count_dead_lettered_legacy_checkout_fulfillments"
  );
  const count = typeof data === "number" ? data : Number.NaN;
  if (error || !Number.isSafeInteger(count) || count < 0) {
    throw new Error(
      `dead-lettered legacy checkout count failed: ${
        error?.message ?? String(data)
      }`
    );
  }
  return count;
}

async function authorizeDuplicateRefundReview(
  sb: ServiceClient,
  candidate: LegacyCandidate,
  leaseToken: string,
  winner: { customerId: string; subscriptionId: string }
): Promise<void> {
  const { data, error } = await sb.rpc(
    "record_legacy_duplicate_refund_review",
    {
      p_session_id: candidate.session_id,
      p_lease_token: leaseToken,
      p_user_id: candidate.user_id,
      p_winner_customer_id: winner.customerId,
      p_winner_subscription_id: winner.subscriptionId,
    }
  );
  if (error || data !== true) {
    throw new Error(
      `legacy duplicate review authorization failed: ${
        error?.message ?? String(data)
      }`
    );
  }
}

async function findCurrentCheckoutConflict(
  sb: ServiceClient,
  candidate: LegacyCandidate,
  leaseToken: string
): Promise<
  | { decision: "no_conflict" }
  | {
      decision: "candidate";
      winnerCustomerId: string;
      winnerSubscriptionId: string;
    }
  | { decision: "blocked" }
> {
  const { data, error } = await sb.rpc(
    "find_legacy_current_checkout_conflict",
    {
      p_session_id: candidate.session_id,
      p_lease_token: leaseToken,
      p_user_id: candidate.user_id,
    }
  );
  if (error) {
    throw new Error(
      `current checkout conflict lookup failed: ${error.message}`
    );
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        decision?: string;
        winner_customer_id?: string | null;
        winner_subscription_id?: string | null;
      }
    | null;
  if (row?.decision === "no_conflict") return { decision: "no_conflict" };
  if (
    row?.decision === "candidate" &&
    row.winner_customer_id &&
    row.winner_subscription_id
  ) {
    return {
      decision: "candidate",
      winnerCustomerId: row.winner_customer_id,
      winnerSubscriptionId: row.winner_subscription_id,
    };
  }
  return { decision: "blocked" };
}

async function authorizeCurrentCheckoutConflictReview(
  sb: ServiceClient,
  candidate: LegacyCandidate,
  leaseToken: string,
  winner: { customerId: string; subscriptionId: string }
): Promise<void> {
  const { data, error } = await sb.rpc(
    "record_legacy_current_checkout_conflict_refund_review",
    {
      p_session_id: candidate.session_id,
      p_lease_token: leaseToken,
      p_user_id: candidate.user_id,
      p_winner_customer_id: winner.customerId,
      p_winner_subscription_id: winner.subscriptionId,
    }
  );
  if (error || data !== true) {
    throw new Error(
      `current checkout conflict authorization failed: ${
        error?.message ?? String(data)
      }`
    );
  }
}

/**
 * Finish abandoned legacy first-letter leases. Ordinary rows are consumed only
 * when the database atomically proves their exact canonical billing/access and
 * usable issue. Duplicate rows additionally require fresh terminal proof for
 * the already-cancelled exact subscription. The worker performs no provider
 * mutation and uses no email plaintext.
 */
export async function reconcileStaleLegacyCheckoutFulfillments(
  sb: ServiceClient,
  options: {
    nowIso?: string;
    limit?: number;
    stripeClient?: Stripe;
  } = {}
): Promise<LegacyFulfillmentReconciliationResult> {
  const result: LegacyFulfillmentReconciliationResult = {
    inspected: 0,
    inProgress: 0,
    finalized: 0,
    completed: 0,
    aborted: 0,
    awaitingIssue: 0,
    retired: 0,
    unresolved: 0,
    deadLettered: 0,
    errors: [],
  };
  const nowIso = options.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    result.errors.push("legacy duplicate reconciliation received an invalid clock");
    return result;
  }
  const safeLimit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 3)));
  const { data, error } = await sb.rpc(
    "list_stale_pending_legacy_fulfillments",
    { p_now: nowIso, p_limit: safeLimit }
  );
  if (error) {
    result.errors.push(`stale legacy fulfillment lookup failed: ${error.message}`);
    return result;
  }
  let stripe: Stripe | null = options.stripeClient ?? null;
  const deferredSessionIds = new Set<string>();

  for (const raw of data ?? []) {
    const candidate = raw as LegacyCandidate;
    result.inspected += 1;
    if (
      !candidate.session_id ||
      !candidate.email_hash ||
      !candidate.user_id ||
      !candidate.stripe_customer_id ||
      !candidate.stripe_subscription_id ||
      !candidate.week_of ||
      typeof candidate.duplicate_refund_review !== "boolean"
      || (
        candidate.duplicate_refund_review &&
        (!candidate.duplicate_winner_customer_id ||
          !candidate.duplicate_winner_subscription_id)
      )
    ) {
      result.unresolved += 1;
      result.errors.push("pending legacy duplicate candidate is missing an exact binding");
      continue;
    }
    if (
      candidate.lease_expires_at &&
      Date.parse(candidate.lease_expires_at) > nowMs
    ) {
      result.inProgress += 1;
      continue;
    }

    const leaseToken = randomUUID();
    let claimed = false;
    let settled = false;
    let failureCode: LegacyReconcileErrorCode = "database_transient";
    try {
      const { data: claimData, error: claimError } = await sb.rpc(
        "claim_legacy_checkout_fulfillment",
        {
          p_session_id: candidate.session_id,
          p_email_hash: candidate.email_hash,
          p_user_id: candidate.user_id,
          p_stripe_customer_id: candidate.stripe_customer_id,
          p_stripe_subscription_id: candidate.stripe_subscription_id,
          p_week_of: candidate.week_of,
          p_lease_token: leaseToken,
          p_lease_seconds: 180,
        }
      );
      if (claimError) {
        throw new Error(`legacy duplicate claim failed: ${claimError.message}`);
      }
      const claim = Array.isArray(claimData)
        ? (claimData[0] as { decision?: string } | undefined)
        : undefined;
      if (claim?.decision === "in_progress") {
        result.inProgress += 1;
        continue;
      }
      if (claim?.decision === "manual_review") {
        result.unresolved += 1;
        continue;
      }
      if (claim?.decision === "aborted" || claim?.decision === "completed") {
        settled = true;
        continue;
      }
      if (claim?.decision !== "claimed") {
        throw new Error(
          `legacy duplicate claim returned ${String(claim?.decision)}`
        );
      }
      claimed = true;

      let duplicateAuthorized = candidate.duplicate_refund_review;
      let duplicateWinner = duplicateAuthorized
        ? {
            customerId: candidate.duplicate_winner_customer_id as string,
            subscriptionId: candidate.duplicate_winner_subscription_id as string,
          }
        : null;
      if (!duplicateAuthorized) {
        const currentConflict = await findCurrentCheckoutConflict(
          sb,
          candidate,
          leaseToken
        );
        if (currentConflict.decision === "blocked") {
          failureCode = "winner_state_unresolved";
          result.unresolved += 1;
          continue;
        }
        if (currentConflict.decision === "candidate") {
          failureCode = "provider_unavailable";
          if (!stripe) stripe = getStripeClient();
          const winner = await stripe.subscriptions.retrieve(
            currentConflict.winnerSubscriptionId
          );
          if (
            winner.id !== currentConflict.winnerSubscriptionId ||
            customerIdOf(winner) !== currentConflict.winnerCustomerId ||
            isFinal(winner.status) ||
            winner.status === "unpaid" ||
            !exactAlphaItem(winner)
          ) {
            failureCode = "winner_not_live_exact";
            result.unresolved += 1;
            continue;
          }
          await authorizeCurrentCheckoutConflictReview(
            sb,
            candidate,
            leaseToken,
            {
              customerId: currentConflict.winnerCustomerId,
              subscriptionId: currentConflict.winnerSubscriptionId,
            }
          );
          duplicateAuthorized = true;
          duplicateWinner = {
            customerId: currentConflict.winnerCustomerId,
            subscriptionId: currentConflict.winnerSubscriptionId,
          };
        }
      }
      if (!duplicateAuthorized) {
        // A generator can crash immediately after losing the canonical user
        // billing CAS, before it records the duplicate obligation. The leased
        // row itself is the durable recovery input. Freshly classify the exact
        // current winner, then let one owner/pair-locked RPC recheck that winner
        // and persist the review before any provider mutation.
        const { data: canonical, error: canonicalError } = await sb
          .from("users")
          .select("stripe_customer_id, stripe_subscription_id")
          .eq("id", candidate.user_id)
          .maybeSingle();
        if (canonicalError) {
          throw new Error(
            `legacy canonical billing lookup failed: ${canonicalError.message}`
          );
        }
        const winnerCustomerId = canonical?.stripe_customer_id ?? null;
        const winnerSubscriptionId = canonical?.stripe_subscription_id ?? null;
        const samePair =
          winnerCustomerId === candidate.stripe_customer_id &&
          winnerSubscriptionId === candidate.stripe_subscription_id;
        const differentCompletePair =
          !!winnerCustomerId && !!winnerSubscriptionId && !samePair;
        if (differentCompletePair) {
          failureCode = "provider_unavailable";
          if (!stripe) stripe = getStripeClient();
          const winner = await stripe.subscriptions.retrieve(
            winnerSubscriptionId
          );
          if (
            winner.id !== winnerSubscriptionId ||
            customerIdOf(winner) !== winnerCustomerId ||
            isFinal(winner.status) ||
            winner.status === "unpaid" ||
            !exactAlphaItem(winner)
          ) {
            failureCode = "winner_not_live_exact";
            result.unresolved += 1;
            continue;
          }
          await authorizeDuplicateRefundReview(sb, candidate, leaseToken, {
            customerId: winnerCustomerId,
            subscriptionId: winnerSubscriptionId,
          });
          duplicateAuthorized = true;
          duplicateWinner = {
            customerId: winnerCustomerId,
            subscriptionId: winnerSubscriptionId,
          };
        } else if (!!winnerCustomerId !== !!winnerSubscriptionId) {
          failureCode = "winner_binding_incomplete";
          result.unresolved += 1;
          continue;
        }
      }

      if (duplicateAuthorized) {
        if (!duplicateWinner) {
          failureCode = "winner_state_unresolved";
          result.unresolved += 1;
          continue;
        }
        failureCode = "provider_unavailable";
        if (!stripe) stripe = getStripeClient();
        let subscription = await stripe.subscriptions.retrieve(
          candidate.stripe_subscription_id
        );
        if (
          subscription.id !== candidate.stripe_subscription_id ||
          customerIdOf(subscription) !== candidate.stripe_customer_id
        ) {
          failureCode = "loser_binding_changed";
          result.unresolved += 1;
          continue;
        }
        if (!isFinal(subscription.status)) {
          // A durable review preserves the exact winner selected by the
          // database, but provider state can change between attempts. Never
          // mutate the loser unless that same winner is freshly proved to be
          // a live, exact Alpha subscription on its stored Customer.
          failureCode = "provider_unavailable";
          const winnerSubscription = await stripe.subscriptions.retrieve(
            duplicateWinner.subscriptionId
          );
          if (
            winnerSubscription.id !== duplicateWinner.subscriptionId ||
            customerIdOf(winnerSubscription) !== duplicateWinner.customerId ||
            isFinal(winnerSubscription.status) ||
            winnerSubscription.status === "unpaid" ||
            !exactAlphaItem(winnerSubscription)
          ) {
            failureCode = "winner_not_live_exact";
            result.unresolved += 1;
            continue;
          }
          // The durable refund review proves this exact Session/subscription
          // lost the canonical-account race. Cancel only a fully inspectable
          // one-item Alpha subscription. Mixed, partial, or unknown state is
          // left untouched and stays visible for manual review.
          if (!exactAlphaItem(subscription)) {
            failureCode = "loser_not_exact_alpha";
            result.unresolved += 1;
            continue;
          }
          subscription = await stripe.subscriptions.cancel(
            candidate.stripe_subscription_id,
            {},
            {
              idempotencyKey: legacyDuplicateCancellationIdempotencyKey(
                candidate.session_id,
                candidate.stripe_subscription_id
              ),
            }
          );
          if (
            subscription.id !== candidate.stripe_subscription_id ||
            customerIdOf(subscription) !== candidate.stripe_customer_id ||
            !isFinal(subscription.status)
          ) {
            failureCode = "cancellation_not_terminal";
            result.unresolved += 1;
            continue;
          }
        }
        const { data: abortData, error: abortError } = await sb.rpc(
          "abort_legacy_checkout_fulfillment",
          {
            p_session_id: candidate.session_id,
            p_lease_token: leaseToken,
            p_stripe_customer_id: candidate.stripe_customer_id,
            p_stripe_subscription_id: candidate.stripe_subscription_id,
            p_winner_customer_id: duplicateWinner.customerId,
            p_winner_subscription_id: duplicateWinner.subscriptionId,
          }
        );
        if (abortError || abortData !== true) {
          throw new Error(
            `legacy duplicate terminal abort failed: ${
              abortError?.message ?? String(abortData)
            }`
          );
        }
        settled = true;
        result.aborted += 1;
        result.finalized += 1;
        continue;
      }

      const { data: completeData, error: completeError } = await sb.rpc(
        "complete_legacy_checkout_fulfillment",
        {
          p_session_id: candidate.session_id,
          p_lease_token: leaseToken,
          p_user_id: candidate.user_id,
        }
      );
      if (completeError) {
        throw new Error(
          `legacy fulfillment completion failed: ${completeError.message}`
        );
      }
      if (completeData === "deletion_pending") {
        failureCode = "state_changed";
        result.inProgress += 1;
        continue;
      }
      if (completeData === "not_ready") {
        const { data: deferData, error: deferError } = await sb.rpc(
          "defer_legacy_checkout_fulfillment",
          {
            p_session_id: candidate.session_id,
            p_lease_token: leaseToken,
            p_user_id: candidate.user_id,
          }
        );
        if (deferError) {
          throw new Error(
            `legacy fulfillment deferral failed: ${deferError.message}`
          );
        }
        if (deferData === "awaiting_issue") {
          settled = true;
          deferredSessionIds.add(candidate.session_id);
          result.awaitingIssue += 1;
          continue;
        }
        if (deferData === "issue_ready") {
          const { data: retryData, error: retryError } = await sb.rpc(
            "complete_legacy_checkout_fulfillment",
            {
              p_session_id: candidate.session_id,
              p_lease_token: leaseToken,
              p_user_id: candidate.user_id,
            }
          );
          if (retryError || retryData !== "completed") {
            throw new Error(
              `legacy fulfillment issue-race completion failed: ${
                retryError?.message ?? String(retryData)
              }`
            );
          }
          settled = true;
          result.completed += 1;
          result.finalized += 1;
          continue;
        }
        result.unresolved += 1;
        failureCode = "state_changed";
        continue;
      }
      if (completeData !== "completed") {
        failureCode = "state_changed";
        result.unresolved += 1;
        continue;
      }
      settled = true;
      result.completed += 1;
      result.finalized += 1;
    } catch (candidateError) {
      result.errors.push(
        candidateError instanceof Error
          ? `legacy fulfillment ${candidate.session_id}: ${candidateError.message}`
          : `legacy fulfillment ${candidate.session_id}: reconciliation failed`
      );
    } finally {
      if (claimed && !settled) {
        try {
          const failureDecision = await failClaim(
            sb,
            candidate,
            leaseToken,
            failureCode
          );
          if (failureDecision === "dead_lettered") {
            result.deadLettered += 1;
          }
        } catch (releaseError) {
          result.errors.push(
            releaseError instanceof Error
              ? releaseError.message
              : "legacy duplicate reconciliation release failed"
          );
        }
      }
    }
  }

  const { data: awaitingRows, error: awaitingError } = await sb.rpc(
    "list_legacy_fulfillments_awaiting_issue",
    { p_now: nowIso, p_limit: safeLimit }
  );
  if (awaitingError) {
    result.errors.push(
      `legacy awaiting-issue lookup failed: ${awaitingError.message}`
    );
    return result;
  }
  for (const raw of awaitingRows ?? []) {
    const row = raw as { session_id?: unknown };
    if (typeof row.session_id !== "string") {
      result.errors.push("legacy awaiting-issue lookup returned an invalid id");
      continue;
    }
    // A row deferred earlier in this same bounded run has a fresh 24-hour
    // deadline and was already counted. Re-reading it would double-count the
    // same unresolved identity and cannot produce a new terminal decision.
    if (deferredSessionIds.has(row.session_id)) continue;
    result.inspected += 1;
    const { data: settleData, error: settleError } = await sb.rpc(
      "settle_legacy_fulfillment_awaiting_issue",
      { p_session_id: row.session_id, p_now: nowIso }
    );
    if (settleError) {
      result.errors.push(
        `legacy awaiting-issue ${row.session_id}: ${settleError.message}`
      );
      continue;
    }
    if (settleData === "completed") {
      result.completed += 1;
      result.finalized += 1;
    } else if (settleData === "retired") {
      result.retired += 1;
      result.finalized += 1;
    } else if (settleData === "waiting") {
      result.awaitingIssue += 1;
    } else if (settleData !== "not_awaiting") {
      result.errors.push(
        `legacy awaiting-issue ${row.session_id}: unexpected ${String(
          settleData
        )}`
      );
    }
  }
  return result;
}
