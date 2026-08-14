// Verify round 23 findings (alpha-drift-r23-01/timeout/concurrency, 2026-08-14):
// round 22's new weekly `schedule` trigger on wrangler-config-guard.yml was
// added specifically for the dependency-audit job, but GitHub Actions has
// no per-job trigger syntax -- `on:` scopes the WHOLE workflow, so the
// schedule event silently also fired the pre-existing `guard` and `build`
// jobs every Monday with no corresponding commit, contradicting round 22's
// own comment. Same round also found: no timeout-minutes on any of the
// three jobs (GitHub defaults to 360min when omitted, unlike every other
// workflow in this repo), and no concurrency group (a push near the new
// Monday 13:00 UTC slot could launch an overlapping run).
//
// This is CI config, not application code -- no local harness can actually
// fire a GitHub Actions schedule event, so this verifies the real YAML
// structure directly (parsed with js-yaml, not string-matched), the same
// deterministic way GitHub Actions itself resolves on:/if:/jobs:.
// Run: npx tsx scripts/verify-wrangler-guard-schedule-scope.mts
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const raw = readFileSync(new URL("../.github/workflows/wrangler-config-guard.yml", import.meta.url), "utf8");
const doc = load(raw) as {
  on: { push?: unknown; workflow_dispatch?: unknown; schedule?: Array<{ cron: string }> };
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, { if?: string; "timeout-minutes"?: number }>;
};

console.log("(1) sanity: the workflow still parses as valid YAML and still has all 3 jobs");
check("(1a) YAML parses", !!doc);
check("(1b) all 3 jobs still exist", "guard" in doc.jobs && "build" in doc.jobs && "dependency-audit" in doc.jobs);
check("(1c) the weekly schedule trigger is still present (this fix scopes it, doesn't remove it)", Array.isArray(doc.on.schedule) && doc.on.schedule.length === 1 && doc.on.schedule[0].cron === "0 13 * * 1");

console.log("(2) alpha-drift-r23-01: guard and build are excluded from the schedule event, dependency-audit is NOT");
check("(2a) guard has an if: excluding schedule", doc.jobs.guard.if === "github.event_name != 'schedule'");
check("(2b) build has an if: excluding schedule", doc.jobs.build.if === "github.event_name != 'schedule'");
check("(2c) dependency-audit has NO if: (deliberately runs on push AND schedule, per its own r22-01 design)", doc.jobs["dependency-audit"].if === undefined);

console.log("(3) alpha-drift-r23 timeout finding: every job now has an explicit timeout-minutes, no job relies on GitHub's 360min default");
check("(3a) guard has a timeout", typeof doc.jobs.guard["timeout-minutes"] === "number" && doc.jobs.guard["timeout-minutes"] > 0);
check("(3b) build has a timeout", typeof doc.jobs.build["timeout-minutes"] === "number" && doc.jobs.build["timeout-minutes"] > 0);
check("(3c) dependency-audit has a timeout", typeof doc.jobs["dependency-audit"]["timeout-minutes"] === "number" && doc.jobs["dependency-audit"]["timeout-minutes"] > 0);
check("(3d) no job's timeout exceeds a sane ceiling (catches a typo like 3600 instead of 10)", [doc.jobs.guard, doc.jobs.build, doc.jobs["dependency-audit"]].every((j) => (j["timeout-minutes"] ?? 0) <= 60));

console.log("(4) alpha-drift-r23 concurrency finding: a concurrency group now exists, matching daily-send.yml's own pattern");
check("(4a) concurrency block exists", !!doc.concurrency);
check("(4b) has a real, non-empty group name", typeof doc.concurrency?.group === "string" && doc.concurrency.group.length > 0);
check("(4c) cancel-in-progress is false (queue behind an in-flight run, don't kill it -- same choice daily-send.yml made)", doc.concurrency?.["cancel-in-progress"] === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("WRANGLER-GUARD-SCHEDULE-SCOPE VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL WRANGLER-GUARD-SCHEDULE-SCOPE ASSERTIONS PASS");
