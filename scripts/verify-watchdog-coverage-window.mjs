// Offline temporal and actual shell-wiring checks. No delivery or network calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { decideWatchdogCoverageWindow, WATCHDOG_COVERAGE_CRON } from "./alpha-watchdog-coverage-window.mjs";

const decide = (time, overrides = {}) => decideWatchdogCoverageWindow({
  eventName: "schedule", schedule: WATCHDOG_COVERAGE_CRON, now: new Date(time), ...overrides,
});
for (const time of ["2026-10-01T00:08:24Z", "2026-10-01T14:17:00Z", "2026-10-01T20:36:59.999Z"]) {
  assert.deepEqual(decide(time), { state: "check", issueDate: "2026-09-30", basis: "closed_day" });
}
for (const time of ["2026-10-01T20:37:00Z", "2026-10-01T23:59:59.999Z", "2026-10-01T16:37:00-04:00"]) {
  assert.deepEqual(decide(time), { state: "check", issueDate: "2026-10-01", basis: "scheduled" });
}
for (const [time, date] of [["2026-12-31T21:00:00Z", "2026-12-31"], ["2027-01-01T21:00:00Z", "2027-01-01"], ["2028-02-29T21:00:00Z", "2028-02-29"]]) {
  assert.equal(decide(time).issueDate, date);
}
assert.deepEqual(decide("2026-10-02T00:08:24Z"), { state: "check", issueDate: "2026-10-01", basis: "closed_day" });
assert.deepEqual(decide("2026-10-01T00:08:24Z", { eventName: "workflow_dispatch", schedule: undefined }),
  { state: "check", issueDate: "2026-10-01", basis: "manual" });
assert.equal(decide("2026-10-01T21:00:00Z", { schedule: undefined }).reason, "schedule_unrecognized");
assert.equal(decide("2026-10-01T21:00:00Z", { schedule: "37 19 * * *" }).reason, "schedule_unrecognized");
assert.equal(decide("2026-10-01T21:00:00Z", { eventName: "push" }).reason, "event_unrecognized");
for (const now of [new Date(NaN), undefined, null, "2026-10-01T21:00:00Z", new Date("1999-01-01T21:00:00Z"), new Date("+010000-01-01T21:00:00Z")]) {
  assert.equal(decide(undefined, { now }).reason, "clock_invalid");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = relative(root, resolve(root, "scripts/alpha-watchdog-coverage-window.mjs"));
const baseEnv = Object.fromEntries(["PATH", "SystemRoot", "HOME", "USER", "LANG", "TMPDIR"].flatMap(key =>
  process.env[key] ? [[key, process.env[key]]] : []));
const freezeClock = time => "data:text/javascript," + encodeURIComponent(
  `const OriginalDate = Date; globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [${JSON.stringify(time)}])); } };`);
function cli(time, eventName = "schedule", schedule = WATCHDOG_COVERAGE_CRON) {
  return spawnSync(process.execPath, ["--import", freezeClock(time), helper], {
    cwd: root, env: { ...baseEnv, GITHUB_EVENT_NAME: eventName, WATCHDOG_CRON: schedule },
    encoding: "utf8", timeout: 3000, maxBuffer: 4096, windowsHide: true,
  });
}
const early = cli("2026-10-01T00:08:24Z");
assert.equal(early.error, undefined);
assert.equal(early.status, 0);
assert.equal(early.stdout, "2026-09-30 closed_day");
assert.equal(early.stderr.trim(), "Watchdog timing unverified: scheduled_window_not_due");
for (const eventName of ["schedule", "workflow_dispatch"]) {
  const result = cli("2026-10-01T20:37:00Z", eventName);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `2026-10-01 ${eventName === "schedule" ? "scheduled" : "manual"}`);
  assert.equal(result.stderr, "");
}
const manualEarly = cli("2026-10-01T00:08:24Z", "workflow_dispatch");
assert.equal(manualEarly.status, 0);
assert.equal(manualEarly.stdout, "2026-10-01 manual");
assert.equal(manualEarly.stderr, "");
for (const [time, cron, reason] of [
  ["2026-10-01T21:00:00Z", "37 19 * * *", "schedule_unrecognized"],
  ["invalid", WATCHDOG_COVERAGE_CRON, "clock_invalid"],
]) {
  const result = cli(time, "schedule", cron);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "Watchdog timing unverified: " + reason);
}
const rejected = cli("2026-10-01T21:00:00Z", "private-input", "private-input");
assert.equal(rejected.status, 2);
assert.ok(!rejected.stderr.includes("private-input"), "only fixed reasons are logged");

