// Local source reads only. No Actions, provider, settings, environment or network calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { load } from "js-yaml";

const workflowPath = ".github/workflows/daily-send.yml";
const preflightPath = "scripts/verify-send-preflight.mjs";
const before = load(execFileSync("git", ["-c", "core.fsmonitor=false", "show", `HEAD:${workflowPath}`], {
  encoding: "utf8",
}));
const after = load(readFileSync(workflowPath, "utf8"));
const preflight = readFileSync(preflightPath, "utf8");

const forwardedSteps = [];
for (const job of Object.values(after.jobs ?? {})) {
  for (const step of job.steps ?? []) {
    const env = step.env ?? {};
    if (!Object.hasOwn(env, "ALPHA_OPENALEX_METADATA_FALLBACK")) continue;
    assert.equal(env.ALPHA_OPENALEX_METADATA_FALLBACK,
      "${{ vars.SEND_ALPHA_OPENALEX_METADATA_FALLBACK }}");
    assert.equal(env.ALPHA_NO_MODEL_MODE, "1");
    assert.equal(env.ALPHA_ALLOW_PAID_AI, "0");
    assert.equal(env.ALPHA_DURABLE_SOURCE_BUDGET, "1");
    assert.equal(env.ALPHA_DURABLE_SOURCE_COOLDOWN,
      "${{ vars.SEND_ALPHA_DURABLE_SOURCE_COOLDOWN }}");
    forwardedSteps.push(step);
    delete env.ALPHA_OPENALEX_METADATA_FALLBACK;
  }
}
assert.equal(forwardedSteps.length, 2,
  "preflight and runtime each receive the default-off OpenAlex variable");
assert.equal(forwardedSteps.filter(step => step.id === "preflight" &&
  String(step.run).includes("scripts/verify-send-preflight.mjs")).length, 1,
  "the preflight step receives the OpenAlex variable");
assert.equal(forwardedSteps.filter(step => step.env?.NEXT_PUBLIC_APP_URL === "https://alpha.everyday.report").length, 1,
  "the send runtime receives the OpenAlex variable");
assert.deepEqual(after, before,
  "only the two OpenAlex forwarding entries are added; triggers and executable workflow controls stay unchanged");

// The flag remains off unless the explicit variable is truthy. Preflight only
// reports configured source tiers; it does not call OpenAlex.
assert.match(preflight, /function enabled\(name\)\s*\{\s*const raw = process\.env\[name\][\s\S]*?return raw === "1" \|\| raw === "true" \|\| raw === "yes";/);
assert.match(preflight,
  /const openAlexMetadataEnabled = strictNoModel && enabled\("ALPHA_OPENALEX_METADATA_FALLBACK"\)\s*&&\s*enabled\("ALPHA_DURABLE_SOURCE_BUDGET"\)\s*&&\s*enabled\("ALPHA_DURABLE_SOURCE_COOLDOWN"\);/,
  "OpenAlex preflight readiness requires no-model mode, the opt-in flag, durable budget and circuit controls");
assert.match(preflight,
  /openAlexMetadataEnabled\s*\?\s*"openalex"\s*:\s*null/,
  "an enabled OpenAlex adapter is included in the fixed fresh-source tier list");
assert.equal((preflight.match(/ALPHA_OPENALEX_METADATA_FALLBACK/g) ?? []).length, 1,
  "preflight reads the flag only in its guarded readiness check");
assert.doesNotMatch(preflight, /fetch\([^\n]*(?:openalex|openalex\.org)|https?:\/\/api\.openalex\.org/i,
  "preflight does not make an OpenAlex request");

console.log("PASS OpenAlex workflow wiring: two default-off forwards, guarded preflight tier, unchanged workflow triggers and send controls");
