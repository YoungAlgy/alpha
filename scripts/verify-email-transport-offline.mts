// Real email helpers and installed Resend SDK, with an in-memory transport.
// No sockets, provider credentials, environment files, or subscriber content.
// Run only through the cleaned, network-denied verification harness.
import assert from "node:assert/strict";
import {
  sendOpsAlert,
  sendOpsWebhookAlert,
  sendPreparedSubscriberEmail,
} from "../lib/email.ts";

const envNames = [
  "NODE_ENV", "RESEND_API_KEY", "RESEND_FROM", "OPS_ALERT_EMAIL",
  "ALPHA_OPS_ALERT_WEBHOOK_URL", "ALPHA_ALLOW_LOCAL_OPS_WEBHOOK_TEST",
] as const;
const oldEnv = new Map(envNames.map((name) => [name, process.env[name]]));
const oldFetch = globalThis.fetch;
const oldTimeout = AbortSignal.timeout;
const oldWarn = console.warn;
const timers: ReturnType<typeof setTimeout>[] = [];
const deadlines: number[] = [];
const calls: string[] = [];
const webhook = "https://discord.com/api/webhooks/1234567890/offline_test_token";
let mode = "success";
let unexpectedCalls = 0;
let assertions = 0;

function equal(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(actual, expected, label);
  assertions += 1;
}

function untilAborted(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

try {
  for (const name of envNames) delete process.env[name];
  process.env.NODE_ENV = "production";
  console.warn = () => undefined;
  // Keep the real requested deadlines visible, but shorten wall-clock waits.
  // Signals still cancel both fetch waits and streamed response-body reads.
  AbortSignal.timeout = (milliseconds: number) => {
    deadlines.push(milliseconds);
    const controller = new AbortController();
    timers.push(setTimeout(() => controller.abort(new Error("offline timeout")), 5));
    return controller.signal;
  };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://api.resend.com/emails" && url !== webhook) {
      unexpectedCalls += 1;
      throw new Error("Unexpected offline destination");
    }
    const signal = init?.signal;
    assert.ok(signal, "the actual helper must supply a cancellation signal");
    assertions += 1;
    equal(init?.method, "POST", "expected request method");
    calls.push(url === webhook ? "webhook" : "resend");
    if (url === webhook) {
      const payload = JSON.parse(String(init?.body));
      equal(payload.content, "**[alpha ops alert]** offline subject\n\noffline body", "fallback payload");
      if (mode === "webhook-timeout") return untilAborted(signal);
      return new Response(null, { status: mode === "webhook-error" ? 500 : 204 });
    }
    equal(new Headers(init?.headers).get("Idempotency-Key"), "alpha-offline-ops", "stable ops idempotency key reaches SDK transport");
    if (mode === "header-timeout") return untilAborted(signal);
    if (mode === "body-timeout") {
      return new Response(new ReadableStream({
        start(controller) {
          if (signal.aborted) controller.error(signal.reason);
          else signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }), { status: 200 });
    }
    if (mode === "success") return Response.json({ id: "offline-confirmed-id" });
    if (mode === "missing-id") return Response.json({ id: " " });
    const quota = mode === "quota";
    return Response.json({
      name: quota ? "monthly_quota_exceeded" : "invalid_api_key",
      message: "offline forced failure",
      statusCode: quota ? 429 : 401,
    }, { status: quota ? 429 : 401 });
  };

  await sendOpsAlert("offline subject", "offline body", "alpha-offline-ops");
  equal(calls, [], "unset providers are a no-op");
  equal(deadlines, [], "unset providers start no timers");
  process.env.RESEND_API_KEY = "offline-not-a-provider-key";
  process.env.ALPHA_OPS_ALERT_WEBHOOK_URL = webhook;

  for (const scenario of ["success", "auth", "quota", "missing-id", "header-timeout", "body-timeout", "webhook-error", "webhook-timeout"]) {
    mode = scenario;
    calls.length = 0;
    deadlines.length = 0;
    await sendOpsAlert("offline subject", "offline body", "alpha-offline-ops");
    equal(calls, scenario === "success" ? ["resend"] : ["resend", "webhook"], `${scenario}: exact bounded channel order`);
    equal(deadlines, scenario === "success" ? [15_000] : [15_000, 8_000], `${scenario}: real helper timeout settings`);
  }

  calls.length = 0;
  deadlines.length = 0;
  mode = "success";
  await sendOpsWebhookAlert("offline subject", "offline body");
  equal(calls, ["webhook"], "bounce/complaint alerts never recurse through Resend");
  equal(deadlines, [8_000], "webhook-only alert stays bounded");

  calls.length = 0;
  process.env.ALPHA_OPS_ALERT_WEBHOOK_URL = "https://example.com/not-approved";
  await sendOpsWebhookAlert("offline subject", "offline body");
  equal(calls, [], "unapproved webhook destination is rejected before transport");

  await assert.rejects(() => sendPreparedSubscriberEmail({} as never), /Subscriber letters are paused/);
  assertions += 1;
  equal(calls, [], "subscriber hold stops before reading payload or contacting a provider");
  equal(unexpectedCalls, 0, "no unexpected destination was attempted");
} finally {
  globalThis.fetch = oldFetch;
  AbortSignal.timeout = oldTimeout;
  console.warn = oldWarn;
  for (const timer of timers) clearTimeout(timer);
  for (const name of envNames) {
    const value = oldEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log(`PASS verify-email-transport-offline (${assertions} assertions, real SDK with memory-only transport)`);