const workflow = load(readFileSync(resolve(root, ".github/workflows/letter-watchdog.yml"), "utf8"));
assert.deepEqual(workflow.on.schedule, [{ cron: WATCHDOG_COVERAGE_CRON }]);
const step = workflow.jobs["check-delivery"].steps.find(step => step.run?.includes("COUNTS=$(RESPONSE="));
assert.equal(step.env.WATCHDOG_CRON, "${{ github.event.schedule }}");
const script = step.run;
const guardStart = script.indexOf('TIMING_SEARCH_PHRASE="Daily letter watchdog timing unverified"');
const guardEndMarker = 'exit "${TIMING_UNVERIFIED}"';
const guardExit = script.indexOf(guardEndMarker, guardStart);
const guardEnd = guardExit < 0 ? -1 : script.indexOf("\nfi", guardExit) + 3;
const pausedGate = script.indexOf('if [ "${MODE}" = "paused" ]; then');
assert.ok(pausedGate >= 0 && guardStart > pausedGate && guardEnd > guardStart);
const rpcPosition = script.indexOf("/rest/v1/rpc/watchdog_issue_delivery_check");
assert.ok(rpcPosition > guardStart && rpcPosition < guardEnd);
const guard = script.slice(guardStart, guardEnd);
assert.match(guard, /WINDOW_CHECK_EXIT=\$\?/);
assert.match(guard, /if \[ "\$\{WINDOW_CHECK_EXIT\}" -ne 0 \]; then[\s\S]*?send_resend_alert[\s\S]*?open_or_update_issue[\s\S]*?exit 1/);
assert.match(guard, /if \[ "\$\{COVERAGE_BASIS\}" = "scheduled" \]; then\s+close_issue_if_open/);
assert.ok(!guard.includes('close_issue_if_open "Daily letter send may'), "unknown timing cannot close delivery alerts");
const unknownTimingBranch = script.slice(guardStart, script.indexOf("read -r ISSUE_DATE", guardStart));
assert.ok(!unknownTimingBranch.includes("watchdog_issue_delivery_check"), "unknown timing cannot query delivery coverage");
assert.ok(!script.includes("CUTOFF=$(date -u"), "no blind current-day or previous-day cutoff");
assert.match(script, /-d "\{\\"issue_date\\": \\"\$\{ISSUE_DATE\}\\"\}"/);
assert.match(script, /checked_issue_date === process\.env\.ISSUE_DATE_TO_CHECK/);
assert.match(script, /COVERAGE_BASIS.*closed_day/);
assert.match(script, /TIMING_UNVERIFIED=1/);
assert.match(script, /exit "\$\{TIMING_UNVERIFIED\}"/);
assert.ok(!script.includes('close_issue_if_open "Daily letter issue coverage unverified'), "date-scoped misses are never closed by a healthy date");
assert.ok(!script.includes('close_issue_if_open "Daily letter issue coverage incomplete'), "date-scoped partial alerts are never closed by a healthy date");
assert.ok(!script.includes("same-day acceptance") && !script.includes("acceptance recorded within UTC"), "claim markers do not prove provider acceptance time");
assert.ok(script.includes("The marker can precede provider acceptance") && script.includes("or authorize retries"), "the bounded aggregate states its timing and retry limits");

