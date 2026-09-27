import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalBrevoMessageId } from "./brevo-message-id";
import {
  isBrevoPreparedEmail,
  sendBrevoPreparedEmail,
  type BrevoPreparedEmail,
  type BrevoDispatchOptions,
  type BrevoHttpTransport,
} from "./brevo-transport";

type RpcClient = Pick<SupabaseClient, "rpc">;
const MIN_PROVIDER_WINDOW_MS = 4 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class BrevoDeliveryAttemptError extends Error {
  constructor(public readonly stage: "claim" | "send" | "finalize", public readonly code: string) {
    super(`Brevo delivery attempt ${stage} failed: ${code}`);
    this.name = "BrevoDeliveryAttemptError";
  }
}

function singleRow(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) && value.length === 1 && value[0] &&
    typeof value[0] === "object" && !Array.isArray(value[0]) ? value[0] : null;
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

/** Live-lane only. The shared ledger must reject every existing pending Brevo
 * attempt, even after a crash or lease expiry. No caller may retry a Brevo send
 * or switch an ambiguous send to Resend. This coordinator has no runtime caller
 * until the migration, suppression ingress and provider-aware coverage ship. */
export async function sendWithBrevoDeliveryAttempt(params: {
  sb: RpcClient;
  userId: string;
  weekOf: string;
  expectedClaimedAt: string;
  prepared: BrevoPreparedEmail;
  options: BrevoDispatchOptions;
  transport: BrevoHttpTransport;
}): Promise<{
  providerSent: boolean;
  messageId: string;
  acceptedAt: string;
  suppressionReviewRequired: boolean;
}> {
  const { sb, userId, weekOf, expectedClaimedAt, prepared, transport } = params;
  const options = { apiKey: params.options?.apiKey, timeoutMs: params.options?.timeoutMs };
  if (!isBrevoPreparedEmail(prepared) || !UUID.test(userId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(weekOf) ||
      !Number.isFinite(Date.parse(weekOf)) || new Date(weekOf).toISOString().slice(0, 10) !== weekOf ||
      !validInstant(expectedClaimedAt) || typeof transport !== "function" ||
      typeof options.apiKey !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(options.apiKey) ||
      (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) ||
        options.timeoutMs < 1 || options.timeoutMs > 15_000))) {
    throw new BrevoDeliveryAttemptError("claim", "invalid_input");
  }
  const leaseToken = randomUUID();
  const identity = {
    p_user_id: userId,
    p_week_of: weekOf,
    p_attempt_id: prepared.attemptId,
    p_lease_token: leaseToken,
    p_request_fingerprint: prepared.requestFingerprint,
  };
  let claimed: Record<string, unknown> | null;
  try {
    const result = await sb.rpc("claim_brevo_delivery_attempt", {
      ...identity,
      p_recipient: prepared.recipient,
      p_expected_claimed_at: expectedClaimedAt,
    });
    if (result.error) throw new Error("claim_failed");
    claimed = singleRow(result.data);
  } catch {
    // A lost claim response is uncertain. Never call the provider in that case.
    throw new BrevoDeliveryAttemptError("claim", "claim_failed");
  }
  if (claimed?.delivery_status === "accepted") {
    const messageId = canonicalBrevoMessageId(claimed.stored_message_id);
    if (!messageId || messageId !== claimed.stored_message_id ||
        claimed.stored_recipient !== prepared.recipient || !validInstant(claimed.stored_accepted_at)) {
      throw new BrevoDeliveryAttemptError("claim", "invalid_accepted_state");
    }
    return {
      providerSent: false, messageId, acceptedAt: claimed.stored_accepted_at,
      // Conservatively retain review until finalization/event state is read.
      suppressionReviewRequired: true,
    };
  }
  if (claimed?.delivery_status !== "claimed" ||
      claimed.stored_recipient !== prepared.recipient ||
      claimed.stored_attempt_id !== prepared.attemptId ||
      !validInstant(claimed.stored_lease_expires_at) ||
      Date.parse(claimed.stored_lease_expires_at) - Date.now() < MIN_PROVIDER_WINDOW_MS) {
    // Do not echo raw database values or errors into a log/alert.
    throw new BrevoDeliveryAttemptError("claim", "not_claimed");
  }

  const markUnconfirmed = async () => {
    try {
      await sb.rpc("mark_brevo_delivery_unconfirmed", identity);
    } catch {
      // The claim already disallows all replays. Losing this diagnostic write
      // must never turn a possibly accepted send into a new dispatch.
    }
  };
  const sent = await sendBrevoPreparedEmail(prepared, options, transport);
  if (sent.status !== "accepted" || sent.requestFingerprint !== prepared.requestFingerprint) {
    await markUnconfirmed();
    throw new BrevoDeliveryAttemptError("send", "unconfirmed");
  }
  let finalized: Record<string, unknown> | null = null;
  try {
    const result = await sb.rpc("finalize_brevo_delivery_attempt", {
      ...identity, p_message_id: sent.messageId,
    });
    if (!result.error) finalized = singleRow(result.data);
  } catch {
    // Provider acceptance is not undone by a failed database response.
  }
  if (!finalized || !["recorded", "recorded_stale", "replayed", "replayed_stale"].includes(
    String(finalized.delivery_status),
  ) || !validInstant(finalized.stored_accepted_at) ||
      typeof finalized.suppression_review_required !== "boolean") {
    await markUnconfirmed();
    throw new BrevoDeliveryAttemptError("finalize", "acceptance_write_failed");
  }
  return {
    providerSent: true,
    messageId: sent.messageId,
    acceptedAt: finalized.stored_accepted_at,
    suppressionReviewRequired: finalized.suppression_review_required,
  };
}
