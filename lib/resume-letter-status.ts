import { hasReaderAccess } from "./access";

export const RESUME_LETTER_MESSAGES = {
  eligible: "Your unsubscribe preference is cleared. Daily letters can resume on the regular schedule.",
  "owner-paused": "Your unsubscribe preference is cleared. Daily letters are still paused for this account. Contact Alpha to have them enabled.",
  "delivery-review": "Your unsubscribe preference is cleared. Email delivery still needs a review. Contact Alpha before expecting letters.",
  "access-required": "Your unsubscribe preference is cleared. Daily letters still need approved access to this account.",
  "sending-paused": "Your unsubscribe preference is cleared. Alpha's daily sending is currently paused.",
} as const;

export type ResumeLetterStatus = keyof typeof RESUME_LETTER_MESSAGES;

const STATUS_TIMESTAMPS = [
  "subscribed_at", "cancelled_at", "access_granted_at", "unsubscribed_at",
  "bounced_at", "complained_at", "suppression_cleanup_pending_at",
] as const;

function validTimestampOrNull(value: unknown): boolean {
  return value === null || typeof value === "string" && value.length > 0 &&
    Number.isFinite(Date.parse(value));
}

/** Point-in-time delivery status after clearing only the reader's Alpha pause.
 * The sender still performs its own current eligibility and provider checks. */
export function getResumeLetterStatus(
  value: unknown,
  options: { brevoSchemaEnabled: boolean; lettersEnabled: boolean; now?: Date },
): ResumeLetterStatus | "unverified" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unverified";
  const row = value as Record<string, unknown>;
  if (typeof row.email !== "string" || !row.email.trim() ||
      STATUS_TIMESTAMPS.some((field) => !Object.hasOwn(row, field) || !validTimestampOrNull(row[field])) ||
      typeof row.delivery_enrolled !== "boolean" || row.unsubscribed_at !== null ||
      options.brevoSchemaEnabled && (!Object.hasOwn(row, "brevo_unsubscribed_at") ||
        !validTimestampOrNull(row.brevo_unsubscribed_at))) return "unverified";

  if (row.bounced_at !== null || row.complained_at !== null ||
      row.suppression_cleanup_pending_at !== null ||
      options.brevoSchemaEnabled && row.brevo_unsubscribed_at !== null) return "delivery-review";

  if (!hasReaderAccess(
    row.subscribed_at as string | null,
    row.cancelled_at as string | null,
    row.access_granted_at as string | null,
    options.now,
  )) return "access-required";
  if (!options.lettersEnabled) return "sending-paused";
  if (!row.delivery_enrolled) return "owner-paused";
  return "eligible";
}

/** Unknown/legacy success payloads cannot turn into a delivery promise. */
export function parseResumeLetterResponse(value: unknown): ResumeLetterStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (!Object.hasOwn(response, "ok") || response.ok !== true ||
      !Object.hasOwn(response, "status") || typeof response.status !== "string" ||
      !Object.hasOwn(RESUME_LETTER_MESSAGES, response.status)) return null;
  return response.status as ResumeLetterStatus;
}
