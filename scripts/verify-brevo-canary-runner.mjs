// Offline only. Provider and localhost requests are replaced with in-memory stubs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { acceptedCanarySummary, runBrevoCanary, validateSendScope } from "./run-brevo-canary.mjs";

const target = "00000000-0000-4000-8000-000000000001";
const env = {
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_ACTIONS: "true", ALPHA_SEND_OPERATION: "brevo_canary",
  ALPHA_CANARY_USER_ID: target, ALPHA_BREVO_CANARY_MODE: "1",
  ALPHA_SUBSCRIBER_EMAIL_PROVIDER: "resend", ALPHA_NO_MODEL_MODE: "1",
  ALPHA_ALLOW_PAID_AI: "0", CRON_SECRET: "offline-fixture-only",
};
const success = {
  canary: true, canaryProvider: "brevo", canarySent: true, subscribers: 1, sent: 1,
  backupSharedSent: 0, backupFreshSent: 0, backupStaleSent: 0,
  deliveryRetryRequired: false, deliveryRetryRequiredTotal: 0,
  deliveryHasMore: false, deliveryCursorAdvanceFailed: false, checkoutRetentionErrors: 0,
};
assert.deepEqual(validateSendScope(env), { ok: true, canary: true, userId: target });
for (const event of ["schedule", "workflow_dispatch"]) {
  assert.deepEqual(validateSendScope({ GITHUB_EVENT_NAME: event,
    ALPHA_SEND_OPERATION: "daily", ALPHA_CANARY_USER_ID: "" }), { ok: true, canary: false });
}
const invalidSettings = [
  { GITHUB_EVENT_NAME: "schedule" }, { GITHUB_EVENT_NAME: "pull_request" },
  { GITHUB_ACTIONS: "false" },
  { ALPHA_CANARY_USER_ID: "" }, { ALPHA_CANARY_USER_ID: `${target}&force=1` },
  { ALPHA_CANARY_USER_ID: ` ${target}` }, { ALPHA_CANARY_USER_ID: `${target},${target}` },
  { ALPHA_SEND_OPERATION: "daily" }, { ALPHA_SEND_OPERATION: "unknown" },
  { ALPHA_BREVO_CANARY_MODE: "0" }, { ALPHA_SUBSCRIBER_EMAIL_PROVIDER: "brevo" },
  { ALPHA_NO_MODEL_MODE: "0" }, { ALPHA_ALLOW_PAID_AI: "1" }, { CRON_SECRET: "" },
];
for (const patch of invalidSettings) {
  let calls = 0;
  const result = await runBrevoCanary({ ...env, ...patch }, async () => { calls++; throw Error("fixture"); });
  assert.equal(result.ok, false);
  assert.equal(calls, 0, `invalid setting must stop before dispatch: ${Object.keys(patch)}`);
}
let calls = 0;
assert.deepEqual(await runBrevoCanary(env, async (url, options) => {
  calls++;
  assert.equal(url.origin, "http://localhost:3100");
  assert.equal(url.pathname, "/api/cron/weekly-send");
  assert.deepEqual([...url.searchParams], [["canaryUserId", target], ["canaryProvider", "brevo"]]);
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "error");
  assert.equal(options.headers.Authorization, `Bearer ${env.CRON_SECRET}`);
  assert.equal(options.signal.aborted, false);
  return Response.json(success);
}), { ok: true, reason: "one_brevo_acceptance_confirmed" });
assert.equal(calls, 1);

assert.equal(acceptedCanarySummary(success), true);
for (const [key, value] of Object.entries(success)) {
  const missing = { ...success };
  delete missing[key];
  assert.equal(acceptedCanarySummary(missing), false, `missing ${key}`);
  const badValue = typeof value === "boolean" ? !value : typeof value === "number" ? value + 1 : "resend";
  assert.equal(acceptedCanarySummary({ ...success, [key]: badValue }), false, `invalid ${key}`);
}
for (const response of [
  () => Response.json(success, { status: 409 }),
  () => Response.json({ ...success, canaryProvider: "resend" }),
  () => Response.json({ ...success, sent: 2 }),
  () => new Response("invalid JSON"),
  () => new Response("x".repeat(65_537)),
  () => { throw Error("uncertain dispatch: private details must stay hidden"); },
]) {
  let attempts = 0;
  const result = await runBrevoCanary(env, async () => { attempts++; return response(); });
  assert.equal(result.ok, false);
  assert.equal(attempts, 1, "uncertainty must never retry");
  assert.doesNotMatch(JSON.stringify(result), /private|offline-fixture|00000000/);
}

const workflow = load(readFileSync(new URL("../.github/workflows/daily-send.yml", import.meta.url), "utf8"));
assert.equal(workflow.on.workflow_dispatch.inputs.operation.default, "daily");
assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, ["daily", "brevo_canary"]);
assert.equal(workflow.on.workflow_dispatch.inputs.canary_user_id.default, "");
assert.equal(workflow.concurrency.group, "alpha-daily-send");
assert.equal(workflow.concurrency["cancel-in-progress"], false);
const steps = workflow.jobs.send.steps;
const validator = steps.findIndex(step => step.run === "node scripts/run-brevo-canary.mjs --validate");
const preflight = steps.findIndex(step => step.run?.includes("verify-send-preflight.mjs"));
assert.ok(validator >= 0 && validator < preflight);
assert.match(steps[preflight].run, /ALPHA_SUBSCRIBER_EMAIL_PROVIDER=brevo node scripts\/verify-send-preflight.mjs/);
const send = steps.find(step => step.run?.includes("MAX_DELIVERY_PAGES=16")).run;
assert.ok(send.indexOf("export ALPHA_BREVO_CANARY_MODE=0") < send.indexOf("start_alpha_server()"));
assert.match(send, /export ALPHA_BREVO_CANARY_MODE=1\s+export ALPHA_SUBSCRIBER_EMAIL_PROVIDER=resend/);
const canaryStart = send.indexOf("node scripts/run-brevo-canary.mjs");
const normalStart = send.indexOf('URL="http://localhost:3100/api/cron/weekly-send"');
assert.ok(canaryStart > 0 && canaryStart < normalStart);
const canaryBranch = send.slice(canaryStart, normalStart);
assert.match(canaryBranch, /CANARY_EXIT=\$\?/);
assert.match(canaryBranch, /stop_alpha_server 120/);
assert.match(canaryBranch, /exit "\$\{CANARY_EXIT\}"/);
assert.doesNotMatch(canaryBranch, /while|curl|gh variable/);
assert.doesNotMatch(send, /\$\{\{\s*inputs\./, "workflow input is passed as environment data, never shell source");
console.log("PASS Brevo canary runner: scope rejection, single dispatch, strict acceptance, private failures, workflow branch isolation");
