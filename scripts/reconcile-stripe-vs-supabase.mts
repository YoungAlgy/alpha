#!/usr/bin/env node
// Weekly, strictly read-only reconciliation of the dedicated Alpha Stripe
// price against Round 80's exact local Customer + Subscription binding.
//
// The pure audit is exported so local verification can inject complete
// fixtures without loading env files or contacting Stripe or Supabase. The
// live entrypoint runs only when this file is executed directly.
//
// This repository is public. Stdout is consumed by a public GitHub Actions
// log and GitHub Issue, so it contains aggregate counts and finding types only.
// Exact identifiers, timestamps, quantities, quotas, and details are formatted
// only for the private Alpha ops alert.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasSubscriberAccess } from "../lib/access.ts";
import { STRIPE_PRICE_ID, getStripeClient } from "../lib/stripe.ts";
import { TOPICS_PER_BUNDLE } from "../lib/types.ts";
import {
  deriveCancelledAt,
  isTerminalSubscriptionStatus,
  subscriptionStatusGrantsAccess,
} from "../lib/webhook-user-mutation.ts";
import { requireExactAlphaSupabaseUrl } from "./alpha-supabase-url.mjs";

export const EXACT_ALPHA_PRICE_ID = "price_1TWfeHAhrDpDN9sHC2Ay0w7h";
if (STRIPE_PRICE_ID !== EXACT_ALPHA_PRICE_ID) {
  throw new Error("Alpha reconciliation price constant mismatch");
}

export type ProviderSubscriptionSnapshot = {
  id: string;
  customerId: string | null;
  status: string;
  cancelAt: number | null;
  itemsHasMore: boolean;
  items: Array<{
    priceId: string | null;
    quantity: number | null;
  }>;
};

export type LocalBillingSnapshot = {
  id: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscribedAt: string | null;
  cancelledAt: string | null;
  topicQuota: number | null;
};

export type ReconciliationFindingType =
  | "access_status_mismatch"
  | "cancellation_mismatch"
  | "local_active_exact_pair_missing"
  | "local_binding_missing"
  | "local_customer_ambiguous"
  | "local_identifier_invalid"
  | "local_provider_ambiguous"
  | "local_provider_missing"
  | "local_provider_pair_mismatch"
  | "local_subscription_ambiguous"
  | "local_timestamp_invalid"
  | "provider_binding_mismatch"
  | "provider_binding_missing"
  | "provider_identifier_invalid"
  | "provider_local_customer_ambiguous"
  | "provider_local_subscription_ambiguous"
  | "provider_mixed_items"
  | "provider_multiple_nonterminal"
  | "provider_orphan"
  | "provider_price_mismatch"
  | "provider_quantity_invalid"
  | "provider_status_unknown"
  | "provider_subscription_ambiguous"
  | "quantity_quota_mismatch"
  | "reconciliation_configuration_missing"
  | "reconciliation_inventory_unavailable";

export type ReconciliationFinding = {
  type: ReconciliationFindingType;
  detail: string;
  userId?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
};

export type PublicReconciliationSummary = {
  checkedAt: string;
  localBillingRows: number;
  exactAlphaSubscriptions: number;
  findingsCount: number;
  findingTypes: Array<{ type: ReconciliationFindingType; count: number }>;
};

type ProviderShape = {
  ok: boolean;
  quantity: number | null;
  reasons: Array<
    | "provider_mixed_items"
    | "provider_price_mismatch"
    | "provider_quantity_invalid"
  >;
};

const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;
const KNOWN_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
]);
const PRIVATE_FINDINGS_CAP = 25;
const PROVIDER_PAGE_SIZE = 100;
const MAX_PROVIDER_PAGES = 10;
const MAX_PROVIDER_SUBSCRIPTIONS =
  PROVIDER_PAGE_SIZE * MAX_PROVIDER_PAGES;
const LOCAL_PAGE_SIZE = 100;
const MAX_LOCAL_BILLING_ROWS = 1_000;
const DATABASE_REQUEST_TIMEOUT_MS = 15_000;

function isCanonicalId(
  value: string | null,
  pattern: RegExp
): value is string {
  return value !== null && value === value.trim() && pattern.test(value);
}

function isValidTimestamp(value: string | null): boolean {
  return value === null || Number.isFinite(Date.parse(value));
}

function sameInstant(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && leftMs === rightMs;
}

