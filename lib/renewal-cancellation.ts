import type Stripe from "stripe";
import { STRIPE_PRICE_ID, getStripeClient } from "@/lib/stripe";
import type { supabaseServiceClient } from "@/lib/supabase/server";

type ServiceClient = Awaited<ReturnType<typeof supabaseServiceClient>>;

const SCHEDULABLE_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  "active",
  "trialing",
  "past_due",
]);

interface RenewalCancellationClaim {
  decision: string;
  pending_at: string | null;
  cancelled_at: string | null;
}

interface PendingRenewalCancellation {
  id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  renewal_cancel_pending_at: string;
  renewal_cancel_customer_id: string | null;
  renewal_cancel_subscription_id: string | null;
  renewal_cancel_next_attempt_at: string;
  renewal_cancel_lease_token: string | null;
  renewal_cancel_lease_expires_at: string | null;
}

export type RenewalCancellationErrorCode =
  | "access_ended"
  | "access_missing"
  | "binding_changed"
  | "deletion_pending"
  | "in_progress"
  | "marker_resolved"
  | "missing_user"
  | "not_due"
  | "pending_binding_changed"
  | "provider_state_unsafe"
  | "settlement_failed";

type RenewalCancellationFailureCode =
  | "provider_unavailable"
  | "provider_rate_limited"
  | "provider_state_unsafe"
  | "settlement_failed"
  | "binding_changed"
  | "unexpected";

export class RenewalCancellationError extends Error {
  constructor(
    public readonly code: RenewalCancellationErrorCode,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "RenewalCancellationError";
  }
}

export interface ScheduleRenewalCancellationInput {
  userId: string;
  customerId: string;
  subscriptionId: string;
  stripeClient: Stripe;
  now?: Date;
  retryDelaySeconds?: number;
}

export interface ScheduleRenewalCancellationResult {
  cancelAt: string;
  alreadyScheduled: boolean;
  ended: boolean;
}

export interface RenewalCancellationReconciliationResult {
  inspected: number;
  scheduled: number;
  alreadyScheduled: number;
  retired: number;
  inProgress: number;
  unresolved: number;
  errors: string[];
}

export interface RenewalCancellationReconciliationOptions {
  limit?: number;
  now?: Date;
  stripeClient?: Stripe;
  stripeClientFactory?: () => Stripe;
}

function rpcRow(data: unknown): RenewalCancellationClaim | null {
  if (Array.isArray(data)) {
    return (data[0] as RenewalCancellationClaim | undefined) ?? null;
  }
  if (data && typeof data === "object") {
    return data as RenewalCancellationClaim;
  }
  return null;
}

function stableRenewalCancellationFailureCode(
  error: unknown
): RenewalCancellationFailureCode {
  if (error instanceof RenewalCancellationError) {
    if (error.code === "provider_state_unsafe") return "provider_state_unsafe";
    if (error.code === "settlement_failed") return "settlement_failed";
    if (
      error.code === "binding_changed" ||
      error.code === "pending_binding_changed"
    ) {
      return "binding_changed";
    }
  }
  if (error && typeof error === "object") {
    const providerError = error as { statusCode?: unknown; type?: unknown };
    if (providerError.statusCode === 429) return "provider_rate_limited";
    if (
      providerError.type === "StripeConnectionError" ||
      providerError.type === "StripeAPIError" ||
      (typeof providerError.statusCode === "number" &&
        providerError.statusCode >= 500)
    ) {
      return "provider_unavailable";
    }
  }
  return "unexpected";
}

function exactCustomerId(subscription: Stripe.Subscription): string | null {
  if (typeof subscription.customer === "string") {
    return subscription.customer.trim() || null;
  }
  if (
    "deleted" in subscription.customer &&
    subscription.customer.deleted === true
  ) {
    return null;
  }
  return subscription.customer.id?.trim() || null;
}

type AlphaLineShape = "exact" | "absent" | "invalid" | "unknown";

function assertExactRenewalIdentity(
  subscription: Stripe.Subscription,
  customerId: string,
  subscriptionId: string
): void {
  if (
    subscription.id !== subscriptionId ||
    exactCustomerId(subscription) !== customerId
  ) {
    throw new RenewalCancellationError(
      "binding_changed",
      "Stripe returned a different subscription binding.",
      409
    );
  }
}

