import type Stripe from "stripe";
import { createHash } from "node:crypto";
import { recordRefundReview } from "@/lib/refund-review";
import {
  STRIPE_PRICE_ID,
  getStripeClient,
  isStripeResourceMissing,
} from "@/lib/stripe";
import type { supabaseServiceClient } from "@/lib/supabase/server";
import {
  isTerminalSubscriptionStatus,
  subscriptionStatusGrantsAccess,
} from "@/lib/webhook-user-mutation";

type ServiceClient = Awaited<ReturnType<typeof supabaseServiceClient>>;

interface OverdueCheckoutProfile {
  id: string;
  owner_user_id: string | null;
  stripe_session_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_state: "open" | "paid" | "recovering";
  recovery_lease_expires_at: string | null;
  recovery_attempt_count: number;
  recovery_last_error_code: CheckoutRecoveryErrorCode | null;
  recovery_dead_lettered_at: string | null;
}

interface RecoveryClaim {
  decision: string;
  recovered_user_id: string | null;
}

export interface CheckoutRecoveryResult {
  inspected: number;
  recovered: number;
  nonAccessBound: number;
  inProgress: number;
  cancelled: number;
  terminallyScrubbed: number;
  reviewSubscriptionIds: string[];
  errors: string[];
}

export type CheckoutRecoveryErrorCode =
  | "provider_unavailable"
  | "provider_rate_limited"
  | "database_transient"
  | "unexpected"
  | "winner_binding_changed"
  | "winner_missing"
  | "winner_not_live_exact_alpha"
  | "review_winner_missing"
  | "loser_binding_changed"
  | "loser_missing_unproven"
  | "loser_not_exact_alpha"
  | "profile_identity_invalid";

export type CurrentCheckoutBillingPair = {
  customerId: string;
  subscriptionId: string;
};

export interface CurrentCheckoutDuplicateReview {
  sessionId: string;
  loser: CurrentCheckoutBillingPair;
  winner: CurrentCheckoutBillingPair | null;
}

export interface CurrentCheckoutDuplicateCleanupInput {
  sessionId: string;
  profileId: string;
  leaseToken: string;
  userId: string;
  loser: CurrentCheckoutBillingPair;
  initialWinner?: CurrentCheckoutBillingPair;
}

export interface CurrentCheckoutDuplicateCleanupDependencies {
  loadReview: (
    input: CurrentCheckoutDuplicateCleanupInput
  ) => Promise<CurrentCheckoutDuplicateReview | null>;
  loadCanonical: (userId: string) => Promise<CanonicalBillingBinding>;
  recordReview: (
    input: CurrentCheckoutDuplicateCleanupInput,
    winner: CurrentCheckoutBillingPair
  ) => Promise<void>;
  retrieveSubscription: (subscriptionId: string) => Promise<Stripe.Subscription>;
  cancelSubscription: (
    subscriptionId: string,
    idempotencyKey: string
  ) => Promise<Stripe.Subscription>;
  abort: (
    input: CurrentCheckoutDuplicateCleanupInput,
    winner: CurrentCheckoutBillingPair
  ) => Promise<void>;
}

export interface CurrentCheckoutDuplicateCleanupResult {
  cancelled: boolean;
  winner: CurrentCheckoutBillingPair;
}

export class CheckoutRecoveryFailure extends Error {
  constructor(
    readonly code: CheckoutRecoveryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CheckoutRecoveryFailure";
  }
}

export function currentCheckoutDuplicateCancellationIdempotencyKey(
  sessionId: string,
  subscriptionId: string
): string {
  if (!sessionId || !subscriptionId) {
    throw new Error("current duplicate cancellation identity is incomplete");
  }
  const digest = createHash("sha256")
    .update(`alpha-current-duplicate-v1:${sessionId}:${subscriptionId}`)
    .digest("hex");
  return `alpha-current-duplicate-cancel-${digest}`;
}

function sameBillingPair(
  left: CurrentCheckoutBillingPair,
  right: CurrentCheckoutBillingPair
): boolean {
  return (
    left.customerId === right.customerId &&
    left.subscriptionId === right.subscriptionId
  );
}

function providerErrorCode(error: unknown): CheckoutRecoveryErrorCode {
  if (error instanceof CheckoutRecoveryFailure) return error.code;
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      statusCode?: unknown;
      status?: unknown;
      code?: unknown;
      type?: unknown;
    };
    if (
      candidate.statusCode === 429 ||
      candidate.status === 429 ||
      candidate.code === "rate_limit" ||
      candidate.code === "rate_limit_error" ||
      candidate.type === "rate_limit_error"
    ) {
      return "provider_rate_limited";
    }
  }
  return "provider_unavailable";
}

function recoveryErrorCode(error: unknown): CheckoutRecoveryErrorCode {
  if (error instanceof CheckoutRecoveryFailure) return error.code;
  return providerErrorCode(error) === "provider_rate_limited"
    ? "provider_rate_limited"
    : "unexpected";
}

async function retrieveDuplicateSubscription(
  dependencies: CurrentCheckoutDuplicateCleanupDependencies,
  subscriptionId: string,
  missingCode: "winner_missing" | "loser_missing_unproven"
): Promise<Stripe.Subscription> {
  try {
    return await dependencies.retrieveSubscription(subscriptionId);
  } catch (error) {
    if (isStripeResourceMissing(error)) {
      throw new CheckoutRecoveryFailure(
        missingCode,
        missingCode === "winner_missing"
          ? "current duplicate winner is missing"
          : "current duplicate loser is missing without exact terminal proof"
      );
    }
    throw new CheckoutRecoveryFailure(
      providerErrorCode(error),
      "current duplicate subscription could not be read"
    );
  }
}