function inspectProviderShape(
  subscription: ProviderSubscriptionSnapshot
): ProviderShape {
  const reasons: ProviderShape["reasons"] = [];
  const alphaItems = subscription.items.filter(
    (item) => item.priceId === EXACT_ALPHA_PRICE_ID
  );
  if (subscription.itemsHasMore || subscription.items.length !== 1) {
    reasons.push("provider_mixed_items");
  }
  if (alphaItems.length !== 1) {
    reasons.push(
      alphaItems.length > 1
        ? "provider_mixed_items"
        : "provider_price_mismatch"
    );
  }
  const quantity = alphaItems.length === 1 ? alphaItems[0].quantity : null;
  if (
    alphaItems.length === 1 &&
    (!Number.isInteger(quantity) ||
      (quantity as number) < 1 ||
      (quantity as number) > 5)
  ) {
    reasons.push("provider_quantity_invalid");
  }
  return {
    ok: reasons.length === 0,
    quantity: typeof quantity === "number" ? quantity : null,
    reasons: [...new Set(reasons)],
  };
}

function normalizeProviderSubscription(
  subscription: Stripe.Subscription
): ProviderSubscriptionSnapshot {
  let customerId: string | null = null;
  if (typeof subscription.customer === "string") {
    customerId = subscription.customer;
  } else if (!("deleted" in subscription.customer && subscription.customer.deleted)) {
    customerId = subscription.customer.id;
  }
  return {
    id: subscription.id,
    customerId,
    status: subscription.status,
    cancelAt: subscription.cancel_at ?? null,
    itemsHasMore: subscription.items.has_more,
    items: subscription.items.data.map((item) => ({
      priceId:
        typeof item.price === "string" ? item.price : item.price?.id ?? null,
      quantity:
        typeof item.quantity === "number" ? item.quantity : null,
    })),
  };
}

function pushToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key) ?? [];
  existing.push(value);
  map.set(key, existing);
}

