#!/usr/bin/env node
// Run the actual preflight body with offline dependencies and captured outputs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { readBoundedJson } from "./alpha-preflight-response.mjs";
import { validateSendScope } from "./run-brevo-canary.mjs";

let source = readFileSync(new URL("./verify-send-preflight.mjs", import.meta.url), "utf8");
source = source.replace(/^#![^\r\n]*\r?\n/, "");
source = source.replace(/^import[\s\S]*?from "[^"]+";\r?$/gm, "");
const outputStart = source.indexOf("async function setWorkflowOutput(");
const outputEnd = source.indexOf("\nfor (const name of SEND_BASE_REQUIRED)", outputStart);
assert.ok(outputStart >= 0 && outputEnd > outputStart);
source = source.slice(0, outputStart) +
  "async function setWorkflowOutput(name, value) { outputs[name] = value; }\n" +
  source.slice(outputEnd);

const env = {
  CRON_SECRET: "fixture", NEXT_PUBLIC_SUPABASE_URL: "https://xpqxhdciaoicsnyyfshy.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fixture", SUPABASE_SECRET_KEY: "fixture",
  RESEND_API_KEY: "fixture", RESEND_FROM: '"alpha." <alpha@everyday.report>',
  BREVO_API_KEY: "fixture", BREVO_FROM_EMAIL: "alpha@backup.alpha.everyday.report",
  BREVO_WEBHOOK_TOKEN: "A".repeat(40), BREVO_EXPECTED_ACCOUNT_EMAIL: "owner@fixture.invalid",
  UNSUBSCRIBE_SECRET: "A".repeat(32), ALPHA_NO_MODEL_MODE: "1", ALPHA_ALLOW_PAID_AI: "0",
  ALPHA_SUBSCRIBER_EMAIL_PROVIDER: "resend", ALPHA_SEND_OPERATION: "daily",
  ALPHA_ACTIVE_READER_COUNT: "3", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "schedule",
};
async function run({ auto = false, general = false, changes = {}, resend = { kind: "ready" },
  brevo = { ready: true } } = {}) {
  const outputs = {};
  const calls = { resend: 0, brevo: 0, oldDomains: 0 };
  const logs = [];
  const context = {
    outputs, Response, AbortSignal,
    process: { env: { ...env, ...changes }, exit: (code) => { throw new Error(`exit:${code}`); } },
    console: { log: (x) => logs.push(x), warn: (x) => logs.push(x), error: (x) => logs.push(x) },
    BREVO_AUTOMATIC_FAILOVER_ENABLED: auto,
    BREVO_SUBSCRIBER_DELIVERY_ENABLED: general,
    BREVO_DELIVERY_SCHEMA_ENABLED: true,
    BREVO_CANARY_DELIVERY_ENABLED: true,
    isExactAlphaSupabaseUrl: () => true,
    readBoundedJson,
    checkResendSendReadiness: async (settings) => {
      calls.resend++;
      if (!Number.isSafeInteger(settings.requiredCount) || settings.requiredCount < 1) {
        return { kind: "blocked", reason: "capacity_count_unavailable" };
      }
      assert.equal(settings.requiredCount, 3);
      return resend;
    },
    checkBrevoSendReadiness: async (_settings, _fetch, count) => {
      calls.brevo++;
      assert.equal(count, changes.ALPHA_SUBSCRIBER_EMAIL_PROVIDER === "brevo" ? 1 : 3);
      return brevo;
    },
    validateSendScope,
    fetch: async (url) => {
      assert.equal(url, "https://api.resend.com/domains");
      calls.oldDomains++;
      return Response.json({ data: [{ name: "everyday.report", status: "verified" }] });
    },
  };
  try {
    await vm.runInNewContext(`(async () => { ${source} })()`, context);
    return { outputs, calls, logs, exit: null };
  } catch (error) {
    if (error?.message !== "exit:1") throw error;
    return { outputs, calls, logs, exit: 1 };
  }
}

let result = await run();
assert.equal(result.outputs.selected_provider, "resend");
assert.equal(result.outputs.delivery_ready, "true");
assert.deepEqual(result.calls, { resend: 0, brevo: 0, oldDomains: 1 });
result = await run({ auto: true, general: true });
assert.equal(result.outputs.selected_provider, "resend");
assert.deepEqual(result.calls, { resend: 1, brevo: 0, oldDomains: 0 });
result = await run({ auto: true, general: false });
assert.equal(result.outputs.selected_provider, "resend");
assert.deepEqual(result.calls, { resend: 0, brevo: 0, oldDomains: 1 });
result = await run({ auto: true, general: true, resend: { kind: "unavailable", reason: "provider_unavailable" } });
assert.equal(result.outputs.selected_provider, "brevo");
assert.deepEqual(result.calls, { resend: 1, brevo: 1, oldDomains: 0 });
result = await run({ auto: true, general: true, resend: { kind: "blocked", reason: "invalid_response" } });
assert.equal(result.exit, 1);
assert.equal(result.outputs.selected_provider, undefined);
assert.equal(result.calls.brevo, 0);
result = await run({ auto: true, general: true, resend: { kind: "unavailable", reason: "provider_unavailable" },
  brevo: { ready: false, reason: "free_capacity_unavailable" } });
assert.equal(result.exit, 1);
assert.equal(result.outputs.selected_provider, undefined);
result = await run({ auto: true, general: true, changes: { GITHUB_EVENT_NAME: "workflow_dispatch", ALPHA_ACTIVE_READER_COUNT: "" } });
assert.equal(result.outputs.selected_provider, "resend");
assert.deepEqual(result.calls, { resend: 0, brevo: 0, oldDomains: 1 });
result = await run({ auto: true, general: true, changes: { ALPHA_ACTIVE_READER_COUNT: "" } });
assert.equal(result.exit, 1);
assert.equal(result.outputs.selected_provider, undefined);
assert.deepEqual(result.calls, { resend: 1, brevo: 0, oldDomains: 0 });
result = await run({ changes: {
  ALPHA_SUBSCRIBER_EMAIL_PROVIDER: "brevo", ALPHA_SEND_OPERATION: "brevo_canary",
  GITHUB_EVENT_NAME: "workflow_dispatch", ALPHA_CANARY_USER_ID: "11111111-1111-4111-8111-111111111111",
} });
assert.equal(result.outputs.selected_provider, "brevo");
assert.deepEqual(result.calls, { resend: 0, brevo: 1, oldDomains: 0 });
result = await run({ changes: { RESEND_API_KEY: "" } });
assert.equal(result.exit, 1);
assert.equal(result.outputs.selected_provider, undefined);
assert.deepEqual(result.calls, { resend: 0, brevo: 0, oldDomains: 0 });
console.log("PASS full preflight sender selection and output routing fixtures");