function alphaLineShape(subscription: Stripe.Subscription): AlphaLineShape {
  if (
    !subscription.items ||
    subscription.items.has_more ||
    !Array.isArray(subscription.items.data)
  ) {
    return "unknown";
  }
  const alphaItems = subscription.items.data.filter((item) => {
    const priceId =
      typeof item.price === "string" ? item.price : item.price?.id;
    return priceId === STRIPE_PRICE_ID;
  });
  if (alphaItems.length === 0) return "absent";
  if (subscription.items.data.length !== 1 || alphaItems.length !== 1) {
    return "invalid";
  }
  const quantity = alphaItems[0].quantity;
  return Number.isInteger(quantity) &&
    (quantity as number) >= 1 &&
    (quantity as number) <= 5
    ? "exact"
    : "invalid";
}

/**
 * Proves that a retrieved object is the exact stored Alpha subscription.
 * A partial items page, mixed price, implicit quantity, or different Customer
 * is unsafe. Callers must leave the durable marker pending in every such case.
 */
export function assertExactAlphaRenewalSubscription(
  subscription: Stripe.Subscription,
  customerId: string,
  subscriptionId: string
): void {
  assertExactRenewalIdentity(subscription, customerId, subscriptionId);
  const shape = alphaLineShape(subscription);
  if (shape === "unknown") {
    throw new RenewalCancellationError(
      "provider_state_unsafe",
      "The Alpha subscription items could not be verified completely.",
      409
    );
  }
  if (shape !== "exact") {
    throw new RenewalCancellationError(
      "provider_state_unsafe",
      "The Alpha subscription has an invalid or mixed line item.",
      409
    );
  }
}

export function isRenewalCancellationSchedulable(
  status: Stripe.Subscription.Status
): boolean {
  return SCHEDULABLE_STATUSES.has(status);
}

function isTerminalRenewalStatus(
  status: Stripe.Subscription.Status
): boolean {
  return status === "incomplete_expired" || status === "canceled";
}

function requiresImmediateRenewalCancellation(
  status: Stripe.Subscription.Status
): boolean {
  return status === "incomplete" || status === "paused" || status === "unpaid";
}

export function verifiedFutureCancellationAt(
  subscription: Stripe.Subscription,
  now: Date
): string {
  if (!subscription.cancel_at_period_end) {
    throw new RenewalCancellationError(
      "provider_state_unsafe",
      "Stripe did not confirm that renewal is off.",
      502
    );
  }
  const cancelAt = subscription.cancel_at;
  if (
    !Number.isSafeInteger(cancelAt) ||
    (cancelAt as number) <= Math.floor(now.getTime() / 1000)
  ) {
    throw new RenewalCancellationError(
      "provider_state_unsafe",
      "Stripe did not return a valid future access end date.",
      502
    );
  }
  const value = new Date((cancelAt as number) * 1000);
  if (Number.isNaN(value.getTime())) {
    throw new RenewalCancellationError(
      "provider_state_unsafe",
      "Stripe returned an invalid access end date.",
      502
    );
  }
  return value.toISOString();
}

async function claimRenewalCancellation(
  sb: ServiceClient,
  input: Pick<
    ScheduleRenewalCancellationInput,
    "userId" | "customerId" | "subscriptionId"
  >,
  leaseToken: string
): Promise<RenewalCancellationClaim> {
  const { data, error } = await sb.rpc("claim_alpha_renewal_cancellation", {
    p_user_id: input.userId,
    p_customer_id: input.customerId,
    p_subscription_id: input.subscriptionId,
    p_lease_token: leaseToken,
    p_lease_seconds: 300,
  });
  if (error) {
    console.error(
      "[renewal-cancellation] durable claim failed:",
      error.message
    );
    throw new RenewalCancellationError(
      "settlement_failed",
      "Couldn't start a safe cancellation. Try again.",
      500
    );
  }
  const row = rpcRow(data);
  if (!row?.decision) {
    throw new RenewalCancellationError(
      "settlement_failed",
      "The cancellation reservation returned no decision.",
      500
    );
  }
  return row;
}

