#!/usr/bin/env node
// One-time operator tool that reverse-audits every Alpha-price Subscription,
// audits every active local billing binding, and repairs only users who predate
// users.stripe_subscription_id. Dry-run performs approved live reads and writes
// a private, identifier-free evidence manifest.
// Apply repeats every proof and changes only a missing exact database binding
// through a service-only compare-and-set RPC. It never sends email or creates,
// updates, cancels, refunds, or deletes a Stripe object.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Stripe from "stripe";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnvLocal } from "./_load-env.mts";
import { requireExactAlphaSupabaseUrl } from "./alpha-supabase-url.mjs";
import { STRIPE_PRICE_ID, getStripeClient } from "../lib/stripe.ts";
import {
  deriveCancelledAt,
  isTerminalSubscriptionStatus,
  subscriptionStatusGrantsAccess,
} from "../lib/webhook-user-mutation.ts";

const usage = [
  "Usage:",
  "  backfill-exact-alpha-subscriptions.mts dry-run --bundle-manifest ABSOLUTE_PATH",
  "  backfill-exact-alpha-subscriptions.mts --apply --manifest ABSOLUTE_PATH --approve-sha256 SHA256 --confirm-reviewed-live-alpha",
].join("\n");
const argv = process.argv.slice(2);
const dryRun =
  argv.length === 3 &&
  argv[0] === "dry-run" &&
  argv[1] === "--bundle-manifest";
const apply =
  argv.length === 6 &&
  argv[0] === "--apply" &&
  argv[1] === "--manifest" &&
  argv[3] === "--approve-sha256" &&
  /^[0-9a-f]{64}$/i.test(argv[4] || "") &&
  argv[5] === "--confirm-reviewed-live-alpha";
if (!dryRun && !apply) {
  console.error(usage);
  process.exit(1);
}

const sha256 = (value: crypto.BinaryLike) =>
  crypto.createHash("sha256").update(value).digest("hex");
const scriptPath = fileURLToPath(import.meta.url);
const scriptSha256 = sha256(readFileSync(scriptPath));
const repositoryHead = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
}).trim();
const worktree = execFileSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
}).trim();
if (!/^[0-9a-f]{40}$/.test(repositoryHead) || worktree) {
  console.error(
    "::error:: The backfill requires one exact clean committed repository state."
  );
  process.exit(1);
}

type BundleManifest = {
  formatVersion: number;
  bundle?: { name?: string; sha256?: string };
  verification?: {
    source?: string;
    sourceSha256?: string;
    name?: string;
    sha256?: string;
  };
  files?: Array<{ name?: string; sha256?: string }>;
  ledgerMode?: string;
  ledgerVersions?: string[];
  repositoryHead?: string;
  builderSha256?: string;
};
const ROUND_80_MIGRATIONS = [
  "20260827000000_checkout_fulfillment_claims.sql",
  "20260827010000_stripe_webhook_event_leases.sql",
  "20260827020000_delivery_suppression_pending.sql",
  "20260827030000_legacy_checkout_fulfillments.sql",
  "20260827040000_refund_review_resolution.sql",
  "20260827050000_daily_paid_call_budget.sql",
  "20260827200000_issues_rls_subscribed_access.sql",
  "20260828000000_alpha_renewal_cancellation.sql",
  "20260830000000_invite_access.sql",
  "20260830010000_weekly_send_delivery_cursors.sql",
  "20260830020000_account_privacy_retry_bounds.sql",
  "20260830030000_distributed_rate_limits.sql",
  "20260830040000_quantity_update_leases.sql",
  "20260830050000_resend_suppression_causality.sql",
] as const;
const ROUND_80_VERSIONS = ROUND_80_MIGRATIONS.map((name) => name.slice(0, 14));
const expectedRound80Files = ROUND_80_MIGRATIONS.map((name) => ({
  name,
  sha256: sha256(
    readFileSync(path.resolve("supabase/migrations", name), "utf8").trimEnd()
  ),
}));
const expectedBundleBuilderSha256 = sha256(
  readFileSync(path.resolve("scripts/build-r80-migration-bundle.mjs"))
);
function readBundleManifest(manifestPath: string) {
  const resolved = path.resolve(manifestPath);
  const raw = readFileSync(resolved);
  const parsed = JSON.parse(raw.toString("utf8")) as BundleManifest;
  if (
    parsed.formatVersion !== 2 ||
    JSON.stringify(parsed.files) !== JSON.stringify(expectedRound80Files) ||
    !/^[0-9a-f]{64}$/.test(parsed.bundle?.sha256 || "") ||
    parsed.ledgerMode !== "atomic-version-insert" ||
    JSON.stringify(parsed.ledgerVersions) !== JSON.stringify(ROUND_80_VERSIONS) ||
    parsed.repositoryHead !== repositoryHead ||
    parsed.builderSha256 !== expectedBundleBuilderSha256 ||
    parsed.verification?.source !== "scripts/r80-live-verification.sql" ||
    !/^[0-9a-f]{64}$/.test(parsed.verification?.sourceSha256 || "") ||
    parsed.verification?.sourceSha256 !== parsed.verification?.sha256
  ) {
    throw new Error("Round 80 bundle manifest is incomplete or incompatible");
  }
  const bundlePath = path.resolve(
    path.dirname(resolved),
    parsed.bundle?.name || ""
  );
  if (sha256(readFileSync(bundlePath)) !== parsed.bundle!.sha256) {
    throw new Error("Round 80 bundle file does not match its manifest");
  }
  const verificationPath = path.resolve(
    path.dirname(resolved),
    parsed.verification?.name || ""
  );
  if (
    sha256(readFileSync(verificationPath)) !== parsed.verification!.sha256
  ) {
    throw new Error("Round 80 live verification SQL does not match its manifest");
  }
  const canonicalVerificationSource = `${readFileSync(
    path.resolve(parsed.verification!.source!),
    "utf8"
  ).trimEnd()}\n`;
  if (sha256(canonicalVerificationSource) !== parsed.verification!.sourceSha256) {
    throw new Error("Round 80 live verification source changed after the manifest");
  }
  return {
    path: resolved,
    sha256: sha256(raw),
    bundleSha256: parsed.bundle!.sha256!,
  };
}

