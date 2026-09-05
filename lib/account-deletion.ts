import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  STRIPE_PRICE_ID,
  describeStripeError,
  getStripeClient,
} from "./stripe";
import { MAX_QTY, MIN_QTY } from "./update-quantity-guards";
import {
  normalizeAccountEmails,
  type AccountEmail,
} from "./account-privacy";

type DeletionSagaState =
  | "prepared"
  | "billing_clean"
  | "auth_delete_started"
  | "complete";

type CheckoutDeletionProfile = {
  id: string;
  stripe_session_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

type LegacyCheckoutDeletion = {
  session_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

type PreparedDeletion = {
  decision: "ready" | "missing_user";
  saga_state: DeletionSagaState | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  exclusive_customer_binding: boolean;
  profiles: CheckoutDeletionProfile[];
  legacy_profiles: LegacyCheckoutDeletion[];
};

type RpcClient = Pick<SupabaseClient, "rpc">;
type DeletionClient = Pick<SupabaseClient, "rpc" | "from">;

const TERMINAL_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "incomplete_expired",
  "resource_missing",
  "no_longer_alpha",
]);

export type AccountDeletionBlockedCode = "unresolved_suppression_recovery";

const UNRESOLVED_SUPPRESSION_RECOVERY_PREPARE_ERROR =
  "account deletion blocked by unresolved suppression recovery";

export class AccountDeletionBlockedError extends Error {
  readonly code: AccountDeletionBlockedCode | undefined;

  constructor(message: string, code?: AccountDeletionBlockedCode) {
    super(message);
    this.name = "AccountDeletionBlockedError";
    this.code = code;
  }
}

export function isAccountDeletionBlockedBySuppressionRecovery(
  error: unknown
): error is AccountDeletionBlockedError {
  return (
    error instanceof AccountDeletionBlockedError &&
    error.code === "unresolved_suppression_recovery"
  );
}

function blocked(message: string, cause?: unknown): AccountDeletionBlockedError {
  const detail = cause === undefined ? "" : `: ${describeStripeError(cause)}`;
  return new AccountDeletionBlockedError(`${message}${detail}`);
}

function stripeId(
  value: string | { id: string } | null | undefined
): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function isResourceMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "resource_missing"
  );
}

function isExactAlphaSubscription(
  subscription: Stripe.Subscription,
  expectedCustomerId: string
): boolean {
  const customerId = stripeId(subscription.customer);
  if (customerId !== expectedCustomerId) return false;
  if (
    !subscription.items ||
    subscription.items.has_more ||
    !Array.isArray(subscription.items.data) ||
    subscription.items.data.length !== 1
  ) {
    return false;
  }
  const item = subscription.items.data[0];
  const priceId = stripeId(item.price);
  const quantity = item.quantity ?? 1;
  return (
    priceId === STRIPE_PRICE_ID &&
    Number.isInteger(quantity) &&
    quantity >= MIN_QTY &&
    quantity <= MAX_QTY
  );
}

function alphaPricePresence(
  subscription: Stripe.Subscription
): "present" | "absent" | "unknown" {
  if (
    !subscription.items ||
    subscription.items.has_more ||
    !Array.isArray(subscription.items.data)
  ) {
    return "unknown";
  }
  return subscription.items.data.some(
    (item) => stripeId(item.price) === STRIPE_PRICE_ID
  )
    ? "present"
    : "absent";
}

function isExactAlphaCheckoutSession(
  session: Stripe.Checkout.Session,
  profileId: string
): boolean {
  if (
    session.mode !== "subscription" ||
    session.metadata?.alpha_profile_id !== profileId ||
    !session.line_items ||
    session.line_items.has_more ||
    !Array.isArray(session.line_items.data) ||
    session.line_items.data.length !== 1
  ) {
    return false;
  }
  const item = session.line_items.data[0];
  return stripeId(item.price) === STRIPE_PRICE_ID && item.quantity === 1;
}