export function reconcileExactAlphaBindings(input: {
  subscriptions: ProviderSubscriptionSnapshot[];
  users: LocalBillingSnapshot[];
  observedAt?: Date;
}): ReconciliationFinding[] {
  const observedAt = input.observedAt ?? new Date();
  const findings: ReconciliationFinding[] = [];
  const findingKeys = new Set<string>();
  const addFinding = (finding: ReconciliationFinding): void => {
    const key = [
      finding.type,
      finding.userId ?? "",
      finding.stripeCustomerId ?? "",
      finding.stripeSubscriptionId ?? "",
      finding.detail,
    ].join("\u0000");
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push(finding);
  };

  const localByCustomer = new Map<string, LocalBillingSnapshot[]>();
  const localBySubscription = new Map<string, LocalBillingSnapshot[]>();
  for (const user of input.users) {
    const customerValid =
      user.stripeCustomerId === null ||
      isCanonicalId(user.stripeCustomerId, CUSTOMER_ID);
    const subscriptionValid =
      user.stripeSubscriptionId === null ||
      isCanonicalId(user.stripeSubscriptionId, SUBSCRIPTION_ID);
    if (
      !customerValid ||
      !subscriptionValid ||
      (user.stripeSubscriptionId !== null && user.stripeCustomerId === null)
    ) {
      addFinding({
        type: "local_identifier_invalid",
        userId: user.id,
        stripeCustomerId: user.stripeCustomerId ?? undefined,
        stripeSubscriptionId: user.stripeSubscriptionId ?? undefined,
        detail: "Local billing identifiers are malformed or incomplete.",
      });
    }
    if (
      !isValidTimestamp(user.subscribedAt) ||
      !isValidTimestamp(user.cancelledAt)
    ) {
      addFinding({
        type: "local_timestamp_invalid",
        userId: user.id,
        stripeCustomerId: user.stripeCustomerId ?? undefined,
        stripeSubscriptionId: user.stripeSubscriptionId ?? undefined,
        detail: `Local subscribed_at=${user.subscribedAt ?? "null"} or cancelled_at=${user.cancelledAt ?? "null"} is invalid.`,
      });
    }
    if (isCanonicalId(user.stripeCustomerId, CUSTOMER_ID)) {
      pushToMap(localByCustomer, user.stripeCustomerId, user);
    }
    if (isCanonicalId(user.stripeSubscriptionId, SUBSCRIPTION_ID)) {
      pushToMap(localBySubscription, user.stripeSubscriptionId, user);
    }
  }

  for (const [customerId, users] of localByCustomer) {
    if (users.length > 1) {
      addFinding({
        type: "local_customer_ambiguous",
        stripeCustomerId: customerId,
        detail: `Stripe Customer ${customerId} is held by ${users.length} local users: ${users.map((user) => user.id).sort().join(", ")}.`,
      });
    }
  }
  for (const [subscriptionId, users] of localBySubscription) {
    if (users.length > 1) {
      addFinding({
        type: "local_subscription_ambiguous",
        stripeSubscriptionId: subscriptionId,
        detail: `Stripe Subscription ${subscriptionId} is held by ${users.length} local users: ${users.map((user) => user.id).sort().join(", ")}.`,
      });
    }
  }

  const providerById = new Map<string, ProviderSubscriptionSnapshot[]>();
  const providerByCustomer = new Map<
    string,
    ProviderSubscriptionSnapshot[]
  >();
  const providerShapes = new Map<ProviderSubscriptionSnapshot, ProviderShape>();
  for (const subscription of input.subscriptions) {
    const subscriptionValid = isCanonicalId(
      subscription.id,
      SUBSCRIPTION_ID
    );
    const customerValid = isCanonicalId(
      subscription.customerId,
      CUSTOMER_ID
    );
    if (!subscriptionValid || !customerValid) {
      addFinding({
        type: "provider_identifier_invalid",
        stripeCustomerId: subscription.customerId ?? undefined,
        stripeSubscriptionId: subscription.id || undefined,
        detail: "Provider Customer or Subscription identifier is malformed, missing, or deleted.",
      });
    }
    const shape = inspectProviderShape(subscription);
    providerShapes.set(subscription, shape);
    for (const reason of shape.reasons) {
      addFinding({
        type: reason,
        stripeCustomerId: subscription.customerId ?? undefined,
        stripeSubscriptionId: subscription.id || undefined,
        detail:
          reason === "provider_mixed_items"
            ? `Subscription ${subscription.id} has a mixed, duplicated, or truncated item list.`
            : reason === "provider_price_mismatch"
              ? `Subscription ${subscription.id} does not contain exactly one ${EXACT_ALPHA_PRICE_ID} item.`
              : `Subscription ${subscription.id} has invalid Alpha quantity ${shape.quantity ?? "null"}.`,
      });
    }
    if (!KNOWN_SUBSCRIPTION_STATUSES.has(subscription.status)) {
      addFinding({
        type: "provider_status_unknown",
        stripeCustomerId: subscription.customerId ?? undefined,
        stripeSubscriptionId: subscription.id || undefined,
        detail: `Subscription ${subscription.id} has unknown status ${subscription.status}.`,
      });
    }
    if (subscriptionValid) {
      pushToMap(providerById, subscription.id, subscription);
    }
    if (subscriptionValid && customerValid) {
      pushToMap(providerByCustomer, subscription.customerId, subscription);
    }
  }

  for (const [subscriptionId, subscriptions] of providerById) {
    if (subscriptions.length > 1) {
      addFinding({
        type: "provider_subscription_ambiguous",
        stripeSubscriptionId: subscriptionId,
        detail: `Provider inventory returned Subscription ${subscriptionId} ${subscriptions.length} times.`,
      });
    }
  }

  const auditedPairs = new Set<string>();
  const auditExactPair = (
    user: LocalBillingSnapshot,
    subscription: ProviderSubscriptionSnapshot
  ): void => {
    const pairKey = `${user.id}\u0000${subscription.id}`;
    if (auditedPairs.has(pairKey)) return;
    auditedPairs.add(pairKey);
    const localAccess = hasSubscriberAccess(
      user.subscribedAt,
      user.cancelledAt,
      observedAt
    );
    const providerAccess = subscriptionStatusGrantsAccess(subscription.status);
    if (localAccess !== providerAccess) {
      addFinding({
        type: "access_status_mismatch",
        userId: user.id,
        stripeCustomerId: user.stripeCustomerId ?? undefined,
        stripeSubscriptionId: user.stripeSubscriptionId ?? undefined,
        detail: `Provider status=${subscription.status} grantsAccess=${providerAccess}, while local subscribed_at=${user.subscribedAt ?? "null"} cancelled_at=${user.cancelledAt ?? "null"} grantsAccess=${localAccess}.`,
      });
    }
    if (providerAccess) {
      const expectedCancelledAt = deriveCancelledAt(
        subscription.status,
        subscription.cancelAt,
        observedAt.toISOString()
      );
      if (!sameInstant(user.cancelledAt, expectedCancelledAt)) {
        addFinding({
          type: "cancellation_mismatch",
          userId: user.id,
          stripeCustomerId: user.stripeCustomerId ?? undefined,
          stripeSubscriptionId: user.stripeSubscriptionId ?? undefined,
          detail: `Provider cancel_at=${subscription.cancelAt ?? "null"} implies cancelled_at=${expectedCancelledAt ?? "null"}, while local cancelled_at=${user.cancelledAt ?? "null"}.`,
        });
      }
    }
    const shape = providerShapes.get(subscription);
    if (
      shape?.ok &&
      user.topicQuota !== (shape.quantity as number) * TOPICS_PER_BUNDLE
    ) {
      addFinding({
        type: "quantity_quota_mismatch",
        userId: user.id,
        stripeCustomerId: user.stripeCustomerId ?? undefined,
        stripeSubscriptionId: user.stripeSubscriptionId ?? undefined,
        detail: `Provider quantity=${shape.quantity} requires topic_quota=${(shape.quantity as number) * TOPICS_PER_BUNDLE}, while local topic_quota=${user.topicQuota ?? "null"}.`,
      });
    }
  };

  for (const [customerId, subscriptions] of providerByCustomer) {
    const nonTerminal = subscriptions.filter(
      (subscription) =>
        !isTerminalSubscriptionStatus(subscription.status)
    );
    if (nonTerminal.length > 1) {
      addFinding({
        type: "provider_multiple_nonterminal",
        stripeCustomerId: customerId,
        detail: `Customer ${customerId} has ${nonTerminal.length} nonterminal Alpha Subscriptions: ${nonTerminal.map((subscription) => subscription.id).sort().join(", ")}.`,
      });
    }
    for (const subscription of nonTerminal) {
      const customerOwners = localByCustomer.get(customerId) ?? [];
      const subscriptionOwners =
        localBySubscription.get(subscription.id) ?? [];
      if (customerOwners.length === 0) {
        addFinding({
          type:
            subscriptionOwners.length === 0
              ? "provider_orphan"
              : "provider_binding_mismatch",
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          detail:
            subscriptionOwners.length === 0
              ? `Nonterminal Alpha Subscription ${subscription.id} has no local Customer or Subscription owner.`
              : `Subscription ${subscription.id} is locally held under a different Customer.`,
        });
        continue;
      }
      if (customerOwners.length !== 1) {
        addFinding({
          type: "provider_local_customer_ambiguous",
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          detail: `Nonterminal Alpha Subscription ${subscription.id} has ${customerOwners.length} local Customer owners.`,
        });
        continue;
      }
      const owner = customerOwners[0];
      if (owner.stripeSubscriptionId === null) {
        addFinding({
          type: "provider_binding_missing",
          userId: owner.id,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          detail: `Local owner ${owner.id} has Customer ${customerId} but no exact Subscription binding for ${subscription.id}.`,
        });
        continue;
      }
      if (owner.stripeSubscriptionId !== subscription.id) {
        addFinding({
          type: "provider_binding_mismatch",
          userId: owner.id,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          detail: `Local owner ${owner.id} stores Subscription ${owner.stripeSubscriptionId}, while provider Subscription ${subscription.id} is nonterminal for the same Customer.`,
        });
        continue;
      }
      if (
        subscriptionOwners.length !== 1 ||
        subscriptionOwners[0].id !== owner.id
      ) {
        addFinding({
          type: "provider_local_subscription_ambiguous",
          userId: owner.id,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          detail: `Subscription ${subscription.id} does not have one exact local owner under Customer ${customerId}.`,
        });
        continue;
      }
      auditExactPair(owner, subscription);
    }
  }

  for (const user of input.users) {
    const localAccess = hasSubscriberAccess(
      user.subscribedAt,
      user.cancelledAt,
      observedAt
    );
    const customerValid = isCanonicalId(user.stripeCustomerId, CUSTOMER_ID);
    const subscriptionValid = isCanonicalId(
      user.stripeSubscriptionId,
      SUBSCRIPTION_ID
    );
    if (!customerValid || !subscriptionValid) {
      if (customerValid && user.stripeSubscriptionId === null && localAccess) {
        addFinding({
          type: "local_binding_missing",
          userId: user.id,
          stripeCustomerId: user.stripeCustomerId,
          detail: `Active billed local user ${user.id} has no stripe_subscription_id.`,
        });
      }
      if (localAccess && (user.stripeCustomerId !== null || user.stripeSubscriptionId !== null)) {
        addFinding({
          type: "local_active_exact_pair_missing",
          userId: user.id,
          stripeCustomerId: user.stripeCustomerId ?? undefined,
          stripeSubscriptionId: user.stripeSubscriptionId ?? undefined,
          detail: `Active billed local user ${user.id} does not have one canonical exact Alpha provider pair.`,
        });
      }
      continue;
    }
    const providerCandidates = providerById.get(user.stripeSubscriptionId) ?? [];
    if (providerCandidates.length === 0) {
      addFinding({
        type: "local_provider_missing",
        userId: user.id,
        stripeCustomerId: user.stripeCustomerId,
        stripeSubscriptionId: user.stripeSubscriptionId,
        detail: `Local Subscription ${user.stripeSubscriptionId} is absent from the exact Alpha price inventory.`,
      });
      if (localAccess) {
        addFinding({
          type: "local_active_exact_pair_missing",
          userId: user.id,
          stripeCustomerId: user.stripeCustomerId,
          stripeSubscriptionId: user.stripeSubscriptionId,
          detail: `Active billed local user ${user.id} has no exact Alpha provider Subscription.`,
        });
      }
      continue;
    }
    if (providerCandidates.length !== 1) {
      addFinding({
        type: "local_provider_ambiguous",
        userId: user.id,
        stripeCustomerId: user.stripeCustomerId,
        stripeSubscriptionId: user.stripeSubscriptionId,
        detail: `Local Subscription ${user.stripeSubscriptionId} appears ${providerCandidates.length} times in provider inventory.`,
      });
      if (localAccess) {
        addFinding({
          type: "local_active_exact_pair_missing",
          userId: user.id,
          stripeCustomerId: user.stripeCustomerId,
          stripeSubscriptionId: user.stripeSubscriptionId,
          detail: `Active billed local user ${user.id} has an ambiguous provider Subscription.`,
        });
      }
      continue;
    }
    const subscription = providerCandidates[0];
    if (subscription.customerId !== user.stripeCustomerId) {
      addFinding({
        type: "local_provider_pair_mismatch",
        userId: user.id,
        stripeCustomerId: user.stripeCustomerId,
        stripeSubscriptionId: user.stripeSubscriptionId,
        detail: `Local Customer ${user.stripeCustomerId} stores Subscription ${user.stripeSubscriptionId}, but provider Customer is ${subscription.customerId ?? "missing"}.`,
      });
      if (localAccess) {
        addFinding({
          type: "local_active_exact_pair_missing",
          userId: user.id,
          stripeCustomerId: user.stripeCustomerId,
          stripeSubscriptionId: user.stripeSubscriptionId,
          detail: `Active billed local user ${user.id} has a cross-Customer provider binding.`,
        });
      }
      continue;
    }
    const shape = providerShapes.get(subscription);
    if (localAccess && !shape?.ok) {
      addFinding({
        type: "local_active_exact_pair_missing",
        userId: user.id,
        stripeCustomerId: user.stripeCustomerId,
        stripeSubscriptionId: user.stripeSubscriptionId,
        detail: `Active billed local user ${user.id} is bound to a provider Subscription with an unsafe Alpha item shape.`,
      });
    }
    auditExactPair(user, subscription);
  }

  return findings.sort((left, right) =>
    [
      left.type,
      left.stripeCustomerId ?? "",
      left.stripeSubscriptionId ?? "",
      left.userId ?? "",
      left.detail,
    ]
      .join(":")
      .localeCompare(
        [
          right.type,
          right.stripeCustomerId ?? "",
          right.stripeSubscriptionId ?? "",
          right.userId ?? "",
          right.detail,
        ].join(":")
      )
  );
}

