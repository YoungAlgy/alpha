import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  deliveryLetterUrl,
  letterUrl,
  makeLetterToken,
  verifyLetterToken,
} from "../lib/letter-token";
import { prepareLetterNotification, type PreparedSubscriberEmail } from "../lib/email";
import { prepareBrevoCandidateEmail } from "../lib/brevo-transport";
import { routeSubscriberLetter, type SubscriberDeliveryConfig } from "../lib/subscriber-email-router";
import { ResendDeliveryAttemptError } from "../lib/resend-delivery-attempt";
import { BrevoDeliveryAttemptError } from "../lib/brevo-delivery-attempt";
import type { Issue } from "../lib/types";

// Offline fixtures only. Override every environment value used by the pure
// email renderer before invoking it. Never load an environment file, inspect
// an existing credential, import a route, or invoke a real provider/database.
const fixtureSecret = "offline-delivery-letter-link-fixture-only";
process.env.UNSUBSCRIBE_SECRET = fixtureSecret;
process.env.NEXT_PUBLIC_APP_URL = "https://alpha.everyday.report";
process.env.RESEND_FROM = '"alpha." <alpha@everyday.report>';

const origin = "https://alpha.everyday.report";
const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const weekOf = "2026-10-03";
const firstClock = Date.parse("2026-10-03T14:17:00.000Z");
const retryClock = Date.parse("2026-10-03T18:47:31.000Z");
const expectedExpiry = Date.parse("2026-10-03T00:00:00.000Z") / 1000 + 90 * 86400;
const fixtureIssue: Issue = {
  id: "reader-2026-10-03",
  volume: 1,
  number: 9,
  weekOf: "Saturday, October 3, 2026",
  recipientFirstName: "Reader",
  recipientCity: "Tampa, FL",
  editorIntro: "An offline fixture note.",
  sections: [{
    topicId: "ai-news",
    topicLabel: "AI news",
    intro: "Offline fixture",
    items: [{
      kind: "read",
      headline: "An offline fixture headline",
      body: "An offline fixture summary.",
      primaryRef: { label: "Offline fixture", url: "https://example.com/offline-fixture" },
    }],
  }],
};
const config: SubscriberDeliveryConfig = {
  lettersEnabled: true,
  schemaEnabled: true,
  brevoEnabled: true,
  preferredProvider: "resend",
  resendReady: true,
  brevoApiKey: "offline-brevo-fixture-marker",
  brevoSender: "alpha@backup.alpha.everyday.report",
  brevoWebhookReady: true,
};

let clock = firstClock;
let checks = 0;
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
Date.now = () => clock;
globalThis.fetch = async () => {
  throw new Error("This offline verifier forbids network access.");
};

async function check(label: string, run: () => unknown | Promise<unknown>) {
  await run();
  checks++;
  console.log(`PASS ${label}`);
}

function tokenFromUrl(url: string): string {
  const token = new URL(url).searchParams.get("t");
  assert.ok(token);
  return token;
}

function prepare(clockAt: number, overrides: {
  firstName?: string;
  issue?: Issue;
  url?: string;
} = {}): PreparedSubscriberEmail {
  clock = clockAt;
  return prepareLetterNotification({
    to: "reader@example.com",
    firstName: overrides.firstName ?? "Reader",
    issue: overrides.issue ?? fixtureIssue,
    inboxUrl: `${origin}/inbox`,
    letterUrl: overrides.url ?? deliveryLetterUrl(userId, origin, weekOf),
    issueNumber: 9,
    userId,
    idempotencyKind: "live",
    deliveryDate: weekOf,
  });
}

function routeParams(prepared: PreparedSubscriberEmail) {
  return {
    userId,
    weekOf,
    deliveryLane: "live",
    expectedClaimedAt: new Date(clock).toISOString(),
    prepared,
  };
}

