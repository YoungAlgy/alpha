// Offline regression for the two GitHub Actions delivery schedules. This reads
// workflow source and evaluates only their inline count parsers with local data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { load } from "js-yaml";

type Workflow = {
  on?: { schedule?: { cron?: string }[] };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, { "timeout-minutes"?: number; steps?: { name?: string; env?: Record<string, string>; run?: string }[] }>;
};

function loadWorkflow(file: string): Workflow {
  const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
  const parsed = load(source);
  assert.ok(parsed && typeof parsed === "object", `${file}: valid YAML`);
  return parsed as Workflow;
}

const send = loadWorkflow("daily-send.yml");
const watchdog = loadWorkflow("letter-watchdog.yml");
const sendSlots = send.on?.schedule?.map(({ cron }) => cron);
const watchdogSlots = watchdog.on?.schedule?.map(({ cron }) => cron);
assert.deepEqual(sendSlots, ["17 14 * * *", "37 15 * * *", "47 18 * * *"]);
assert.deepEqual(watchdogSlots, ["37 20 * * *"]);
assert.equal(send.jobs?.send?.["timeout-minutes"], 90);
assert.equal(send.concurrency?.group, "alpha-daily-send");
assert.equal(send.concurrency?.["cancel-in-progress"], false);

function minuteOfDay(cron: string): number {
  const [minute, hour, day, month, weekday] = cron.split(" ");
  assert.deepEqual([day, month, weekday], ["*", "*", "*"]);
  assert.match(minute, /^\d{1,2}$/);
  assert.match(hour, /^\d{1,2}$/);
  return Number(hour) * 60 + Number(minute);
}
assert.equal(minuteOfDay(watchdogSlots![0]!) - minuteOfDay(sendSlots![2]!), 90 + 20);

const sendSteps = send.jobs?.send?.steps ?? [];
const precheck = sendSteps.find((step) => step.name?.startsWith("Pre-check"));
const preflight = sendSteps.find((step) => step.name?.startsWith("Pre-flight"));
assert.ok(precheck?.run, "send precheck exists");
assert.equal(preflight?.env?.ALPHA_NO_MODEL_MODE, "1");
assert.equal(preflight?.env?.ALPHA_ALLOW_PAID_AI, "0");
const deliveryStep = sendSteps.find((step) => step.run?.includes("MAX_DELIVERY_PAGES=16"));
assert.ok(deliveryStep?.run, "bounded delivery step exists");
assert.equal(deliveryStep.env?.ALPHA_NO_MODEL_MODE, "1");
assert.equal(deliveryStep.env?.ALPHA_ALLOW_PAID_AI, "0");

const watchdogSteps = watchdog.jobs?.["check-delivery"]?.steps ?? [];
const watchdogCheck = watchdogSteps.find((step) => step.run?.includes("COUNTS=$(RESPONSE="));
assert.ok(watchdogCheck?.run, "watchdog coverage check exists");
const cutoff = "CUTOFF=$(date -u +%Y-%m-%dT00:00:00Z)";
for (const [name, script] of [["send", precheck.run], ["watchdog", watchdogCheck.run]] as const) {
  assert.equal(script.split(cutoff).length - 1, 1, `${name}: exact UTC midnight cutoff`);
  assert.match(script, /watchdog_delivery_check/);
  assert.match(script, /-d "\{\\"cutoff\\": \\"\$\{CUTOFF\}\\"\}"/);
}

function extractCounts(script: string): string {
  const match = script.match(/COUNTS=\$\(RESPONSE="\$\{RESPONSE\}" node -e "([\s\S]*?)"\)/);
  assert.ok(match, "actual inline Node count parser found");
  return match[1]!;
}

function parseCounts(code: string, raw: string): string {
  let output = "";
  vm.runInNewContext(code, {
    process: { env: { RESPONSE: raw }, stdout: { write: (part: string) => { output += part; } } },
    console: { log: (...parts: unknown[]) => { output += parts.join(" "); } },
  }, { timeout: 1000 });
  return output;
}

const cases: [string, string, string][] = [
  ["valid covered", '[{"uncovered_count":0,"active_subscriber_count":4}]', "0 4"],
  ["valid uncovered", '[{"uncovered_count":2,"active_subscriber_count":4}]', "2 4"],
  ["negative", '[{"uncovered_count":-1,"active_subscriber_count":4}]', "-1 -1"],
  ["fractional", '[{"uncovered_count":0.5,"active_subscriber_count":4}]', "-1 -1"],
  ["unsafe integer", '[{"uncovered_count":9007199254740992,"active_subscriber_count":9007199254740992}]', "-1 -1"],
  ["null row", "[null]", "-1 -1"],
  ["empty array", "[]", "-1 -1"],
  ["multiple rows", '[{"uncovered_count":0,"active_subscriber_count":4},{"uncovered_count":0,"active_subscriber_count":4}]', "-1 -1"],
  ["uncovered above active", '[{"uncovered_count":5,"active_subscriber_count":4}]', "-1 -1"],
  ["malformed JSON", "[{", "-1 -1"],
];
for (const [name, script] of [["send", precheck.run], ["watchdog", watchdogCheck.run]] as const) {
  const code = extractCounts(script);
  for (const [caseName, raw, expected] of cases) {
    assert.equal(parseCounts(code, raw), expected, `${name}: ${caseName}`);
  }
}

// At the former 16:00 watchdog slot, a rolling 20-hour window began at
// yesterday 20:00. It could count a late prior-day letter at 20:30. The UTC
// midnight cutoff rejects that row. The current 20:37 slot is tested above.
const priorDayDelivery = Date.parse("2026-09-25T20:30:00Z");
const formerCheck = Date.parse("2026-09-26T16:00:00Z");
const todayMidnight = Date.parse("2026-09-26T00:00:00Z");
assert.ok(priorDayDelivery >= formerCheck - 20 * 60 * 60 * 1000);
assert.ok(priorDayDelivery < todayMidnight);

console.log(`PASS verify-schedule-reliability (${cases.length * 2} inline parser cases, workflow timing and policy)`);