function parsePreparedDeletion(data: unknown): PreparedDeletion {
  if (!data || typeof data !== "object") {
    throw blocked("account-deletion preparation returned no durable state");
  }
  const raw = data as Record<string, unknown>;
  if (raw.decision === "missing_user") {
    return {
      decision: "missing_user",
      saga_state: null,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      exclusive_customer_binding: false,
      profiles: [],
      legacy_profiles: [],
    };
  }
  const validStates: DeletionSagaState[] = [
    "prepared",
    "billing_clean",
    "auth_delete_started",
    "complete",
  ];
  if (
    raw.decision !== "ready" ||
    typeof raw.saga_state !== "string" ||
    !validStates.includes(raw.saga_state as DeletionSagaState) ||
    typeof raw.exclusive_customer_binding !== "boolean" ||
    !Array.isArray(raw.profiles) ||
    !Array.isArray(raw.legacy_profiles)
  ) {
    throw blocked("account-deletion preparation returned malformed state");
  }
  const profiles = raw.profiles.map((entry): CheckoutDeletionProfile => {
    if (!entry || typeof entry !== "object") {
      throw blocked("account-deletion preparation returned a malformed checkout tombstone");
    }
    const row = entry as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      (typeof row.stripe_session_id !== "string" &&
        row.stripe_session_id !== null)
    ) {
      throw blocked("account-deletion preparation returned an incomplete checkout tombstone");
    }
    return {
      id: row.id,
      stripe_session_id:
        typeof row.stripe_session_id === "string"
          ? row.stripe_session_id
          : null,
      stripe_customer_id:
        typeof row.stripe_customer_id === "string"
          ? row.stripe_customer_id
          : null,
      stripe_subscription_id:
        typeof row.stripe_subscription_id === "string"
          ? row.stripe_subscription_id
          : null,
    };
  });
  const legacyProfiles = raw.legacy_profiles.map(
    (entry): LegacyCheckoutDeletion => {
      if (!entry || typeof entry !== "object") {
        throw blocked(
          "account-deletion preparation returned a malformed legacy checkout tombstone"
        );
      }
      const row = entry as Record<string, unknown>;
      if (
        typeof row.session_id !== "string" ||
        (typeof row.stripe_customer_id !== "string" &&
          row.stripe_customer_id !== null) ||
        (typeof row.stripe_subscription_id !== "string" &&
          row.stripe_subscription_id !== null) ||
        ((row.stripe_customer_id === null) !==
          (row.stripe_subscription_id === null))
      ) {
        throw blocked(
          "account-deletion preparation returned an incomplete legacy checkout tombstone"
        );
      }
      return {
        session_id: row.session_id,
        stripe_customer_id: row.stripe_customer_id as string | null,
        stripe_subscription_id: row.stripe_subscription_id as string | null,
      };
    }
  );
  return {
    decision: "ready",
    saga_state: raw.saga_state as DeletionSagaState,
    stripe_customer_id:
      typeof raw.stripe_customer_id === "string"
        ? raw.stripe_customer_id
        : null,
    stripe_subscription_id:
      typeof raw.stripe_subscription_id === "string"
        ? raw.stripe_subscription_id
        : null,
    exclusive_customer_binding: raw.exclusive_customer_binding,
    profiles,
    legacy_profiles: legacyProfiles,
  };
}

async function callBooleanRpc(
  svc: RpcClient,
  name: string,
  args: Record<string, unknown>
): Promise<void> {
  const { data, error } = await svc.rpc(name, args);
  if (error || data !== true) {
    throw blocked(
      `${name} did not confirm its database transition`,
      error?.message ?? data
    );
  }
}

async function recordSubscriptionStatus(
  svc: RpcClient,
  userId: string,
  customerId: string,
  subscriptionId: string,
  status: string
): Promise<void> {
  await callBooleanRpc(svc, "record_account_deletion_subscription", {
    p_user_id: userId,
    p_customer_id: customerId,
    p_subscription_id: subscriptionId,
    p_status: status,
  });
}

async function retrieveSession(
  stripe: Stripe,
  sessionId: string
): Promise<Stripe.Checkout.Session | null> {
  try {
    return await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "subscription"],
    });
  } catch (error) {
    if (isResourceMissing(error)) return null;
    throw error;
  }
}

async function retrieveSubscription(
  stripe: Stripe,
  subscriptionId: string
): Promise<Stripe.Subscription | null> {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    if (isResourceMissing(error)) return null;
    throw error;
  }
}

