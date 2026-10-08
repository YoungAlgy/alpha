// Compare the candidate with the exact local HEAD. No workflow execution.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { load } from "js-yaml";
const path = ".github/workflows/daily-send.yml";
const before = load(execFileSync("git", ["-c", "core.fsmonitor=false", "show", `HEAD:${path}`], { encoding: "utf8" }));
const after = load(readFileSync(path, "utf8"));
let forwarded = 0;
for (const job of Object.values(after.jobs)) {
  for (const step of job.steps ?? []) {
    if (!Object.hasOwn(step.env ?? {}, "ALPHA_CCMIXTER_METADATA_FALLBACK")) continue;
    assert.equal(step.env.ALPHA_CCMIXTER_METADATA_FALLBACK, "${{ vars.SEND_ALPHA_CCMIXTER_METADATA_FALLBACK }}");
    assert.equal(step.env.ALPHA_NO_MODEL_MODE, "1");
    assert.equal(step.env.ALPHA_ALLOW_PAID_AI, "0");
    assert.equal(step.env.ALPHA_DURABLE_SOURCE_BUDGET, "1");
    assert.equal(step.env.ALPHA_DURABLE_SOURCE_COOLDOWN, "${{ vars.SEND_ALPHA_DURABLE_SOURCE_COOLDOWN }}");
    delete step.env.ALPHA_CCMIXTER_METADATA_FALLBACK;
    forwarded++;
  }
}
assert.equal(forwarded, 2);
assert.deepEqual(after, before, "only two default-off source entries, no schedule/permission/sender/provider/scope changes");
console.log("PASS ccMixter workflow candidate: two default-off source entries only, all send and schedule controls unchanged");
