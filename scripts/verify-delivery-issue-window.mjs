// Offline clock, CLI and actual workflow wiring. No app, secrets or transports.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { DAILY_SEND_CRONS, decideDeliveryIssueWindow, validateDeliveryIssueWindow } from "../lib/delivery-issue-window.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const decide = (time, extra = {}) => decideDeliveryIssueWindow({
  eventName: "schedule", schedule: DAILY_SEND_CRONS[0], now: new Date(time), ...extra,
});
for (const time of ["2026-10-06T00:22:03Z", "2026-10-07T14:16:59.999Z"]) {
  for (const schedule of DAILY_SEND_CRONS)
    assert.deepEqual(decide(time, { schedule }), { state: "defer", reason: "before_primary_window" });
}
for (const time of ["2026-10-07T14:17:00Z", "2026-10-07T23:59:59.999Z", "2026-10-07T10:17:00-04:00", "2028-02-29T14:17:00Z", "2027-01-01T14:17:00Z"]) {
  const now = new Date(time);
  assert.deepEqual(decide(time), { state: "ready", issueDate: now.toISOString().slice(0,10), startedAt: now.toISOString() });
}
assert.equal(decide("2026-10-07T01:00:00Z", { eventName: "workflow_dispatch", schedule: undefined }).state, "ready");
for (const [extra, reason] of [
  [{ schedule: "private-input" }, "schedule_unrecognized"],
  [{ eventName: "push" }, "event_unrecognized"],
  [{ now: new Date(NaN) }, "clock_invalid"],
  [{ now: new Date("1999-01-01T14:17:00Z") }, "clock_invalid"],
]) assert.equal(decide("2026-10-07T14:17:00Z", extra).reason, reason);

const pin = { eventName: "schedule", schedule: DAILY_SEND_CRONS[2],
  issueDate: "2026-12-31", startedAt: "2026-12-31T23:59:00.000Z" };
for (const time of ["2026-12-31T23:59:00Z", "2027-01-01T00:05:00Z", "2027-01-01T01:28:59.999Z"])
  assert.deepEqual(validateDeliveryIssueWindow({ ...pin, now: new Date(time) }), { state: "ready", issueDate: pin.issueDate });
for (const time of ["2027-01-01T01:29:00Z", "2027-01-02T00:05:00Z", "2026-12-31T23:58:59Z"])
  assert.equal(validateDeliveryIssueWindow({ ...pin, now: new Date(time) }).state, "rejected");
for (const extra of [
  { issueDate: "2027-01-01" }, { issueDate: undefined }, { startedAt: undefined },
  { startedAt: "2026-02-30T23:59:00.000Z" }, { startedAt: "2026-12-31T13:59:00.000Z" },
  { schedule: "37 20 * * *" }, { eventName: "push" }, { now: new Date(NaN) },
]) assert.equal(validateDeliveryIssueWindow({ ...pin, now: new Date("2027-01-01T00:05:00Z"), ...extra }).state, "rejected");

const baseEnv = Object.fromEntries(["PATH", "SystemRoot", "LANG", "TEMP", "TMP"].flatMap(key => process.env[key] ? [[key,process.env[key]]] : []));
function cli(time, eventName = "schedule", schedule = DAILY_SEND_CRONS[0]) {
  const frozen = "data:text/javascript," + encodeURIComponent(`const Original=Date;globalThis.Date=class extends Original{constructor(...args){super(...(args.length?args:[${JSON.stringify(time)}]));}};`);
  return spawnSync(process.execPath, ["--import", frozen, "scripts/alpha-daily-send-window.mjs"], {
    cwd: root, env: { ...baseEnv, GITHUB_EVENT_NAME: eventName, ALPHA_DELIVERY_CRON: schedule },
    windowsHide: true, encoding: "utf8", timeout: 3000, maxBuffer: 4096,
  });
}
const early = cli("2026-10-06T00:22:03Z");
assert.equal(early.error, undefined);
assert.equal(early.status, 0);
assert.equal(early.stdout, "ready=false\n");
assert.equal(early.stderr.trim(), "Delivery window: before_primary_window");
const due = cli("2026-10-07T14:17:00Z");
assert.equal(due.status, 0);
assert.equal(due.stdout, "ready=true\nissue_date=2026-10-07\nstarted_at=2026-10-07T14:17:00.000Z\n");
assert.equal(due.stderr, "");
const invalid = cli("2026-10-07T14:17:00Z", "private-input", "private-input");
assert.equal(invalid.status, 1);
assert.equal(invalid.stdout, "ready=false\n");
assert.equal(invalid.stderr.trim(), "Delivery window: event_unrecognized");

const workflow = load(readFileSync(resolve(root,".github/workflows/daily-send.yml"),"utf8"));
assert.deepEqual(workflow.on.schedule.map(item => item.cron), DAILY_SEND_CRONS);
const steps = workflow.jobs.send.steps;
assert.equal(steps.filter(step => step.uses?.startsWith("actions/checkout@")).length, 1);
assert.ok(steps[0].uses.startsWith("actions/checkout@"));
assert.equal(steps[1].id, "window");
assert.equal(steps[1].run, 'node scripts/alpha-daily-send-window.mjs >> "$GITHUB_OUTPUT"');
const precheck = steps.find(step => step.id === "precheck");
assert.equal(precheck.if, "github.event_name == 'schedule' && steps.window.outputs.ready == 'true'");
assert.equal(precheck["continue-on-error"], undefined);
for (const step of steps.slice(3).filter(step => !step.uses?.startsWith("actions/upload-artifact@"))) {
  assert.equal(step.if, "steps.window.outputs.ready == 'true' && steps.precheck.outputs.skip != 'true'",
    "every possible send/provider/install/build step uses only the guarded normal-success condition");
  assert.equal(step["continue-on-error"], undefined, "no failed prerequisite is ignored");
}
assert.equal(workflow.jobs.send["continue-on-error"], undefined);
const send = steps.find(step => step.run?.includes("MAX_DELIVERY_PAGES=16"));
assert.equal(send.env.ALPHA_DELIVERY_ISSUE_DATE, "${{ steps.window.outputs.issue_date }}");
assert.equal(send.env.ALPHA_DELIVERY_RUN_STARTED_AT, "${{ steps.window.outputs.started_at }}");
assert.equal(send.env.ALPHA_DELIVERY_CRON, "${{ github.event.schedule }}");
assert.ok(send.run.includes("s.weekOf!==process.env.ALPHA_DELIVERY_ISSUE_DATE"));
assert.ok(precheck.run.includes("checked_issue_date === process.env.ALPHA_DELIVERY_ISSUE_DATE"));
assert.ok(precheck.run.includes("Exact issue coverage unavailable. No delivery attempt was started."));
console.log("PASS verify-delivery-issue-window (early deferral, immutable date, midnight/year rollover, expiry, CLI and gated workflow)");
