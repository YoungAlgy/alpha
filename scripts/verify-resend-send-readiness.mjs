#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkResendSendReadiness } from "./resend-send-readiness.mjs";
import { BREVO_AUTOMATIC_FAILOVER_ENABLED } from "../lib/brevo-rollout-policy.mjs";

const settings = {
  apiKey: "fixture-key", sender: '"alpha." <alpha@everyday.report>', requiredCount: 3,
};
const domains = { data: [{ name: "everyday.report", status: "verified" }] };
const usage = { object: "usage", emails: {
  daily: { used: 1, limit: 4 }, monthly: { used: 8, limit: 12 },
} };
function transport({ domain = domains, quota = usage, status = 200, throwAt = -1 } = {}) {
  const paths = [];
  return { paths, fetch: async (url, init) => {
    paths.push(url);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(paths, paths.slice(0, 2).map((_, i) =>
      `https://api.resend.com/${i === 0 ? "domains" : "usage"}`));
    if (paths.length - 1 === throwAt) throw new Error("offline timeout fixture");
    return Response.json(paths.length === 1 ? domain : quota, { status });
  } };
}
assert.equal(BREVO_AUTOMATIC_FAILOVER_ENABLED, true);
let stub = transport();
assert.deepEqual(await checkResendSendReadiness(settings, stub.fetch), { kind: "ready" });
assert.equal(stub.paths.length, 2);
// The sender comes from the daily workflow secret, not the quota probe's
// hardcoded display string. Test its supported shapes without loading secrets.
for (const sender of [
  'alpha. <alpha@everyday.report>',
  'Alpha <alpha@everyday.report>',
  '"Alpha Daily" <alpha@everyday.report>',
  'alpha@everyday.report',
  '  "alpha." <alpha@everyday.report>  ',
  'Alpha <daily.letter+news@everyday.report>',
]) {
  stub = transport();
  assert.deepEqual(await checkResendSendReadiness({ ...settings, sender }, stub.fetch),
    { kind: "ready" });
  assert.equal(stub.paths.length, 2);
}
for (const sender of [
  undefined, null, 1, '', ' ', 'bad',
  'Alpha <alpha@other.invalid>',
  'Alpha <alpha@everyday.report.other.invalid>',
  'Alpha <alpha@backup.alpha.everyday.report>',
  'Alpha <alpha@everyday.report>, Other <other@everyday.report>',
  'alpha@everyday.report;other@everyday.report',
  'Alpha <alpha@everyday.report> extra',
  'Alpha <<alpha@everyday.report>>',
  '"Alpha <alpha@everyday.report>',
  '"Alpha" extra <alpha@everyday.report>',
  'Alpha <alpha @everyday.report>',
  'Alpha <@everyday.report>',
  '.alpha@everyday.report', 'alpha.@everyday.report', 'al..pha@everyday.report',
  `${'a'.repeat(65)}@everyday.report`,
  `${'A'.repeat(321)} <alpha@everyday.report>`,
  'Alpha\r\nBcc: other@everyday.report <alpha@everyday.report>',
  '\nalpha@everyday.report', 'alpha@everyday.report\n',
  'Alpha\t<alpha@everyday.report>', 'Alpha\0 <alpha@everyday.report>',
  'Alpha\u007f <alpha@everyday.report>', 'Alpha\u2028 <alpha@everyday.report>',
]) {
  let reads = 0;
  assert.deepEqual(await checkResendSendReadiness({ ...settings, sender }, async () => {
    reads++;
    throw new Error('invalid sender must block before provider reads');
  }), { kind: "blocked", reason: "invalid_settings" });
  assert.equal(reads, 0);
}
for (const [input, expected] of [
  [{ domain: { data: [] } }, { kind: "blocked", reason: "sender_domain_unverified" }],
  [{ quota: { ...usage, emails: { ...usage.emails, daily: { used: 2, limit: 4 } } } },
    { kind: "unavailable", reason: "capacity_unavailable" }],
  [{ quota: { ...usage, emails: { ...usage.emails, daily: { used: 5, limit: 4 } } } },
    { kind: "unavailable", reason: "capacity_unavailable" }],
  [{ quota: { ...usage, emails: { ...usage.emails, daily: { used: 1, limit: null } } } },
    { kind: "blocked", reason: "usage_unverified" }],
  [{ quota: { object: "wrong" } }, { kind: "blocked", reason: "usage_unverified" }],
  [{ status: 429 }, { kind: "unavailable", reason: "provider_unavailable" }],
  [{ status: 503 }, { kind: "unavailable", reason: "provider_unavailable" }],
  [{ status: 403 }, { kind: "blocked", reason: "authentication_denied" }],
  [{ throwAt: 0 }, { kind: "unavailable", reason: "provider_unavailable" }],
]) {
  stub = transport(input);
  assert.deepEqual(await checkResendSendReadiness(settings, stub.fetch), expected);
}
assert.deepEqual(await checkResendSendReadiness(settings, async (url) =>
  url.endsWith("/domains") ? Response.json(domains) : new Response("{", { status: 200 })),
  { kind: "blocked", reason: "invalid_response" });
assert.deepEqual(await checkResendSendReadiness({ ...settings, requiredCount: 0 },
  async () => { throw new Error("must not read"); }),
  { kind: "blocked", reason: "capacity_count_unavailable" });
assert.deepEqual(await checkResendSendReadiness({ ...settings, sender: "bad" },
  async () => { throw new Error("must not read"); }),
  { kind: "blocked", reason: "invalid_settings" });
assert.deepEqual(await checkResendSendReadiness({ ...settings, apiKey: "bad\nkey" },
  async () => { throw new Error("must not read"); }),
  { kind: "blocked", reason: "invalid_settings" });
const preflight = readFileSync(new URL("./verify-send-preflight.mjs", import.meta.url), "utf8");
assert.match(preflight, /BREVO_AUTOMATIC_FAILOVER_ENABLED &&/);
assert.match(preflight, /selectedProvider = "brevo"/);
const workflow = readFileSync(new URL("../.github\/workflows\/daily-send.yml", import.meta.url), "utf8");
assert.match(workflow, /ALPHA_ACTIVE_READER_COUNT: \$\{\{ steps\.precheck\.outputs\.active_count \}\}/);
assert.match(workflow, /ALPHA_PREFLIGHT_SELECTED_PROVIDER: \$\{\{ steps\.preflight\.outputs\.selected_provider \}\}/);
console.log("PASS staged Resend read-only sender and quota checks");