async function cancelExactAlphaSubscription(
  svc: RpcClient,
  stripe: Stripe,
  userId: string,
  customerId: string,
  subscriptionId: string,
  suppliedSubscription?: Stripe.Subscription
): Promise<void> {
  let subscription =
    suppliedSubscription ??
    (await retrieveSubscription(stripe, subscriptionId));
  if (!subscription) {
    await recordSubscriptionStatus(
      svc,
      userId,
      customerId,
      subscriptionId,
      "resource_missing"
    );
    return;
  }
  if (subscription.id !== subscriptionId || stripeId(subscription.customer) !== customerId) {
    throw blocked(
      `Stripe subscription ${subscriptionId} is not bound to exact customer ${customerId}`
    );
  }

  await recordSubscriptionStatus(
    svc,
    userId,
    customerId,
    subscriptionId,
    subscription.status
  );
  if (TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) return;
  const alphaPresence = alphaPricePresence(subscription);
  if (alphaPresence === "absent") {
    await recordSubscriptionStatus(
      svc,
      userId,
      customerId,
      subscriptionId,
      "no_longer_alpha"
    );
    return;
  }
  if (
    alphaPresence === "unknown" ||
    !isExactAlphaSubscription(subscription, customerId)
  ) {
    throw blocked(
      `nonterminal Stripe subscription ${subscriptionId} has an unsafe mixed or malformed Alpha shape`
    );
  }

  try {
    subscription = await stripe.subscriptions.cancel(subscriptionId);
  } catch (cancelError) {
    // Stripe may accept the cancellation and lose the response. One bounded
    // read distinguishes that idempotent success from a subscription that can
    // still bill. Any other uncertainty leaves Auth intact for a later retry.
    try {
      subscription = await retrieveSubscription(stripe, subscriptionId);
    } catch (readError) {
      throw blocked(
        `could not confirm cancellation of Alpha subscription ${subscriptionId}`,
        readError
      );
    }
    if (!subscription) {
      await recordSubscriptionStatus(
        svc,
        userId,
        customerId,
        subscriptionId,
        "resource_missing"
      );
      return;
    }
    if (!TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) {
      throw blocked(
        `Alpha subscription ${subscriptionId} remained ${subscription.status} after cancellation failed`,
        cancelError
      );
    }
  }

  if (
    subscription.id !== subscriptionId ||
    stripeId(subscription.customer) !== customerId ||
    !TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)
  ) {
    throw blocked(
      `Stripe did not return a terminal exact Alpha subscription for ${subscriptionId}`
    );
  }
  await recordSubscriptionStatus(
    svc,
    userId,
    customerId,
    subscriptionId,
    subscription.status
  );
}