function claimDecisionError(decision: string): RenewalCancellationError {
  switch (decision) {
    case "in_progress":
      return new RenewalCancellationError(
        "in_progress",
        "Your cancellation is already being checked. Try again in a moment.",
        409
      );
    case "not_due":
      return new RenewalCancellationError(
        "not_due",
        "Your cancellation is queued for another safe check.",
        409
      );
    case "deletion_pending":
      return new RenewalCancellationError(
        "deletion_pending",
        "Account deletion is already in progress. It will handle your subscription.",
        409
      );
    case "missing_user":
      return new RenewalCancellationError(
        "missing_user",
        "Your Alpha account could not be found.",
        404
      );
    case "access_missing":
      return new RenewalCancellationError(
        "access_missing",
        "No paid Alpha access is active on this account.",
        409
      );
    case "access_ended":
      return new RenewalCancellationError(
        "access_ended",
        "This Alpha subscription has already ended.",
        409
      );
    case "pending_binding_changed":
      return new RenewalCancellationError(
        "pending_binding_changed",
        "A different exact subscription cancellation still needs review.",
        409
      );
    default:
      return new RenewalCancellationError(
        "binding_changed",
        "Your exact Alpha subscription binding changed. No billing change was made.",
        409
      );
  }
}

async function settleRenewalCancellation(
  sb: ServiceClient,
  input: Pick<
    ScheduleRenewalCancellationInput,
    "userId" | "customerId" | "subscriptionId"
  >,
  leaseToken: string,
  cancelAt: string
): Promise<void> {
  const { data, error } = await sb.rpc("settle_alpha_renewal_cancellation", {
    p_user_id: input.userId,
    p_customer_id: input.customerId,
    p_subscription_id: input.subscriptionId,
    p_lease_token: leaseToken,
    p_cancel_at: cancelAt,
  });
  if (error || data !== "settled") {
    const decision = error?.message ?? String(data);
    console.error(
      "[renewal-cancellation] verified Stripe result is still pending local sync:",
      decision
    );
    throw new RenewalCancellationError(
      "settlement_failed",
      "Stripe confirmed renewal is off, but Alpha is still syncing the end date. It will retry automatically.",
      500
    );
  }
}

async function settleCurrentNoAccessRenewalCancellation(
  sb: ServiceClient,
  input: Pick<
    ScheduleRenewalCancellationInput,
    "userId" | "customerId" | "subscriptionId"
  >,
  leaseToken: string
): Promise<void> {
  const { data, error } = await sb.rpc(
    "settle_alpha_renewal_cancellation_no_access",
    {
      p_user_id: input.userId,
      p_customer_id: input.customerId,
      p_subscription_id: input.subscriptionId,
      p_lease_token: leaseToken,
    }
  );
  if (error || data !== "settled") {
    console.error(
      "[renewal-cancellation] provider no-access result is still pending local sync:",
      error?.message ?? String(data)
    );
    throw new RenewalCancellationError(
      "settlement_failed",
      "Stripe shows this Alpha subscription has no access, but Alpha is still syncing that result. It will retry automatically.",
      500
    );
  }
}

function immediateCancellationIdempotencyKey(
  subscriptionId: string,
  pendingAt: string
): string {
  const pendingMillis = new Date(pendingAt).getTime();
  if (!Number.isSafeInteger(pendingMillis)) {
    throw new RenewalCancellationError(
      "settlement_failed",
      "The durable cancellation marker has no stable retry time.",
      500
    );
  }
  return `alpha-renewal-end-${subscriptionId}-${pendingMillis}`;
}

async function cancelExactNonterminalNoAccessSubscription(
  input: Pick<
    ScheduleRenewalCancellationInput,
    "customerId" | "subscriptionId" | "stripeClient"
  >,
  pendingAt: string
): Promise<Stripe.Subscription> {
  const terminated = await input.stripeClient.subscriptions.cancel(
    input.subscriptionId,
    { invoice_now: false, prorate: false },
    {
      idempotencyKey: immediateCancellationIdempotencyKey(
        input.subscriptionId,
        pendingAt
      ),
    }
  );
  assertExactAlphaRenewalSubscription(
    terminated,
    input.customerId,
    input.subscriptionId
  );
  if (!isTerminalRenewalStatus(terminated.status)) {
    throw new RenewalCancellationError(
      "provider_state_unsafe",
      "Stripe did not confirm that the unsafe exact Alpha subscription ended.",
      502
    );
  }
  return terminated;
}