type UserRow = {
  id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscribed_at: string | null;
  cancelled_at: string | null;
  topic_quota: number | null;
  renewal_cancel_pending_at: string | null;
  renewal_cancel_customer_id: string | null;
  renewal_cancel_subscription_id: string | null;
};
type Decision =
  | "eligible"
  | "verified_existing"
  | "local_identifier_malformed"
  | "existing_binding_mismatch"
  | "local_customer_ambiguous"
  | "local_reservation_conflict"
  | "provider_missing"
  | "provider_ambiguous"
  | "provider_shape_unsafe"
  | "provider_status_mismatch"
  | "local_quota_mismatch"
  | "local_cancellation_mismatch"
  | "provider_unavailable";
type ProviderIssueDecision =
  | "provider_identifier_unsafe"
  | "provider_shape_unsafe"
  | "provider_status_unknown"
  | "provider_nonterminal_ambiguous"
  | "provider_nonterminal_local_missing"
  | "provider_nonterminal_local_ambiguous"
  | "provider_access_state_mismatch"
  | "provider_nonterminal_binding_missing"
  | "provider_nonterminal_binding_mismatch";
type Evidence = {
  userId: string;
  customerId: string;
  subscriptionId: string | null;
  providerStatus: string | null;
  providerQuantity: number | null;
  providerCancelledAt: string | null;
  localSubscribedAt: string;
  localCancelledAt: string | null;
  localTopicQuota: number | null;
  decision: Decision;
};
type ProviderInventoryEntry = {
  subscriptionId: string;
  customerId: string;
  status: string;
  exactShape: boolean;
  quantity: number | null;
  cancelAt: number | null;
};
type ProviderIssue = {
  customerId: string;
  subscriptionIds: string[];
  decision: ProviderIssueDecision;
};
type Discovery = {
  evidence: Evidence[];
  providerInventory: ProviderInventoryEntry[];
  providerIssues: ProviderIssue[];
};

type AccountDeletionSagaRow = {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};
type AccountDeletionSubscriptionRow = {
  user_id: string;
  customer_id: string;
  subscription_id: string;
};
type CheckoutProfileRow = {
  id: string;
  owner_user_id: string | null;
  provisioned_user_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_state: string;
};
type LegacyFulfillmentRow = {
  session_id: string;
  user_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string;
};
type RefundReviewRow = {
  session_id: string;
  subscription_id: string;
  customer_id: string;
  winner_subscription_id: string | null;
  winner_customer_id: string | null;
  status: string;
};
type RenewalReservationRow = {
  id: string;
  renewal_cancel_pending_at: string;
  renewal_cancel_customer_id: string | null;
  renewal_cancel_subscription_id: string | null;
};
type ConflictSnapshot = {
  deletionSagas: AccountDeletionSagaRow[];
  deletionSubscriptions: AccountDeletionSubscriptionRow[];
  checkoutProfiles: CheckoutProfileRow[];
  legacyFulfillments: LegacyFulfillmentRow[];
  refundReviews: RefundReviewRow[];
  renewalReservations: RenewalReservationRow[];
};

const PROVIDER_PAGE_SIZE = 100;
const MAX_PROVIDER_PAGES = 10;
const MAX_PROVIDER_SUBSCRIPTIONS =
  PROVIDER_PAGE_SIZE * MAX_PROVIDER_PAGES;
const LOCAL_PAGE_SIZE = 100;
const MAX_LOCAL_BILLING_ROWS = 1_000;
const MAX_CONFLICT_ROWS_PER_TABLE = 1_000;
const MAX_ACTIVE_CANDIDATES = 100;
const DATABASE_REQUEST_TIMEOUT_MS = 15_000;
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

function exactAlphaShape(
  subscription: Stripe.Subscription,
  customerId: string
): { ok: true; quantity: number } | { ok: false } {
  if (
    exactCustomerId(subscription) !== customerId ||
    !subscription.items ||
    subscription.items.has_more ||
    !Array.isArray(subscription.items.data) ||
    subscription.items.data.length !== 1
  ) {
    return { ok: false };
  }
  const item = subscription.items.data[0];
  const priceId =
    typeof item?.price === "string" ? item.price : item?.price?.id;
  const quantity = item?.quantity;
  if (
    priceId !== STRIPE_PRICE_ID ||
    !Number.isInteger(quantity) ||
    (quantity as number) < 1 ||
    (quantity as number) > 5
  ) {
    return { ok: false };
  }
  return { ok: true, quantity: quantity as number };
}

function sameInstant(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && leftMs === rightMs;
}

function hasCurrentLocalAccess(user: UserRow, observedAt: Date): boolean {
  if (!user.subscribed_at) return false;
  if (!user.cancelled_at) return true;
  const cancelledAt = Date.parse(user.cancelled_at);
  return Number.isFinite(cancelledAt) && cancelledAt > observedAt.getTime();
}

