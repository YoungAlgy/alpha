// Structural local Git reads only. No workflow/service/environment request.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { load } from "js-yaml";
const path = ".github/workflows/daily-send.yml";
const before = load(execFileSync("git", ["show", `05f979ef4100b98b840aa514ceff55225d1a4c66:${path}`], { encoding: "utf8" }));
const after = load(readFileSync(path, "utf8"));
let forwarded = 0;
for (const job of Object.values(after.jobs)) {
  for (const step of job.steps ?? []) {
    if (!Object.hasOwn(step.env ?? {}, "ALPHA_DURABLE_SOURCE_COOLDOWN")) continue;
    assert.equal(step.env.ALPHA_DURABLE_SOURCE_COOLDOWN, "${{ vars.SEND_ALPHA_DURABLE_SOURCE_COOLDOWN }}");
    assert.equal(step.env.ALPHA_DURABLE_SOURCE_BUDGET, "1");
    assert.equal(step.env.ALPHA_NO_MODEL_MODE, "1");
    assert.equal(step.env.ALPHA_ALLOW_PAID_AI, "0");
    delete step.env.ALPHA_DURABLE_SOURCE_COOLDOWN;
    assert.equal(step.env.ALPHA_PLOS_METADATA_FALLBACK, "${{ vars.SEND_ALPHA_PLOS_METADATA_FALLBACK }}");
    delete step.env.ALPHA_PLOS_METADATA_FALLBACK;
    forwarded++;
  }
}
assert.equal(forwarded, 2, "only preflight and runtime receive the off-default flag");
assert.deepEqual(after, before, "all schedules, concurrency, delivery and executable steps unchanged");
console.log("PASS source circuit workflow: two opt-in entries, no scheduling or send changes");
