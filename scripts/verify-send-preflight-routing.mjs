#!/usr/bin/env node
// Run the actual preflight body with offline dependencies and captured outputs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { readBoundedJson } from "./alpha-preflight-response.mjs";
import { validateSendScope } from "./run-brevo-canary.mjs";
import { checkResendSendReadiness as actualResendReadiness } from "./resend-send-readiness.mjs";

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
  brevo = { ready: true }, realResend = false, remaining = 3 } = {}) {
  const outputs = {};
  const calls = { resend: 0, brevo: 0, oldDomains: 0 };
  const logs = [];
  const readinessReads = [];
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
      if (realResend) {
        assert.equal(settings.sender, changes.RESEND_FROM ?? env.RESEND_FROM);
        return actualResendReadiness(settings, async (url, init) => {
          assert.equal(init.method, "GET");
          readinessReads.push(url);
          assert.equal(url, `https://api.resend.com/${readinessReads.length === 1 ? 'domains' : 'usage'}`);
          assert.ok(readinessReads.length <= 2);
          return Response.json(readinessReads.length === 1
            ? { data: [{ name: "everyday.report", status: "verified" }] }
            : { object: "usage", emails: {
              daily: { used: 0, limit: remaining }, monthly: { used: 0, limit: remaining },
            } });
        });
      }
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
    return { outputs, calls, logs, readinessReads, exit: null };
  } catch (error) {
    if (error?.message !== "exit:1") throw error;
    return { outputs, calls, logs, readinessReads, exit: 1 };
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
// Exercise the real validator through the scheduled body, rather than only a
// hardcoded sender or a mocked readiness result. All provider reads stay local.
result = await run({ auto: true, general: true, realResend: true,
  changes: { RESEND_FROM: '  Alpha <daily@everyday.report>  ' } });
assert.equal(result.exit, null);
assert.equal(result.outputs.selected_provider, "resend");
assert.equal(result.outputs.delivery_ready, "true");
assert.deepEqual(result.calls, { resend: 1, brevo: 0, oldDomains: 0 });
assert.equal(result.readinessReads.length, 2);
assert.equal(result.logs.some((line) => line.includes('daily@')), false);
result = await run({ auto: true, general: true, realResend: true, remaining: 2,
  changes: { RESEND_FROM: 'Alpha <daily@everyday.report>' } });
assert.equal(result.outputs.selected_provider, "brevo");
assert.deepEqual(result.calls, { resend: 1, brevo: 1, oldDomains: 0 });
assert.equal(result.readinessReads.length, 2);
for (const sender of ['Alpha <daily@other.invalid>', 'Alpha\r\n <daily@everyday.report>']) {
  result = await run({ auto: true, general: true, realResend: true,
    changes: { RESEND_FROM: sender } });
  assert.equal(result.exit, 1);
  assert.equal(result.outputs.selected_provider, undefined);
  assert.deepEqual(result.calls, { resend: 1, brevo: 0, oldDomains: 0 });
  assert.equal(result.readinessReads.length, 0);
  assert.equal(result.logs.some((line) => line.includes(sender)), false);
}
result = await run({ changes: {
  ALPHA_NO_KEY_SOURCES: "1", ALPHA_PUBLIC_FEED_FALLBACK: "0", ALPHA_GDELT_FALLBACK: "1",
  BRAVE_SEARCH_API_KEY: "offline-brave", YOU_API_KEY: "offline-you", GEMINI_API_KEY: "offline-gemini",
} });
assert.equal(result.exit, null);
assert.equal(result.outputs.fresh_source_ready, "true");
assert.ok(result.logs.includes("OK: current-source discovery tiers configured: public-feed, gdelt."));
assert.equal(result.outputs.selected_provider, "resend");
result = await run({ changes: { ALPHA_NO_KEY_SOURCES: "true", ALPHA_PUBLIC_FEED_FALLBACK: "0" } });
assert.equal(result.outputs.fresh_source_ready, "true");
assert.ok(result.logs.includes("OK: current-source discovery tiers configured: public-feed."));
result = await run({ changes: { ALPHA_GDELT_FALLBACK: "1", ALPHA_PUBLIC_FEED_FALLBACK: "0" } });
assert.ok(result.logs.includes("OK: current-source discovery tiers configured: gdelt."));
result = await run({ changes: { ALPHA_PUBLISHER_FEED_FALLBACK: "1", ALPHA_PUBLIC_FEED_FALLBACK: "0" } });
assert.equal(result.outputs.fresh_source_ready, "true");
assert.ok(result.logs.includes("OK: current-source discovery tiers configured: publisher-feed."));
result = await run({ changes: { ALPHA_NO_KEY_SOURCES: "1", ALPHA_PUBLISHER_FEED_FALLBACK: "1", ALPHA_GDELT_FALLBACK: "1" } });
assert.ok(result.logs.includes("OK: current-source discovery tiers configured: public-feed, publisher-feed, gdelt."));
result = await run({ changes: { ALPHA_GDELT_FALLBACK: "0", ALPHA_NO_KEY_SOURCES: "0", ALPHA_PUBLIC_FEED_FALLBACK: "0" } });
assert.equal(result.outputs.fresh_source_ready, "false");
result = await run({ changes: { ALPHA_OPEN_NEWS_FALLBACK: "1" } });
assert.equal(result.outputs.fresh_source_ready, "true");
assert.ok(result.logs.includes("OK: current-source discovery tiers configured: open-news-feed."));
assert.equal(result.outputs.selected_provider, "resend");
assert.deepEqual(result.calls, { resend: 0, brevo: 0, oldDomains: 1 });
result = await run({ changes: {
  ALPHA_NO_KEY_SOURCES: "1", ALPHA_PUBLISHER_FEED_FALLBACK: "1",
  ALPHA_OPEN_NEWS_FALLBACK: "1", ALPHA_GDELT_FALLBACK: "1",
} });
assert.ok(result.logs.includes("OK: current-source discovery tiers configured: public-feed, publisher-feed, open-news-feed, gdelt."));
for (const disabled of [undefined, "0", "false"]) {
  result = await run({ changes: { ALPHA_OPEN_NEWS_FALLBACK: disabled } });
  assert.equal(result.outputs.fresh_source_ready, "false");
  assert.ok(!result.logs.some((line) => line.includes("open-news-feed")));
}
for (const enabled of ["true", "yes"]) {
  result = await run({ changes: { ALPHA_OPEN_NEWS_FALLBACK: enabled } });
  assert.equal(result.outputs.fresh_source_ready, "true");
  assert.ok(result.logs.includes("OK: current-source discovery tiers configured: open-news-feed."));
}
result = await run({ changes: { ALPHA_OPEN_NEWS_FALLBACK: "1", ALPHA_NO_MODEL_MODE: "0" } });
assert.equal(result.exit, 1);
assert.equal(result.outputs.fresh_source_ready, "false");
assert.ok(!result.logs.some((line) => line.includes("open-news-feed")));
for (const disabled of [undefined, "0", "false"]) {
  result = await run({ changes: { ALPHA_RESEARCH_METADATA_FALLBACK: disabled } });
  assert.equal(result.outputs.fresh_source_ready, "false");
  assert.ok(!result.logs.some((line) => line.includes("research-metadata")));
}
for (const enabled of ["1", "true", "yes"]) {
  result = await run({ changes: { ALPHA_RESEARCH_METADATA_FALLBACK: enabled } });
  assert.equal(result.outputs.fresh_source_ready, "true");
  assert.ok(result.logs.includes("OK: current-source discovery tiers configured: research-metadata."));
  assert.equal(result.outputs.selected_provider, "resend");
  assert.deepEqual(result.calls, { resend: 0, brevo: 0, oldDomains: 1 });
}
result = await run({ changes: { ALPHA_RESEARCH_METADATA_FALLBACK: "1", ALPHA_NO_MODEL_MODE: "0" } });
assert.equal(result.exit, 1);
assert.equal(result.outputs.fresh_source_ready, "false");
assert.ok(!result.logs.some((line) => line.includes("research-metadata")));
result = await run({ changes: {
  ALPHA_NO_KEY_SOURCES: "1", ALPHA_PUBLISHER_FEED_FALLBACK: "1",
  ALPHA_OPEN_NEWS_FALLBACK: "1", ALPHA_RESEARCH_METADATA_FALLBACK: "1", ALPHA_GDELT_FALLBACK: "1",
} });
assert.ok(result.logs.includes("OK: current-source discovery tiers configured: public-feed, publisher-feed, open-news-feed, research-metadata, gdelt."));
// PLOS reporting must use the same four gates as the source adapter. These
// checks run the preflight body with fixtures, never the live preflight entry.
const plosFlags = {
  ALPHA_PLOS_METADATA_FALLBACK: "1",
  ALPHA_DURABLE_SOURCE_BUDGET: "1",
  ALPHA_DURABLE_SOURCE_COOLDOWN: "1",
};
for (const enabled of ["1", "true", "yes", " YES "]) {
  result = await run({ changes: { ...plosFlags, ALPHA_PLOS_METADATA_FALLBACK: enabled } });
  assert.equal(result.exit, null);
  assert.equal(result.outputs.fresh_source_ready, "true");
  assert.ok(result.logs.includes("OK: current-source discovery tiers configured: plos-research."));
  assert.equal(result.outputs.selected_provider, "resend");
  assert.deepEqual(result.calls, { resend: 0, brevo: 0, oldDomains: 1 });
}
for (const flag of Object.keys(plosFlags)) {
  for (const disabled of [undefined, "0", "false", "invalid"]) {
    result = await run({ changes: { ...plosFlags, [flag]: disabled } });
    assert.equal(result.outputs.fresh_source_ready, "false");
    assert.ok(!result.logs.some((line) => line.includes("plos-research")));
  }
}
result = await run({ changes: { ...plosFlags, ALPHA_NO_MODEL_MODE: "0" } });
assert.equal(result.exit, 1);
assert.equal(result.outputs.fresh_source_ready, "false");
assert.ok(!result.logs.some((line) => line.includes("plos-research")));
result = await run({ changes: {
  ...plosFlags, ALPHA_NO_KEY_SOURCES: "1", ALPHA_PUBLISHER_FEED_FALLBACK: "1",
  ALPHA_OPEN_NEWS_FALLBACK: "1", ALPHA_RESEARCH_METADATA_FALLBACK: "1", ALPHA_GDELT_FALLBACK: "1",
} });
assert.ok(result.logs.includes("OK: current-source discovery tiers configured: public-feed, publisher-feed, open-news-feed, research-metadata, plos-research, gdelt."));
assert.ok(result.logs.some((line) => line.includes("local no-model writer enabled")));
assert.ok(!result.logs.some((line) => line.includes("backup-only mode")));
for (const skippedKey of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY", "BRAVE_SEARCH_API_KEY", "YOU_API_KEY"]) {
  assert.ok(!result.logs.some((line) => line.startsWith(`::warning::${skippedKey} is not set`)));
}
assert.ok(result.logs.some((line) => line.startsWith("::warning::ALPHA_OPS_ALERT_WEBHOOK_URL is not set")));
result = await run();
assert.ok(result.logs.some((line) => line.startsWith("::warning::BRAVE_SEARCH_API_KEY is not set")));
assert.ok(result.logs.some((line) => line.startsWith("::warning::YOU_API_KEY is not set")));
assert.ok(!result.logs.some((line) => line.startsWith("::warning::GEMINI_API_KEY is not set")));
assert.ok(result.logs.some((line) => line.includes("Only an already persisted issue or the bounded prior-issue backup")));
// Invalid paid/model policy still blocks before every provider check.
for (const changes of [{ ALPHA_ALLOW_PAID_AI: "1" }, { ALPHA_NO_MODEL_MODE: "0" }]) {
  result = await run({ changes: { ...plosFlags, ...changes } });
  assert.equal(result.exit, 1);
  assert.equal(result.outputs.selected_provider, undefined);
  assert.deepEqual(result.calls, { resend: 0, brevo: 0, oldDomains: 0 });
}
const ccmixterFlags = {
  ALPHA_CCMIXTER_METADATA_FALLBACK: "1",
  ALPHA_DURABLE_SOURCE_BUDGET: "1",
  ALPHA_DURABLE_SOURCE_COOLDOWN: "1",
};
for (const enabled of ["1", "true", "yes", " YES "]) {
  result = await run({ changes: { ...ccmixterFlags, ALPHA_CCMIXTER_METADATA_FALLBACK: enabled } });
  assert.equal(result.exit, null);
  assert.equal(result.outputs.fresh_source_ready, "true");
  assert.ok(result.logs.includes("OK: current-source discovery tiers configured: ccmixter-uploads."));
  assert.equal(result.outputs.selected_provider, "resend");
  assert.deepEqual(result.calls, { resend: 0, brevo: 0, oldDomains: 1 });
}
for (const flag of Object.keys(ccmixterFlags)) {
  for (const disabled of [undefined, "0", "false", "invalid"]) {
    result = await run({ changes: { ...ccmixterFlags, [flag]: disabled } });
    assert.equal(result.outputs.fresh_source_ready, "false");
    assert.ok(!result.logs.some((line) => line.includes("ccmixter-uploads")));
  }
}
result = await run({ changes: { ...ccmixterFlags, ALPHA_NO_MODEL_MODE: "0" } });
assert.equal(result.exit, 1);
assert.equal(result.outputs.fresh_source_ready, "false");
assert.ok(!result.logs.some((line) => line.includes("ccmixter-uploads")));
const federalRegisterFlags = {
  ALPHA_FEDERAL_REGISTER_FINANCE_FALLBACK: "1",
  ALPHA_DURABLE_SOURCE_BUDGET: "1",
  ALPHA_DURABLE_SOURCE_COOLDOWN: "1",
};
for (const enabled of ["1", "true", "yes", " YES "]) {
  result = await run({ changes: { ...federalRegisterFlags, ALPHA_FEDERAL_REGISTER_FINANCE_FALLBACK: enabled } });
  assert.equal(result.exit, null);
  assert.equal(result.outputs.fresh_source_ready, "true");
  assert.ok(result.logs.includes("OK: current-source discovery tiers configured: federal-register-finance."));
  assert.equal(result.outputs.selected_provider, "resend");
  assert.deepEqual(result.calls, { resend: 0, brevo: 0, oldDomains: 1 });
}
for (const flag of Object.keys(federalRegisterFlags)) {
  for (const disabled of [undefined, "0", "false", "invalid"]) {
    result = await run({ changes: { ...federalRegisterFlags, [flag]: disabled } });
    assert.equal(result.outputs.fresh_source_ready, "false");
    assert.ok(!result.logs.some((line) => line.includes("federal-register-finance")));
  }
}
result = await run({ changes: { ...federalRegisterFlags, ALPHA_NO_MODEL_MODE: "0" } });
assert.equal(result.exit, 1);
assert.equal(result.outputs.fresh_source_ready, "false");
assert.ok(!result.logs.some((line) => line.includes("federal-register-finance")));
console.log("PASS full preflight sender selection, gated public-source discovery and accurate no-model reporting fixtures");