// Model only the database result boundary, using an immutable pending
// fingerprint. The real router and coordinator must honor its conflict.
// This does not claim to execute or verify the installed SQL.
function resendHarness(storedFingerprint: string, forcedStatus?: string) {
  const calls: string[] = [];
  let dispatches = 0;
  let finalized = false;
  const sb = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push(name);
      if (name === "resolve_subscriber_delivery_provider") {
        return { data: "resend", error: null };
      }
      if (name === "claim_resend_delivery_attempt") {
        const status = forcedStatus ?? (args.p_request_fingerprint === storedFingerprint
          ? "replayed" : "payload_changed");
        return { data: [{
          delivery_status: status,
          stored_recipient: "reader@example.com",
          stored_message_id: null,
          stored_accepted_at: null,
          stored_lease_expires_at: new Date(clock + 5 * 60_000).toISOString(),
          stored_retry_deadline_at: new Date(firstClock + 23 * 60 * 60_000).toISOString(),
        }], error: null };
      }
      if (name === "finalize_resend_delivery_attempt") {
        assert.equal(args.p_request_fingerprint, storedFingerprint);
        finalized = true;
        return { data: [{
          delivery_status: "recorded",
          stored_accepted_at: new Date(clock).toISOString(),
          suppression_review_required: false,
        }], error: null };
      }
      throw new Error("Unexpected offline RPC call.");
    },
  };
  return {
    calls,
    storedFingerprint,
    dispatches: () => dispatches,
    finalized: () => finalized,
    deliver: (prepared: PreparedSubscriberEmail) => routeSubscriberLetter({
      ...routeParams(prepared), sb: sb as never,
    }, {
      config,
      sendResend: async (sent) => {
        assert.equal(sent.requestFingerprint, storedFingerprint);
        dispatches++;
        return { id: "offline-resend-acceptance-proof" };
      },
      brevoTransport: async () => { throw new Error("Unexpected provider switch."); },
    }),
  };
}

