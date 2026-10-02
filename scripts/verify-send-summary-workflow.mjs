// Exact local regression for the separately reviewed public-log projection.
// Feature wiring checks reuse this one permitted normalization. All remaining
// YAML fields and executable text are still compared against their baseline.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { load } from "js-yaml";

const PUBLIC_LOG_COMMAND = 'printf \'%s\' "${RESPONSE}" | node scripts/print-send-summary.mjs';

export function restoreReviewedSummaryLogging(before, after) {
  const restored = structuredClone(after);
  let replacements = 0;
  for (const [jobName, job] of Object.entries(before.jobs)) {
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (typeof step.run !== "string") continue;
      const original = step.run.split("\n").filter(line =>
        line.trim().startsWith('echo "${RESPONSE}" | node -e "let d=') &&
        line.includes("'backupSharedSentEmails','backupFreshSentEmails'"));
      if (original.length === 0) continue;
      assert.equal(original.length, 1, "one exact historical summary logger");
      const current = restored.jobs?.[jobName]?.steps?.[index];
      assert.equal(typeof current?.run, "string");
      const replacement = current.run.split("\n").filter(line => line.trim() === PUBLIC_LOG_COMMAND);
      assert.equal(replacement.length, 1, "one exact allowlisted summary logger");
      current.run = current.run.replace(replacement[0], original[0]);
      replacements++;
    }
  }
  assert.equal(replacements, 1, "only one reviewed public-log command can be normalized");
  return restored;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = ".github/workflows/daily-send.yml";
  const before = load(execFileSync("git", ["show", `207a4fae833b5c08c6675a90fa65a55ad84a53fb:${path}`], { encoding: "utf8" }));
  const after = load(readFileSync(path, "utf8"));
  assert.deepEqual(restoreReviewedSummaryLogging(before, after), before,
    "only public summary printing changed, all schedules, guards and send/maintenance steps preserved");

  const missing = structuredClone(after);
  const runtime = Object.values(missing.jobs).flatMap(job => job.steps ?? [])
    .find(step => step.run?.includes(PUBLIC_LOG_COMMAND));
  assert.ok(runtime);
  runtime.run = runtime.run.replace(PUBLIC_LOG_COMMAND, "true");
  assert.throws(() => restoreReviewedSummaryLogging(before, missing));
  const duplicate = structuredClone(after);
  const duplicateRuntime = Object.values(duplicate.jobs).flatMap(job => job.steps ?? [])
    .find(step => step.run?.includes(PUBLIC_LOG_COMMAND));
  duplicateRuntime.run += `\n${PUBLIC_LOG_COMMAND}\n`;
  assert.throws(() => restoreReviewedSummaryLogging(before, duplicate));
  const drift = structuredClone(after);
  drift.concurrency = { group: "unsafe-test-drift", "cancel-in-progress": true };
  assert.notDeepEqual(restoreReviewedSummaryLogging(before, drift), before,
    "normalization cannot hide an unrelated guard change");
  console.log("PASS exact summary logging scope, with schedules, permissions, guards and sends unchanged");
}
