import assert from "node:assert/strict";
import {
  authenticateBrevoWebhook,
  brevoWebhookSecretConfigured,
  handleBrevoSuppressionWebhook,
  parseBrevoSuppressionEvent,
  type BrevoSuppressionEvent,
} from "../lib/brevo-webhook";
import { canonicalBrevoMessageId } from "../lib/brevo-message-id";

const SECRET = "local_test_brevo_webhook_secret_123456789";
const NOW = 1_700_000_000_000;
const TOKEN = `Bearer ${SECRET}`;
const EVENT = {
  event: "hard_bounce",
  "message-id": "<Case.ID@example.com>",
  email: " Reader@Example.com ",
  ts_event: NOW / 1_000,
};

let checks = 0;
function equal(actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected);
  checks++;
}

function request(body: BodyInit | null, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("https://example.com/api/webhooks/brevo", {
    method,
    headers: { authorization: TOKEN, "content-type": "application/json", ...headers },
    body: method === "POST" ? body : null,
    duplex: "half",
  } as RequestInit);
}

function jsonRequest(value: unknown, headers: Record<string, string> = {}): Request {
  return request(JSON.stringify(value), headers);
}

async function responseIs(response: Response, status: number, body: unknown): Promise<void> {
  equal(response.status, status);
  equal(await response.json(), body);
  equal(response.headers.get("cache-control"), "no-store");
}

function bodyWithPullMarker(): { body: ReadableStream<Uint8Array>; wasRead: () => boolean } {
  let read = false;
  return {
    body: new ReadableStream<Uint8Array>({ pull() { read = true; } }, { highWaterMark: 0 }),
    wasRead: () => read,
  };
}

