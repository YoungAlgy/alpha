// Offline contract check. --release-scope also compares the entire workflow to
// its approved baseline. Default CI mode works in a shallow checkout. No HTTP.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "js-yaml";

const file = ".github/workflows/daily-send.yml";
const baseline = "350587afdd6558379cad949e661ddc217cac9458";
const before = process.argv.includes("--release-scope")
  ? load(execFileSync("git", ["-c", "core.fsmonitor=false", "show", `${baseline}:${file}`], { encoding: "utf8" }))
  : null;
const current = load(readFileSync(file, "utf8"));
// YAML block scalars normalize line endings. Match that on Windows checkouts.
const helper = readFileSync("scripts/alpha-workflow-failure-alert.mjs", "utf8").replace(/\r\n/g, "\n").trimEnd();
const marker = "    # Mark before the request. The pre-request alert must never\n" +
  "    # claim nothing started after a possibly accepted route call.\n" +
  '    echo "route_attempted=true" >> "$GITHUB_OUTPUT"\n';
const trailer = 'const result = await notifyAlphaWorkflowFailure(process.env);\n' +
  'console.log("[alpha-workflow-failure-alert] " + result);\n' +
  'if (result !== "accepted") console.log("::warning::Alpha pre-request failure notice was not confirmed. Details withheld.");\n';
const expectedRun = "node --input-type=module <<'ALPHA_FAILURE_ALERT'\n" + helper + "\n" + trailer + "ALPHA_FAILURE_ALERT\n";
const expression = (value) => "${{ " + value + " }}";
const expectedEnv = {
  ALPHA_OPS_ALERT_WEBHOOK_URL: expression("secrets.SEND_ALPHA_OPS_ALERT_WEBHOOK_URL"),
  ALPHA_WORKFLOW_EVENT: expression("github.event_name"),
  ALPHA_WORKFLOW_REPOSITORY: expression("github.repository"),
  ALPHA_WORKFLOW_RUN_ID: expression("github.run_id"),
  ALPHA_WORKFLOW_RUN_ATTEMPT: expression("github.run_attempt"),
  ALPHA_WORKFLOW_ISSUE_DATE: expression("steps.window.outputs.issue_date"),
  ALPHA_ROUTE_ATTEMPTED: expression("steps.delivery.outputs.route_attempted"),
};
for (const [key, id] of [["CHECKOUT", "checkout"], ["WINDOW", "window"], ["PRECHECK", "precheck"],
  ["SETUP", "setup"], ["SCOPE", "scope"], ["PREFLIGHT", "preflight"], ["INSTALL", "install"],
  ["BUILD_ENV", "build_env"], ["CACHE", "cache"], ["BUILD", "build"], ["DELIVERY", "delivery"]]) {
  expectedEnv[`ALPHA_STEP_${key}`] = expression(`steps.${id}.outcome`);
}
const addedIds = new Map([
  [0, "checkout"], [3, "setup"], [4, "scope"], [6, "install"], [7, "build_env"],
  [8, "cache"], [9, "build"], [10, "delivery"],
]);

function restoreReviewedChange(candidate) {
  const restored = structuredClone(candidate);
  const steps = restored.jobs.send.steps;
  const indexes = steps.flatMap((step, index) => step.id === "failure_notice" ? [index] : []);
  assert.equal(indexes.length, 1);
  const index = indexes[0];
  const notice = steps[index];
  assert.deepEqual(notice, {
    name: "Report a pre-request scheduled workflow failure",
    id: "failure_notice",
    if: "failure() && github.event_name == 'schedule' && steps.delivery.outputs.route_attempted != 'true'",
    "continue-on-error": true,
    "timeout-minutes": 1,
    shell: "bash",
    env: expectedEnv,
    run: expectedRun,
  });
  assert.equal(steps[index + 1].name, "Upload public-safe server diagnostics on failure");
  assert.equal(index, 11);
  steps.splice(index, 1);
  for (const [position, id] of addedIds) {
    if (before) assert.equal(before.jobs.send.steps[position].id, undefined);
    assert.equal(steps[position].id, id);
    delete steps[position].id;
  }
  const runtime = steps[10];
  assert.equal(runtime.run.split(marker).length, 2, "one exact marker");
  assert.match(runtime.run, /echo "route_attempted=true" >> "\$GITHUB_OUTPUT"\n\s*RAW=\$\(curl/);
  runtime.run = runtime.run.replace(marker, "");
  return restored;
}

const restored = restoreReviewedChange(current);
if (before) assert.deepEqual(restored, before,
  "all schedules, permissions, concurrency, guards, source flags and delivery commands preserved");
for (const mutate of [
  (v) => { v.jobs.send.steps.find(s => s.id === "failure_notice").if = "always()"; },
  (v) => { v.jobs.send.steps.find(s => s.id === "failure_notice").env.EXTRA = "unsafe"; },
  (v) => { v.jobs.send.steps.find(s => s.id === "failure_notice").run += "\nfetch('https://invalid.example');"; },
  (v) => { v.jobs.send.steps.find(s => s.id === "delivery").run = v.jobs.send.steps.find(s => s.id === "delivery").run.replace(marker, ""); },
]) {
  const copy = structuredClone(current);
  mutate(copy);
  assert.throws(() => restoreReviewedChange(copy));
}
if (before) {
  const unrelated = structuredClone(current);
  unrelated.concurrency["cancel-in-progress"] = true;
  assert.notDeepEqual(restoreReviewedChange(unrelated), before, "notice normalization cannot hide scheduler drift");
}

// Execute the exact embedded runner with no checkout or installed packages.
// Inject fetch before it runs. Never inherit the parent's operational env.
const empty = mkdtempSync(path.join(tmpdir(), "alpha-workflow-alert-"));
try {
  const bootstrap = `globalThis.fetch = async (url, init) => {
    if (url !== "https://discord.com/api/webhooks/123456789012345678/fake_test_token") throw new Error("unexpected test endpoint");
    const body = JSON.parse(init.body);
    if (!body.content.includes("Stage: checkout") || !body.content.includes("Issue date: unavailable")) throw new Error("wrong fixed context");
    if (init.redirect !== "error" || init.credentials !== "omit" || init.signal.aborted) throw new Error("unsafe request contract");
    process.stdout.write("OFFLINE_POST_VERIFIED\\n");
    return { status: 204, get body() { throw new Error("body accessed"); } };
  };\n`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", bootstrap + helper + "\n" + trailer], {
    cwd: empty,
    env: {
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
      GITHUB_ACTIONS: "true",
      ALPHA_WORKFLOW_EVENT: "schedule",
      ALPHA_WORKFLOW_REPOSITORY: "YoungAlgy/alpha",
      ALPHA_SEND_OPERATION: "daily",
      ALPHA_WORKFLOW_RUN_ID: "12345",
      ALPHA_WORKFLOW_RUN_ATTEMPT: "1",
      ALPHA_STEP_CHECKOUT: "failure",
      ALPHA_OPS_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789012345678/fake_test_token",
    },
    timeout: 10_000,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, "exact inline program runs without checkout");
  assert.equal(child.stdout, "OFFLINE_POST_VERIFIED\n[alpha-workflow-failure-alert] accepted\n");
  assert.equal(child.stderr, "");
} finally {
  rmdirSync(empty);
}
console.log(`PASS ${before ? "exact workflow delta, " : ""}inline parity, failure gates, mutation guards and empty-checkout execution. Zero network requests.`);
