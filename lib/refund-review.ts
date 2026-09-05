import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

type RpcClient = Pick<SupabaseClient, "rpc">;

export type RefundReviewReason =
  | "duplicate_checkout"
  | "unfulfillable_checkout"
  | "overdue_checkout";

export interface RefundReviewBillingPair {
  customerId: string;
  subscriptionId: string;
}

export interface WebhookDuplicateRefundReviewInput {
  sessionId: string;
  userId: string;
  emailHash: string;
  weekOf: string;
  loser: RefundReviewBillingPair;
  winner: RefundReviewBillingPair;
}

interface WebhookDuplicateSubscriptionSnapshot {
  id: string;
  customer: string | { id: string };
  status: string;
}

export interface WebhookDuplicateCancellationDependencies<
  T extends WebhookDuplicateSubscriptionSnapshot,
> {
  retrieveSubscription: (subscriptionId: string) => Promise<T>;
  cancelSubscription: (
    subscriptionId: string,
    idempotencyKey: string
  ) => Promise<T>;
  isExactAlphaSubscription: (subscription: T) => boolean;
  isTerminalSubscriptionStatus: (status: string) => boolean;
}

export interface WebhookDuplicateCancellationResult<
  T extends WebhookDuplicateSubscriptionSnapshot,
> {
  subscription: T;
  cancelled: boolean;
}

function webhookSubscriptionCustomerId(
  subscription: WebhookDuplicateSubscriptionSnapshot
): string {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
}

function assertWebhookDuplicateIdentity(
  input: WebhookDuplicateRefundReviewInput
): void {
  if (
    !input.sessionId.trim() ||
    !input.userId.trim() ||
    !/^[0-9a-f]{64}$/.test(input.emailHash) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.weekOf) ||
    !input.loser.customerId.trim() ||
    !input.loser.subscriptionId.trim() ||
    !input.winner.customerId.trim() ||
    !input.winner.subscriptionId.trim()
  ) {
    throw new Error("webhook duplicate billing identity is incomplete");
  }
  if (
    input.loser.customerId === input.winner.customerId &&
    input.loser.subscriptionId === input.winner.subscriptionId
  ) {
    throw new Error("webhook duplicate winner matches the loser");
  }
}

function proveExactWebhookDuplicateSubscription<
  T extends WebhookDuplicateSubscriptionSnapshot,
>(
  subscription: T,
  expected: RefundReviewBillingPair,
  isExactAlphaSubscription: (subscription: T) => boolean
): void {
  if (
    subscription.id !== expected.subscriptionId ||
    webhookSubscriptionCustomerId(subscription) !== expected.customerId
  ) {
    throw new Error("webhook duplicate subscription binding changed");
  }
  if (!isExactAlphaSubscription(subscription)) {
    throw new Error("webhook duplicate subscription is not exact Alpha");
  }
}

export function webhookDuplicateCancellationIdempotencyKey(
  sessionId: string,
  subscriptionId: string
): string {
  if (!sessionId.trim() || !subscriptionId.trim()) {
    throw new Error("webhook duplicate cancellation identity is incomplete");
  }
  const digest = createHash("sha256")
    .update(`alpha-webhook-duplicate-v1:${sessionId}:${subscriptionId}`)
    .digest("hex");
  return `alpha-webhook-duplicate-cancel-${digest}`;
}

export async function recordWebhookDuplicateRefundReview(
  sb: RpcClient,
  input: WebhookDuplicateRefundReviewInput
): Promise<void> {
  assertWebhookDuplicateIdentity(input);
  const { data, error } = await sb.rpc(
    "record_webhook_duplicate_refund_review",
    {
      p_session_id: input.sessionId,
      p_user_id: input.userId,
      p_email_hash: input.emailHash,
      p_week_of: input.weekOf,
      p_loser_customer_id: input.loser.customerId,
      p_loser_subscription_id: input.loser.subscriptionId,
      p_winner_customer_id: input.winner.customerId,
      p_winner_subscription_id: input.winner.subscriptionId,
    }
  );
  if (error || data !== true) {
    throw new Error(
      `webhook duplicate refund review was not authorized: ${
        error?.message ?? String(data)
      }`
    );
  }
}