async function loadAllAlphaSubscriptions(
  stripe: Stripe
): Promise<Stripe.Subscription[]> {
  const subscriptions: Stripe.Subscription[] = [];
  const seen = new Set<string>();
  let startingAfter: string | undefined;
  let pageCount = 0;
  for (;;) {
    if (pageCount >= MAX_PROVIDER_PAGES) {
      throw new Error(
        `provider page cap exceeded: maximum ${MAX_PROVIDER_PAGES} Alpha subscription pages`
      );
    }
    if (subscriptions.length >= MAX_PROVIDER_SUBSCRIPTIONS) {
      throw new Error(
        `provider audit cap exceeded: maximum ${MAX_PROVIDER_SUBSCRIPTIONS} Alpha subscriptions`
      );
    }
    let page: Stripe.ApiList<Stripe.Subscription>;
    try {
      page = await stripe.subscriptions.list({
        price: STRIPE_PRICE_ID,
        status: "all",
        limit: PROVIDER_PAGE_SIZE,
        starting_after: startingAfter,
      });
      pageCount += 1;
    } catch {
      throw new Error("provider subscription inventory unavailable");
    }
    if (
      !Array.isArray(page.data) ||
      page.data.length > PROVIDER_PAGE_SIZE ||
      (page.has_more && page.data.length === 0)
    ) {
      throw new Error("provider subscription inventory shape is unsafe");
    }
    for (const subscription of page.data) {
      if (seen.has(subscription.id)) {
        throw new Error("provider subscription pagination repeated an object");
      }
      seen.add(subscription.id);
      subscriptions.push(subscription);
      if (subscriptions.length > MAX_PROVIDER_SUBSCRIPTIONS) {
        throw new Error(
          `provider audit cap exceeded: maximum ${MAX_PROVIDER_SUBSCRIPTIONS} Alpha subscriptions`
        );
      }
    }
    if (!page.has_more) break;
    if (subscriptions.length >= MAX_PROVIDER_SUBSCRIPTIONS) {
      throw new Error(
        `provider audit cap exceeded: more than ${MAX_PROVIDER_SUBSCRIPTIONS} Alpha subscriptions`
      );
    }
    const nextCursor = page.data[page.data.length - 1]?.id;
    if (!nextCursor || nextCursor === startingAfter) {
      throw new Error("provider subscription pagination did not advance");
    }
    startingAfter = nextCursor;
  }
  return subscriptions.sort((a, b) => a.id.localeCompare(b.id));
}

async function loadAllBillingRows(sb: SupabaseClient): Promise<UserRow[]> {
  const base = () =>
    sb
      .from("users")
      .select(
        "id, stripe_customer_id, stripe_subscription_id, subscribed_at, cancelled_at, topic_quota, renewal_cancel_pending_at, renewal_cancel_customer_id, renewal_cancel_subscription_id"
      )
      .or("stripe_customer_id.not.is.null,stripe_subscription_id.not.is.null")
      .order("id", { ascending: true });

  const { count, error: countError } = await sb
    .from("users")
    .select("id", { count: "exact", head: true })
    .or("stripe_customer_id.not.is.null,stripe_subscription_id.not.is.null");
  if (countError || count === null) {
    throw new Error("billing row count unavailable");
  }
  if (count > MAX_LOCAL_BILLING_ROWS) {
    throw new Error(
      `billing row audit cap exceeded: ${count}, maximum ${MAX_LOCAL_BILLING_ROWS}`
    );
  }

  const rows: UserRow[] = [];
  let cursor: string | null = null;
  while (rows.length < count) {
    let query = base().limit(Math.min(LOCAL_PAGE_SIZE, count - rows.length));
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw new Error("billing row inventory unavailable");
    if (!data?.length) break;
    rows.push(...(data as UserRow[]));
    cursor = data[data.length - 1]?.id || null;
  }
  if (rows.length !== count) {
    throw new Error(`candidate count changed during read: ${count} -> ${rows.length}`);
  }
  return rows;
}

async function loadBoundedRows<T>(
  sb: SupabaseClient,
  table: string,
  columns: string,
  orderColumns: string[],
  label: string
): Promise<T[]> {
  const { count, error } = await sb
    .from(table)
    .select(orderColumns[0], { count: "exact", head: true });
  if (error || count === null) {
    throw new Error(`${label} count unavailable`);
  }
  if (count > MAX_CONFLICT_ROWS_PER_TABLE) {
    throw new Error(
      `${label} audit cap exceeded: ${count}, maximum ${MAX_CONFLICT_ROWS_PER_TABLE}`
    );
  }
  const rows: T[] = [];
  for (let from = 0; from < count; from += LOCAL_PAGE_SIZE) {
    let query = sb.from(table).select(columns);
    for (const column of orderColumns) {
      query = query.order(column, { ascending: true });
    }
    const { data, error: readError } = await query.range(
      from,
      Math.min(count - 1, from + LOCAL_PAGE_SIZE - 1)
    );
    if (readError) throw new Error(`${label} inventory unavailable`);
    rows.push(...((data || []) as T[]));
  }
  if (rows.length !== count) {
    throw new Error(`${label} count changed during read: ${count} -> ${rows.length}`);
  }
  return rows;
}