export function buildPublicReconciliationSummary(input: {
  subscriptions: ProviderSubscriptionSnapshot[];
  users: LocalBillingSnapshot[];
  findings: ReconciliationFinding[];
  checkedAt?: Date;
}): PublicReconciliationSummary {
  const counts = new Map<ReconciliationFindingType, number>();
  for (const finding of input.findings) {
    counts.set(finding.type, (counts.get(finding.type) ?? 0) + 1);
  }
  return {
    checkedAt: (input.checkedAt ?? new Date()).toISOString(),
    localBillingRows: input.users.length,
    exactAlphaSubscriptions: input.subscriptions.length,
    findingsCount: input.findings.length,
    findingTypes: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => ({ type, count })),
  };
}

export function buildPrivateReconciliationAlert(
  findings: ReconciliationFinding[],
  cap: number = PRIVATE_FINDINGS_CAP
): string {
  const shown = findings.slice(0, cap).map((finding) => {
    const exactReferences = [
      finding.stripeCustomerId
        ? `customer ${finding.stripeCustomerId}`
        : null,
      finding.stripeSubscriptionId
        ? `subscription ${finding.stripeSubscriptionId}`
        : null,
      finding.userId ? `user ${finding.userId}` : null,
    ].filter((value): value is string => value !== null);
    return `- [${finding.type}] ${finding.detail}${exactReferences.length > 0 ? ` (${exactReferences.join(", ")})` : ""}`;
  });
  const omitted = findings.length - shown.length;
  return (
    shown.join("\n") +
    (omitted > 0
      ? `\n\n(+${omitted} more exact finding${omitted === 1 ? "" : "s"} omitted from this private alert.)`
      : "")
  );
}

function boundedDatabaseFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignals = [
    init?.signal,
    input instanceof Request ? input.signal : undefined,
  ].filter((signal): signal is AbortSignal => !!signal);
  const relays = [...new Set(upstreamSignals)].map((signal) => {
    const relayAbort = () => controller.abort(signal.reason);
    if (signal.aborted) relayAbort();
    else signal.addEventListener("abort", relayAbort, { once: true });
    return { signal, relayAbort };
  });
  const timeout = setTimeout(
    () => controller.abort(new Error("database request deadline exceeded")),
    DATABASE_REQUEST_TIMEOUT_MS
  );
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
    for (const { signal, relayAbort } of relays) {
      signal.removeEventListener("abort", relayAbort);
    }
  });
}

async function loadProviderSubscriptions(
  stripe: Stripe
): Promise<ProviderSubscriptionSnapshot[]> {
  const subscriptions: ProviderSubscriptionSnapshot[] = [];
  const seen = new Set<string>();
  let startingAfter: string | undefined;
  let pageCount = 0;
  for (;;) {
    if (pageCount >= MAX_PROVIDER_PAGES) {
      throw new Error("provider page cap exceeded");
    }
    let page: Stripe.ApiList<Stripe.Subscription>;
    try {
      page = await stripe.subscriptions.list({
        price: STRIPE_PRICE_ID,
        status: "all",
        limit: PROVIDER_PAGE_SIZE,
        starting_after: startingAfter,
      });
    } catch {
      throw new Error("provider inventory unavailable");
    }
    pageCount += 1;
    if (!Array.isArray(page.data)) {
      throw new Error("provider inventory response malformed");
    }
    if (subscriptions.length + page.data.length > MAX_PROVIDER_SUBSCRIPTIONS) {
      throw new Error("provider subscription cap exceeded");
    }
    for (const subscription of page.data) {
      if (seen.has(subscription.id)) {
        throw new Error("provider pagination repeated a subscription");
      }
      seen.add(subscription.id);
      subscriptions.push(normalizeProviderSubscription(subscription));
    }
    if (!page.has_more) break;
    const nextCursor = page.data.at(-1)?.id;
    if (!nextCursor || nextCursor === startingAfter) {
      throw new Error("provider pagination made no progress");
    }
    startingAfter = nextCursor;
  }
  return subscriptions;
}

