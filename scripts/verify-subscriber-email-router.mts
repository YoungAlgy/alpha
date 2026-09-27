import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  brevoDeliveryConfigured, routeSubscriberLetter, subscriberDeliveryConfigured,
  type SubscriberDeliveryConfig,
} from "../lib/subscriber-email-router";
import type { PreparedSubscriberEmail } from "../lib/email";

const USER = "11111111-1111-4111-8111-111111111111";
const WEEK = "2026-09-26";
const CLAIMED = "2026-09-26T14:17:00.000Z";
const LANE = "live";
const UNSUB = "https://alpha.everyday.report/api/unsubscribe?token=fixture-token";
const FUTURE = () => new Date(Date.now() + 5 * 60_000).toISOString();
const ACCEPTED = "2026-09-26T14:18:00.000Z";
let checks = 0;
function same(actual: unknown, expected: unknown): void { assert.deepEqual(actual, expected); checks++; }
async function rejects(work: Promise<unknown>, match: RegExp): Promise<void> {
  await assert.rejects(work, match); checks++;
}

function prepared(lane = LANE, withUnsub = true): PreparedSubscriberEmail {
  const payload = {
    from: '"alpha." <alpha@everyday.report>', to: "reader@example.com",
    replyTo: "alpha@everyday.report", subject: "Local fixture",
    html: withUnsub ? `<p>Local fixture <a href="${UNSUB}">unsubscribe</a></p>` : "<p>Local fixture</p>",
    text: withUnsub ? `Local fixture ${UNSUB}` : "Local fixture",
    headers: {
      "X-Alpha-Issue-Id": `${USER}:${WEEK}`,
      ...(withUnsub ? { "List-Unsubscribe": `<${UNSUB}>` } : {}),
    },
  };
  const idempotencyKey = `alpha-letter-${USER}-${WEEK}-${lane}`;
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify({ payload, idempotencyKey })).digest("hex");
  return { recipient: payload.to, requestFingerprint, idempotencyKey, payload };
}

const base: SubscriberDeliveryConfig = {
  lettersEnabled: true, schemaEnabled: true, brevoEnabled: true,
  preferredProvider: "brevo", resendReady: true,
  brevoApiKey: "fixture-only-key", brevoSender: "alpha@backup.alpha.everyday.report",
  brevoWebhookReady: true,
};
function params(email = prepared(), lane = LANE) {
  return { userId: USER, weekOf: WEEK, deliveryLane: lane,
    expectedClaimedAt: CLAIMED, prepared: email };
}
function fakeRpc(existing: "none" | "resend" | "brevo", claim = "claimed") {
  const calls: string[] = [];
  const sb = { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === "resolve_subscriber_delivery_provider") return { data: existing, error: null };
    if (name === "claim_resend_delivery_attempt") return { data: [{
      delivery_status: claim, stored_recipient: args.p_recipient,
      stored_lease_expires_at: FUTURE(),
      stored_retry_deadline_at: new Date(Date.now() + 23 * 60 * 60_000).toISOString(),
    }], error: null };
    if (name === "finalize_resend_delivery_attempt") return { data: [{
      delivery_status: "recorded", stored_accepted_at: ACCEPTED,
      suppression_review_required: false,
    }], error: null };
    if (name === "claim_brevo_delivery_attempt") return { data: [{
      delivery_status: claim, stored_recipient: args.p_recipient,
      stored_attempt_id: args.p_attempt_id, stored_lease_expires_at: FUTURE(),
    }], error: null };
    if (name === "finalize_brevo_delivery_attempt") return { data: [{
      delivery_status: "recorded", stored_accepted_at: ACCEPTED,
      suppression_review_required: false,
    }], error: null };
    if (name === "mark_brevo_delivery_unconfirmed") return { data: [{ delivery_status: "manual_review" }], error: null };
    throw new Error(`unexpected fixture RPC: ${name}`);
  } };
  return { sb, calls };
}

same(subscriberDeliveryConfigured({ ...base, schemaEnabled: false, brevoEnabled: false,
  brevoWebhookReady: false, preferredProvider: "brevo" }), true);