async function loadRenewalReservations(
  sb: SupabaseClient
): Promise<RenewalReservationRow[]> {
  const base = () =>
    sb
      .from("users")
      .select(
        "id, renewal_cancel_pending_at, renewal_cancel_customer_id, renewal_cancel_subscription_id"
      )
      .not("renewal_cancel_pending_at", "is", null)
      .order("id", { ascending: true });
  const { count, error: countError } = await sb
    .from("users")
    .select("id", { count: "exact", head: true })
    .not("renewal_cancel_pending_at", "is", null);
  if (countError || count === null) {
    throw new Error("renewal reservation count unavailable");
  }
  if (count > MAX_CONFLICT_ROWS_PER_TABLE) {
    throw new Error(
      `renewal reservation audit cap exceeded: ${count}, maximum ${MAX_CONFLICT_ROWS_PER_TABLE}`
    );
  }
  const rows: RenewalReservationRow[] = [];
  let cursor: string | null = null;
  while (rows.length < count) {
    let query = base().limit(Math.min(LOCAL_PAGE_SIZE, count - rows.length));
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw new Error("renewal reservation inventory unavailable");
    if (!data?.length) break;
    rows.push(...(data as RenewalReservationRow[]));
    cursor = data[data.length - 1]?.id || null;
  }
  if (rows.length !== count) {
    throw new Error(
      `renewal reservation count changed during read: ${count} -> ${rows.length}`
    );
  }
  return rows;
}

async function loadConflictSnapshot(sb: SupabaseClient): Promise<ConflictSnapshot> {
  const deletionSagas = await loadBoundedRows<AccountDeletionSagaRow>(
    sb,
    "account_deletion_sagas",
    "user_id, stripe_customer_id, stripe_subscription_id",
    ["user_id"],
    "account deletion saga"
  );
  const deletionSubscriptions =
    await loadBoundedRows<AccountDeletionSubscriptionRow>(
      sb,
      "account_deletion_alpha_subscriptions",
      "user_id, customer_id, subscription_id",
      ["user_id", "subscription_id"],
      "account deletion subscription"
    );
  const checkoutProfiles = await loadBoundedRows<CheckoutProfileRow>(
    sb,
    "checkout_profiles",
    "id, owner_user_id, provisioned_user_id, stripe_customer_id, stripe_subscription_id, billing_state",
    ["id"],
    "checkout profile"
  );
  const legacyFulfillments = await loadBoundedRows<LegacyFulfillmentRow>(
    sb,
    "legacy_checkout_fulfillments",
    "session_id, user_id, stripe_customer_id, stripe_subscription_id, status",
    ["session_id"],
    "legacy checkout fulfillment"
  );
  const refundReviews = await loadBoundedRows<RefundReviewRow>(
    sb,
    "refund_reviews",
    "session_id, subscription_id, customer_id, winner_subscription_id, winner_customer_id, status",
    ["session_id", "subscription_id"],
    "refund review"
  );
  const renewalReservations = await loadRenewalReservations(sb);
  return {
    deletionSagas,
    deletionSubscriptions,
    checkoutProfiles,
    legacyFulfillments,
    refundReviews,
    renewalReservations,
  };
}

function hasReservationConflict(
  user: UserRow,
  customerId: string,
  subscriptionId: string,
  billingRows: UserRow[],
  snapshot: ConflictSnapshot
): boolean {
  if (
    user.renewal_cancel_pending_at ||
    user.renewal_cancel_customer_id ||
    user.renewal_cancel_subscription_id
  ) {
    return true;
  }
  if (
    snapshot.deletionSagas.some(
      (row) =>
        row.user_id === user.id ||
        row.stripe_customer_id === customerId ||
        row.stripe_subscription_id === subscriptionId
    ) ||
    snapshot.deletionSubscriptions.some(
      (row) =>
        row.user_id !== user.id &&
        (row.customer_id === customerId || row.subscription_id === subscriptionId)
    ) ||
    snapshot.renewalReservations.some(
      (row) =>
        row.id !== user.id &&
        (row.renewal_cancel_customer_id === customerId ||
          row.renewal_cancel_subscription_id === subscriptionId)
    )
  ) {
    return true;
  }

  const activeCheckoutStates = new Set([
    "open",
    "creating",
    "paid",
    "recovering",
    "deleting",
  ]);
  if (
    snapshot.checkoutProfiles.some(
      (row) =>
        activeCheckoutStates.has(row.billing_state) &&
        (row.owner_user_id === user.id ||
          row.provisioned_user_id === user.id ||
          row.stripe_customer_id === customerId ||
          row.stripe_subscription_id === subscriptionId)
    )
  ) {
    return true;
  }

  const pendingLegacyStates = new Set([
    "pending",
    "awaiting_issue",
    "deleting",
  ]);
  if (
    snapshot.legacyFulfillments.some(
      (row) =>
        pendingLegacyStates.has(row.status) &&
        (row.user_id === user.id ||
          row.stripe_customer_id === customerId ||
          row.stripe_subscription_id === subscriptionId)
    )
  ) {
    return true;
  }

  const unresolvedRefundStates = new Set(["pending", "reviewed"]);
  if (
    snapshot.refundReviews.some(
      (row) =>
        unresolvedRefundStates.has(row.status) &&
        ((row.customer_id === customerId &&
          row.subscription_id === subscriptionId) ||
          (row.winner_customer_id === customerId &&
            row.winner_subscription_id === subscriptionId))
    )
  ) {
    return true;
  }

  if (
    billingRows.some(
      (row) =>
        row.id !== user.id &&
        (row.stripe_customer_id === customerId ||
          row.stripe_subscription_id === subscriptionId)
    ) ||
    snapshot.checkoutProfiles.some(
      (row) =>
        (row.stripe_customer_id === customerId ||
          row.stripe_subscription_id === subscriptionId) &&
        ((row.owner_user_id === null && row.provisioned_user_id === null) ||
          (row.owner_user_id !== null && row.owner_user_id !== user.id) ||
          (row.provisioned_user_id !== null &&
            row.provisioned_user_id !== user.id))
    ) ||
    snapshot.legacyFulfillments.some(
      (row) =>
        (row.stripe_customer_id === customerId ||
          row.stripe_subscription_id === subscriptionId) &&
        row.user_id !== user.id
    )
  ) {
    return true;
  }
  return false;
}