async function claimRenewalCancellationRetirement(
  sb: ServiceClient,
  input: Pick<
    ScheduleRenewalCancellationInput,
    "userId" | "customerId" | "subscriptionId"
  >,
  leaseToken: string
): Promise<void> {
  const { data, error } = await sb.rpc(
    "claim_alpha_renewal_cancellation_retirement",
    {
      p_user_id: input.userId,
      p_customer_id: input.customerId,
      p_subscription_id: input.subscriptionId,
      p_lease_token: leaseToken,
      p_lease_seconds: 300,
    }
  );
  if (error) {
    console.error(
      "[renewal-cancellation] marker-retirement claim failed:",
      error.message
    );
    throw new RenewalCancellationError(
      "settlement_failed",
      "Couldn't check the older cancellation marker. Alpha will retry automatically.",
      500
    );
  }
  if (data === "claimed") return;
  if (data === "in_progress") throw claimDecisionError("in_progress");
  if (data === "not_due") throw claimDecisionError("not_due");
  if (data === "deletion_pending") {
    throw claimDecisionError("deletion_pending");
  }
  if (data === "marker_missing") {
    throw new RenewalCancellationError(
      "marker_resolved",
      "The older cancellation marker is already resolved.",
      409
    );
  }
  throw new RenewalCancellationError(
    "binding_changed",
    "The exact cancellation marker changed during review.",
    409
  );
}

async function retireRenewalCancellationMarker(
  sb: ServiceClient,
  input: Pick<
    ScheduleRenewalCancellationInput,
    "userId" | "customerId" | "subscriptionId"
  >,
  leaseToken: string
): Promise<void> {
  const { data, error } = await sb.rpc(
    "retire_alpha_renewal_cancellation_marker",
    {
      p_user_id: input.userId,
      p_customer_id: input.customerId,
      p_subscription_id: input.subscriptionId,
      p_lease_token: leaseToken,
    }
  );
  if (error || (data !== "retired" && data !== "marker_missing")) {
    console.error(
      "[renewal-cancellation] resolved marker retirement failed:",
      error?.message ?? String(data)
    );
    throw new RenewalCancellationError(
      "settlement_failed",
      "The resolved cancellation marker is still syncing. Alpha will retry automatically.",
      500
    );
  }
}

async function releaseRenewalCancellationLease(
  sb: ServiceClient,
  input: Pick<
    ScheduleRenewalCancellationInput,
    "userId" | "customerId" | "subscriptionId" | "retryDelaySeconds"
  >,
  leaseToken: string,
  failureCode: RenewalCancellationFailureCode
): Promise<void> {
  const { data, error } = await sb.rpc(
    "release_alpha_renewal_cancellation_lease",
    {
      p_user_id: input.userId,
      p_customer_id: input.customerId,
      p_subscription_id: input.subscriptionId,
      p_lease_token: leaseToken,
      p_retry_seconds: Math.max(
        0,
        Math.min(3600, Math.trunc(input.retryDelaySeconds ?? 0))
      ),
      p_error_code: failureCode,
    }
  );
  if (error) {
    throw new Error(`cancellation lease release failed: ${error.message}`);
  }
  if (data !== "released" && data !== "lease_lost") {
    throw new Error(`cancellation lease release failed: ${String(data)}`);
  }
}

async function deferRenewalCancellationForUnavailableProvider(
  sb: ServiceClient,
  row: PendingRenewalCancellation
): Promise<"deferred" | "in_progress" | "resolved"> {
  if (
    !row.renewal_cancel_customer_id ||
    !row.renewal_cancel_subscription_id
  ) {
    throw new Error("exact billing marker is incomplete");
  }
  const markerInput = {
    userId: row.id,
    customerId: row.renewal_cancel_customer_id,
    subscriptionId: row.renewal_cancel_subscription_id,
    retryDelaySeconds: 15 * 60,
  };
  const leaseToken = crypto.randomUUID();
  try {
    await claimRenewalCancellationRetirement(sb, markerInput, leaseToken);
  } catch (error) {
    if (
      error instanceof RenewalCancellationError &&
      (error.code === "in_progress" || error.code === "not_due")
    ) {
      return "in_progress";
    }
    if (
      error instanceof RenewalCancellationError &&
      error.code === "marker_resolved"
    ) {
      return "resolved";
    }
    throw error;
  }
  await releaseRenewalCancellationLease(
    sb,
    markerInput,
    leaseToken,
    "provider_unavailable"
  );
  return "deferred";
}

