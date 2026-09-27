import { createHash, timingSafeEqual } from "node:crypto";
import { canonicalBrevoMessageId } from "./brevo-message-id";

const MAX_BODY_BYTES = 16_384;
const MAX_READ_MS = 5_000;
const MAX_FUTURE_SKEW_MS = 10 * 60_000;
const EARLIEST_EVENT_MS = Date.UTC(2000, 0, 1);
class BodyReadTimeout extends Error {}

export type BrevoSuppressionEvent = Readonly<{
  messageId: string;
  recipient: string;
  type: "hard_bounce" | "spam" | "unsubscribed";
  eventAt: string;
}>;

type ParsedEvent =
  | { status: "event"; event: BrevoSuppressionEvent }
  | { status: "ignored" }
  | { status: "invalid" };

/** Read only the allowlisted fields. Provider subject, links, IP, custom
 * headers and other metadata must never enter Alpha's suppression audit. */
export function parseBrevoSuppressionEvent(value: unknown, nowMs = Date.now()): ParsedEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "invalid" };
  const input = value as Record<string, unknown>;
  if (typeof input.event !== "string" || !/^[a-z_]{1,40}$/.test(input.event)) {
    return { status: "invalid" };
  }
  if (input.event !== "hard_bounce" && input.event !== "spam" && input.event !== "unsubscribed") {
    return { status: "ignored" };
  }
  const messageId = canonicalBrevoMessageId(input["message-id"]);
  const recipient = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  // One mailbox only. Ownership still requires the exact saved attempt in SQL.
  if (!messageId || recipient.length > 254 ||
      !/^[^\s<>(),:;"\\@]+@[^\s<>(),:;"\\@]+\.[^\s<>(),:;"\\@]+$/.test(recipient) ||
      /[\p{Cc}]/u.test(recipient)) return { status: "invalid" };
  // ts_event is the documented UTC event clock in seconds. date is local
  // time, and ts_epoch can describe the original send. Neither is a fallback.
  if (typeof input.ts_event !== "number" || !Number.isSafeInteger(input.ts_event)) {
    return { status: "invalid" };
  }
  const eventMs = input.ts_event * 1_000;
  if (!Number.isSafeInteger(eventMs) || !Number.isFinite(nowMs) ||
      eventMs < EARLIEST_EVENT_MS || eventMs > nowMs + MAX_FUTURE_SKEW_MS ||
      eventMs > 8_640_000_000_000_000) return { status: "invalid" };
  return {
    status: "event",
    event: Object.freeze({ messageId, recipient, type: input.event, eventAt: new Date(eventMs).toISOString() }),
  };
}

export function brevoWebhookSecretConfigured(secret: unknown): secret is string {
  return typeof secret === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(secret);
}

/** This is bearer authentication, not a per-message signature. Use a dedicated
 * webhook token, never the sending API key. Authentication precedes body reads. */
export function authenticateBrevoWebhook(authorization: string | null, secret: string): boolean {
  if (!brevoWebhookSecretConfigured(secret) || !authorization || authorization.length > 263) return false;
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(authorization);
  if (!match) return false;
  return timingSafeEqual(
    createHash("sha256").update(match[1]).digest(),
    createHash("sha256").update(secret).digest(),
  );
}

async function boundedBody(req: Request, timeoutMs: number): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("invalid_body");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const aborted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new BodyReadTimeout()); cancel(); }, timeoutMs);
  });
  try {
    const reading = (async () => {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "";
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) { done = true; break; }
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY_BYTES) throw new Error("invalid_body");
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    })();
    return await Promise.race([reading, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!done) cancel();
    // Cancellation may still have a pending read. Release after it settles.
    try { reader.releaseLock(); } catch { /* request stream cleanup only */ }
  }
}

const RECORD_STATUSES = new Set([
  "applied", "causally_ignored", "pending_owner", "manual_review", "expired_unowned",
]);

function resultResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Isolated ingress. Callers inject persistence after shared ownership and
 * suppression RPCs are installed. No environment loading or provider calls.
 * A failed persistence operation is never acknowledged as received. */
export async function handleBrevoSuppressionWebhook(
  req: Request,
  options: {
    secret: string | undefined;
    record: (event: BrevoSuppressionEvent) => Promise<unknown>;
    nowMs?: number;
    readTimeoutMs?: number;
  },
): Promise<Response> {
  if (req.method !== "POST") return resultResponse(405, { error: "method_not_allowed" });
  if (!brevoWebhookSecretConfigured(options.secret)) {
    return resultResponse(503, { error: "webhook_not_configured" });
  }
  if (!authenticateBrevoWebhook(req.headers.get("authorization"), options.secret)) {
    return resultResponse(401, { error: "unauthorized" });
  }
  const contentType = req.headers.get("content-type") ?? "";
  const length = req.headers.get("content-length");
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))) {
    return resultResponse(400, { error: "invalid_body" });
  }
  const timeoutMs = options.readTimeoutMs ?? MAX_READ_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_READ_MS) {
    return resultResponse(503, { error: "webhook_not_configured" });
  }
  let parsed: ParsedEvent;
  try {
    parsed = parseBrevoSuppressionEvent(await boundedBody(req, timeoutMs), options.nowMs);
  } catch (error) {
    if (error instanceof BodyReadTimeout) return resultResponse(503, { error: "body_read_timeout" });
    return resultResponse(400, { error: "invalid_body" });
  }
  if (parsed.status === "invalid") return resultResponse(400, { error: "invalid_event" });
  if (parsed.status === "ignored") return resultResponse(200, { received: true });
  try {
    const recorded = await options.record(parsed.event);
    const row = Array.isArray(recorded) && recorded.length === 1 ? recorded[0] : null;
    if (!row || !RECORD_STATUSES.has(row.delivery_status) ||
        !Number.isSafeInteger(row.updated_count) || row.updated_count < 0 || row.updated_count > 1 ||
        (row.delivery_status !== "applied" && row.updated_count !== 0)) {
      return resultResponse(503, { error: "suppression_write_failed" });
    }
    return resultResponse(200, {
      received: true,
      ...(row.delivery_status === "pending_owner" || row.delivery_status === "manual_review"
        ? { reviewRequired: true } : {}),
    });
  } catch {
    return resultResponse(503, { error: "suppression_write_failed" });
  }
}