same(subscriberDeliveryConfigured({ ...base, schemaEnabled: false, resendReady: false }), false);
same(subscriberDeliveryConfigured({ ...base, lettersEnabled: false }), false);
same(brevoDeliveryConfigured({ ...base, brevoSender: "alpha@example.com" }), false);

{
  const db = fakeRpc("none"); let resend = 0; let brevo = 0;
  const result = await routeSubscriberLetter({ ...params(), sb: db.sb as never }, {
    config: { ...base, schemaEnabled: false, brevoEnabled: false, preferredProvider: "brevo" },
    sendResend: async () => { resend++; return { id: "re_fixture" }; },
    brevoTransport: async () => { brevo++; return Response.json({ messageId: "unused" }, { status: 201 }); },
  });
  same(result.provider, "resend"); same(resend, 1); same(brevo, 0);
  same(db.calls, ["claim_resend_delivery_attempt", "finalize_resend_delivery_attempt"]);
}

{
  const db = fakeRpc("none"); let resend = 0;
  await routeSubscriberLetter({ ...params(prepared("live", false)), sb: db.sb as never }, {
    config: { ...base, schemaEnabled: false, preferredProvider: "resend" },
    sendResend: async () => { resend++; return { id: "re_fixture" }; },
    brevoTransport: async () => { throw new Error("unexpected Brevo send"); },
  });
  same(resend, 1);
  same(db.calls, ["claim_resend_delivery_attempt", "finalize_resend_delivery_attempt"]);
}

{
  const db = fakeRpc("resend"); let resend = 0; let brevo = 0;
  const result = await routeSubscriberLetter({ ...params(), sb: db.sb as never }, {
    config: base, sendResend: async () => { resend++; return { id: "re_fixture" }; },
    brevoTransport: async () => { brevo++; return Response.json({ messageId: "unused" }, { status: 201 }); },
  });
  same(result.provider, "resend"); same(resend, 1); same(brevo, 0);
  same(db.calls[0], "resolve_subscriber_delivery_provider");
}

{
  const db = fakeRpc("resend"); let resend = 0; let brevo = 0;
  await rejects(routeSubscriberLetter({ ...params(), requireProvider: "brevo", sb: db.sb as never }, {
    config: base,
    sendResend: async () => { resend++; return { id: "unused" }; },
    brevoTransport: async () => { brevo++; return Response.json({ messageId: "unused" }, { status: 201 }); },
  }), /differs from the required canary provider/);
  same(db.calls, ["resolve_subscriber_delivery_provider"]);
  same(resend, 0); same(brevo, 0);
}

// While the provider lookup is pending, the caller may mutate its original
// config and prepared payload. The send must use the validated frozen copy.
{
  const original = prepared();
  const config = { ...base, preferredProvider: "resend" };
  let release!: (value: { data: string; error: null }) => void;
  let observed: PreparedSubscriberEmail | null = null;
  const db = { rpc: (name: string, args: Record<string, unknown>) => {
    if (name === "resolve_subscriber_delivery_provider") {
      return new Promise<{ data: string; error: null }>((resolve) => { release = resolve; });
    }
    if (name === "claim_resend_delivery_attempt") return Promise.resolve({ data: [{
      delivery_status: "claimed", stored_recipient: args.p_recipient,
      stored_lease_expires_at: FUTURE(),
      stored_retry_deadline_at: new Date(Date.now() + 23 * 60 * 60_000).toISOString(),
    }], error: null });
    if (name === "finalize_resend_delivery_attempt") return Promise.resolve({ data: [{
      delivery_status: "recorded", stored_accepted_at: ACCEPTED,
      suppression_review_required: false,
    }], error: null });
    throw new Error(`unexpected fixture RPC: ${name}`);
  } };
  const work = routeSubscriberLetter({ ...params(original), sb: db as never }, {
    config, sendResend: async (value) => { observed = value; return { id: "unused" }; },
    brevoTransport: async () => { throw new Error("unexpected Brevo send"); },
  });
  original.payload.subject = "MUTATED";
  config.preferredProvider = "brevo";
  release({ data: "resend", error: null });
  const result = await work;
  same(result.provider, "resend");
  same(observed?.payload.subject, "Local fixture");
  same(observed?.payload.to, "reader@example.com");
}