async function inspectAndRetireResolvedMarker(
  sb: ServiceClient,
  input: Pick<
    ScheduleRenewalCancellationInput,
    | "userId"
    | "customerId"
    | "subscriptionId"
    | "stripeClient"
    | "now"
    | "retryDelaySeconds"
  >,
  pendingAt: string,
  allowNoLongerAlpha: boolean,
  settleCurrentAccess: boolean
): Promise<void> {
  const leaseToken = crypto.randomUUID();
  await claimRenewalCancellationRetirement(sb, input, leaseToken);
  let retired = false;
  let primaryError: unknown;
  try {
    const subscription = await input.stripeClient.subscriptions.retrieve(
      input.subscriptionId
    );
    assertExactRenewalIdentity(
      subscription,
      input.customerId,
      input.subscriptionId
    );
    const shape = alphaLineShape(subscription);
    if (shape === "unknown") {
      throw new RenewalCancellationError(
        "provider_state_unsafe",
        "The older subscription items could not be verified completely.",
        409
      );
    }
    const alreadySafelyScheduled =
      shape === "exact" &&
      isRenewalCancellationSchedulable(subscription.status) &&
      subscription.cancel_at_period_end === true;
    if (alreadySafelyScheduled) {
      verifiedFutureCancellationAt(subscription, input.now ?? new Date());
    }
    if (
      requiresImmediateRenewalCancellation(subscription.status) &&
      shape === "exact"
    ) {
      await cancelExactNonterminalNoAccessSubscription(input, pendingAt);
    } else if (
      !isTerminalRenewalStatus(subscription.status) &&
      !(allowNoLongerAlpha && shape === "absent") &&
      !alreadySafelyScheduled
    ) {
      throw new RenewalCancellationError(
        "provider_state_unsafe",
        "The older exact Alpha subscription may still renew. Its marker needs review.",
        409
      );
    }
    if (settleCurrentAccess) {
      await settleCurrentNoAccessRenewalCancellation(sb, input, leaseToken);
    } else {
      await retireRenewalCancellationMarker(sb, input, leaseToken);
    }
    retired = true;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (!retired) {
      try {
        await releaseRenewalCancellationLease(
          sb,
          input,
          leaseToken,
          stableRenewalCancellationFailureCode(primaryError)
        );
      } catch (releaseError) {
        console.error(
          "[renewal-cancellation] retirement lease release failed:",
          releaseError instanceof Error ? releaseError.message : releaseError,
          primaryError instanceof Error ? primaryError.message : primaryError
        );
      }
    }
  }
}

/**
 * Claims the exact pair before any provider mutation. If Stripe succeeds and
 * the process dies before settlement, the marker remains and the bounded
 * reconciler can retrieve the same subscription and finish the same CAS.
 */