// Execute only the exact new shell guard with alert/issue functions stubbed.
// The actual helper uses a frozen local clock. No curl/gh/database is reachable.
let shellCases = 0;
if (process.platform === "linux") {
  const shell = `set -uo pipefail\nset +e\nISSUE_CHANNEL_FAILED=0\nsend_resend_alert() { printf 'ops_alert\\n'; }\nopen_or_update_issue() { printf 'opened_issue:%s\\n' "$1"; }\nclose_issue_if_open() { if [ "$1" = "Daily letter watchdog timing unverified" ]; then printf 'timing_resolved\\n'; else printf 'coverage_resolved:%s\\n' "$1"; fi; }\ncurl() { printf 'coverage_rpc\\n' >&2; printf '[{"checked_issue_date":"%s","uncovered_count":%s,"active_subscriber_count":%s}]' "\${FIXTURE_DATE:-$ISSUE_DATE}" "\${FIXTURE_UNCOVERED:-0}" "\${FIXTURE_ACTIVE:-1}"; }\n${guard}`;
  for (const [time, eventName, expectedExit, expected] of [
    ["2026-10-01T00:08:24Z", "schedule", 1, ["ops_alert", "opened_issue:Daily letter watchdog timing unverified", "2026-09-30", "closed_day"]],
    ["2026-10-01T20:37:00Z", "schedule", 0, ["timing_resolved", "2026-10-01", "scheduled"]],
    ["2026-10-01T00:08:24Z", "workflow_dispatch", 0, ["2026-10-01", "manual"]],
    ["invalid", "schedule", 1, ["ops_alert", "opened_issue:Daily letter watchdog timing unverified"]],
  ]) {
    const result = spawnSync("bash", ["-c", shell], {
      cwd: root, env: { ...baseEnv, NODE_OPTIONS: "--import=" + freezeClock(time),
        GITHUB_EVENT_NAME: eventName, WATCHDOG_CRON: WATCHDOG_COVERAGE_CRON,
        GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "YoungAlgy/alpha", GITHUB_RUN_ID: "offline",
        SUPABASE_URL: "https://xpqxhdciaoicsnyyfshy.supabase.co", SUPABASE_KEY: "offline-fixture-key" },
      encoding: "utf8", timeout: 3000, maxBuffer: 4096,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expectedExit);
    for (const value of expected) assert.ok(result.stdout.includes(value), value);
    if (expectedExit !== 0) assert.ok(!result.stdout.includes("timing_resolved"));
    if (eventName === "workflow_dispatch") assert.ok(!result.stdout.includes("timing_resolved"));
    if (time === "2026-10-01T00:08:24Z" && eventName === "schedule") {
      assert.ok(result.stderr.includes("coverage_rpc"), "closed-day check continues through exact-date coverage and exits TIMING_UNVERIFIED=1");
      assert.ok(result.stdout.includes("uncovered: 0"), "zero uncovered does not erase timing failure");
      assert.ok(!result.stdout.includes("coverage_resolved:"), "closed-day coverage cannot close older notices");
    }
    if (time === "invalid") assert.ok(!result.stderr.includes("coverage_rpc"), "unknown clock fails before querying coverage");
    shellCases++;
  }
  for (const [fixture, expectedExit, expected] of [
    [{ FIXTURE_ACTIVE: "0" }, 0, "OK: 0/0"],
    [{ FIXTURE_DATE: "2026-09-30" }, 1, "could not verify delivery"],
    [{ FIXTURE_UNCOVERED: "1" }, 1, "lack bounded accepted-issue evidence"],
  ]) {
    const result = spawnSync("bash", ["-c", shell], {
      cwd: root, env: { ...baseEnv, ...fixture, NODE_OPTIONS: "--import=" + freezeClock("2026-10-01T20:37:00Z"),
        GITHUB_EVENT_NAME: "schedule", WATCHDOG_CRON: WATCHDOG_COVERAGE_CRON,
        GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "YoungAlgy/alpha", GITHUB_RUN_ID: "offline",
        SUPABASE_URL: "https://xpqxhdciaoicsnyyfshy.supabase.co", SUPABASE_KEY: "offline-fixture-key" },
      encoding: "utf8", timeout: 3000, maxBuffer: 4096,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expectedExit);
    assert.ok(result.stdout.includes(expected));
    assert.ok(!result.stdout.includes("coverage_resolved:"));
    shellCases++;
  }
}
console.log(`PASS verify-watchdog-coverage-window (UTC boundaries, closed-day checks, manual checks, fixed logs, shell cases=${shellCases})`);