for (const failure of [
  { data: null, error: { message: "private" } },
  { data: "unexpected", error: null },
]) {
  let resend = 0; let brevo = 0;
  const db = { rpc: async () => failure };
  await rejects(routeSubscriberLetter({ ...params(), sb: db as never }, {
    config: base, sendResend: async () => { resend++; return { id: "unused" }; },
    brevoTransport: async () => { brevo++; return Response.json({ messageId: "unused" }); },
  }), /provider could not be verified/);
  same(resend, 0); same(brevo, 0);
}

for (const [name, config, email, lane] of [
  ["disabled", { ...base, brevoEnabled: false }, prepared(), "live"],
  ["no token", { ...base, brevoApiKey: "" }, prepared(), "live"],
  ["wrong sender", { ...base, brevoSender: "alpha@example.com" }, prepared(), "live"],
  ["no webhook", { ...base, brevoWebhookReady: false }, prepared(), "live"],
  ["force lane", base, prepared("force-fixture"), "force-fixture"],
  ["missing unsub", base, prepared("live", false), "live"],
] as const) {
  const db = fakeRpc("none"); let resend = 0; let brevo = 0;
  await rejects(routeSubscriberLetter({ ...params(email, lane), sb: db.sb as never }, {
    config, sendResend: async () => { resend++; return { id: "unused" }; },
    brevoTransport: async () => { brevo++; return Response.json({ messageId: "unused" }); },
  }), /Brevo is not enabled|requires Alpha's unsubscribe/);
  same(resend, 0); same(brevo, 0);
  same(db.calls, name === "missing unsub" ? [] : ["resolve_subscriber_delivery_provider"]);
  same(typeof name, "string");
}

{
  const db = fakeRpc("resend"); let resend = 0; let brevo = 0;
  await rejects(routeSubscriberLetter({ ...params(prepared("live", false)), sb: db.sb as never }, {
    config: base,
    sendResend: async () => { resend++; return { id: "unused" }; },
    brevoTransport: async () => { brevo++; return Response.json({ messageId: "unused" }); },
  }), /requires Alpha's unsubscribe/);
  same(db.calls, []); same(resend, 0); same(brevo, 0);
}

{
  const db = fakeRpc("none"); let resend = 0; let brevo = 0;
  await rejects(routeSubscriberLetter({ ...params(), sb: db.sb as never }, {
    config: base, sendResend: async () => { resend++; return { id: "unused" }; },
    brevoTransport: async () => { brevo++; return new Response("failed", { status: 503 }); },
  }), /Brevo delivery attempt send failed: unconfirmed/);
  same(resend, 0); same(brevo, 1);
  same(db.calls, ["resolve_subscriber_delivery_provider", "claim_brevo_delivery_attempt", "mark_brevo_delivery_unconfirmed"]);
  const retry = fakeRpc("brevo", "manual_review");
  await rejects(routeSubscriberLetter({ ...params(), sb: retry.sb as never }, {
    config: { ...base, preferredProvider: "resend" },
    sendResend: async () => { resend++; return { id: "unused" }; },
    brevoTransport: async () => { brevo++; return Response.json({ messageId: "unused" }); },
  }), /Brevo delivery attempt claim failed: not_claimed/);
  same(resend, 0); same(brevo, 1);
}

{
  const db = fakeRpc("none"); let resend = 0; let brevo = 0;
  const result = await routeSubscriberLetter({ ...params(), sb: db.sb as never }, {
    config: base, sendResend: async () => { resend++; return { id: "unused" }; },
    brevoTransport: async (_url, init) => {
      brevo++;
      same(init.method, "POST");
      return Response.json({ messageId: "<fixture-brevo@example.com>" }, { status: 201 });
    },
  });
  same(result.provider, "brevo"); same(result.providerSent, true);
  same(result.messageId, "fixture-brevo@example.com");
  same(resend, 0); same(brevo, 1);
  same(db.calls, ["resolve_subscriber_delivery_provider", "claim_brevo_delivery_attempt", "finalize_brevo_delivery_attempt"]);
}

console.log(`Subscriber email router offline checks passed (${checks} assertions).`);