type DatabaseUserRow = {
  id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscribed_at: string | null;
  cancelled_at: string | null;
  topic_quota: number | null;
};

async function loadLocalBillingRows(
  supabase: SupabaseClient
): Promise<LocalBillingSnapshot[]> {
  const rows: DatabaseUserRow[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | null = null;
  for (let from = 0; ; from += LOCAL_PAGE_SIZE) {
    const { data, error, count } = await supabase
      .from("users")
      .select(
        "id, stripe_customer_id, stripe_subscription_id, subscribed_at, cancelled_at, topic_quota",
        { count: "exact" }
      )
      .or(
        "stripe_customer_id.not.is.null,stripe_subscription_id.not.is.null"
      )
      .order("id", { ascending: true })
      .range(from, from + LOCAL_PAGE_SIZE - 1);
    if (error || count === null || !Array.isArray(data)) {
      throw new Error("local billing inventory unavailable");
    }
    if (expectedTotal === null) {
      expectedTotal = count;
      if (expectedTotal > MAX_LOCAL_BILLING_ROWS) {
        throw new Error("local billing row cap exceeded");
      }
    } else if (count !== expectedTotal) {
      throw new Error("local billing row count changed during pagination");
    }
    for (const raw of data as DatabaseUserRow[]) {
      if (seen.has(raw.id)) {
        throw new Error("local billing pagination repeated a row");
      }
      seen.add(raw.id);
      rows.push(raw);
    }
    if (rows.length > expectedTotal) {
      throw new Error("local billing inventory exceeded exact count");
    }
    if (rows.length === expectedTotal) break;
    if (data.length === 0 || data.length < LOCAL_PAGE_SIZE) {
      throw new Error("local billing inventory ended before exact count");
    }
  }
  return rows.map((row) => ({
    id: row.id,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscribedAt: row.subscribed_at,
    cancelledAt: row.cancelled_at,
    topicQuota: row.topic_quota,
  }));
}

function operationalFailureSummary(
  type: ReconciliationFindingType
): PublicReconciliationSummary {
  return {
    checkedAt: new Date().toISOString(),
    localBillingRows: 0,
    exactAlphaSubscriptions: 0,
    findingsCount: 1,
    findingTypes: [{ type, count: 1 }],
  };
}

async function runLiveReconciliation(): Promise<void> {
  const stripeSecret = process.env.STRIPE_SECRET_KEY?.trim();
  const supabaseUrl =
    process.env.SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseKey =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!stripeSecret || !supabaseUrl || !supabaseKey) {
    console.log(
      JSON.stringify(
        operationalFailureSummary("reconciliation_configuration_missing"),
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }
  let validatedSupabaseUrl: URL;
  try {
    validatedSupabaseUrl = requireExactAlphaSupabaseUrl(supabaseUrl);
  } catch {
    console.log(
      JSON.stringify(
        operationalFailureSummary("reconciliation_configuration_missing"),
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const [{ createClient }, { sendOpsAlert }] = await Promise.all([
    import("@supabase/supabase-js"),
    import("../lib/email.ts"),
  ]);
  const stripe = getStripeClient();
  const supabase = createClient(validatedSupabaseUrl.toString(), supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: boundedDatabaseFetch },
  });
  let subscriptions: ProviderSubscriptionSnapshot[];
  let users: LocalBillingSnapshot[];
  try {
    [subscriptions, users] = await Promise.all([
      loadProviderSubscriptions(stripe),
      loadLocalBillingRows(supabase),
    ]);
  } catch {
    console.log(
      JSON.stringify(
        operationalFailureSummary("reconciliation_inventory_unavailable"),
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const checkedAt = new Date();
  const findings = reconcileExactAlphaBindings({
    subscriptions,
    users,
    observedAt: checkedAt,
  });
  const publicSummary = buildPublicReconciliationSummary({
    subscriptions,
    users,
    findings,
    checkedAt,
  });
  console.log(JSON.stringify(publicSummary, null, 2));

  if (findings.length > 0) {
    const privateBody = buildPrivateReconciliationAlert(findings);
    await sendOpsAlert(
      "alpha. exact subscription drift found",
      `${findings.length} exact Alpha binding discrepanc${findings.length === 1 ? "y" : "ies"} found:\n\n${privateBody}`,
      `alpha-stripe-reconcile-${checkedAt.toISOString().slice(0, 10)}`
    ).catch(() =>
      console.warn(
        "sendOpsAlert failed; private Alpha reconciliation details were not delivered."
      )
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `OK: ${users.length} local billing row(s) and ${subscriptions.length} exact Alpha Subscription(s) checked, zero drift found.`
  );
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  await runLiveReconciliation().catch(() => {
    console.error("::error:: reconciliation could not complete.");
    process.exitCode = 1;
  });
}
