import type Stripe from "stripe";
import { isUserNotFoundError } from "@/lib/gotrue-errors";
import {
  beginAccountDeletionAuthRemoval,
  completeAccountDeletion,
  settleAccountDeletionBilling,
  settleAccountDeletionPrivacy,
} from "@/lib/account-deletion";
import { normalizeAccountEmails } from "@/lib/account-privacy";
import type { supabaseServiceClient } from "@/lib/supabase/server";

type ServiceClient = Awaited<ReturnType<typeof supabaseServiceClient>>;

type ReconciliationRow = {
  user_id: string;
  state: "prepared" | "billing_clean" | "auth_delete_started";
  support_deleted_at: string | null;
  delivery_policy_settled_at: string | null;
  reconcile_attempt_count: number;
  reconcile_dead_lettered_at: string | null;
};

type DeletionState = ReconciliationRow["state"] | "complete";

export interface AccountDeletionReconciliationSummary {
  inspected: number;
  billingResumed: number;
  authDeleted: number;
  completed: number;
  privacyBlocked: number;
  deadLettered: number;
  errors: string[];
}

async function lookupAuthUser(
  sb: ServiceClient,
  userId: string
): Promise<{
  exists: boolean;
  confirmedEmail: string | null;
  mirrorEmail: string | null;
}> {
  const { data, error } = await sb.auth.admin.getUserById(userId);
  if (error) {
    if (isUserNotFoundError(error)) {
      return { exists: false, confirmedEmail: null, mirrorEmail: null };
    }
    throw new Error(`Auth lookup failed: ${error.message}`);
  }
  if (!data?.user) {
    throw new Error("Auth lookup returned no user and no terminal not-found proof");
  }
  const email = data.user.email?.toLowerCase().trim() || null;
  const { data: mirror, error: mirrorError } = await sb
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  if (mirrorError) {
    throw new Error(`public email mirror lookup failed: ${mirrorError.message}`);
  }
  return {
    exists: true,
    confirmedEmail: data.user.email_confirmed_at && email ? email : null,
    mirrorEmail:
      mirror && typeof mirror.email === "string"
        ? mirror.email.toLowerCase().trim() || null
        : null,
  };
}

type AccountDeletionErrorCode =
  | "provider_unavailable"
  | "privacy_blocked"
  | "database_transient"
  | "state_changed"
  | "unexpected";

function accountDeletionErrorCode(error: unknown): AccountDeletionErrorCode {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("privacy") || message.includes("email-provider")) {
    return "privacy_blocked";
  }
  if (
    message.includes("auth") ||
    message.includes("stripe") ||
    message.includes("provider")
  ) {
    return "provider_unavailable";
  }
  if (
    message.includes("database") ||
    message.includes("durable") ||
    message.includes("lookup") ||
    message.includes("rpc")
  ) {
    return "database_transient";
  }
  if (message.includes("changed") || message.includes("lease")) {
    return "state_changed";
  }
  return "unexpected";
}

function accountDeletionRetryMinutes(attempts: number): number {
  switch (Math.min(Math.max(0, attempts), 6)) {
    case 0:
      return 5;
    case 1:
      return 15;
    case 2:
      return 60;
    case 3:
      return 180;
    case 4:
      return 360;
    case 5:
      return 720;
    default:
      return 1440;
  }
}