async function settleCheckoutProfile(
  svc: RpcClient,
  stripe: Stripe,
  userId: string,
  profile: CheckoutDeletionProfile,
  authorizedSubscriptions: Map<string, Set<string>>
): Promise<void> {
  if (!profile.stripe_session_id) {
    throw blocked(
      `checkout profile ${profile.id} still has an in-flight Session creation lease`
    );
  }
  let session: Stripe.Checkout.Session | null;
  try {
    session = await retrieveSession(stripe, profile.stripe_session_id);
  } catch (error) {
    throw blocked(
      `could not inspect Checkout Session ${profile.stripe_session_id}`,
      error
    );
  }

  if (!session) {
    // resource_missing can also mean the wrong Stripe account or mode. A
    // locally stored Session id therefore needs signed terminal evidence, not
    // absence from one provider lookup.
    throw blocked(
      `bound Checkout Session ${profile.stripe_session_id} is missing and has no authoritative terminal proof`
    );
  }
  if (
    session.mode !== "subscription" ||
    session.metadata?.alpha_profile_id !== profile.id
  ) {
    throw blocked(
      `Checkout Session ${profile.stripe_session_id} has an invalid staged profile binding`
    );
  }
  if (
    session.status !== "expired" &&
    !isExactAlphaCheckoutSession(session, profile.id)
  ) {
    throw blocked(
      `Checkout Session ${profile.stripe_session_id} is not the exact Alpha checkout item`
    );
  }

  if (session.status === "open") {
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch (expireError) {
      // A payment can complete between retrieve and expire. Always re-read
      // instead of treating the expire error as proof of either outcome.
      if (!isResourceMissing(expireError)) {
        // Deliberately continue to the authoritative read below.
      }
    }
    try {
      session = await retrieveSession(stripe, profile.stripe_session_id);
    } catch (error) {
      throw blocked(
        `could not re-read Checkout Session ${profile.stripe_session_id} after expiry attempt`,
        error
      );
    }
    if (!session) {
      throw blocked(
        `Checkout Session ${profile.stripe_session_id} disappeared before terminal status could be confirmed`
      );
    }
    if (
      session.mode !== "subscription" ||
      session.metadata?.alpha_profile_id !== profile.id ||
      (session.status !== "expired" &&
        !isExactAlphaCheckoutSession(session, profile.id))
    ) {
      throw blocked(
        `Checkout Session ${profile.stripe_session_id} changed its Alpha binding during deletion`
      );
    }
  }

  if (session.status === "expired") {
    if (profile.stripe_customer_id || profile.stripe_subscription_id) {
      throw blocked(
        `expired Checkout Session ${profile.stripe_session_id} conflicts with a stored billing binding`
      );
    }
    await callBooleanRpc(svc, "settle_account_deletion_checkout_profile", {
      p_user_id: userId,
      p_profile_id: profile.id,
      p_session_id: profile.stripe_session_id,
      p_customer_id: null,
      p_subscription_id: null,
      p_terminal_state: "expired",
    });
    return;
  }
  if (session.status !== "complete") {
    throw blocked(
      `Checkout Session ${profile.stripe_session_id} remained in unsupported state ${session.status}`
    );
  }

  const customerId = stripeId(session.customer);
  const subscriptionId = stripeId(session.subscription);
  if (!customerId || !subscriptionId) {
    throw blocked(
      `completed Checkout Session ${profile.stripe_session_id} has no exact customer and subscription`
    );
  }
  if (
    (profile.stripe_customer_id &&
      profile.stripe_customer_id !== customerId) ||
    (profile.stripe_subscription_id &&
      profile.stripe_subscription_id !== subscriptionId)
  ) {
    throw blocked(
      `completed Checkout Session ${profile.stripe_session_id} conflicts with its durable billing binding`
    );
  }
  const customerSubscriptions =
    authorizedSubscriptions.get(customerId) ?? new Set<string>();
  customerSubscriptions.add(subscriptionId);
  authorizedSubscriptions.set(customerId, customerSubscriptions);
  const expandedSubscription =
    typeof session.subscription === "object" && session.subscription
      ? session.subscription
      : undefined;
  await cancelExactAlphaSubscription(
    svc,
    stripe,
    userId,
    customerId,
    subscriptionId,
    expandedSubscription
  );
  await callBooleanRpc(svc, "settle_account_deletion_checkout_profile", {
    p_user_id: userId,
    p_profile_id: profile.id,
    p_session_id: profile.stripe_session_id,
    p_customer_id: customerId,
    p_subscription_id: subscriptionId,
    p_terminal_state: "ended",
  });
}

async function inspectCustomerForUnboundAlphaDrift(
  svc: RpcClient,
  stripe: Stripe,
  userId: string,
  customerId: string,
  authorizedSubscriptionIds: ReadonlySet<string>,
  recordDrift = true
): Promise<{
  hasUnboundLiveAlpha: boolean;
  unboundLiveSubscriptions: Stripe.Subscription[];
}> {
  let page: Stripe.ApiList<Stripe.Subscription>;
  try {
    page = await stripe.subscriptions.list({
      customer: customerId,
      price: STRIPE_PRICE_ID,
      status: "all",
      limit: 100,
    });
  } catch (error) {
    throw blocked(
      `could not inspect Alpha subscriptions for Stripe customer ${customerId}`,
      error
    );
  }
  if (page.has_more || !Array.isArray(page.data)) {
    throw blocked(
      `Alpha subscription lookup for Stripe customer ${customerId} was incomplete`
    );
  }
  let hasUnboundLiveAlpha = false;
  const unboundLiveSubscriptions: Stripe.Subscription[] = [];
  for (const subscription of page.data) {
    if (authorizedSubscriptionIds.has(subscription.id)) continue;
    if (stripeId(subscription.customer) !== customerId) {
      throw blocked(
        `Stripe customer-filtered subscription ${subscription.id} returned a different customer binding`
      );
    }
    if (recordDrift) {
      await recordSubscriptionStatus(
        svc,
        userId,
        customerId,
        subscription.id,
        subscription.status
      );
    }
    if (!TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) {
      hasUnboundLiveAlpha = true;
      unboundLiveSubscriptions.push(subscription);
      if (recordDrift) {
        console.warn(
          "[account-deletion] a Stripe customer also has an unbound Alpha-priced subscription; preserving it because it is outside the deleting user's exact stored binding"
        );
      }
    }
  }
  return { hasUnboundLiveAlpha, unboundLiveSubscriptions };
}

