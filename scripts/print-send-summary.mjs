#!/usr/bin/env node
// Public-safe projection for the CRON_SECRET-gated weekly-send response.
// Missing fields stay missing: absence is not proof that an event count was 0.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_SEND_SUMMARY_BYTES = 65_536;
export const REDACTED_SEND_SUMMARY =
  "[send summary redacted: invalid or oversized JSON]";

const COUNT_FIELDS = Object.freeze([
  "subscribers",
  "sent",
  "backupSharedSent",
  "backupFreshSent",
  "backupStaleSent",
  "skippedNoName",
  "skippedEmptyPool",
  "skippedBlankSubscribersTotal",
  "skippedAlreadyDelivered",
  "deferredTotal",
  "failed",
  "braveRateLimited",
  "youRateLimited",
  "geminiRateLimited",
  "groqRateLimited",
  "deepseekRateLimited",
  "paidCallsThisRun",
  "paidCallCounterDelta",
  "paidCallReservationsGranted",
  "paidCallReservationsUsed",
  "paidCallReservationsUnused",
  "hardFailedTopics",
  "unsubscribedMidRunSkips",
  "cancelledMidRunSkips",
  "unenrolledMidRunSkips",
  "suppressedMidRunSkips",
  "eligibilityRecheckFailures",
  "checkoutRetentionErrors",
  "elapsedMs",
  "failuresTotal",
  "deliveryBatchSize",
  "deliveryPageCount",
  "deliveryRetryRequiredTotal",
]);

const BOOLEAN_FIELDS = Object.freeze([
  "canary",
  "canarySent",
  "paidCallCeilingHit",
  "paidCallReservationExhausted",
  "deliveryWrapped",
  "deliveryCursorAdvanceFailed",
  "deliveryPageComplete",
  "deliveryRetryRequired",
  "deliveryPageBlocked",
  "deliveryHasMore",
]);

const DATE_FIELDS = Object.freeze(["issueDate", "weekOf", "paidCallBudgetDate"]);

const SUBSCRIBER_ARRAY_FIELDS = Object.freeze([
  "backupSharedSentEmails",
  "backupFreshSentEmails",
  "backupStaleSentEmails",
  "skippedBlankSubscribers",
  "deferred",
  "failures",
]);

const CURSOR_STATES = new Set([
  "advanced",
  "advanced_with_retry",
  "override_read_only",
  "empty",
  "advance_failed",
]);

function ownValue(input, key) {
  if (!Object.hasOwn(input, key)) return { present: false };
  try {
    return { present: true, value: input[key] };
  } catch {
    return { present: false };
  }
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const stamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}

/**
 * Return only fixed, aggregate fields safe for a public Actions log.
 * Unknown keys, identifiers, arbitrary errors, nested objects and invalid
 * known values are omitted. No missing count is synthesized as zero.
 */
export function projectSendSummary(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const projected = {};
  for (const key of COUNT_FIELDS) {
    const field = ownValue(input, key);
    if (
      field.present &&
      Number.isSafeInteger(field.value) &&
      field.value >= 0
    ) {
      projected[key] = field.value;
    }
  }

  for (const key of BOOLEAN_FIELDS) {
    const field = ownValue(input, key);
    if (field.present && typeof field.value === "boolean") {
      projected[key] = field.value;
    }
  }

  for (const key of DATE_FIELDS) {
    const field = ownValue(input, key);
    if (field.present && validDate(field.value)) projected[key] = field.value;
  }

  const cursorState = ownValue(input, "deliveryCursorState");
  if (
    cursorState.present &&
    typeof cursorState.value === "string" &&
    CURSOR_STATES.has(cursorState.value)
  ) {
    projected.deliveryCursorState = cursorState.value;
  }

  for (const key of SUBSCRIBER_ARRAY_FIELDS) {
    const field = ownValue(input, key);
    if (field.present && Array.isArray(field.value)) {
      projected[key] = field.value.length;
    }
  }

  return projected;
}

export function renderSendSummary(input, maxBytes = MAX_SEND_SUMMARY_BYTES) {
  if (
    typeof input !== "string" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    Buffer.byteLength(input, "utf8") > maxBytes
  ) {
    return REDACTED_SEND_SUMMARY;
  }

  try {
    const projected = projectSendSummary(JSON.parse(input));
    return projected ? JSON.stringify(projected, null, 2) : REDACTED_SEND_SUMMARY;
  } catch {
    return REDACTED_SEND_SUMMARY;
  }
}

async function readBoundedInput(stream, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function main() {
  try {
    const input = await readBoundedInput(process.stdin, MAX_SEND_SUMMARY_BYTES);
    process.stdout.write(
      `${input === null ? REDACTED_SEND_SUMMARY : renderSendSummary(input)}\n`
    );
  } catch {
    process.stdout.write(`${REDACTED_SEND_SUMMARY}\n`);
  }
}

const invokedPath = process.argv[1];
if (
  typeof invokedPath === "string" &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  await main();
}
