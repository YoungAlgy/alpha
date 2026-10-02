// Local structural check. No remote history, settings, secret or workflow call.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { load } from "js-yaml";
const path = ".github/workflows/daily-send.yml";
// Keep the reviewed pre-feature reference after this candidate is committed.
const base = "e4374fe229cff6914883f359bb9d3bf895b4b740";
const before = load(execFileSync("git", ["show", `${base}:${path}`], { encoding: "utf8" }));
const after = load(readFileSync(path, "utf8"));
let forwarded = 0;
for (const job of Object.values(after.jobs)) {
  for (const step of job.steps ?? []) {
    if (!Object.hasOwn(step.env ?? {}, "ALPHA_RESEARCH_METADATA_FALLBACK")) continue;
    assert.equal(step.env.ALPHA_RESEARCH_METADATA_FALLBACK, "${{ vars.SEND_ALPHA_RESEARCH_METADATA_FALLBACK }}");
    assert.equal(step.env.ALPHA_NO_MODEL_MODE, "1");
    assert.equal(step.env.ALPHA_ALLOW_PAID_AI, "0");
    assert.equal(step.env.ALPHA_DURABLE_SOURCE_BUDGET, "1");
    delete step.env.ALPHA_RESEARCH_METADATA_FALLBACK;
    // The separately reviewed circuit is also opt-in. Its own focused check
    // proves both forwarding sites and every unchanged workflow control.
    assert.equal(step.env.ALPHA_DURABLE_SOURCE_COOLDOWN, "${{ vars.SEND_ALPHA_DURABLE_SOURCE_COOLDOWN }}");
    delete step.env.ALPHA_DURABLE_SOURCE_COOLDOWN;
    assert.equal(step.env.ALPHA_PLOS_METADATA_FALLBACK, "${{ vars.SEND_ALPHA_PLOS_METADATA_FALLBACK }}");
    delete step.env.ALPHA_PLOS_METADATA_FALLBACK;
    forwarded++;
  }
}
assert.equal(forwarded, 2, "preflight and runtime each receive the opt-in variable");
assert.deepEqual(after, before, "every other workflow control and schedule is unchanged");
console.log("PASS research workflow wiring, two opt-in entries and unchanged executable controls");
