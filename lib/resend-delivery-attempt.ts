import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type RpcClient = Pick<SupabaseClient, "rpc">;

type ClaimRow = {
  delivery_status?: unknown;
  stored_recipient?: unknown;
  stored_message_id?: unknown;
  stored_accepted_at?: unknown;
  stored_lease_expires_at?: unknown;
  stored_retry_deadline_at?: unknown;
};

type FinalizeRow = {
  delivery_status?: unknown;
  stored_accepted_at?: unknown;
  suppression_review_required?: unknown;
};

const MIN_PROVIDER_WINDOW_MS = 4 * 60_000;

export type ResendDeliveryAttemptResult = {
  providerSent: boolean;
  messageId: string;
  acceptedAt: string;
  suppressionReviewRequired: boolean;
};

export class ResendDeliveryAttemptError extends Error {
  constructor(
    public readonly stage: "claim" | "send" | "finalize",
    public readonly code: string
  ) {
    super(`Resend delivery attempt ${stage} failed: ${code}`);
    this.name = "ResendDeliveryAttemptError";
  }
}

function canonicalEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || normalized !== value) return null;
  return normalized;
}

function claimRow(value: unknown): ClaimRow | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  return row && typeof row === "object" ? (row as ClaimRow) : null;
}

function finalizeRow(value: unknown): FinalizeRow | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  return row && typeof row === "object" ? (row as FinalizeRow) : null;
}

/**
 * Stage one immutable recipient before a Resend call, then finalize the exact
 * provider message under the same bounded lease. A retry on the same provider
 * idempotency lane can only reuse that stored recipient.
 */
export async function sendWithResendDeliveryAttempt(params: {
  sb: RpcClient;
  userId: string;
  weekOf: string;
  recipient: string;
  deliveryLane: string;
  payloadFingerprint: string;
  expectedClaimedAt: string | null;
  send: (recipient: string) => Promise<{ id: string }>;
}): Promise<ResendDeliveryAttemptResult> {
  const recipient = canonicalEmail(params.recipient);
  if (!recipient) {
    throw new ResendDeliveryAttemptError("claim", "recipient_not_canonical");
  }
  if (!/^[0-9a-f]{64}$/.test(params.payloadFingerprint)) {
    throw new ResendDeliveryAttemptError("claim", "fingerprint_invalid");
  }

  const leaseToken = randomUUID();
  const { data, error } = await params.sb.rpc(
    "claim_resend_delivery_attempt",
    {
      p_user_id: params.userId,
      p_week_of: params.weekOf,
      p_recipient: recipient,
      p_delivery_lane: params.deliveryLane,
      p_request_fingerprint: params.payloadFingerprint,
      p_lease_token: leaseToken,
      p_expected_claimed_at: params.expectedClaimedAt,
    }
  );
  if (error) {
    throw new ResendDeliveryAttemptError("claim", error.message);
  }
  const row = claimRow(data);
  const status = row?.delivery_status;
  const storedRecipient = row?.stored_recipient;
  if (status === "finalized") {
    if (
      typeof row?.stored_message_id !== "string" ||
      !row.stored_message_id ||
      typeof row.stored_accepted_at !== "string"
    ) {
      throw new ResendDeliveryAttemptError("claim", "invalid_finalized_state");
    }
    return {
      providerSent: false,
      messageId: row.stored_message_id,
      acceptedAt: row.stored_accepted_at,
      suppressionReviewRequired: false,
    };
  }
  if (
    (status !== "claimed" && status !== "replayed") ||
    storedRecipient !== recipient ||
    typeof row?.stored_lease_expires_at !== "string"
  ) {
    throw new ResendDeliveryAttemptError(
      "claim",
      typeof status === "string" ? status : "invalid_claim_state"
    );
  }
  const leaseExpiresAt = Date.parse(row.stored_lease_expires_at);
  if (
    !Number.isFinite(leaseExpiresAt) ||
    leaseExpiresAt - Date.now() < MIN_PROVIDER_WINDOW_MS
  ) {
    throw new ResendDeliveryAttemptError("claim", "lease_window_too_short");
  }
  const retryDeadlineAt = Date.parse(
    typeof row.stored_retry_deadline_at === "string"
      ? row.stored_retry_deadline_at
      : ""
  );
  if (
    !Number.isFinite(retryDeadlineAt) ||
    retryDeadlineAt - Date.now() < MIN_PROVIDER_WINDOW_MS
  ) {
    throw new ResendDeliveryAttemptError("claim", "retry_window_too_short");
  }

  let sent: { id: string };
  try {
    sent = await params.send(storedRecipient);
  } catch (error) {
    throw new ResendDeliveryAttemptError(
      "send",
      error instanceof Error ? error.message : "provider_error"
    );
  }
  if (!sent?.id || typeof sent.id !== "string") {
    throw new ResendDeliveryAttemptError("send", "message_id_missing");
  }

  const { data: finalized, error: finalizeError } = await params.sb.rpc(
    "finalize_resend_delivery_attempt",
    {
      p_user_id: params.userId,
      p_week_of: params.weekOf,
      p_delivery_lane: params.deliveryLane,
      p_lease_token: leaseToken,
      p_request_fingerprint: params.payloadFingerprint,
      p_message_id: sent.id,
    }
  );
  const finalRow = finalizeRow(finalized);
  const finalStatus = finalRow?.delivery_status;
  if (
    finalizeError ||
    typeof finalStatus !== "string" ||
    !["recorded", "recorded_stale", "replayed", "replayed_stale"].includes(
      finalStatus
    ) ||
    typeof finalRow?.stored_accepted_at !== "string" ||
    typeof finalRow.suppression_review_required !== "boolean"
  ) {
    throw new ResendDeliveryAttemptError(
      "finalize",
      finalizeError?.message ??
        (typeof finalStatus === "string" ? finalStatus : "invalid_finalize_state")
    );
  }
  return {
    providerSent: true,
    messageId: sent.id,
    acceptedAt: finalRow.stored_accepted_at,
    suppressionReviewRequired: finalRow.suppression_review_required,
  };
}
