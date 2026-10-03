// Structural local Git reads only. No workflow/service/environment request.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { load } from "js-yaml";
const path = ".github/workflows/daily-send.yml";
// The starting candidate already includes reviewed source flags and later
// timing/logging fixes. Compare exactly with that checkpoint, without erasing
// those established fields to match an older historical workflow.
const before = load(execFileSync("git", ["show", `5e8a0042417763df812fc1d3c9e94d28f3e3a49f:${path}`], { encoding: "utf8" }));
const after = load(readFileSync(path, "utf8"));
let forwarded = 0;
for (const job of Object.values(after.jobs)) {
  for (const step of job.steps ?? []) {
    if (!Object.hasOwn(step.env ?? {}, "ALPHA_DURABLE_SOURCE_COOLDOWN")) continue;
    assert.equal(step.env.ALPHA_DURABLE_SOURCE_COOLDOWN, "${{ vars.SEND_ALPHA_DURABLE_SOURCE_COOLDOWN }}");
    assert.equal(step.env.ALPHA_DURABLE_SOURCE_BUDGET, "1");
    assert.equal(step.env.ALPHA_NO_MODEL_MODE, "1");
    assert.equal(step.env.ALPHA_ALLOW_PAID_AI, "0");
    assert.equal(step.env.ALPHA_PLOS_METADATA_FALLBACK, "${{ vars.SEND_ALPHA_PLOS_METADATA_FALLBACK }}");
    assert.equal(step.env.ALPHA_ISSUE_CITATION_HISTORY, "${{ vars.SEND_ALPHA_ISSUE_CITATION_HISTORY }}");
    delete step.env.ALPHA_ISSUE_CITATION_HISTORY;
    forwarded++;
  }
}
assert.equal(forwarded, 2, "only preflight and runtime receive the off-default flag");
assert.deepEqual(after, before,
  "starting schedules, concurrency, delivery and executable steps unchanged except optional history flag forwarding");
console.log("PASS source circuit workflow: two off-default history entries, no scheduling or send changes");
