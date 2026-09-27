#!/usr/bin/env node
// Pure fixture checks. The injected transport never reaches Brevo or a network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkBrevoSendReadiness,
  validateBrevoSendSettings,
} from "./brevo-send-readiness.mjs";
import {
  BREVO_DELIVERY_SCHEMA_ENABLED,
  BREVO_SUBSCRIBER_DELIVERY_ENABLED,
} from "../lib/brevo-rollout-policy.mjs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const settings = {
  apiKey: `xkeysib-${"A".repeat(40)}`,
  sender: "alpha@backup.alpha.everyday.report",
  webhookToken: "fixture_only_webhook_token_1234567890",
  expectedAccountEmail: "owner@fixture.invalid",
};
const account = {
  companyName: "Alpha", email: settings.expectedAccountEmail, relay: { enabled: true },
  plan: [{ type: "free", creditsType: "sendLimit", credits: 300 }],
};
const senders = { senders: [{ email: settings.sender, active: true }] };
const domain = { domain: "backup.alpha.everyday.report", verified: true, authenticated: true };

assert.equal(BREVO_DELIVERY_SCHEMA_ENABLED, true);
assert.equal(BREVO_SUBSCRIBER_DELIVERY_ENABLED, false);
assert.equal(validateBrevoSendSettings(settings), null);
for (const [change, reason] of [
  [{ apiKey: "smtp-key" }, "invalid_api_key"],
  [{ sender: "alpha@example.invalid" }, "invalid_sender"],
  [{ webhookToken: "short" }, "invalid_webhook_token"],
  [{ expectedAccountEmail: "Owner@fixture.invalid" }, "invalid_account_identity"],
]) {
  assert.equal(validateBrevoSendSettings({ ...settings, ...change }), reason);
}

const expectedPaths = [
  "https://api.brevo.com/v3/account",
  "https://api.brevo.com/v3/senders?domain=backup.alpha.everyday.report",
  "https://api.brevo.com/v3/senders/domains/backup.alpha.everyday.report",
];
async function fixtureTransport(overrides = {}) {
  const calls = [];
  const bodies = [overrides.account ?? account, overrides.senders ?? senders, overrides.domain ?? domain];
  const transport = async (url, init) => {
    const index = calls.length;
    calls.push(url);
    assert.equal(url, expectedPaths[index]);
    assert.equal(init.method, "GET");
    assert.equal(init.headers["api-key"], settings.apiKey);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(bodies[index], { status: overrides.status ?? 200 });
  };
  return { calls, transport };
}

const ready = await fixtureTransport();
assert.deepEqual(await checkBrevoSendReadiness(settings, ready.transport), { ready: true });
assert.deepEqual(ready.calls, expectedPaths);
for (const [override, reason, expectedCalls] of [
  [{ account: { ...account, email: "other@fixture.invalid" } }, "account_relay_unavailable", 1],
  [{ account: { ...account, relay: { enabled: false } } }, "account_relay_unavailable", 1],
  [{ account: { ...account, plan: [{ type: "free", creditsType: "sendLimit", credits: 0 }] } }, "free_capacity_unavailable", 1],
  [{ account: { ...account, plan: [{ type: "free", creditsType: "sendLimit", credits: "300" }] } }, "free_capacity_unavailable", 1],
  [{ account: { ...account, plan: [...account.plan, { type: "payAsYouGo", creditsType: "sendLimit", credits: 5 }] } }, "free_capacity_unavailable", 1],
  [{ account: { ...account, plan: [...account.plan, { type: "subscription", creditsType: "sendLimit", credits: 5 }] } }, "free_capacity_unavailable", 1],
  [{ senders: { senders: [{ email: settings.sender, active: false }] } }, "sender_unavailable", 2],
  [{ domain: { ...domain, authenticated: false } }, "domain_unverified", 3],
  [{ status: 403 }, "account_relay_unavailable", 1],
]) {
  const fixture = await fixtureTransport(override);
  assert.deepEqual(await checkBrevoSendReadiness(settings, fixture.transport), { ready: false, reason });
  assert.equal(fixture.calls.length, expectedCalls);
}
assert.deepEqual(await checkBrevoSendReadiness(settings, async () => { throw new Error("private body"); }), {
  ready: false, reason: "readiness_unavailable",
});
assert.deepEqual(await checkBrevoSendReadiness({ ...settings, apiKey: "bad" }, async () => {
  throw new Error("must not call");
}), { ready: false, reason: "invalid_api_key" });

const policyTs = read("../lib/brevo-delivery-policy.ts");
assert.match(policyTs, /from "\.\/brevo-rollout-policy\.mjs"/);
const preflight = read("./verify-send-preflight.mjs");
assert.match(preflight, /BREVO_SUBSCRIBER_DELIVERY_ENABLED \|\| \(brevoCanarySelected && BREVO_CANARY_DELIVERY_ENABLED\)/);
assert.match(preflight, /deliveryReady && brevoSelected/);
assert.match(preflight, /deliveryReady && !brevoSelected/);
const workflow = read("../.github/workflows/daily-send.yml");
for (const mapping of [
  "ALPHA_SUBSCRIBER_EMAIL_PROVIDER: ${{ vars.SEND_ALPHA_SUBSCRIBER_EMAIL_PROVIDER }}",
  "BREVO_API_KEY: ${{ secrets.SEND_BREVO_API_KEY }}",
  "BREVO_FROM_EMAIL: ${{ secrets.SEND_BREVO_FROM_EMAIL }}",
  "BREVO_WEBHOOK_TOKEN: ${{ secrets.SEND_BREVO_WEBHOOK_TOKEN }}",
]) {
  assert.equal(workflow.split(mapping).length - 1, 2, `${mapping} must map preflight and runtime`);
}
assert.equal(workflow.split("BREVO_EXPECTED_ACCOUNT_EMAIL: ${{ secrets.SEND_BREVO_EXPECTED_ACCOUNT_EMAIL }}").length - 1, 1);

console.log("PASS Brevo send readiness: source gates, bounded read-only contract, workflow mapping");
