#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { checkQuotaAccess } from "./check-resend-quota-access.mjs";

const env = {
  GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "YoungAlgy/alpha",
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/master",
  GITHUB_SHA: "a".repeat(40), RESEND_API_KEY: "fixture-key",
  RESEND_FROM: '"alpha." <alpha@everyday.report>',
};
const domains = { data: [{ name: "everyday.report", status: "verified" }] };
const usage = { object: "usage", emails: {
  daily: { used: 1, limit: 4 }, monthly: { used: 8, limit: 12 },
} };
function fixture({ domain = domains, quota = usage, status = 200 } = {}) {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    calls.push(url);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.Authorization, `Bearer ${env.RESEND_API_KEY}`);
    assert.equal(url, `https://api.resend.com/${calls.length === 1 ? "domains" : "usage"}`);
    assert.ok(calls.length <= 2);
    return Response.json(calls.length === 1 ? domain : quota, { status });
  } };
}

let stub = fixture();
assert.deepEqual(await checkQuotaAccess(env, stub.fetch), {
  status: "contract_verified", reason: "ready", quotaContractVerified: true,
  requests: [{ endpoint: "domains", httpStatus: 200 }, { endpoint: "usage", httpStatus: 200 }],
});
assert.equal(stub.calls.length, 2);

stub = fixture({ quota: { ...usage, emails: {
  ...usage.emails, daily: { used: 4, limit: 4 },
} } });
assert.deepEqual(await checkQuotaAccess(env, stub.fetch), {
  status: "contract_verified", reason: "capacity_unavailable", quotaContractVerified: true,
  requests: [{ endpoint: "domains", httpStatus: 200 }, { endpoint: "usage", httpStatus: 200 }],
});
assert.equal(stub.calls.length, 2);

stub = fixture({ status: 403 });
assert.deepEqual(await checkQuotaAccess(env, stub.fetch), {
  status: "blocked", reason: "authentication_denied", quotaContractVerified: false,
  requests: [{ endpoint: "domains", httpStatus: 403 }],
});
assert.equal(stub.calls.length, 1);

stub = fixture({ domain: { data: [] } });
assert.deepEqual(await checkQuotaAccess(env, stub.fetch), {
  status: "blocked", reason: "sender_domain_unverified", quotaContractVerified: false,
  requests: [{ endpoint: "domains", httpStatus: 200 }],
});
assert.equal(stub.calls.length, 1);

stub = fixture({ quota: { object: "usage", emails: { daily: { used: 0, limit: null } } } });
assert.equal((await checkQuotaAccess(env, stub.fetch)).quotaContractVerified, false);
let deniedCalls = 0;
const deniedUsage = await checkQuotaAccess(env, async () => {
  deniedCalls++;
  return deniedCalls === 1 ? Response.json(domains) : Response.json({}, { status: 403 });
});
assert.equal(deniedUsage.quotaContractVerified, false);
assert.deepEqual(deniedUsage.requests, [{ endpoint: "domains", httpStatus: 200 }, { endpoint: "usage", httpStatus: 403 }]);
assert.equal(JSON.stringify(deniedUsage).includes(env.RESEND_API_KEY), false);

for (const change of [
  { GITHUB_ACTIONS: "false" }, { GITHUB_REPOSITORY: "Other/alpha" },
  { GITHUB_EVENT_NAME: "schedule" }, { GITHUB_REF: "refs/heads/other" },
  { GITHUB_SHA: "wrong" }, { RESEND_FROM: "wrong" },
]) {
  let calls = 0;
  assert.deepEqual(await checkQuotaAccess({ ...env, ...change }, async () => { calls += 1; }), {
    status: "blocked", reason: "invalid_context", quotaContractVerified: false,
  });
  assert.equal(calls, 0);
}

const workflow = readFileSync(new URL("../.github/workflows/resend-quota-check.yml", import.meta.url), "utf8");
const parsedWorkflow = load(workflow);
assert.deepEqual(parsedWorkflow.on, { workflow_dispatch: {} });
assert.deepEqual(parsedWorkflow.permissions, { contents: "read" });
assert.deepEqual(Object.keys(parsedWorkflow.jobs), ["check"]);
const steps = parsedWorkflow.jobs.check.steps;
assert.equal(steps.length, 2);
assert.deepEqual(steps[0].with, { "persist-credentials": false });
assert.deepEqual(steps[1].env, {
  RESEND_API_KEY: "${{ secrets.SEND_RESEND_API_KEY }}", RESEND_FROM: env.RESEND_FROM,
});
assert.equal(steps[1].run, "node scripts/check-resend-quota-access.mjs");
assert.match(workflow, /workflow_dispatch: \{\}/);
assert.doesNotMatch(workflow, /\bschedule:|\bpush:|npm (?:ci|install)|next (?:build|start)|send[a-z-]*email/i);
assert.match(workflow, /permissions:\s*\n\s*contents: read/);
assert.match(workflow, /timeout-minutes: 3/);
assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /RESEND_API_KEY: \$\{\{ secrets\.SEND_RESEND_API_KEY \}\}/);
assert.match(workflow, /RESEND_FROM: '"alpha\." <alpha@everyday\.report>'/);
assert.match(workflow, /run: node scripts\/check-resend-quota-access\.mjs/);
console.log("PASS no-send Resend quota access probe fixtures and workflow guards");