export async function settleAccountDeletionBilling(
  svc: RpcClient,
  userId: string,
  stripeClient?: Stripe
): Promise<DeletionSagaState> {
  const { data, error } = await svc.rpc("prepare_account_deletion", {
    p_user_id: userId,
  });
  if (error) {
    if (error.message === UNRESOLVED_SUPPRESSION_RECOVERY_PREPARE_ERROR) {
      throw new AccountDeletionBlockedError(
        UNRESOLVED_SUPPRESSION_RECOVERY_PREPARE_ERROR,
        "unresolved_suppression_recovery"
      );
    }
    throw blocked("could not prepare durable account deletion", error.message);
  }
  const prepared = parsePreparedDeletion(data);
  if (prepared.decision === "missing_user") {
    throw blocked("public user and durable deletion tombstone are both missing");
  }
  if (prepared.saga_state !== "prepared") {
    return prepared.saga_state!;
  }

  if (
    prepared.stripe_subscription_id &&
    !prepared.stripe_customer_id
  ) {
    throw blocked(
      "stored Alpha subscription has no exact Stripe customer binding"
    );
  }

  const requiresStripe =
    !!prepared.stripe_customer_id ||
    !!prepared.stripe_subscription_id ||
    prepared.profiles.length > 0 ||
    prepared.legacy_profiles.some(
      (legacy) =>
        !!legacy.stripe_customer_id && !!legacy.stripe_subscription_id
    );
  const stripe = requiresStripe ? stripeClient ?? getStripeClient() : null;
  const authorizedSubscriptions = new Map<string, Set<string>>();
  if (prepared.stripe_customer_id) {
    authorizedSubscriptions.set(prepared.stripe_customer_id, new Set());
  }

  if (stripe) {
    for (const profile of prepared.profiles) {
      await settleCheckoutProfile(
        svc,
        stripe,
        userId,
        profile,
        authorizedSubscriptions
      );
    }

    for (const legacy of prepared.legacy_profiles) {
      if (!legacy.stripe_customer_id || !legacy.stripe_subscription_id) {
        continue;
      }
      const customerSubscriptions =
        authorizedSubscriptions.get(legacy.stripe_customer_id) ??
        new Set<string>();
      customerSubscriptions.add(legacy.stripe_subscription_id);
      authorizedSubscriptions.set(
        legacy.stripe_customer_id,
        customerSubscriptions
      );
      await cancelExactAlphaSubscription(
        svc,
        stripe,
        userId,
        legacy.stripe_customer_id,
        legacy.stripe_subscription_id
      );
    }

    if (
      prepared.stripe_customer_id &&
      prepared.stripe_subscription_id
    ) {
      authorizedSubscriptions
        .get(prepared.stripe_customer_id)!
        .add(prepared.stripe_subscription_id);
      await cancelExactAlphaSubscription(
        svc,
        stripe,
        userId,
        prepared.stripe_customer_id,
        prepared.stripe_subscription_id
      );
    }


    if (
      prepared.stripe_customer_id &&
      !prepared.stripe_subscription_id &&
      authorizedSubscriptions.get(prepared.stripe_customer_id)?.size === 0
    ) {
      const legacyInspection = await inspectCustomerForUnboundAlphaDrift(
        svc,
        stripe,
        userId,
        prepared.stripe_customer_id,
        new Set(),
        false
      );
      if (legacyInspection.hasUnboundLiveAlpha) {
        if (
          !prepared.exclusive_customer_binding ||
          legacyInspection.unboundLiveSubscriptions.length !== 1
        ) {
          throw blocked(
            `customer-only legacy billing for ${prepared.stripe_customer_id} is not uniquely attributable to this user`
          );
        }
        const candidate = legacyInspection.unboundLiveSubscriptions[0];
        if (!isExactAlphaSubscription(candidate, prepared.stripe_customer_id)) {
          throw blocked(
            `customer-only legacy subscription ${candidate.id} is not one exact Alpha item`
          );
        }
        await callBooleanRpc(svc, "bind_account_deletion_subscription", {
          p_user_id: userId,
          p_customer_id: prepared.stripe_customer_id,
          p_subscription_id: candidate.id,
          p_status: candidate.status,
        });
        authorizedSubscriptions
          .get(prepared.stripe_customer_id)!
          .add(candidate.id);
        await cancelExactAlphaSubscription(
          svc,
          stripe,
          userId,
          prepared.stripe_customer_id,
          candidate.id,
          candidate
        );
      }
    }

    // Re-read only the exact subscription ids durably bound to this user or
    // one of their checkout profiles. A Stripe Customer can be reused by
    // historical drift, so another Alpha subscription under that Customer is
    // logged but never treated as authorization to mutate it.
    for (const [customerId, subscriptionIds] of authorizedSubscriptions) {
      for (const subscriptionId of subscriptionIds) {
        const subscription = await retrieveSubscription(stripe, subscriptionId);
        if (!subscription) {
          await recordSubscriptionStatus(
            svc,
            userId,
            customerId,
            subscriptionId,
            "resource_missing"
          );
          continue;
        }
        if (stripeId(subscription.customer) !== customerId) {
          throw blocked(
            `exact subscription ${subscriptionId} moved to a different customer`
          );
        }
        if (TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) {
          await recordSubscriptionStatus(
            svc,
            userId,
            customerId,
            subscriptionId,
            subscription.status
          );
          continue;
        }
        if (alphaPricePresence(subscription) === "absent") {
          await recordSubscriptionStatus(
            svc,
            userId,
            customerId,
            subscriptionId,
            "no_longer_alpha"
          );
          continue;
        }
        {
          throw blocked(
            `exact Alpha subscription ${subscriptionId} was not terminal at final verification`
          );
        }
      }
      const drift = await inspectCustomerForUnboundAlphaDrift(
        svc,
        stripe,
        userId,
        customerId,
        subscriptionIds
      );
      // A customer-only legacy binding supplies no exact subscription id. A
      // complete read proving no other live Alpha subscription is the only
      // safe automatic case. If one exists, Auth stays intact for manual
      // binding repair instead of guessing which account owns it.
      if (drift.hasUnboundLiveAlpha) {
        throw blocked(
          `Stripe customer ${customerId} still has a live Alpha subscription that is not authorized by this deletion saga`
        );
      }
    }
  }

  await callBooleanRpc(svc, "confirm_account_deletion_billing", {
    p_user_id: userId,
  });
  return "billing_clean";
}

