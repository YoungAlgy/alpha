import { createHash } from "node:crypto";
import { canonicalBrevoMessageId } from "./brevo-message-id";

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
const MAX_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16_384;

export type BrevoHttpTransport = (
  url: string,
  init: RequestInit
) => Promise<Response>;

export type BrevoCandidateEmail = {
  attemptId: string;
  sender: { email: string; name: string };
  recipient: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  issueHeader?: string;
};

export type BrevoDispatchOptions = {
  apiKey: string;
  timeoutMs?: number;
};

export type BrevoPreparedEmail = Readonly<{
  attemptId: string;
  recipient: string;
  serializedBody: string;
  requestFingerprint: string;
}>;

export type BrevoPreparationResult =
  | { status: "prepared"; prepared: BrevoPreparedEmail }
  | { status: "not_prepared"; reason: "invalid_input" };

export type BrevoCandidateResult =
  | { status: "not_attempted"; reason: "invalid_input" | "invalid_prepared" | "transport_missing" }
  | {
      status: "unconfirmed";
      reason: "http_rejected" | "redirect" | "invalid_response" | "timeout" | "transport_error";
      requestFingerprint: string;
    }
  | { status: "accepted"; messageId: string; requestFingerprint: string };

type DispatchOutcome =
  | { status: "accepted"; messageId: string }
  | {
      status: "unconfirmed";
      reason: Extract<BrevoCandidateResult, { status: "unconfirmed" }>["reason"];
    };

// The registry binds the public, frozen preparation result to its original
// primitives. A caller cannot forge or replace the fingerprint after a claim.
const preparedSnapshots = new WeakMap<BrevoPreparedEmail, BrevoPreparedEmail>();

/** Check registry identity before using a prepared recipient or fingerprint in
 * a durable claim. Cloned or caller-constructed objects never pass. */
export function isBrevoPreparedEmail(value: unknown): value is BrevoPreparedEmail {
  if (!value || typeof value !== "object") return false;
  const prepared = value as BrevoPreparedEmail;
  const saved = preparedSnapshots.get(prepared);
  return !!saved && Object.isFrozen(prepared) &&
    prepared.attemptId === saved.attemptId &&
    prepared.recipient === saved.recipient &&
    prepared.serializedBody === saved.serializedBody &&
    prepared.requestFingerprint === saved.requestFingerprint;
}