async function proveDuplicateWinnerCanonical(
  input: CurrentCheckoutDuplicateCleanupInput,
  winner: CurrentCheckoutBillingPair,
  dependencies: CurrentCheckoutDuplicateCleanupDependencies
): Promise<void> {
  const canonical = await dependencies.loadCanonical(input.userId);
  if (!canonical.customerId || !canonical.subscriptionId) {
    throw new CheckoutRecoveryFailure(
      "winner_binding_changed",
      "current duplicate winner no longer matches the canonical billing binding"
    );
  }
  const canonicalPair: CurrentCheckoutBillingPair = {
    customerId: canonical.customerId,
    subscriptionId: canonical.subscriptionId,
  };
  if (!sameBillingPair(winner, canonicalPair)) {
    throw new CheckoutRecoveryFailure(
      "winner_binding_changed",
      "current duplicate winner no longer matches the canonical billing binding"
    );
  }
}

async function proveDuplicateWinnerLive(
  winner: CurrentCheckoutBillingPair,
  dependencies: CurrentCheckoutDuplicateCleanupDependencies
): Promise<void> {
  const subscription = await retrieveDuplicateSubscription(
    dependencies,
    winner.subscriptionId,
    "winner_missing"
  );
  if (
    subscription.id !== winner.subscriptionId ||
    customerIdOf(subscription) !== winner.customerId
  ) {
    throw new CheckoutRecoveryFailure(
      "winner_binding_changed",
      "current duplicate winner provider binding changed"
    );
  }
  if (
    !subscriptionStatusGrantsAccess(subscription.status) ||
    alphaShape(subscription) !== "exact"
  ) {
    throw new CheckoutRecoveryFailure(
      "winner_not_live_exact_alpha",
      "current duplicate winner is not a live one-item Alpha subscription"
    );
  }
}

function proveDuplicateReviewIdentity(
  review: CurrentCheckoutDuplicateReview,
  input: CurrentCheckoutDuplicateCleanupInput
): void {
  if (
    review.sessionId !== input.sessionId ||
    !sameBillingPair(review.loser, input.loser)
  ) {
    throw new CheckoutRecoveryFailure(
      "profile_identity_invalid",
      "current duplicate review does not match the exact loser"
    );
  }
}

function proveDuplicateLoser(
  loser: Stripe.Subscription,
  expected: CurrentCheckoutBillingPair
): void {
  if (
    loser.id !== expected.subscriptionId ||
    customerIdOf(loser) !== expected.customerId
  ) {
    throw new CheckoutRecoveryFailure(
      "loser_binding_changed",
      "current duplicate loser provider binding changed"
    );
  }
  if (alphaShape(loser) !== "exact") {
    throw new CheckoutRecoveryFailure(
      "loser_not_exact_alpha",
      "current duplicate loser is not a one-item Alpha subscription"
    );
  }
}

/**
 * Finish one exact current-checkout duplicate using a durable winner proof.
 * Both the request path and scheduled recovery use this same injectable state
 * machine, so a crash cannot create a looser retry path.
 */
export async function cleanupCurrentCheckoutDuplicate(
  input: CurrentCheckoutDuplicateCleanupInput,
  dependencies: CurrentCheckoutDuplicateCleanupDependencies
): Promise<CurrentCheckoutDuplicateCleanupResult> {
  if (
    !input.sessionId ||
    !input.profileId ||
    !input.leaseToken ||
    !input.userId ||
    !input.loser.customerId ||
    !input.loser.subscriptionId
  ) {
    throw new CheckoutRecoveryFailure(
      "profile_identity_invalid",
      "current duplicate cleanup identity is incomplete"
    );
  }

  let review = await dependencies.loadReview(input);
  if (review) proveDuplicateReviewIdentity(review, input);
  let winner = review?.winner ?? input.initialWinner ?? null;
  if (!winner) {
    throw new CheckoutRecoveryFailure(
      "review_winner_missing",
      "current duplicate review has no durable winner"
    );
  }
  if (sameBillingPair(winner, input.loser)) {
    throw new CheckoutRecoveryFailure(
      "review_winner_missing",
      "current duplicate review winner matches the loser"
    );
  }

  // Read the loser first. If a previous idempotent cancellation succeeded and
  // the process crashed, an exact terminal loser can finish local cleanup even
  // when the canonical winner later ended. No provider mutation remains in
  // that case, but the database still rechecks the exact canonical pair.
  let loser = await retrieveDuplicateSubscription(
    dependencies,
    input.loser.subscriptionId,
    "loser_missing_unproven"
  );
  proveDuplicateLoser(loser, input.loser);
  let winnerProviderProved = false;

  await proveDuplicateWinnerCanonical(input, winner, dependencies);
  if (!isTerminalSubscriptionStatus(loser.status)) {
    await proveDuplicateWinnerLive(winner, dependencies);
    winnerProviderProved = true;
  }

  // A review may predate winner columns. Attach the freshly canonical pair and
  // reload it before it becomes recovery authority.
  if (!review?.winner) {
    await dependencies.recordReview(input, winner);
    review = await dependencies.loadReview(input);
    if (!review) {
      throw new CheckoutRecoveryFailure(
        "review_winner_missing",
        "current duplicate review did not retain its winner"
      );
    }
    proveDuplicateReviewIdentity(review, input);
    if (!review.winner || !sameBillingPair(review.winner, winner)) {
      throw new CheckoutRecoveryFailure(
        "winner_binding_changed",
        "current duplicate review stored a different winner"
      );
    }
    winner = review.winner;
  }

  // This is the final database gate before any provider mutation. The RPC
  // rechecks the canonical winner, loser profile, exact lease, and review.
  await dependencies.recordReview(input, winner);

  loser = await retrieveDuplicateSubscription(
    dependencies,
    input.loser.subscriptionId,
    "loser_missing_unproven"
  );
  proveDuplicateLoser(loser, input.loser);

  // Terminal state should not reverse. If a provider ever reports that
  // impossible transition, take the full live-winner proof and repeat the
  // database gate before allowing a mutation.
  if (!isTerminalSubscriptionStatus(loser.status) && !winnerProviderProved) {
    await proveDuplicateWinnerLive(winner, dependencies);
    winnerProviderProved = true;
    await dependencies.recordReview(input, winner);
    loser = await retrieveDuplicateSubscription(
      dependencies,
      input.loser.subscriptionId,
      "loser_missing_unproven"
    );
    proveDuplicateLoser(loser, input.loser);
  }

  let cancelled = false;
  if (!isTerminalSubscriptionStatus(loser.status)) {
    try {
      loser = await dependencies.cancelSubscription(
        input.loser.subscriptionId,
        currentCheckoutDuplicateCancellationIdempotencyKey(
          input.sessionId,
          input.loser.subscriptionId
        )
      );
    } catch (error) {
      throw new CheckoutRecoveryFailure(
        providerErrorCode(error),
        "current duplicate loser cancellation failed"
      );
    }
    cancelled = true;
  }
  if (
    loser.id !== input.loser.subscriptionId ||
    customerIdOf(loser) !== input.loser.customerId
  ) {
    throw new CheckoutRecoveryFailure(
      "loser_binding_changed",
      "current duplicate cancellation returned a different billing pair"
    );
  }
  if (alphaShape(loser) !== "exact") {
    throw new CheckoutRecoveryFailure(
      "loser_not_exact_alpha",
      "current duplicate cancellation changed the Alpha item shape"
    );
  }
  if (!isTerminalSubscriptionStatus(loser.status)) {
    throw new CheckoutRecoveryFailure(
      "provider_unavailable",
      "current duplicate cancellation did not return a terminal subscription"
    );
  }

  await dependencies.abort(input, winner);
  return { cancelled, winner };
}