export async function beginAccountDeletionAuthRemoval(
  svc: RpcClient,
  userId: string
): Promise<void> {
  await callBooleanRpc(svc, "begin_account_deletion_auth_removal", {
    p_user_id: userId,
  });
}

export async function removeAccountAuthAndCompleteSaga(
  svc: RpcClient,
  userId: string,
  deleteAuthUser: () => Promise<void>
): Promise<void> {
  // Keep the retry point durable before the irreversible Auth call. If the
  // provider call fails, a later request resumes from auth_delete_started.
  // Completion is part of the same application step so callers never report
  // full deletion while checkout identity scrubbing is still pending.
  await beginAccountDeletionAuthRemoval(svc, userId);
  await deleteAuthUser();
  await completeAccountDeletion(svc, userId);
}

export async function settleAccountDeletionPrivacy(
  svc: DeletionClient,
  userId: string,
  emails: AccountEmail | readonly AccountEmail[]
): Promise<void> {
  const normalizedEmails = normalizeAccountEmails(
    ...(Array.isArray(emails) ? emails : [emails])
  );
  if (normalizedEmails.length === 0) {
    throw blocked("account deletion has no confirmed email for privacy cleanup");
  }

  const { error: linkedError } = await svc
    .from("support_tickets")
    .delete()
    .eq("user_id", userId);
  if (linkedError) {
    throw blocked("linked support-ticket deletion failed", linkedError.message);
  }

  for (const normalizedEmail of normalizedEmails) {
    const escapedEmail = normalizedEmail.replace(/[\\%_]/g, "\\$&");
    const { error: orphanError } = await svc
      .from("support_tickets")
      .delete()
      .is("user_id", null)
      .ilike("email", escapedEmail);
    if (orphanError) {
      throw blocked(
        "orphaned support-ticket deletion failed",
        orphanError.message
      );
    }
  }
  await callBooleanRpc(svc, "mark_account_deletion_support_deleted", {
    p_user_id: userId,
  });

  // Account deletion preserves Resend's provider-side suppression policy. The
  // app does not claim provider-record deletion from a status code or a
  // best-effort recovery call. This marker says the local deletion policy was
  // durably settled after the app-owned support records were removed.
  await callBooleanRpc(svc, "mark_account_deletion_delivery_policy_settled", {
    p_user_id: userId,
  });
}

export async function completeAccountDeletion(
  svc: RpcClient,
  userId: string
): Promise<void> {
  await callBooleanRpc(svc, "complete_account_deletion", {
    p_user_id: userId,
  });
}