try {
  const firstPrepared = prepare(firstClock);
  const retryPrepared = prepare(retryClock);
  const firstUrl = deliveryLetterUrl(userId, origin, weekOf);
  const token = tokenFromUrl(firstUrl);

  await check("previous clock-minted links change the real email fingerprint", () => {
    clock = firstClock;
    const initialUrl = letterUrl(userId, origin, weekOf);
    const initial = prepare(firstClock, { url: initialUrl });
    clock = retryClock;
    const laterUrl = letterUrl(userId, origin, weekOf);
    const later = prepare(retryClock, { url: laterUrl });
    assert.notEqual(initialUrl, laterUrl);
    assert.notEqual(initial.requestFingerprint, later.requestFingerprint);
    assert.equal(initial.idempotencyKey, later.idempotencyKey);
  });

  await check("production preparation is identical across later-slot clocks", () => {
    clock = firstClock;
    assert.equal(deliveryLetterUrl(userId, `${origin}/`, weekOf), firstUrl);
    clock = retryClock;
    assert.equal(deliveryLetterUrl(userId, origin, weekOf), firstUrl);
    assert.equal(firstPrepared.payload.html, retryPrepared.payload.html);
    assert.equal(firstPrepared.payload.text, retryPrepared.payload.text);
    assert.equal(firstPrepared.idempotencyKey, retryPrepared.idempotencyKey);
    assert.equal(firstPrepared.requestFingerprint, retryPrepared.requestFingerprint);
    assert.deepEqual(firstPrepared.payload, retryPrepared.payload);
    assert.ok(firstPrepared.payload.html.includes(firstUrl));
    assert.ok(firstPrepared.payload.text.includes(firstUrl));
    assert.equal(firstPrepared.payload.headers["X-Alpha-Issue-Id"], `${userId}:${weekOf}`);
  });

  await check("fixed UTC issue expiry keeps existing verifier semantics", () => {
    const parts = token.split(".");
    assert.equal(parts.length, 4);
    assert.equal(Number(parts[2]), expectedExpiry);
    clock = firstClock;
    assert.deepEqual(verifyLetterToken(token), { userId, weekOf });
    clock = expectedExpiry * 1000 - 1000;
    assert.deepEqual(verifyLetterToken(token), { userId, weekOf });
    clock = expectedExpiry * 1000;
    assert.deepEqual(verifyLetterToken(token), { userId, weekOf });
    clock += 1000;
    assert.equal(verifyLetterToken(token), null);
  });

  await check("issue and user isolation plus token tampering remain enforced", () => {
    clock = firstClock;
    const [user, issueDate, expiry, signature] = token.split(".");
    assert.notEqual(deliveryLetterUrl(userId, origin, "2026-10-04"), firstUrl);
    assert.notEqual(deliveryLetterUrl(otherUserId, origin, weekOf), firstUrl);
    for (const tampered of [
      `${otherUserId}.${issueDate}.${expiry}.${signature}`,
      `${user}.2026-10-04.${expiry}.${signature}`,
      `${user}.${issueDate}.${Number(expiry) + 1}.${signature}`,
      `${user}.${issueDate}.${expiry}.AAAAAAAAAAAAAAAA`,
    ]) assert.equal(verifyLetterToken(tampered), null);
    const leap = tokenFromUrl(deliveryLetterUrl(userId, origin, "2028-02-29"));
    assert.equal(Number(leap.split(".")[2]), Date.parse("2028-02-29T00:00:00Z") / 1000 + 90 * 86400);
  });

  await check("malformed calendar dates cannot become delivery identities", () => {
    for (const invalid of ["", "2026-2-03", "2026-02-29", "2026-04-31", "2026-13-01",
      "2026-00-01", "2026-10-00", "2026-10-03T00:00:00Z", " 2026-10-03", "2026-10-03 "])
      assert.throws(() => deliveryLetterUrl(userId, origin, invalid));
  });

  await check("generic v2 minting and already-sent legacy v1 links still work", () => {
    clock = firstClock;
    const generic = makeLetterToken(userId, weekOf);
    const genericUrl = letterUrl(userId, origin, weekOf);
    const expiry = Math.floor(firstClock / 1000) + 90 * 86400;
    assert.equal(Number(generic.split(".")[2]), expiry);
    assert.deepEqual(verifyLetterToken(generic), { userId, weekOf });
    assert.equal(tokenFromUrl(genericUrl), generic);
    const signature = createHmac("sha256", fixtureSecret)
      .update(`letter:${userId}.${expiry}`).digest("base64url").slice(0, 16);
    const legacy = `${userId}.${expiry}.${signature}`;
    assert.deepEqual(verifyLetterToken(legacy), { userId, weekOf: null });
    clock = retryClock;
    assert.notEqual(makeLetterToken(userId, weekOf), generic);
    assert.deepEqual(verifyLetterToken(generic), { userId, weekOf });
    assert.deepEqual(verifyLetterToken(legacy), { userId, weekOf: null });
    clock = expiry * 1000 + 1000;
    assert.equal(verifyLetterToken(legacy), null);
  });

  await check("same pending Resend fingerprint reaches the injected dispatch and finalizer", async () => {
    clock = retryClock;
    const harness = resendHarness(firstPrepared.requestFingerprint);
    const result = await harness.deliver(retryPrepared);
    assert.equal(result.provider, "resend");
    assert.equal(result.providerSent, true);
    assert.equal(harness.dispatches(), 1);
    assert.equal(harness.finalized(), true);
    assert.equal(harness.storedFingerprint, firstPrepared.requestFingerprint);
  });

  clock = firstClock;
  const oldPrepared = prepare(firstClock, { url: letterUrl(userId, origin, weekOf) });
  for (const [label, stored, incoming] of [
    ["old clock-dependent pending token", oldPrepared, retryPrepared],
    ["changed reader name", firstPrepared, prepare(retryClock, { firstName: "Changed" })],
    ["changed issue content", firstPrepared, prepare(retryClock, {
      issue: { ...fixtureIssue, editorIntro: "Changed offline fixture note." },
    })],
  ] as const) {
    await check(`${label} still fails the immutable fingerprint claim`, async () => {
      clock = retryClock;
      assert.notEqual(stored.requestFingerprint, incoming.requestFingerprint);
      const harness = resendHarness(stored.requestFingerprint);
      await assert.rejects(() => harness.deliver(incoming), (error: unknown) =>
        error instanceof ResendDeliveryAttemptError && error.stage === "claim" && error.code === "payload_changed");
      assert.equal(harness.dispatches(), 0);
      assert.equal(harness.finalized(), false);
      assert.equal(harness.storedFingerprint, stored.requestFingerprint);
      assert.deepEqual(harness.calls, ["resolve_subscriber_delivery_provider", "claim_resend_delivery_attempt"]);
    });
  }

  for (const status of ["busy", "other_lane_pending", "recipient_changed", "ambiguous_expired"]) {
    await check(`${status} claim cannot be bypassed by a stable CTA`, async () => {
      clock = retryClock;
      const harness = resendHarness(firstPrepared.requestFingerprint, status);
      await assert.rejects(() => harness.deliver(retryPrepared), (error: unknown) =>
        error instanceof ResendDeliveryAttemptError && error.stage === "claim" && error.code === status);
      assert.equal(harness.dispatches(), 0);
      assert.equal(harness.finalized(), false);
      assert.equal(harness.storedFingerprint, firstPrepared.requestFingerprint);
    });
  }

  await check("Brevo preparation preserves the CTA for the same attempt identity", () => {
    const attemptId = "33333333-3333-4333-8333-333333333333";
    const draft = (prepared: PreparedSubscriberEmail, id = attemptId) => prepareBrevoCandidateEmail({
      attemptId: id,
      sender: { email: config.brevoSender, name: "alpha." },
      recipient: prepared.recipient,
      replyTo: prepared.payload.replyTo,
      subject: prepared.payload.subject,
      html: prepared.payload.html,
      text: prepared.payload.text,
      issueHeader: prepared.payload.headers["X-Alpha-Issue-Id"],
    });
    const first = draft(firstPrepared);
    const retry = draft(retryPrepared);
    const differentAttempt = draft(retryPrepared, "44444444-4444-4444-8444-444444444444");
    assert.equal(first.status, "prepared");
    assert.equal(retry.status, "prepared");
    assert.equal(differentAttempt.status, "prepared");
    if (first.status !== "prepared" || retry.status !== "prepared" || differentAttempt.status !== "prepared")
      throw new Error("Unexpected offline Brevo preparation failure.");
    assert.equal(first.prepared.serializedBody, retry.prepared.serializedBody);
    assert.equal(first.prepared.requestFingerprint, retry.prepared.requestFingerprint);
    assert.notEqual(first.prepared.requestFingerprint, differentAttempt.prepared.requestFingerprint);
  });

  await check("real Brevo router keeps an unconfirmed attempt blocked on the next clock", async () => {
    let dispatches = 0;
    let stored: Record<string, unknown> | null = null;
    let dispatchedBody: Record<string, unknown> | null = null;
    const calls: string[] = [];
    const sb = {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push(name);
        if (name === "resolve_subscriber_delivery_provider") return { data: stored ? "brevo" : "none", error: null };
        if (name === "claim_brevo_delivery_attempt") {
          if (!stored) stored = { ...args };
          return { data: [{
            delivery_status: dispatches === 0 ? "claimed" : "manual_review",
            stored_recipient: "reader@example.com",
            stored_attempt_id: stored.p_attempt_id,
            stored_message_id: null,
            stored_accepted_at: null,
            stored_lease_expires_at: new Date(clock + 5 * 60_000).toISOString(),
          }], error: null };
        }
        if (name === "mark_brevo_delivery_unconfirmed") return { data: "marked", error: null };
        throw new Error("Unconfirmed Brevo fixture must never finalize.");
      },
    };
    const deliver = (prepared: PreparedSubscriberEmail) => routeSubscriberLetter({
      ...routeParams(prepared), sb: sb as never,
    }, {
      config: { ...config, preferredProvider: "brevo" },
      sendResend: async () => { throw new Error("Unconfirmed Brevo must never switch provider."); },
      brevoTransport: async (_url, init) => {
        dispatches++;
        dispatchedBody = JSON.parse(String(init.body));
        return new Response(null, { status: 500 });
      },
    });
    clock = firstClock;
    await assert.rejects(() => deliver(firstPrepared), (error: unknown) =>
      error instanceof BrevoDeliveryAttemptError && error.stage === "send" && error.code === "unconfirmed");
    const firstAttempt = stored as Record<string, unknown> | null;
    const firstBody = dispatchedBody as Record<string, unknown> | null;
    assert.ok(firstAttempt);
    assert.ok(firstBody);
    assert.equal(firstBody.htmlContent, firstPrepared.payload.html);
    assert.equal(firstBody.textContent, firstPrepared.payload.text);
    const originalAttempt = { ...firstAttempt };
    clock = retryClock;
    await assert.rejects(() => deliver(retryPrepared), (error: unknown) =>
      error instanceof BrevoDeliveryAttemptError && error.stage === "claim" && error.code === "not_claimed");
    assert.equal(dispatches, 1);
    assert.deepEqual(stored, originalAttempt);
    assert.deepEqual(calls, [
      "resolve_subscriber_delivery_provider", "claim_brevo_delivery_attempt", "mark_brevo_delivery_unconfirmed",
      "resolve_subscriber_delivery_provider", "claim_brevo_delivery_attempt",
    ]);
  });

  await check("both production delivery routes use the stable link helper", () => {
    for (const path of ["../app/api/cron/weekly-send/route.ts", "../app/api/generate/route.ts"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.match(source, /import\s*\{\s*deliveryLetterUrl\s+as\s+buildLetterUrl\s*\}\s*from\s*["']@\/lib\/letter-token["']/);
      assert.ok(source.includes("letterUrl: buildLetterUrl("));
      assert.ok(source.includes("sendPreparedSubscriberLetter({"));
    }
  });
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
}

console.log(`PASS verify-delivery-letter-link-stability (offline, ${checks} scenarios)`);
