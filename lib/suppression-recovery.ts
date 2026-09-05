import type { SupabaseClient } from "@supabase/supabase-js";
import { MANUAL_PROVIDER_SUPPRESSION_REMOVAL_ENABLED } from "@/lib/suppression-recovery-policy";

type RpcClient = Pick<SupabaseClient, "rpc">;

type ClaimStatus =
  | "claimed"
  | "missing"
  | "deletion_pending"
  | "review_required"
  | "ineligible"
  | "already_clear"
  | "delivery_busy"
  | "identity_conflict";

type ClaimRow = {
  recovery_status?: unknown;
  recovery_token?: unknown;
  recovery_started_at?: unknown;
  recipient_email?: unknown;
};

export type SuppressionRecoveryResult =
  | { status: "manual_recovery_disabled" }
  | { status: "cleared" }
  | { status: "already_clear" }
  | {
      status:
        | "missing"
        | "deletion_pending"
        | "review_required"
        | "ineligible"
        | "delivery_busy"
        | "identity_conflict";
    }
  | { status: "provider_unavailable" }
  | { status: "provider_failed" }
  | { status: "state_changed" }
  | { status: "settlement_unconfirmed" };

const CLAIM_STATUSES = new Set<ClaimStatus>([
  "claimed",
  "missing",
  "deletion_pending",
  "review_required",
  "ineligible",
  "already_clear",
  "delivery_busy",
  "identity_conflict",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function asSingleClaimRow(value: unknown): ClaimRow | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  return row && typeof row === "object" ? (row as ClaimRow) : null;
}

function isCanonicalEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 254 &&
    value === value.trim().toLowerCase() &&
    EMAIL_PATTERN.test(value)
  );
}

function isClaimedRow(
  row: ClaimRow
): row is ClaimRow & {
  recovery_token: string;
  recovery_started_at: string;
  recipient_email: string;
} {
  return (
    typeof row.recovery_token === "string" &&
    UUID_PATTERN.test(row.recovery_token) &&
    typeof row.recovery_started_at === "string" &&
    ISO_TIMESTAMP_PATTERN.test(row.recovery_started_at) &&
    Number.isFinite(Date.parse(row.recovery_started_at)) &&
    isCanonicalEmail(row.recipient_email)
  );
}

function hasNoClaimData(row: ClaimRow): boolean {
  return (
    row.recovery_token === null &&
    row.recovery_started_at === null &&
    row.recipient_email === null
  );
}

/**
 * Deferred protocol behind a checked-in safety hold. New calls return before
 * configuration or RPC access. The retained claim and settlement code needs
 * a separate review before manual provider recovery can be enabled again.
 */
export async function recoverResendSuppression(params: {
  sb: RpcClient;
  userId: string;
  providerConfigured: boolean;
  removeSuppression: (recipientEmail: string) => Promise<boolean>;
}): Promise<SuppressionRecoveryResult> {
  if (!MANUAL_PROVIDER_SUPPRESSION_REMOVAL_ENABLED) {
    return { status: "manual_recovery_disabled" };
  }
  if (!params.providerConfigured) return { status: "provider_unavailable" };

  let claimed: ClaimRow | null;
  try {
    const { data, error } = await params.sb.rpc(
      "claim_resend_suppression_recovery",
      { p_user_id: params.userId }
    );
    if (error) return { status: "settlement_unconfirmed" };
    claimed = asSingleClaimRow(data);
  } catch {
    return { status: "settlement_unconfirmed" };
  }
  if (!claimed || !CLAIM_STATUSES.has(claimed.recovery_status as ClaimStatus)) {
    return { status: "settlement_unconfirmed" };
  }
  const recoveryStatus = claimed.recovery_status as ClaimStatus;
  if (recoveryStatus !== "claimed") {
    if (!hasNoClaimData(claimed)) {
      return { status: "settlement_unconfirmed" };
    }
    return { status: recoveryStatus };
  }
  if (!isClaimedRow(claimed)) return { status: "settlement_unconfirmed" };

  let providerCleared = false;
  try {
    providerCleared =
      (await params.removeSuppression(claimed.recipient_email)) === true;
  } catch {
    return { status: "provider_failed" };
  }
  if (!providerCleared) return { status: "provider_failed" };

  try {
    const { data, error } = await params.sb.rpc(
      "finalize_resend_suppression_recovery",
      {
        p_user_id: params.userId,
        p_recovery_token: claimed.recovery_token,
      }
    );
    if (error || typeof data !== "string") {
      return { status: "settlement_unconfirmed" };
    }
    if (data === "cleared") return { status: "cleared" };
    if (data === "state_changed") return { status: "state_changed" };
    return { status: "settlement_unconfirmed" };
  } catch {
    return { status: "settlement_unconfirmed" };
  }
}