export async function scheduleExactAlphaRenewalCancellation(
  sb: ServiceClient,
  input: ScheduleRenewalCancellationInput
): Promise<ScheduleRenewalCancellationResult> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new RenewalCancellationError(
      "provider_state_unsafe",
      "The cancellation clock is invalid.",
      500
    );
  }
  const leaseToken = crypto.randomUUID();
  const claim = await claimRenewalCancellation(sb, input, leaseToken);
  if (claim.decision !== "claimed") {
    throw claimDecisionError(claim.decision);
  }
  if (!claim.pending_at || Number.isNaN(new Date(claim.pending_at).getTime())) {
    throw new RenewalCancellationError(
      "settlement_failed",
      "The durable cancellation marker has no valid start time.",
      500
    );
  }

  let settled = false;
  let primaryError: unknown;
  try {
    const current = await input.stripeClient.subscriptions.retrieve(
      input.subscriptionId
    );
    assertExactRenewalIdentity(
      current,
      input.customerId,
      input.subscriptionId
    );
    const currentShape = alphaLineShape(current);
    if (currentShape === "unknown") {
      throw new RenewalCancellationError(
        "provider_state_unsafe",
        "The Alpha subscription items could not be verified completely.",
        409
      );
    }
    if (isTerminalRenewalStatus(current.status) || currentShape === "absent") {
      await settleCurrentNoAccessRenewalCancellation(sb, input, leaseToken);
      settled = true;
      return {
        cancelAt: now.toISOString(),
        alreadyScheduled: true,
        ended: true,
      };
    }
    assertExactAlphaRenewalSubscription(
      current,
      input.customerId,
      input.subscriptionId
    );
    if (requiresImmediateRenewalCancellation(current.status)) {
      await cancelExactNonterminalNoAccessSubscription(
        input,
        claim.pending_at
      );
      await settleCurrentNoAccessRenewalCancellation(sb, input, leaseToken);
      settled = true;
      return {
        cancelAt: now.toISOString(),
        alreadyScheduled: false,
        ended: true,
      };
    }
    if (!isRenewalCancellationSchedulable(current.status)) {
      console.warn(
        "[renewal-cancellation] exact subscription has an unschedulable status:",
        current.status
      );
      throw new RenewalCancellationError(
        "provider_state_unsafe",
        "This subscription state cannot be safely changed here. Use Stripe billing or contact support.",
        409
      );
    }

    const alreadyScheduled = current.cancel_at_period_end === true;
    const updated = alreadyScheduled
      ? current
      : await input.stripeClient.subscriptions.update(
          input.subscriptionId,
          { cancel_at_period_end: true },
          {
            idempotencyKey: `alpha-renewal-${input.subscriptionId}-${new Date(
              claim.pending_at
            ).getTime()}`,
          }
        );

    assertExactRenewalIdentity(
      updated,
      input.customerId,
      input.subscriptionId
    );
    const updatedShape = alphaLineShape(updated);
    if (updatedShape === "unknown") {
      throw new RenewalCancellationError(
        "provider_state_unsafe",
        "Stripe returned incomplete subscription items after the update.",
        502
      );
    }
    if (isTerminalRenewalStatus(updated.status) || updatedShape === "absent") {
      await settleCurrentNoAccessRenewalCancellation(sb, input, leaseToken);
      settled = true;
      return {
        cancelAt: now.toISOString(),
        alreadyScheduled: true,
        ended: true,
      };
    }
    assertExactAlphaRenewalSubscription(
      updated,
      input.customerId,
      input.subscriptionId
    );
    if (requiresImmediateRenewalCancellation(updated.status)) {
      await cancelExactNonterminalNoAccessSubscription(
        input,
        claim.pending_at
      );
      await settleCurrentNoAccessRenewalCancellation(sb, input, leaseToken);
      settled = true;
      return {
        cancelAt: now.toISOString(),
        alreadyScheduled: false,
        ended: true,
      };
    }
    if (!isRenewalCancellationSchedulable(updated.status)) {
      console.warn(
        "[renewal-cancellation] exact subscription changed to an unsafe status during update:",
        updated.status
      );
      throw new RenewalCancellationError(
        "provider_state_unsafe",
        "Stripe returned an unexpected subscription state. Alpha will keep checking it.",
        502
      );
    }
    const cancelAt = verifiedFutureCancellationAt(updated, now);
    await settleRenewalCancellation(sb, input, leaseToken, cancelAt);
    settled = true;
    return { cancelAt, alreadyScheduled, ended: false };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (!settled) {
      try {
        // The lease is released for prompt retry. The exact-pair pending marker
        // deliberately remains red until a token/CAS settlement succeeds.
        await releaseRenewalCancellationLease(
          sb,
          input,
          leaseToken,
          stableRenewalCancellationFailureCode(primaryError)
        );
      } catch (releaseError) {
        console.error(
          "[renewal-cancellation] marker lease release failed after cancellation error:",
          releaseError instanceof Error ? releaseError.message : releaseError,
          primaryError instanceof Error ? primaryError.message : primaryError
        );
      }
    }
  }
}

/**
 * Bounded recovery for post-Stripe/pre-database crashes. It reads only exact
 * stored markers, never scans a Customer, and reuses the same claim/update/CAS
 * path as the signed-in route.
 */