/**
 * Re-read a canonical winner after the final checkout completion CAS loses.
 * The caller owns all provider and database classification. This small seam
 * keeps the adversarial interleaving directly testable without loading route
 * environment or making a provider call.
 */
export async function resolveCurrentCheckoutCompletionConflict<T>(input: {
  loadWinner: () => Promise<T>;
  classifyWinner: (
    winner: T
  ) => Promise<"same" | "replaceable" | "duplicate_live_alpha" | "blocked">;
  cancelLosing: (winner: T) => Promise<never>;
  completionError: unknown;
}): Promise<never> {
  const winner = await input.loadWinner();
  const decision = await input.classifyWinner(winner);
  if (decision === "duplicate_live_alpha") {
    return input.cancelLosing(winner);
  }
  throw input.completionError;
}

function customerIdOf(subscription: Stripe.Subscription): string {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
}

type AlphaShape = "exact" | "absent" | "invalid" | "unknown";

function alphaShape(subscription: Stripe.Subscription): AlphaShape {
  if (
    !subscription.items ||
    subscription.items.has_more ||
    !Array.isArray(subscription.items.data)
  ) {
    return "unknown";
  }
  const alphaItems = subscription.items.data.filter((item) => {
    const priceId =
      typeof item.price === "string" ? item.price : item.price.id;
    return priceId === STRIPE_PRICE_ID;
  });
  if (alphaItems.length === 0) return "absent";
  if (subscription.items.data.length !== 1 || alphaItems.length !== 1) {
    return "invalid";
  }
  const quantity = alphaItems[0].quantity ?? 1;
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 5
    ? "exact"
    : "invalid";
}

