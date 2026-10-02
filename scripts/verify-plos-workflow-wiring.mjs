// Local source reads only. No Actions, provider, settings or environment calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { load } from "js-yaml";
const path = ".github/workflows/daily-send.yml";
const before = load(execFileSync("git", ["show", `1eb3a14be5b68b18933bfc19cf1c77f8a04d63a5:${path}`], { encoding: "utf8" }));
const after = load(readFileSync(path, "utf8"));
let forwarded = 0;
for (const job of Object.values(after.jobs)) {
  for (const step of job.steps ?? []) {
    if (!Object.hasOwn(step.env ?? {}, "ALPHA_PLOS_METADATA_FALLBACK")) continue;
    assert.equal(step.env.ALPHA_PLOS_METADATA_FALLBACK, "${{ vars.SEND_ALPHA_PLOS_METADATA_FALLBACK }}");
    assert.equal(step.env.ALPHA_NO_MODEL_MODE, "1");
    assert.equal(step.env.ALPHA_ALLOW_PAID_AI, "0");
    assert.equal(step.env.ALPHA_DURABLE_SOURCE_BUDGET, "1");
    assert.equal(step.env.ALPHA_DURABLE_SOURCE_COOLDOWN, "${{ vars.SEND_ALPHA_DURABLE_SOURCE_COOLDOWN }}");
    delete step.env.ALPHA_PLOS_METADATA_FALLBACK;
    forwarded++;
  }
}
assert.equal(forwarded, 2);
assert.deepEqual(after, before, "schedules, sender controls, permissions and all executable steps unchanged");
console.log("PASS PLOS workflow: two off-default forwarding entries, no send or schedule changes");