export async function reconcilePendingAlphaRenewalCancellations(
  sb: ServiceClient,
  options: RenewalCancellationReconciliationOptions = {}
): Promise<RenewalCancellationReconciliationResult> {
  const now = options.now ?? new Date();
  const safeLimit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 5)));
  const result: RenewalCancellationReconciliationResult = {
    inspected: 0,
    scheduled: 0,
    alreadyScheduled: 0,
    retired: 0,
    inProgress: 0,
    unresolved: 0,
    errors: [],
  };

  const { data, error } = await sb
    .from("users")
    .select(
      "id, stripe_customer_id, stripe_subscription_id, renewal_cancel_pending_at, renewal_cancel_customer_id, renewal_cancel_subscription_id, renewal_cancel_next_attempt_at, renewal_cancel_lease_token, renewal_cancel_lease_expires_at"
    )
    .not("renewal_cancel_pending_at", "is", null)
    .lte("renewal_cancel_next_attempt_at", now.toISOString())
    .order("renewal_cancel_next_attempt_at", { ascending: true })
    .order("renewal_cancel_pending_at", { ascending: true })
    .limit(safeLimit);
  if (error) {
    result.errors.push(
      `pending renewal cancellation lookup failed: ${error.message}`
    );
    result.unresolved += 1;
    return result;
  }
  if ((data?.length ?? 0) === 0) return result;

  let stripe: Stripe | null;
  try {
    stripe =
      options.stripeClient ??
      (options.stripeClientFactory ?? getStripeClient)();
  } catch {
    stripe = null;
  }

  for (const raw of data ?? []) {
    const row = raw as PendingRenewalCancellation;
    result.inspected += 1;
    if (
      !row.renewal_cancel_customer_id ||
      !row.renewal_cancel_subscription_id
    ) {
      result.unresolved += 1;
      result.errors.push(
        `renewal cancellation ${row.id}: exact billing marker is incomplete`
      );
      continue;
    }
    if (
      row.renewal_cancel_lease_token &&
      row.renewal_cancel_lease_expires_at &&
      new Date(row.renewal_cancel_lease_expires_at).getTime() > now.getTime()
    ) {
      result.inProgress += 1;
      continue;
    }

    if (!stripe) {
      try {
        const deferred =
          await deferRenewalCancellationForUnavailableProvider(sb, row);
        if (deferred === "in_progress") {
          result.inProgress += 1;
          continue;
        }
        if (deferred === "resolved") {
          result.retired += 1;
          continue;
        }
        result.unresolved += 1;
        result.errors.push(
          `renewal cancellation ${row.id}: provider unavailable, retry deferred`
        );
      } catch {
        result.unresolved += 1;
        result.errors.push(
          `renewal cancellation ${row.id}: provider unavailable and exact retry deferral failed`
        );
      }
      continue;
    }

    try {
      const markerInput = {
        userId: row.id,
        customerId: row.renewal_cancel_customer_id,
        subscriptionId: row.renewal_cancel_subscription_id,
        stripeClient: stripe,
        now,
        retryDelaySeconds: 15 * 60,
      };
      const markerIsCurrent =
        row.stripe_customer_id === row.renewal_cancel_customer_id &&
        row.stripe_subscription_id === row.renewal_cancel_subscription_id;
      if (!markerIsCurrent) {
        await inspectAndRetireResolvedMarker(
          sb,
          markerInput,
          row.renewal_cancel_pending_at,
          true,
          false
        );
        result.retired += 1;
        continue;
      }

      let scheduled: ScheduleRenewalCancellationResult;
      try {
        scheduled = await scheduleExactAlphaRenewalCancellation(
          sb,
          markerInput
        );
      } catch (scheduleError) {
        if (
          scheduleError instanceof RenewalCancellationError &&
          scheduleError.code === "access_ended"
        ) {
          await inspectAndRetireResolvedMarker(
            sb,
            markerInput,
            row.renewal_cancel_pending_at,
            true,
            true
          );
          result.retired += 1;
          continue;
        }
        throw scheduleError;
      }
      if (scheduled.ended) result.retired += 1;
      else if (scheduled.alreadyScheduled) result.alreadyScheduled += 1;
      else result.scheduled += 1;
    } catch (reconcileError) {
      if (
        reconcileError instanceof RenewalCancellationError &&
        (reconcileError.code === "in_progress" ||
          reconcileError.code === "not_due")
      ) {
        result.inProgress += 1;
        continue;
      }
      if (
        reconcileError instanceof RenewalCancellationError &&
        reconcileError.code === "marker_resolved"
      ) {
        result.retired += 1;
        continue;
      }
      result.unresolved += 1;
      result.errors.push(
        `renewal cancellation ${row.id}: ${
          reconcileError instanceof Error
            ? reconcileError.message
            : "reconciliation failed"
        }`
      );
    }
  }
  return result;
}