function buildProviderAudit(
  subscriptions: Stripe.Subscription[],
  billingRows: UserRow[],
  observedAt: Date
): {
  inventory: ProviderInventoryEntry[];
  issues: ProviderIssue[];
} {
  const inventory: ProviderInventoryEntry[] = [];
  const issues: ProviderIssue[] = [];
  const subscriptionsByCustomer = new Map<string, Stripe.Subscription[]>();

  for (const subscription of subscriptions) {
    const rawSubscriptionId = subscription.id;
    const subscriptionId = rawSubscriptionId.trim();
    const customerId = exactCustomerId(subscription) || "";
    const terminal = isTerminalSubscriptionStatus(subscription.status);
    const identifierSafe =
      rawSubscriptionId === subscriptionId &&
      /^sub_[A-Za-z0-9]+$/.test(subscriptionId) &&
      /^cus_[A-Za-z0-9]+$/.test(customerId);
    const shape = identifierSafe
      ? exactAlphaShape(subscription, customerId)
      : ({ ok: false } as const);
    inventory.push({
      subscriptionId,
      customerId,
      status: subscription.status,
      exactShape: shape.ok,
      quantity: shape.ok ? shape.quantity : null,
      cancelAt: subscription.cancel_at ?? null,
    });
    if (!identifierSafe) {
      if (!terminal) {
        issues.push({
          customerId,
          subscriptionIds: [subscriptionId],
          decision: "provider_identifier_unsafe",
        });
      }
      continue;
    }
    if (!shape.ok && !terminal) {
      issues.push({
        customerId,
        subscriptionIds: [subscriptionId],
        decision: "provider_shape_unsafe",
      });
    }
    const customerSubscriptions = subscriptionsByCustomer.get(customerId) || [];
    customerSubscriptions.push(subscription);
    subscriptionsByCustomer.set(customerId, customerSubscriptions);
  }

  for (const [customerId, customerSubscriptions] of subscriptionsByCustomer) {
    const nonTerminal = customerSubscriptions.filter(
      (subscription) => !isTerminalSubscriptionStatus(subscription.status)
    );
    if (nonTerminal.length > 1) {
      issues.push({
        customerId,
        subscriptionIds: nonTerminal.map((subscription) => subscription.id).sort(),
        decision: "provider_nonterminal_ambiguous",
      });
    }
    for (const subscription of nonTerminal) {
      if (!KNOWN_SUBSCRIPTION_STATUSES.has(subscription.status)) {
        issues.push({
          customerId,
          subscriptionIds: [subscription.id],
          decision: "provider_status_unknown",
        });
        continue;
      }
      const owners = billingRows.filter(
        (row) => row.stripe_customer_id === customerId
      );
      if (owners.length === 0) {
        issues.push({
          customerId,
          subscriptionIds: [subscription.id],
          decision: "provider_nonterminal_local_missing",
        });
        continue;
      }
      if (owners.length !== 1) {
        issues.push({
          customerId,
          subscriptionIds: [subscription.id],
          decision: "provider_nonterminal_local_ambiguous",
        });
        continue;
      }
      const owner = owners[0];
      const subscriptionOwners = billingRows.filter(
        (row) => row.stripe_subscription_id === subscription.id
      );
      if (
        subscriptionOwners.some((row) => row.id !== owner.id) ||
        (subscriptionOwners.length === 1 &&
          subscriptionOwners[0].id !== owner.id)
      ) {
        issues.push({
          customerId,
          subscriptionIds: [subscription.id],
          decision: "provider_nonterminal_local_ambiguous",
        });
        continue;
      }
      const grantsAccess = subscriptionStatusGrantsAccess(subscription.status);
      const localAccess = hasCurrentLocalAccess(owner, observedAt);
      if (grantsAccess !== localAccess) {
        issues.push({
          customerId,
          subscriptionIds: [subscription.id],
          decision: "provider_access_state_mismatch",
        });
        continue;
      }
      if (owner.stripe_subscription_id === null) {
        if (!(grantsAccess && localAccess)) {
          issues.push({
            customerId,
            subscriptionIds: [subscription.id],
            decision: "provider_nonterminal_binding_missing",
          });
        }
      } else if (owner.stripe_subscription_id !== subscription.id) {
        issues.push({
          customerId,
          subscriptionIds: [subscription.id],
          decision: "provider_nonterminal_binding_mismatch",
        });
      }
    }
  }

  return {
    inventory: inventory.sort((a, b) =>
      `${a.customerId}:${a.subscriptionId}`.localeCompare(
        `${b.customerId}:${b.subscriptionId}`
      )
    ),
    issues: issues.sort((a, b) =>
      `${a.decision}:${a.customerId}:${a.subscriptionIds.join(",")}`.localeCompare(
        `${b.decision}:${b.customerId}:${b.subscriptionIds.join(",")}`
      )
    ),
  };
}

