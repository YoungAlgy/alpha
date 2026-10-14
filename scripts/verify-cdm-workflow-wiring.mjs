// Static local policy checks only. No framework, provider or environment loading.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { load } from "js-yaml";
const path = ".github/workflows/daily-send.yml";
const before = load(execFileSync("git", ["-c", "core.fsmonitor=false", "show", `HEAD:${path}`], { encoding: "utf8" }));
const after = load(readFileSync(path, "utf8"));
const preflight = readFileSync("scripts/verify-send-preflight.mjs", "utf8");
let entries = 0;
for (const job of Object.values(after.jobs)) for (const step of job.steps ?? []) {
  if (!Object.hasOwn(step.env ?? {}, "ALPHA_CDM_METADATA_FALLBACK")) continue;
  assert.equal(step.env.ALPHA_CDM_METADATA_FALLBACK, "${{ vars.SEND_ALPHA_CDM_METADATA_FALLBACK }}");
  assert.equal(step.env.ALPHA_NO_MODEL_MODE, "1");
  assert.equal(step.env.ALPHA_ALLOW_PAID_AI, "0");
  assert.equal(step.env.ALPHA_DURABLE_SOURCE_BUDGET, "1");
  assert.equal(step.env.ALPHA_DURABLE_SOURCE_COOLDOWN, "${{ vars.SEND_ALPHA_DURABLE_SOURCE_COOLDOWN }}");
  delete step.env.ALPHA_CDM_METADATA_FALLBACK;
  entries++;
}
assert.equal(entries, 2);
assert.deepEqual(after, before, "only two default-off forwarding entries change the workflow");
assert.match(preflight, /const cdmMetadataEnabled = strictNoModel && enabled\("ALPHA_CDM_METADATA_FALLBACK"\) &&\s*enabled\("ALPHA_DURABLE_SOURCE_BUDGET"\) && enabled\("ALPHA_DURABLE_SOURCE_COOLDOWN"\);/);
assert.match(preflight, /cdmMetadataEnabled \? "cdm-music" : null/);
assert.doesNotMatch(preflight, /https?:\/\/cdm\.link|fetch\([^\n]*cdm/i);
const migration = readFileSync("supabase/migrations/20261013020000_cdm_public_source_circuit.sql", "utf8");
assert.match(migration, /v_rows is distinct from v_prior/);
assert.match(migration, /cardinality\(v_constraint\) not in \(cardinality\(v_rows\), cardinality\(v_rows\) \+ 1\)/);
assert.match(migration, /insert into public\.alpha_public_source_circuits \(provider\) values \('cdm-music'\) on conflict \(provider\) do nothing/);
assert.doesNotMatch(migration, /create (?:or replace )?function|grant |revoke |update |delete |truncate /i);
console.log("PASS CDM workflow/default-off gates and static additive-migration checks. SQL execution remains unqualified.");