async function main(): Promise<void> {
  equal(brevoWebhookSecretConfigured(SECRET), true);
  equal(brevoWebhookSecretConfigured("short"), false);
  equal(brevoWebhookSecretConfigured("a".repeat(257)), false);
  equal(authenticateBrevoWebhook(TOKEN, SECRET), true);
  equal(authenticateBrevoWebhook(`bearer ${SECRET}`, SECRET), true);
  for (const bad of [null, `Bearer ${SECRET}x`, `Bearer  ${SECRET}`, `Basic ${SECRET}`, `Bearer ${"x".repeat(264)}`]) {
    equal(authenticateBrevoWebhook(bad, SECRET), false);
  }

  equal(canonicalBrevoMessageId("<Case.ID@example.com>"), "Case.ID@example.com");
  equal(canonicalBrevoMessageId("Case.ID@example.com"), "Case.ID@example.com");
  for (const bad of [" <<a@example.com>> ", "<<a@example.com>>", "a<@example.com", "a\n@example.com", "", "a".repeat(513), 42]) {
    equal(canonicalBrevoMessageId(bad), null);
  }

  for (const event of ["hard_bounce", "spam", "unsubscribed"] as const) {
    equal(parseBrevoSuppressionEvent({ ...EVENT, event }, NOW), {
      status: "event",
      event: {
        messageId: "Case.ID@example.com", recipient: "reader@example.com",
        type: event, eventAt: new Date(NOW).toISOString(),
      },
    });
  }
  equal(parseBrevoSuppressionEvent({ ...EVENT, event: "soft_bounce" }, NOW), { status: "ignored" });
  for (const bad of [
    { ...EVENT, event: "hard_bounce;drop" },
    { ...EVENT, "message-id": "<a@example.com><b@example.com>" },
    { ...EVENT, "message-id": "a\r\n@example.com" },
    { ...EVENT, email: "a@example.com,b@example.com" },
    { ...EVENT, email: "<a@example.com>" },
    { ...EVENT, email: "a@example.com\nBcc: b@example.com" },
    { ...EVENT, ts_event: undefined, date: "2023-11-14 22:13:20", ts_epoch: NOW / 1_000 },
    { ...EVENT, ts_event: "1700000000", date: new Date(NOW).toISOString() },
    { ...EVENT, ts_event: (NOW + 601_000) / 1_000 },
    { ...EVENT, ts_event: 946684799 },
    { ...EVENT, ts_event: Number.MAX_SAFE_INTEGER },
  ]) equal(parseBrevoSuppressionEvent(bad, NOW), { status: "invalid" });

  let recorded: BrevoSuppressionEvent[] = [];
  const record = async (event: BrevoSuppressionEvent): Promise<unknown> => {
    recorded.push(event);
    return [{ delivery_status: "applied", updated_count: 1 }];
  };
  const handle = (req: Request, options: Partial<Parameters<typeof handleBrevoSuppressionWebhook>[1]> = {}) =>
    handleBrevoSuppressionWebhook(req, { secret: SECRET, record, nowMs: NOW, ...options });

  await responseIs(await handle(jsonRequest(EVENT)), 200, { received: true });
  equal(recorded, [{ messageId: "Case.ID@example.com", recipient: "reader@example.com", type: "hard_bounce", eventAt: new Date(NOW).toISOString() }]);
  recorded = [];
  await responseIs(await handle(jsonRequest({ ...EVENT, event: "soft_bounce" })), 200, { received: true });
  equal(recorded.length, 0);
  await responseIs(await handle(jsonRequest({ ...EVENT, ts_event: undefined, date: "2023-11-14" })), 400, { error: "invalid_event" });
  equal(recorded.length, 0);

  for (const [headers, options, status, body] of [
    [{ authorization: `Bearer ${SECRET}x` }, {}, 401, { error: "unauthorized" }],
    [{ authorization: "" }, {}, 401, { error: "unauthorized" }],
    [{}, { secret: undefined }, 503, { error: "webhook_not_configured" }],
    [{ "content-type": "text/plain" }, {}, 400, { error: "invalid_body" }],
    [{ "content-length": "16385" }, {}, 400, { error: "invalid_body" }],
    [{ "content-length": "nope" }, {}, 400, { error: "invalid_body" }],
    [{}, { readTimeoutMs: 0 }, 503, { error: "webhook_not_configured" }],
  ] as const) {
    const marker = bodyWithPullMarker();
    await responseIs(await handle(request(marker.body, headers), options), status, body);
    equal(marker.wasRead(), false);
  }
  await responseIs(await handle(request(null, {}, "GET")), 405, { error: "method_not_allowed" });
  equal(recorded.length, 0);

  await responseIs(await handle(request("{broken")), 400, { error: "invalid_body" });
  await responseIs(await handle(request(new Uint8Array([0xc3, 0x28]))), 400, { error: "invalid_body" });
  await responseIs(await handle(request("😀".repeat(4_097))), 400, { error: "invalid_body" });
  await responseIs(await handle(request("😀".repeat(4_097), { "content-length": "16388" })), 400, { error: "invalid_body" });
  equal(recorded.length, 0);

  const hanging = new ReadableStream<Uint8Array>({ start() { /* Never enqueue. */ } });
  await responseIs(await handle(request(hanging), { readTimeoutMs: 20 }), 503, { error: "body_read_timeout" });
  equal(recorded.length, 0);

  for (const output of [null, [], [{ delivery_status: "unknown", updated_count: 0 }],
    [{ delivery_status: "applied", updated_count: 2 }],
    [{ delivery_status: "pending_owner", updated_count: 1 }],
    [{ delivery_status: "applied", updated_count: 1 }, { delivery_status: "applied", updated_count: 1 }]]) {
    await responseIs(await handle(jsonRequest(EVENT), { record: async () => output }), 503, { error: "suppression_write_failed" });
  }
  await responseIs(await handle(jsonRequest(EVENT), { record: async () => { throw new Error("sensitive provider details"); } }), 503, { error: "suppression_write_failed" });
  for (const status of ["pending_owner", "manual_review"] as const) {
    await responseIs(await handle(jsonRequest(EVENT), { record: async () => [{ delivery_status: status, updated_count: 0 }] }), 200, { received: true, reviewRequired: true });
  }
  for (const status of ["causally_ignored", "expired_unowned"] as const) {
    await responseIs(await handle(jsonRequest(EVENT), { record: async () => [{ delivery_status: status, updated_count: 0 }] }), 200, { received: true });
  }
  console.log(`Brevo webhook offline checks passed (${checks} assertions).`);
}

await main();