async function discover(
  sb: SupabaseClient,
  stripe: Stripe
): Promise<Discovery> {
  const observedAt = new Date();
  const billingRows = await loadAllBillingRows(sb);
  const candidates = billingRows.filter((user) =>
    hasCurrentLocalAccess(user, observedAt)
  );
  if (candidates.length > MAX_ACTIVE_CANDIDATES) {
    throw new Error(
      `audit cap exceeded: ${candidates.length} active billed rows, maximum ${MAX_ACTIVE_CANDIDATES}`
    );
  }
  const subscriptions = await loadAllAlphaSubscriptions(stripe);
  const providerAudit = buildProviderAudit(
    subscriptions,
    billingRows,
    observedAt
  );
  const conflictSnapshot = await loadConflictSnapshot(sb);
  const subscriptionsByCustomer = new Map<string, Stripe.Subscription[]>();
  for (const subscription of subscriptions) {
    const customerId = exactCustomerId(subscription);
    if (!customerId) continue;
    const rows = subscriptionsByCustomer.get(customerId) || [];
    rows.push(subscription);
    subscriptionsByCustomer.set(customerId, rows);
  }
  const evidence: Evidence[] = [];
  for (const user of candidates) {
    const rawCustomerId = user.stripe_customer_id || "";
    const rawSubscriptionId = user.stripe_subscription_id;
    const customerId = rawCustomerId.trim();
    const existingSubscriptionId = rawSubscriptionId?.trim() || null;
    const base: Evidence = {
      userId: user.id,
      customerId,
      subscriptionId: existingSubscriptionId,
      providerStatus: null,
      providerQuantity: null,
      providerCancelledAt: null,
      localSubscribedAt: user.subscribed_at!,
      localCancelledAt: user.cancelled_at,
      localTopicQuota: user.topic_quota,
      decision: "provider_unavailable",
    };
    if (
      !/^cus_[A-Za-z0-9]+$/.test(customerId) ||
      rawCustomerId !== customerId ||
      (rawSubscriptionId !== null &&
        rawSubscriptionId !== existingSubscriptionId) ||
      (existingSubscriptionId !== null &&
        !/^sub_[A-Za-z0-9]+$/.test(existingSubscriptionId))
    ) {
      evidence.push({ ...base, decision: "local_identifier_malformed" });
      continue;
    }
    if (
      billingRows.filter((row) => row.stripe_customer_id === customerId)
        .length !== 1
    ) {
      evidence.push({ ...base, decision: "local_customer_ambiguous" });
      continue;
    }

    const customerSubscriptions = subscriptionsByCustomer.get(customerId) || [];
    const shaped = customerSubscriptions.map((subscription) => ({
      subscription,
      shape: exactAlphaShape(subscription, customerId),
    }));
    if (
      shaped.some(
        ({ subscription, shape }) =>
          !isTerminalSubscriptionStatus(subscription.status) && !shape.ok
      )
    ) {
      evidence.push({ ...base, decision: "provider_shape_unsafe" });
      continue;
    }
    const nonTerminal = shaped.filter(
      ({ subscription }) =>
        !isTerminalSubscriptionStatus(subscription.status)
    );
    if (nonTerminal.length > 1) {
      evidence.push({ ...base, decision: "provider_ambiguous" });
      continue;
    }
    const eligible = shaped.filter(({ subscription }) =>
      subscriptionStatusGrantsAccess(subscription.status)
    );
    if (eligible.length === 0) {
      evidence.push({
        ...base,
        decision:
          customerSubscriptions.length === 0
            ? "provider_missing"
            : "provider_status_mismatch",
      });
      continue;
    }
    if (eligible.length !== 1) {
      evidence.push({ ...base, decision: "provider_ambiguous" });
      continue;
    }
    const subscription = eligible[0].subscription;
    const shape = eligible[0].shape;
    if (!shape.ok) throw new Error("unreachable provider shape state");
    const providerCancelledAt = deriveCancelledAt(
      subscription.status,
      subscription.cancel_at
    );
    const exact: Evidence = {
      ...base,
      subscriptionId: subscription.id,
      providerStatus: subscription.status,
      providerQuantity: shape.quantity,
      providerCancelledAt,
      decision: "eligible",
    };
    if (
      hasReservationConflict(
        user,
        customerId,
        subscription.id,
        billingRows,
        conflictSnapshot
      )
    ) {
      exact.decision = "local_reservation_conflict";
    } else if (user.topic_quota !== shape.quantity * 5) {
      exact.decision = "local_quota_mismatch";
    } else if (!sameInstant(user.cancelled_at, providerCancelledAt)) {
      exact.decision = "local_cancellation_mismatch";
    } else if (
      existingSubscriptionId !== null &&
      existingSubscriptionId !== subscription.id
    ) {
      exact.decision = "existing_binding_mismatch";
    } else if (existingSubscriptionId === subscription.id) {
      exact.decision = "verified_existing";
    }
    evidence.push(exact);
  }
  return {
    evidence: evidence.sort((a, b) => a.userId.localeCompare(b.userId)),
    providerInventory: providerAudit.inventory,
    providerIssues: providerAudit.issues,
  };
}

function canonicalDiscovery(discovery: Discovery): string {
  return JSON.stringify(discovery);
}

function providerInventorySha256(discovery: Discovery): string {
  return sha256(JSON.stringify(discovery.providerInventory));
}

function safeEntries(evidence: Evidence[]) {
  return evidence.map((entry) => ({
    reference: sha256(
      `${entry.userId}:${entry.customerId}:${entry.subscriptionId || "none"}`
    ).slice(0, 16),
    decision: entry.decision,
    providerStatus: entry.providerStatus,
    providerQuantity: entry.providerQuantity,
  }));
}

function safeProviderIssues(issues: ProviderIssue[]) {
  return issues.map((issue) => ({
    reference: sha256(
      `${issue.customerId}:${issue.subscriptionIds.join(":")}`
    ).slice(0, 16),
    decision: issue.decision,
  }));
}