function canonicalEmail(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 254 ||
      value !== value.trim().toLowerCase()) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  const labels = domain.split(".");
  // A single canonical dot-atom mailbox. Display-name/address-list syntax is
  // not accepted here, even when it contains no whitespace.
  return local.length <= 64 &&
    /^[a-z0-9!#$%&'*+\/=?^_`{|}~.-]+$/.test(local) &&
    !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") &&
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function safeHeaderValue(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    /^[\x20-\x7e]+$/.test(value);
}

function safeDisplayText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength && value === value.trim() &&
    !/[\p{Cc}\u2028\u2029]/u.test(value);
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing_body");
  let finished = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { finished = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("body_too_large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

function validInput(value: BrevoCandidateEmail): boolean {
  return !!value &&
    typeof value.attemptId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.attemptId) &&
    !!value.sender &&
    canonicalEmail(value.sender.email) &&
    safeDisplayText(value.sender.name, 128) &&
    canonicalEmail(value.recipient) &&
    canonicalEmail(value.replyTo) &&
    safeDisplayText(value.subject, 998) &&
    typeof value.html === "string" && value.html.length > 0 &&
    typeof value.text === "string" && value.text.length > 0 &&
    (value.issueHeader === undefined || safeHeaderValue(value.issueHeader, 256));
}

/**
 * Pure with respect to its input and output: the exact payload and fingerprint
 * are fixed before the database claim. No credentials, environment or network.
 */
export function prepareBrevoCandidateEmail(email: BrevoCandidateEmail): BrevoPreparationResult {
  // Copy every value once. Accessor-backed or malformed runtime inputs cannot
  // change between validation and serialization or leak an exception.
  let snapshot: BrevoCandidateEmail;
  try {
    snapshot = {
      attemptId: email.attemptId,
      sender: { email: email.sender.email, name: email.sender.name },
      recipient: email.recipient,
      replyTo: email.replyTo,
      subject: email.subject,
      html: email.html,
      text: email.text,
      issueHeader: email.issueHeader,
    };
  } catch {
    return { status: "not_prepared", reason: "invalid_input" };
  }
  try {
    if (!validInput(snapshot)) return { status: "not_prepared", reason: "invalid_input" };
  } catch {
    return { status: "not_prepared", reason: "invalid_input" };
  }

  // Brevo manages List-Unsubscribe itself. Only Alpha-specific custom headers
  // are sent; Resend's standard headers are deliberately not copied here.
  const headers: Record<string, string> = {
    "X-Alpha-Attempt-Id": snapshot.attemptId,
  };
  if (snapshot.issueHeader) headers["X-Alpha-Issue-Id"] = snapshot.issueHeader;
  const body = {
    sender: { email: snapshot.sender.email, name: snapshot.sender.name },
    to: [{ email: snapshot.recipient }],
    replyTo: { email: snapshot.replyTo },
    subject: snapshot.subject,
    htmlContent: snapshot.html,
    textContent: snapshot.text,
    headers,
  };
  const serializedBody = JSON.stringify(body);
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify({ provider: "brevo", attemptId: snapshot.attemptId, body: serializedBody }))
    .digest("hex");
  const prepared = Object.freeze({
    attemptId: snapshot.attemptId,
    recipient: snapshot.recipient,
    serializedBody,
    requestFingerprint,
  });
  preparedSnapshots.set(prepared, { ...prepared });
  return Object.freeze({ status: "prepared", prepared });
}

/**
 * Candidate only. One dispatch, no automatic retry or provider switch. The
 * attempt header is correlation, not idempotency. Any outcome after transport
 * invocation that lacks acceptance proof needs reconciliation.
 */
export async function sendBrevoPreparedEmail(
  prepared: BrevoPreparedEmail,
  options: BrevoDispatchOptions,
  transport: BrevoHttpTransport
): Promise<BrevoCandidateResult> {
  if (!isBrevoPreparedEmail(prepared)) {
    return { status: "not_attempted", reason: "invalid_prepared" };
  }
  const saved = preparedSnapshots.get(prepared)!;
  if (typeof transport !== "function") {
    return { status: "not_attempted", reason: "transport_missing" };
  }
  let apiKey: unknown;
  let timeoutMs: unknown;
  try {
    apiKey = options.apiKey;
    timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
  } catch {
    return { status: "not_attempted", reason: "invalid_input" };
  }
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(apiKey) ||
      !Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > MAX_TIMEOUT_MS) {
    return { status: "not_attempted", reason: "invalid_input" };
  }

  const requestFingerprint = saved.requestFingerprint;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("deadline"));
        controller.abort();
      }, timeoutMs as number);
    });
    const dispatch = (async (): Promise<DispatchOutcome> => {
      const response = await transport(BREVO_SEND_URL, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: saved.serializedBody,
        redirect: "error",
        signal: controller.signal,
      });
      if (!(response instanceof Response)) return { status: "unconfirmed", reason: "invalid_response" };
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        return { status: "unconfirmed", reason: "timeout" };
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => {});
        return { status: "unconfirmed", reason: "redirect" };
      }
      if (response.status !== 201) {
        void response.body?.cancel().catch(() => {});
        return { status: "unconfirmed", reason: "http_rejected" };
      }
      let parsed: unknown;
      try {
        parsed = await readBoundedJson(response, controller.signal);
      } catch {
        if (timedOut) throw new Error("deadline");
        return { status: "unconfirmed", reason: "invalid_response" };
      }
      const id = parsed && typeof parsed === "object" && "messageId" in parsed
        ? canonicalBrevoMessageId(parsed.messageId) : null;
      if (!id) {
        return { status: "unconfirmed", reason: "invalid_response" };
      }
      return { status: "accepted", messageId: id };
    })();
    const outcome = await Promise.race([dispatch, deadline]);
    return { ...outcome, requestFingerprint };
  } catch {
    return {
      status: "unconfirmed",
      reason: timedOut ? "timeout" : "transport_error",
      requestFingerprint,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