export async function reconcileStaleAccountDeletions(
  sb: ServiceClient,
  options: {
    nowIso?: string;
    staleMinutes?: number;
    limit?: number;
    stripeClient?: Stripe;
  } = {}
): Promise<AccountDeletionReconciliationSummary> {
  const summary: AccountDeletionReconciliationSummary = {
    inspected: 0,
    billingResumed: 0,
    authDeleted: 0,
    completed: 0,
    privacyBlocked: 0,
    deadLettered: 0,
    errors: [],
  };
  const nowIso = options.nowIso ?? new Date().toISOString();
  const nowMs = new Date(nowIso).getTime();
  if (!Number.isFinite(nowMs)) {
    summary.errors.push("account-deletion reconciliation received an invalid clock");
    return summary;
  }
  const requestedStaleMinutes = Number.isSafeInteger(options.staleMinutes)
    ? (options.staleMinutes as number)
    : 15;
  const staleMinutes = Math.max(
    5,
    Math.min(24 * 60, requestedStaleMinutes)
  );
  const requestedLimit = Number.isSafeInteger(options.limit)
    ? (options.limit as number)
    : 10;
  const limit = Math.max(1, Math.min(25, requestedLimit));
  const staleBefore = new Date(nowMs - staleMinutes * 60_000).toISOString();
  const { data, error } = await sb
    .from("account_deletion_sagas")
    .select(
      "user_id, state, support_deleted_at, delivery_policy_settled_at, reconcile_attempt_count, reconcile_dead_lettered_at"
    )
    .in("state", ["prepared", "billing_clean", "auth_delete_started"])
    .is("reconcile_dead_lettered_at", null)
    .lte("reconcile_next_attempt_at", nowIso)
    .lt("updated_at", staleBefore)
    .order("reconcile_next_attempt_at", { ascending: true })
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) {
    summary.errors.push(`stale account-deletion lookup failed: ${error.message}`);
    return summary;
  }

  for (const raw of data ?? []) {
    const row = raw as ReconciliationRow;
    summary.inspected += 1;
    try {
      let state: DeletionState = row.state;
      if (state === "prepared") {
        state = await settleAccountDeletionBilling(
          sb,
          row.user_id,
          options.stripeClient
        );
        summary.billingResumed += 1;
      }

      const { data: fresh, error: freshError } = await sb
        .from("account_deletion_sagas")
        .select(
          "state, support_deleted_at, delivery_policy_settled_at, reconcile_dead_lettered_at"
        )
        .eq("user_id", row.user_id)
        .maybeSingle();
      if (freshError || !fresh) {
        throw new Error(
          `durable saga re-read failed: ${freshError?.message ?? "row missing"}`
        );
      }
      state = fresh.state as DeletionState;
      if (state === "complete") {
        continue;
      }
      if (
        (state === "billing_clean" || state === "auth_delete_started") &&
        (!fresh.support_deleted_at || !fresh.delivery_policy_settled_at)
      ) {
        // The saga deliberately stores no email. While Auth still exists, its
        // exact confirmed identity is the only permitted service-side retry
        // source. Never use an email lookup or log the address.
        const authIdentity = await lookupAuthUser(sb, row.user_id);
        const cleanupEmails = normalizeAccountEmails(
          authIdentity.confirmedEmail,
          authIdentity.mirrorEmail
        );
        if (!authIdentity.exists || cleanupEmails.length === 0) {
          summary.privacyBlocked += 1;
          throw new Error(
            "required privacy cleanup has no confirmed Auth identity"
          );
        }
        await settleAccountDeletionPrivacy(
          sb,
          row.user_id,
          cleanupEmails
        );
        const { data: privacyFresh, error: privacyFreshError } = await sb
          .from("account_deletion_sagas")
          .select(
            "state, support_deleted_at, delivery_policy_settled_at, reconcile_dead_lettered_at"
          )
          .eq("user_id", row.user_id)
          .maybeSingle();
        if (
          privacyFreshError ||
          !privacyFresh ||
          !privacyFresh.support_deleted_at ||
          !privacyFresh.delivery_policy_settled_at
        ) {
          summary.privacyBlocked += 1;
          throw new Error(
            `required privacy cleanup was not durably confirmed: ${
              privacyFreshError?.message ?? "markers missing"
            }`
          );
        }
        state = privacyFresh.state as DeletionState;
      }
      if (state === "billing_clean") {
        await beginAccountDeletionAuthRemoval(sb, row.user_id);
        state = "auth_delete_started";
      }
      if (state !== "auth_delete_started") {
        throw new Error(`unexpected durable saga state ${state}`);
      }

      if ((await lookupAuthUser(sb, row.user_id)).exists) {
        const { error: deleteError } = await sb.auth.admin.deleteUser(row.user_id);
        if (deleteError && !isUserNotFoundError(deleteError)) {
          throw new Error(`Auth deletion retry failed: ${deleteError.message}`);
        }
        summary.authDeleted += 1;
      }
      if ((await lookupAuthUser(sb, row.user_id)).exists) {
        throw new Error("Auth deletion could not be confirmed terminal");
      }
      await completeAccountDeletion(sb, row.user_id);
      summary.completed += 1;
    } catch (reconcileError) {
      summary.errors.push(
        `account deletion ${row.user_id}: ${
          reconcileError instanceof Error
            ? reconcileError.message
            : "reconciliation failed"
        }`
      );
      const attempts = Number.isSafeInteger(row.reconcile_attempt_count)
        ? Math.max(0, row.reconcile_attempt_count)
        : 0;
      const retryMinutes = accountDeletionRetryMinutes(attempts);
      // Long Stripe/Auth calls can outlive the discovery clock supplied to
      // this run. Base the persisted deadline on the later local clock so the
      // bounded RPC cannot reject an already-expired retry timestamp.
      const retryClockMs = Math.max(nowMs, Date.now());
      const retryAt = new Date(retryClockMs + retryMinutes * 60_000).toISOString();
      const { data: deferred, error: deferError } = await sb.rpc(
        "fail_account_deletion_reconciliation",
        {
          p_user_id: row.user_id,
          p_error_code: accountDeletionErrorCode(reconcileError),
          p_retry_at: retryAt,
        }
      );
      if (deferError || typeof deferred !== "string") {
        summary.errors.push(
          `account deletion ${row.user_id}: retry backoff was not persisted: ${
            deferError?.message ?? String(deferred)
          }`
        );
      } else if (deferred === "dead_lettered") {
        summary.deadLettered += 1;
      } else if (
        ![
          "deferred",
          "manual_review",
          "already_dead_lettered",
          "complete",
          "state_changed",
          "missing",
          "lease_lost",
        ].includes(deferred)
      ) {
        summary.errors.push(
          `account deletion ${row.user_id}: retry transition returned ${deferred}`
        );
      }
    }
  }
  return summary;
}