const boundedDatabaseFetch: typeof fetch = async (input, init) => {
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
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    for (const { signal, relayAbort } of relays) {
      signal.removeEventListener("abort", relayAbort);
    }
  }
};

loadEnvLocal();
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
const serviceKey =
  process.env.SUPABASE_SECRET_KEY?.trim() ||
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
  "";
if (!supabaseUrl || !serviceKey || !process.env.STRIPE_SECRET_KEY?.trim()) {
  console.error("::error:: Exact Alpha Supabase and Stripe credentials are required.");
  process.exit(1);
}
let validatedSupabaseUrl: URL;
try {
  validatedSupabaseUrl = requireExactAlphaSupabaseUrl(
    supabaseUrl,
    "NEXT_PUBLIC_SUPABASE_URL"
  );
} catch {
  console.error(
    "::error:: NEXT_PUBLIC_SUPABASE_URL must be the dedicated Alpha Supabase HTTPS host (value withheld)."
  );
  process.exit(1);
}
const sb = createClient(validatedSupabaseUrl.toString(), serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: boundedDatabaseFetch },
});
const stripe = getStripeClient();

if (dryRun) {
  const bundle = readBundleManifest(argv[2]);
  const discovery = await discover(sb, stripe);
  const evidence = discovery.evidence;
  const eligibleCount = evidence.filter((item) => item.decision === "eligible").length;
  const verifiedExistingCount = evidence.filter(
    (item) => item.decision === "verified_existing"
  ).length;
  const decisionCounts = Object.fromEntries(
    [...new Set(evidence.map((item) => item.decision))]
      .sort()
      .map((decision) => [
        decision,
        evidence.filter((item) => item.decision === decision).length,
      ])
  );
  const providerDecisionCounts = Object.fromEntries(
    [...new Set(discovery.providerIssues.map((item) => item.decision))]
      .sort()
      .map((decision) => [
        decision,
        discovery.providerIssues.filter((item) => item.decision === decision)
          .length,
      ])
  );
  const createdAt = new Date();
  const outputDir = path.resolve(
    process.env.ALPHA_SUBSCRIPTION_BACKFILL_DIR?.trim() ||
      "backup/subscription-backfill"
  );
  mkdirSync(outputDir, { recursive: true });
  const safeTime = createdAt.toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `${safeTime}-dry-run.json`);
  const manifest = {
    formatVersion: 3,
    mode: "dry-run",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    repositoryHead,
    scriptSha256,
    bundleManifestPath: bundle.path,
    bundleManifestSha256: bundle.sha256,
    bundleSha256: bundle.bundleSha256,
    alphaPriceId: STRIPE_PRICE_ID,
    candidateCount: evidence.length,
    eligibleCount,
    verifiedExistingCount,
    blockedCount: evidence.length - eligibleCount - verifiedExistingCount,
    decisionCounts,
    providerSubscriptionCount: discovery.providerInventory.length,
    providerIssueCount: discovery.providerIssues.length,
    providerDecisionCounts,
    providerInventorySha256: providerInventorySha256(discovery),
    evidenceSha256: sha256(canonicalDiscovery(discovery)),
    entries: safeEntries(evidence),
    providerIssues: safeProviderIssues(discovery.providerIssues),
  };
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(outputPath, encoded, { mode: 0o600 });
  const manifestSha = sha256(encoded);
  console.log(`Dry-run manifest: ${outputPath}`);
  console.log(`Manifest SHA256: ${manifestSha}`);
  console.log(
    `Active billed rows: ${manifest.candidateCount}; repairable: ${manifest.eligibleCount}; already exact: ${manifest.verifiedExistingCount}; local blocked: ${manifest.blockedCount}; Alpha provider subscriptions: ${manifest.providerSubscriptionCount}; provider blocked: ${manifest.providerIssueCount}.`
  );
  if (manifest.blockedCount > 0 || manifest.providerIssueCount > 0) {
    process.exitCode = 2;
  }
} else {
  const manifestPath = path.resolve(argv[2]);
  const manifestRaw = readFileSync(manifestPath);
  if (sha256(manifestRaw).toLowerCase() !== argv[4].toLowerCase()) {
    throw new Error("approved manifest SHA256 does not match the file");
  }
  const manifest = JSON.parse(manifestRaw.toString("utf8")) as {
    formatVersion: number;
    mode: string;
    createdAt: string;
    expiresAt: string;
    repositoryHead: string;
    scriptSha256: string;
    bundleManifestPath: string;
    bundleManifestSha256: string;
    bundleSha256: string;
    alphaPriceId: string;
    candidateCount: number;
    eligibleCount: number;
    verifiedExistingCount: number;
    blockedCount: number;
    providerSubscriptionCount: number;
    providerIssueCount: number;
    providerInventorySha256: string;
    evidenceSha256: string;
  };
  const bundle = readBundleManifest(manifest.bundleManifestPath);
  if (
    manifest.formatVersion !== 3 ||
    manifest.mode !== "dry-run" ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !Number.isFinite(Date.parse(manifest.expiresAt)) ||
    Date.parse(manifest.expiresAt) < Date.now() ||
    Date.parse(manifest.createdAt) > Date.now() + 60_000 ||
    manifest.repositoryHead !== repositoryHead ||
    manifest.scriptSha256 !== scriptSha256 ||
    manifest.bundleManifestSha256 !== bundle.sha256 ||
    manifest.bundleSha256 !== bundle.bundleSha256 ||
    manifest.alphaPriceId !== STRIPE_PRICE_ID ||
    !Number.isInteger(manifest.candidateCount) ||
    manifest.candidateCount < 0 ||
    manifest.candidateCount > MAX_ACTIVE_CANDIDATES ||
    !Number.isInteger(manifest.eligibleCount) ||
    manifest.eligibleCount < 0 ||
    !Number.isInteger(manifest.verifiedExistingCount) ||
    manifest.verifiedExistingCount < 0 ||
    !Number.isInteger(manifest.blockedCount) ||
    manifest.blockedCount < 0 ||
    !Number.isInteger(manifest.providerSubscriptionCount) ||
    manifest.providerSubscriptionCount < 0 ||
    manifest.providerSubscriptionCount > MAX_PROVIDER_SUBSCRIPTIONS ||
    !Number.isInteger(manifest.providerIssueCount) ||
    manifest.providerIssueCount !== 0 ||
    !/^[0-9a-f]{64}$/.test(manifest.providerInventorySha256) ||
    !/^[0-9a-f]{64}$/.test(manifest.evidenceSha256) ||
    manifest.candidateCount !==
      manifest.eligibleCount + manifest.verifiedExistingCount ||
    manifest.blockedCount !== 0
  ) {
    throw new Error("approved manifest is stale, blocked, or does not match this release");
  }
  const discovery = await discover(sb, stripe);
  const evidence = discovery.evidence;
  if (
    evidence.length !== manifest.candidateCount ||
    evidence.filter((item) => item.decision === "eligible").length !==
      manifest.eligibleCount ||
    evidence.filter((item) => item.decision === "verified_existing").length !==
      manifest.verifiedExistingCount ||
    discovery.providerInventory.length !== manifest.providerSubscriptionCount ||
    discovery.providerIssues.length !== 0 ||
    providerInventorySha256(discovery) !== manifest.providerInventorySha256 ||
    sha256(canonicalDiscovery(discovery)) !== manifest.evidenceSha256 ||
    evidence.some(
      (item) =>
        item.decision !== "eligible" && item.decision !== "verified_existing"
    )
  ) {
    throw new Error("live evidence changed after the approved dry-run");
  }

  const repairable = evidence.filter((item) => item.decision === "eligible");
  const expectedFinalEvidence: Evidence[] = evidence.map((item) => ({
    ...item,
    decision:
      item.decision === "eligible" ? "verified_existing" : item.decision,
  }));
  for (let index = 0; index < repairable.length; index++) {
    const item = repairable[index];
    let subscription: Stripe.Subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(item.subscriptionId!);
    } catch {
      throw new Error(
        `provider evidence unavailable before apply item ${index + 1}`
      );
    }
    const shape = exactAlphaShape(subscription, item.customerId);
    const providerCancelledAt = deriveCancelledAt(
      subscription.status,
      subscription.cancel_at
    );
    if (
      subscription.id !== item.subscriptionId ||
      !shape.ok ||
      !subscriptionStatusGrantsAccess(subscription.status) ||
      subscription.status !== item.providerStatus ||
      shape.quantity !== item.providerQuantity ||
      !sameInstant(providerCancelledAt, item.providerCancelledAt) ||
      shape.quantity * 5 !== item.localTopicQuota
    ) {
      throw new Error(`provider evidence changed before apply item ${index + 1}`);
    }
    const params = {
      p_user_id: item.userId,
      p_customer_id: item.customerId,
      p_subscription_id: item.subscriptionId!,
      p_provider_status: subscription.status,
      p_provider_quantity: shape.quantity,
      p_provider_observed_at: new Date().toISOString(),
      p_expected_subscribed_at: item.localSubscribedAt,
      p_expected_cancelled_at: item.localCancelledAt,
      p_expected_topic_quota: item.localTopicQuota,
    };
    let result = await sb.rpc("bind_existing_alpha_subscription", params);
    if (!result.error && result.data === "busy") {
      result = await sb.rpc("bind_existing_alpha_subscription", params);
    }
    if (result.error || !["bound", "already_bound"].includes(result.data)) {
      throw new Error(`binding RPC stopped at item ${index + 1}`);
    }
    const { data: confirmed, error: confirmError } = await sb
      .from("users")
      .select("stripe_customer_id, stripe_subscription_id")
      .eq("id", item.userId)
      .maybeSingle();
    if (
      confirmError ||
      confirmed?.stripe_customer_id !== item.customerId ||
      confirmed?.stripe_subscription_id !== item.subscriptionId
    ) {
      throw new Error(`binding confirmation failed at item ${index + 1}`);
    }
    console.log(`Applied exact binding ${index + 1}/${repairable.length}.`);
  }

  const finalDiscovery = await discover(sb, stripe);
  const finalEvidence = finalDiscovery.evidence;
  if (
    finalEvidence.length !== manifest.candidateCount ||
    finalEvidence.some((item) => item.decision !== "verified_existing") ||
    JSON.stringify(finalEvidence) !== JSON.stringify(expectedFinalEvidence) ||
    finalDiscovery.providerInventory.length !==
      manifest.providerSubscriptionCount ||
    finalDiscovery.providerIssues.length !== 0 ||
    providerInventorySha256(finalDiscovery) !==
      manifest.providerInventorySha256
  ) {
    throw new Error(
      "Alpha provider coverage and active billing bindings were not all exact after apply"
    );
  }
  console.log(
    `Applied ${repairable.length} exact binding(s); audited ${finalEvidence.length} active billed row(s) and ${finalDiscovery.providerInventory.length} Alpha provider subscription(s); every binding and provider coverage check is exact.`
  );
}