// The locked RPC is the final local authorization gate. A fresh exact loser
// read after that gate makes a retry safe after a prior cancellation succeeded
// but local settlement did not. Only a still-nonterminal loser is mutated.
export async function cancelWebhookDuplicateSubscription<
  T extends WebhookDuplicateSubscriptionSnapshot,
>(
  sb: RpcClient,
  input: WebhookDuplicateRefundReviewInput,
  dependencies: WebhookDuplicateCancellationDependencies<T>
): Promise<WebhookDuplicateCancellationResult<T>> {
  await recordWebhookDuplicateRefundReview(sb, input);

  let subscription = await dependencies.retrieveSubscription(
    input.loser.subscriptionId
  );
  proveExactWebhookDuplicateSubscription(
    subscription,
    input.loser,
    dependencies.isExactAlphaSubscription
  );
  if (dependencies.isTerminalSubscriptionStatus(subscription.status)) {
    return { subscription, cancelled: false };
  }

  subscription = await dependencies.cancelSubscription(
    input.loser.subscriptionId,
    webhookDuplicateCancellationIdempotencyKey(
      input.sessionId,
      input.loser.subscriptionId
    )
  );
  proveExactWebhookDuplicateSubscription(
    subscription,
    input.loser,
    dependencies.isExactAlphaSubscription
  );
  if (!dependencies.isTerminalSubscriptionStatus(subscription.status)) {
    throw new Error(
      "webhook duplicate subscription cancellation did not become terminal"
    );
  }
  return { subscription, cancelled: true };
}

export async function recordRefundReview(
  sb: RpcClient,
  input: {
    sessionId: string;
    subscriptionId: string;
    customerId: string;
    reason: RefundReviewReason;
  }
): Promise<void> {
  const { data, error } = await sb.rpc("record_refund_review", {
    p_session_id: input.sessionId,
    p_subscription_id: input.subscriptionId,
    p_customer_id: input.customerId,
    p_reason: input.reason,
  });
  if (error || data !== true) {
    throw new Error(
      `refund review was not recorded: ${error?.message ?? String(data)}`
    );
  }
}

export async function countUnresolvedRefundReviews(
  sb: RpcClient
): Promise<number> {
  const { data, error } = await sb.rpc("count_unresolved_refund_reviews");
  if (error || !Number.isInteger(data) || data < 0) {
    throw new Error(
      `unresolved refund-review count failed: ${error?.message ?? String(data)}`
    );
  }
  return data;
}

export async function pruneResolvedRefundReviews(
  sb: RpcClient,
  nowIso: string,
  limit = 100
): Promise<{ pruned: number; remaining: number }> {
  const { data: prunedData, error: pruneError } = await sb.rpc(
    "prune_resolved_refund_reviews",
    {
      p_now: nowIso,
      p_limit: limit,
    }
  );
  const pruned =
    typeof prunedData === "number" ? prunedData : Number.NaN;
  if (pruneError || !Number.isSafeInteger(pruned) || pruned < 0) {
    throw new Error(
      `resolved refund-review prune failed: ${pruneError?.message ?? String(prunedData)}`
    );
  }

  const { data: remainingData, error: remainingError } = await sb.rpc(
    "count_prunable_resolved_refund_reviews",
    { p_now: nowIso }
  );
  const remaining =
    typeof remainingData === "number" ? remainingData : Number.NaN;
  if (
    remainingError ||
    !Number.isSafeInteger(remaining) ||
    remaining < 0
  ) {
    throw new Error(
      `resolved refund-review remaining count failed: ${remainingError?.message ?? String(remainingData)}`
    );
  }

  return { pruned, remaining };
}