async function proveNoCurrentAlphaSubscription(
  stripe: Stripe,
  customerId: string
): Promise<void> {
  let subscriptions: Stripe.ApiList<Stripe.Subscription>;
  try {
    subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      price: STRIPE_PRICE_ID,
      status: "all",
      limit: 100,
    });
  } catch (error) {
    throw new Error(
      `missing subscription has no complete Customer proof: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (subscriptions.has_more || !Array.isArray(subscriptions.data)) {
    throw new Error("missing subscription Customer proof is incomplete");
  }
  for (const subscription of subscriptions.data) {
    if (customerIdOf(subscription) !== customerId) {
      throw new Error("Customer-filtered subscription binding has drifted");
    }
    if (!isTerminalSubscriptionStatus(subscription.status)) {
      throw new Error(
        `Customer still has current Alpha subscription ${subscription.id}`
      );
    }
  }
}

function sessionPaymentComplete(session: Stripe.Checkout.Session): boolean {
  return (
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required"
  );
}

function sessionBillingRefs(session: Stripe.Checkout.Session): {
  customerId: string | null;
  subscriptionId: string | null;
} {
  return {
    customerId:
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id ?? null,
    subscriptionId:
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null,
  };
}

function validateSessionBinding(
  session: Stripe.Checkout.Session,
  profile: OverdueCheckoutProfile
): void {
  if (
    session.id !== profile.stripe_session_id ||
    session.metadata?.alpha_profile_id !== profile.id ||
    session.mode !== "subscription"
  ) {
    throw new Error("overdue Checkout Session binding is invalid");
  }
}

function validateCompletedSession(
  session: Stripe.Checkout.Session,
  profile: OverdueCheckoutProfile
): { customerId: string; subscriptionId: string } {
  validateSessionBinding(session, profile);
  if (session.status !== "complete" || !sessionPaymentComplete(session)) {
    throw new Error("overdue Checkout Session payment is not complete");
  }
  const items = session.line_items?.data ?? [];
  const exactLine =
    !!session.line_items &&
    !session.line_items.has_more &&
    Array.isArray(session.line_items.data) &&
    items.length === 1 &&
    items[0].quantity === 1 &&
    (typeof items[0].price === "string"
      ? items[0].price
      : items[0].price?.id) === STRIPE_PRICE_ID;
  if (!exactLine) {
    throw new Error("completed overdue Checkout Session has an invalid Alpha line");
  }
  const refs = sessionBillingRefs(session);
  if (!refs.customerId || !refs.subscriptionId) {
    throw new Error("completed overdue Checkout Session has no exact billing refs");
  }
  if (
    (profile.stripe_customer_id &&
      profile.stripe_customer_id !== refs.customerId) ||
    (profile.stripe_subscription_id &&
      profile.stripe_subscription_id !== refs.subscriptionId)
  ) {
    throw new Error("overdue Checkout Session billing refs conflict with storage");
  }
  return {
    customerId: refs.customerId,
    subscriptionId: refs.subscriptionId,
  };
}

async function retrieveSession(
  stripe: Stripe,
  profile: OverdueCheckoutProfile
): Promise<Stripe.Checkout.Session | null> {
  if (!profile.stripe_session_id) return null;
  try {
    const session = await stripe.checkout.sessions.retrieve(
      profile.stripe_session_id,
      { expand: ["line_items"] }
    );
    validateSessionBinding(session, profile);
    return session;
  } catch (error) {
    if (isStripeResourceMissing(error)) return null;
    throw error;
  }
}

async function claimRecovery(
  sb: ServiceClient,
  profileId: string,
  customerId: string | null,
  subscriptionId: string | null,
  leaseToken: string
): Promise<RecoveryClaim> {
  const { data, error } = await sb.rpc("claim_checkout_profile_recovery", {
    p_profile_id: profileId,
    p_customer_id: customerId,
    p_subscription_id: subscriptionId,
    p_lease_token: leaseToken,
    p_lease_seconds: 300,
  });
  if (error) throw new Error(`checkout recovery claim failed: ${error.message}`);
  const row = Array.isArray(data) ? (data[0] as RecoveryClaim | undefined) : null;
  if (!row?.decision) {
    throw new Error("checkout recovery claim returned no decision");
  }
  return row;
}

async function recoverProvisioning(
  sb: ServiceClient,
  profileId: string,
  customerId: string,
  subscriptionId: string,
  leaseToken: string,
  grantAccess: boolean,
  priorCustomerId: string | null,
  priorSubscriptionId: string | null,
  priorBindingReplaceable: boolean
): Promise<RecoveryClaim> {
  const { data, error } = await sb.rpc(
    "recover_checkout_profile_provisioning",
    {
      p_profile_id: profileId,
      p_customer_id: customerId,
      p_subscription_id: subscriptionId,
      p_lease_token: leaseToken,
      p_grant_access: grantAccess,
      p_prior_customer_id: priorCustomerId,
      p_prior_subscription_id: priorSubscriptionId,
      p_prior_binding_replaceable: priorBindingReplaceable,
    }
  );
  if (error) {
    throw new Error(`checkout provisioning recovery failed: ${error.message}`);
  }
  const row = Array.isArray(data) ? (data[0] as RecoveryClaim | undefined) : null;
  if (!row?.decision) {
    throw new Error("checkout provisioning recovery returned no decision");
  }
  return row;
}

function isSafelyUnfulfillableRecovery(decision: string): boolean {
  return (
    decision === "canonical_user_missing" ||
    decision === "canonical_profile_incomplete" ||
    decision === "profile_privacy_invariant_failed" ||
    decision === "active_owner_conflict"
  );
}

export type CanonicalBillingBinding = {
  customerId: string | null;
  subscriptionId: string | null;
};

async function loadCanonicalBillingBinding(
  sb: ServiceClient,
  userId: string
): Promise<CanonicalBillingBinding> {
  const { data, error } = await sb
    .from("users")
    .select("stripe_customer_id, stripe_subscription_id")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    throw new CheckoutRecoveryFailure(
      "database_transient",
      `canonical billing lookup failed: ${error.message}`
    );
  }
  return {
    customerId: data?.stripe_customer_id ?? null,
    subscriptionId: data?.stripe_subscription_id ?? null,
  };
}

/**
 * Discovery alone never authorizes replacement. The final database RPC also
 * compare-and-sets these exact prior IDs under the active recovery token.
 */
export async function classifyPriorRecoveryBinding(
  stripe: Stripe,
  prior: CanonicalBillingBinding,
  next: { customerId: string; subscriptionId: string }
): Promise<"same_or_empty" | "replaceable"> {
  if ((prior.customerId === null) !== (prior.subscriptionId === null)) {
    throw new Error("canonical billing binding is partial");
  }
  if (!prior.customerId || !prior.subscriptionId) return "same_or_empty";
  if (
    prior.customerId === next.customerId &&
    prior.subscriptionId === next.subscriptionId
  ) {
    return "same_or_empty";
  }

  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(prior.subscriptionId);
  } catch (error) {
    if (!isStripeResourceMissing(error)) throw error;
    await proveNoCurrentAlphaSubscription(stripe, prior.customerId);
    return "replaceable";
  }
  if (
    subscription.id !== prior.subscriptionId ||
    customerIdOf(subscription) !== prior.customerId
  ) {
    throw new Error("canonical prior subscription binding has drifted");
  }
  if (isTerminalSubscriptionStatus(subscription.status)) return "replaceable";
  if (alphaShape(subscription) === "absent") return "replaceable";
  throw new Error(
    `canonical prior subscription remains nonterminal with status ${subscription.status}`
  );
}

async function settleRecovery(
  sb: ServiceClient,
  profileId: string,
  leaseToken: string,
  terminalState: "ended" | "expired",
  customerId: string | null,
  subscriptionId: string | null
): Promise<void> {
  const { data, error } = await sb.rpc("settle_checkout_profile_recovery", {
    p_profile_id: profileId,
    p_lease_token: leaseToken,
    p_terminal_state: terminalState,
    p_customer_id: customerId,
    p_subscription_id: subscriptionId,
  });
  if (error || data !== "settled") {
    throw new Error(
      `checkout recovery settlement failed: ${error?.message ?? String(data)}`
    );
  }
}

const CHECKOUT_RECOVERY_RETRY_MINUTES = [5, 15, 60, 180, 360, 720, 1440] as const;

export function checkoutRecoveryRetryAt(
  nowMs: number,
  priorAttemptCount: number
): string {
  if (!Number.isFinite(nowMs)) {
    throw new Error("checkout recovery retry clock is invalid");
  }
  const normalizedAttempt = Number.isFinite(priorAttemptCount)
    ? Math.trunc(priorAttemptCount)
    : 0;
  const safeAttempt = Math.max(
    0,
    Math.min(
      CHECKOUT_RECOVERY_RETRY_MINUTES.length - 1,
      normalizedAttempt
    )
  );
  return new Date(
    nowMs + CHECKOUT_RECOVERY_RETRY_MINUTES[safeAttempt] * 60_000
  ).toISOString();
}

async function failRecovery(
  sb: ServiceClient,
  profileId: string,
  leaseToken: string,
  errorCode: CheckoutRecoveryErrorCode,
  retryAtIso: string
): Promise<void> {
  const { data, error } = await sb.rpc("fail_checkout_profile_recovery", {
    p_profile_id: profileId,
    p_lease_token: leaseToken,
    p_error_code: errorCode,
    p_retry_at: retryAtIso,
  });
  if (error) {
    throw new Error(`checkout recovery failure settlement failed: ${error.message}`);
  }
  if (
    data !== "deferred" &&
    data !== "dead_lettered" &&
    data !== "lease_lost" &&
    data !== "fulfillment_in_progress" &&
    data !== "deletion_pending" &&
    data !== "profile_missing"
  ) {
    throw new Error(
      `checkout recovery failure settlement failed: ${String(data)}`
    );
  }
}

async function deferRecoveryCandidate(
  sb: ServiceClient,
  profile: OverdueCheckoutProfile,
  deferToken: string,
  errorCode: CheckoutRecoveryErrorCode,
  retryAtIso: string
): Promise<void> {
  const { data, error } = await sb.rpc(
    "defer_checkout_profile_recovery_candidate",
    {
      p_profile_id: profile.id,
      p_expected_owner_user_id: profile.owner_user_id,
      p_expected_billing_state: profile.billing_state,
      p_expected_customer_id: profile.stripe_customer_id,
      p_expected_subscription_id: profile.stripe_subscription_id,
      p_expected_recovery_lease_expires_at:
        profile.recovery_lease_expires_at,
      p_defer_token: deferToken,
      p_error_code: errorCode,
      p_retry_at: retryAtIso,
    }
  );
  if (error) {
    throw new Error(`checkout recovery deferral failed: ${error.message}`);
  }
  if (
    data !== "deferred" &&
    data !== "dead_lettered" &&
    data !== "state_changed" &&
    data !== "deletion_pending" &&
    data !== "profile_missing" &&
    data !== "not_due" &&
    data !== "in_progress"
  ) {
    throw new Error(`checkout recovery deferral failed: ${String(data)}`);
  }
}

async function queueOverdueRefundReview(
  sb: ServiceClient,
  result: CheckoutRecoveryResult,
  profile: OverdueCheckoutProfile,
  customerId: string,
  subscriptionId: string
): Promise<void> {
  if (!profile.stripe_session_id) {
    throw new Error(
      "never-provisioned checkout has no exact Session for charge review"
    );
  }
  await recordRefundReview(sb, {
    sessionId: profile.stripe_session_id,
    subscriptionId,
    customerId,
    reason: "overdue_checkout",
  });
  if (!result.reviewSubscriptionIds.includes(subscriptionId)) {
    result.reviewSubscriptionIds.push(subscriptionId);
  }
}

async function loadCurrentDuplicateRefundReview(
  sb: ServiceClient,
  profile: OverdueCheckoutProfile,
  customerId: string,
  subscriptionId: string
): Promise<CurrentCheckoutDuplicateReview | null> {
  if (!profile.stripe_session_id) return null;
  const { data, error } = await sb
    .from("refund_reviews")
    .select(
      "session_id, customer_id, subscription_id, reason, winner_customer_id, winner_subscription_id"
    )
    .eq("session_id", profile.stripe_session_id)
    .eq("customer_id", customerId)
    .eq("subscription_id", subscriptionId)
    .maybeSingle();
  if (error) {
    throw new CheckoutRecoveryFailure(
      "database_transient",
      `current duplicate review lookup failed: ${error.message}`
    );
  }
  if (!data) return null;
  const winnerCustomerId = data.winner_customer_id ?? null;
  const winnerSubscriptionId = data.winner_subscription_id ?? null;
  if (
    (!winnerCustomerId || !winnerSubscriptionId) &&
    data.reason !== "duplicate_checkout"
  ) {
    return null;
  }
  return {
    sessionId: data.session_id,
    loser: {
      customerId: data.customer_id,
      subscriptionId: data.subscription_id,
    },
    winner:
      winnerCustomerId && winnerSubscriptionId
        ? {
            customerId: winnerCustomerId,
            subscriptionId: winnerSubscriptionId,
          }
        : null,
  };
}

export function currentCheckoutDuplicateCleanupDependencies(
  sb: ServiceClient,
  stripe: Stripe
): CurrentCheckoutDuplicateCleanupDependencies {
  return {
    loadReview: async (input) => {
      const { data, error } = await sb
        .from("refund_reviews")
        .select(
          "session_id, customer_id, subscription_id, reason, winner_customer_id, winner_subscription_id"
        )
        .eq("session_id", input.sessionId)
        .eq("customer_id", input.loser.customerId)
        .eq("subscription_id", input.loser.subscriptionId)
        .maybeSingle();
      if (error) {
        throw new CheckoutRecoveryFailure(
          "database_transient",
          `current duplicate review lookup failed: ${error.message}`
        );
      }
      if (!data) return null;
      const winnerCustomerId = data.winner_customer_id ?? null;
      const winnerSubscriptionId = data.winner_subscription_id ?? null;
      if (
        (!winnerCustomerId || !winnerSubscriptionId) &&
        data.reason !== "duplicate_checkout"
      ) {
        return null;
      }
      return {
        sessionId: data.session_id,
        loser: {
          customerId: data.customer_id,
          subscriptionId: data.subscription_id,
        },
        winner:
          winnerCustomerId && winnerSubscriptionId
            ? {
                customerId: winnerCustomerId,
                subscriptionId: winnerSubscriptionId,
              }
            : null,
      };
    },
    loadCanonical: (userId) => loadCanonicalBillingBinding(sb, userId),
    recordReview: async (input, winner) => {
      const { data, error } = await sb.rpc(
        "record_current_checkout_duplicate_refund_review",
        {
          p_session_id: input.sessionId,
          p_profile_id: input.profileId,
          p_lease_token: input.leaseToken,
          p_user_id: input.userId,
          p_loser_customer_id: input.loser.customerId,
          p_loser_subscription_id: input.loser.subscriptionId,
          p_winner_customer_id: winner.customerId,
          p_winner_subscription_id: winner.subscriptionId,
        }
      );
      if (error || data !== true) {
        throw new CheckoutRecoveryFailure(
          "database_transient",
          `current duplicate review was not authorized: ${
            error?.message ?? String(data)
          }`
        );
      }
    },
    retrieveSubscription: (subscriptionId) =>
      stripe.subscriptions.retrieve(subscriptionId),
    cancelSubscription: (subscriptionId, idempotencyKey) =>
      stripe.subscriptions.cancel(
        subscriptionId,
        {},
        { idempotencyKey }
      ),
    abort: async (input, winner) => {
      const { data, error } = await sb.rpc(
        "abort_current_checkout_duplicate_fulfillment",
        {
          p_session_id: input.sessionId,
          p_profile_id: input.profileId,
          p_lease_token: input.leaseToken,
          p_user_id: input.userId,
          p_customer_id: input.loser.customerId,
          p_subscription_id: input.loser.subscriptionId,
          p_winner_customer_id: winner.customerId,
          p_winner_subscription_id: winner.subscriptionId,
        }
      );
      if (error || data !== true) {
        throw new CheckoutRecoveryFailure(
          "database_transient",
          `current duplicate terminal abort failed: ${
            error?.message ?? String(data)
          }`
        );
      }
    },
  };
}

/**
 * Hard-deadline recovery for a paid/bound checkout that never reached a
 * canonical user. Provider mutations require a durable database lease. The
 * claim holds the exact profile while Stripe is classified. A second
 * token-gated transaction reruns canonical provisioning under the same owner,
 * billing, and deletion locks before cancellation is even considered.
 */
export async function reconcileOverdueCheckoutProfiles(
  sb: ServiceClient,
  nowIso: string = new Date().toISOString(),
  limit = 5,
  stripeClient?: Stripe
): Promise<CheckoutRecoveryResult> {
  const result: CheckoutRecoveryResult = {
    inspected: 0,
    recovered: 0,
    nonAccessBound: 0,
    inProgress: 0,
    cancelled: 0,
    terminallyScrubbed: 0,
    reviewSubscriptionIds: [],
    errors: [],
  };
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    result.errors.push("checkout recovery received an invalid clock");
    return result;
  }
  const safeLimit = Math.max(1, Math.min(10, Math.trunc(limit)));
  const { data, error } = await sb
    .from("checkout_profiles")
    .select(
      "id, owner_user_id, stripe_session_id, stripe_customer_id, stripe_subscription_id, billing_state, recovery_lease_expires_at, recovery_attempt_count, recovery_last_error_code, recovery_dead_lettered_at"
    )
    .is("provisioned_user_id", null)
    .is("recovery_dead_lettered_at", null)
    .in("billing_state", ["open", "paid", "recovering"])
    .lt("expires_at", nowIso)
    .or(
      `recovery_lease_expires_at.is.null,recovery_lease_expires_at.lte.${nowIso}`
    )
    .order("expires_at", { ascending: true })
    .limit(safeLimit);
  if (error) {
    result.errors.push(`overdue checkout lookup failed: ${error.message}`);
    return result;
  }
  const candidates = (data ?? []).filter(
    (raw) => !(raw as OverdueCheckoutProfile).recovery_dead_lettered_at
  );
  if (candidates.length === 0) return result;

  let stripe: Stripe;
  try {
    stripe = stripeClient ?? getStripeClient();
  } catch (providerError) {
    const providerMessage =
      providerError instanceof Error
        ? providerError.message
        : "Stripe is unavailable for overdue checkout recovery";
    for (const raw of candidates) {
      const profile = raw as OverdueCheckoutProfile;
      result.inspected += 1;
      result.errors.push(`checkout ${profile.id}: ${providerMessage}`);
      try {
        await deferRecoveryCandidate(
          sb,
          profile,
          crypto.randomUUID(),
          "provider_unavailable",
          checkoutRecoveryRetryAt(nowMs, profile.recovery_attempt_count)
        );
      } catch (deferError) {
        result.errors.push(
          deferError instanceof Error
            ? `checkout ${profile.id}: ${deferError.message}`
            : `checkout ${profile.id}: recovery deferral failed`
        );
      }
    }
    return result;
  }

  for (const raw of candidates) {
    const profile = raw as OverdueCheckoutProfile;
    result.inspected += 1;

    if (profile.recovery_dead_lettered_at) {
      result.inProgress += 1;
      continue;
    }

    const leaseToken = crypto.randomUUID();
    let leaseClaimed = false;
    let leaseSettled = false;
    let failureCode: CheckoutRecoveryErrorCode = "unexpected";
    const retryAtIso = checkoutRecoveryRetryAt(
      nowMs,
      profile.recovery_attempt_count
    );
    try {
      if (!profile.owner_user_id) {
        throw new CheckoutRecoveryFailure(
          "profile_identity_invalid",
          "overdue current checkout has no stable owner"
        );
      }
      if (
        profile.billing_state === "recovering" &&
        profile.recovery_lease_expires_at &&
        profile.recovery_lease_expires_at > nowIso
      ) {
        result.inProgress += 1;
        continue;
      }
      let customerId = profile.stripe_customer_id;
      let subscriptionId = profile.stripe_subscription_id;
      let session: Stripe.Checkout.Session | null = null;

      if ((customerId === null) !== (subscriptionId === null)) {
        throw new Error("overdue checkout has only one stored billing reference");
      }

      // If billing refs are not stored yet, the Session read is evidence only.
      // No Stripe mutation happens until the durable claim is granted. Newly
      // discovered refs are reserved by that lease and verified again by the
      // token-gated provisioning transaction below.
      if (!customerId && !subscriptionId) {
        if (!profile.stripe_session_id) {
          throw new Error("overdue checkout has no Session or exact billing refs");
        }
        session = await retrieveSession(stripe, profile);
        if (!session) {
          // A missing Session can also mean a wrong Stripe account or mode. It
          // is not proof that the original Session never created billing.
          throw new Error(
            "bound Checkout Session is missing without independent terminal billing evidence"
          );
        }
        if (session.status === "complete") {
          const refs = validateCompletedSession(session, profile);
          customerId = refs.customerId;
          subscriptionId = refs.subscriptionId;
        } else if (session.status !== "open" && session.status !== "expired") {
          throw new Error(
            `unsupported overdue Checkout Session status ${String(session.status)}`
          );
        }
      }

      const claim = await claimRecovery(
        sb,
        profile.id,
        customerId,
        subscriptionId,
        leaseToken
      );
      if (
        claim.decision === "recovered" ||
        claim.decision === "already_provisioned"
      ) {
        if (claim.recovered_user_id !== profile.owner_user_id) {
          throw new Error("checkout recovery returned a different owner");
        }
        result.recovered += 1;
        continue;
      }
      if (claim.decision === "already_terminal") {
        result.terminallyScrubbed += 1;
        continue;
      }
      if (
        claim.decision === "in_progress" ||
        claim.decision === "deletion_pending" ||
        claim.decision === "manual_review" ||
        claim.decision === "not_due" ||
        claim.decision === "dead_lettered"
      ) {
        result.inProgress += 1;
        continue;
      }
      if (claim.decision !== "claimed") {
        throw new Error(`checkout recovery was not claimable: ${claim.decision}`);
      }
      leaseClaimed = true;

      if (profile.stripe_session_id && !session) {
        session = await retrieveSession(stripe, profile);
        if (!session && !customerId && !subscriptionId) {
          throw new Error(
            "bound Checkout Session is missing without independent terminal billing evidence"
          );
        }
      }

      if (session) {
        if (session.status === "open") {
          if (customerId || subscriptionId) {
            throw new Error("open Checkout Session conflicts with stored billing refs");
          }
          const expired = await stripe.checkout.sessions.expire(session.id);
          if (expired.id !== session.id || expired.status !== "expired") {
            throw new Error("overdue Checkout Session did not expire");
          }
          await settleRecovery(
            sb,
            profile.id,
            leaseToken,
            "expired",
            null,
            null
          );
          leaseSettled = true;
          result.terminallyScrubbed += 1;
          continue;
        }
        if (session.status === "expired") {
          if (customerId || subscriptionId) {
            throw new Error("expired Checkout Session conflicts with stored billing refs");
          }
          await settleRecovery(
            sb,
            profile.id,
            leaseToken,
            "expired",
            null,
            null
          );
          leaseSettled = true;
          result.terminallyScrubbed += 1;
          continue;
        }
        const refs = validateCompletedSession(session, profile);
        if (
          (customerId && customerId !== refs.customerId) ||
          (subscriptionId && subscriptionId !== refs.subscriptionId)
        ) {
          throw new Error("overdue Checkout Session billing refs changed after claim");
        }
        customerId = refs.customerId;
        subscriptionId = refs.subscriptionId;
      }

      if (!customerId || !subscriptionId) {
        throw new Error("overdue paid checkout has no exact billing refs");
      }

      const duplicateReview = await loadCurrentDuplicateRefundReview(
        sb,
        profile,
        customerId,
        subscriptionId
      );
      let initialDuplicateWinner: CurrentCheckoutBillingPair | undefined;
      if (!duplicateReview?.winner) {
        const canonical = await loadCanonicalBillingBinding(
          sb,
          profile.owner_user_id
        );
        if (
          canonical.customerId &&
          canonical.subscriptionId &&
          (canonical.customerId !== customerId ||
            canonical.subscriptionId !== subscriptionId)
        ) {
          let winner: Stripe.Subscription | null = null;
          try {
            winner = await stripe.subscriptions.retrieve(
              canonical.subscriptionId
            );
          } catch (winnerError) {
            if (!isStripeResourceMissing(winnerError)) throw winnerError;
          }
          if (
            winner &&
            winner.id === canonical.subscriptionId &&
            customerIdOf(winner) === canonical.customerId &&
            subscriptionStatusGrantsAccess(winner.status) &&
            alphaShape(winner) === "exact"
          ) {
            initialDuplicateWinner = {
              customerId: canonical.customerId,
              subscriptionId: canonical.subscriptionId,
            };
          }
        }
      }

      if (duplicateReview || initialDuplicateWinner) {
        if (!profile.stripe_session_id) {
          throw new CheckoutRecoveryFailure(
            "profile_identity_invalid",
            "current duplicate checkout has no exact Session binding"
          );
        }
        const cleanup = await cleanupCurrentCheckoutDuplicate(
          {
            sessionId: profile.stripe_session_id,
            profileId: profile.id,
            leaseToken,
            userId: profile.owner_user_id,
            loser: { customerId, subscriptionId },
            initialWinner: initialDuplicateWinner,
          },
          currentCheckoutDuplicateCleanupDependencies(sb, stripe)
        );
        leaseSettled = true;
        if (cleanup.cancelled) result.cancelled += 1;
        result.terminallyScrubbed += 1;
        if (!result.reviewSubscriptionIds.includes(subscriptionId)) {
          result.reviewSubscriptionIds.push(subscriptionId);
        }
        continue;
      }

      let subscription: Stripe.Subscription;
      try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
      } catch (subscriptionError) {
        if (!isStripeResourceMissing(subscriptionError)) throw subscriptionError;
        // A missing exact Subscription can also mean the runtime is pointed at
        // a different Stripe account or mode. Settle only after the known
        // Customer is readable and a complete price-filtered scan proves no
        // current Alpha subscription can still charge.
        await proveNoCurrentAlphaSubscription(stripe, customerId);
        await queueOverdueRefundReview(
          sb,
          result,
          profile,
          customerId,
          subscriptionId
        );
        await settleRecovery(
          sb,
          profile.id,
          leaseToken,
          "ended",
          customerId,
          subscriptionId
        );
        leaseSettled = true;
        result.terminallyScrubbed += 1;
        continue;
      }
      if (
        subscription.id !== subscriptionId ||
        customerIdOf(subscription) !== customerId
      ) {
        throw new Error("overdue checkout subscription binding has drifted");
      }

      const shape = alphaShape(subscription);
      if (
        isTerminalSubscriptionStatus(subscription.status) ||
        shape === "absent"
      ) {
        await queueOverdueRefundReview(
          sb,
          result,
          profile,
          customerId,
          subscriptionId
        );
        await settleRecovery(
          sb,
          profile.id,
          leaseToken,
          "ended",
          customerId,
          subscriptionId
        );
        leaseSettled = true;
        result.terminallyScrubbed += 1;
        continue;
      }
      if (shape !== "exact") {
        throw new Error(`nonterminal overdue checkout has ${shape} Alpha item shape`);
      }
      if (!profile.stripe_session_id) {
        throw new Error("nonterminal overdue checkout has no exact Session binding");
      }

      const priorBinding = await loadCanonicalBillingBinding(
        sb,
        profile.owner_user_id
      );
      const priorDecision = await classifyPriorRecoveryBinding(
        stripe,
        priorBinding,
        { customerId, subscriptionId }
      );
      const grantsAccess = subscriptionStatusGrantsAccess(subscription.status);

      const recovered = await recoverProvisioning(
        sb,
        profile.id,
        customerId,
        subscriptionId,
        leaseToken,
        grantsAccess,
        priorBinding.customerId,
        priorBinding.subscriptionId,
        priorDecision === "replaceable"
      );
      if (recovered.decision === "recovered") {
        if (recovered.recovered_user_id !== profile.owner_user_id) {
          throw new Error("checkout provisioning recovered a different owner");
        }
        leaseSettled = true;
        result.recovered += 1;
        continue;
      }
      if (recovered.decision === "recovered_no_access") {
        if (recovered.recovered_user_id !== profile.owner_user_id) {
          throw new Error("checkout non-access binding recovered a different owner");
        }
        leaseSettled = true;
        result.nonAccessBound += 1;
        continue;
      }
      if (
        recovered.decision === "lease_lost" ||
        recovered.decision === "deletion_pending"
      ) {
        result.inProgress += 1;
        continue;
      }
      if (!isSafelyUnfulfillableRecovery(recovered.decision)) {
        throw new Error(
          `checkout provisioning was not recoverable: ${recovered.decision}`
        );
      }

      // Record the exact charge/subscription review before the provider
      // mutation only after the token-gated database transaction proves the
      // stable owner cannot safely be provisioned. A crash after cancellation
      // can never lose the refund obligation.
      await queueOverdueRefundReview(
        sb,
        result,
        profile,
        customerId,
        subscriptionId
      );
      const cancelled = await stripe.subscriptions.cancel(subscriptionId);
      if (
        cancelled.id !== subscriptionId ||
        customerIdOf(cancelled) !== customerId ||
        !isTerminalSubscriptionStatus(cancelled.status)
      ) {
        throw new Error("exact overdue Alpha cancellation was not terminal");
      }
      await settleRecovery(
        sb,
        profile.id,
        leaseToken,
        "ended",
        customerId,
        subscriptionId
      );
      leaseSettled = true;
      result.cancelled += 1;
      result.terminallyScrubbed += 1;
    } catch (profileError) {
      failureCode = recoveryErrorCode(profileError);
      result.errors.push(
        profileError instanceof Error
          ? `checkout ${profile.id}: ${profileError.message}`
          : `checkout ${profile.id}: recovery failed`
      );
      if (!leaseClaimed) {
        try {
          await deferRecoveryCandidate(
            sb,
            profile,
            leaseToken,
            failureCode,
            retryAtIso
          );
        } catch (deferError) {
          result.errors.push(
            deferError instanceof Error
              ? `checkout ${profile.id}: ${deferError.message}`
              : `checkout ${profile.id}: recovery deferral failed`
          );
        }
      }
    } finally {
      if (leaseClaimed && !leaseSettled) {
        try {
          await failRecovery(
            sb,
            profile.id,
            leaseToken,
            failureCode,
            retryAtIso
          );
        } catch (releaseError) {
          result.errors.push(
            releaseError instanceof Error
              ? `checkout ${profile.id}: ${releaseError.message}`
              : `checkout ${profile.id}: recovery failure settlement failed`
          );
        }
      }
    }
  }

  return result;
}
