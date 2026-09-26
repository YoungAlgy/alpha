#!/usr/bin/env node
// Offline watchdog contract checks. No network, provider, or application run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideWatchdogDeliveryMode,
  parseSubscriberDeliveryPolicy,
} from "./alpha-watchdog-delivery-mode.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const pausedPolicy = "// approved pause\nexport const SUBSCRIBER_LETTERS_ENABLED: boolean = false;\n";
const openPolicy = "/* reviewed resume */\nexport const SUBSCRIBER_LETTERS_ENABLED: boolean = true;\n";
const heldInteractivePolicy = "export const SUBSCRIBER_LETTERS_ENABLED: boolean = false;\nexport const INTERACTIVE_LETTERS_ENABLED: boolean = false;\n";
const manualFirstPolicy = "export const SUBSCRIBER_LETTERS_ENABLED: boolean = true;\nexport const INTERACTIVE_LETTERS_ENABLED: boolean = false;\n";
const health = (mode, release = sha) => JSON.stringify({
  ok: true,
  accessMode: "invite",
  subscriberDeliveryMode: mode,
  release,
});
const decide = (overrides = {}) => decideWatchdogDeliveryMode({
  policySource: pausedPolicy,
  expectedSha: sha,
  checkoutSha: sha,
  healthHttpStatus: 200,
  healthBody: health("paused"),
  ...overrides,
});

assert.equal(parseSubscriberDeliveryPolicy(pausedPolicy), "paused");
assert.equal(parseSubscriberDeliveryPolicy(openPolicy), "open");
assert.equal(parseSubscriberDeliveryPolicy(heldInteractivePolicy), "paused");
assert.equal(parseSubscriberDeliveryPolicy(manualFirstPolicy), "open");
assert.equal(parseSubscriberDeliveryPolicy(manualFirstPolicy.replace("INTERACTIVE_LETTERS_ENABLED: boolean = false", "INTERACTIVE_LETTERS_ENABLED: boolean = true")), null);
assert.equal(parseSubscriberDeliveryPolicy("// comment only"), null);
assert.equal(parseSubscriberDeliveryPolicy(pausedPolicy + "export const EXTRA = true;"), null);
assert.equal(parseSubscriberDeliveryPolicy(pausedPolicy + openPolicy), null);
assert.equal(parseSubscriberDeliveryPolicy("export const SUBSCRIBER_LETTERS_ENABLED: boolean = process.env.OPEN;"), null);
assert.equal(parseSubscriberDeliveryPolicy("/* unterminated\n" + pausedPolicy), null);
assert.equal(parseSubscriberDeliveryPolicy("// /*\nexport const EXTRA = true;\n*/\n" + pausedPolicy), null);
assert.equal(parseSubscriberDeliveryPolicy("ex/**/port const SUBSCRIBER_LETTERS_ENABLED: boolean = false;"), null);
assert.equal(parseSubscriberDeliveryPolicy("export const SUBSCRIBER_LETTERS_ENABLED: boolean = fal/**/se;"), null);
assert.equal(parseSubscriberDeliveryPolicy("export/**/const SUBSCRIBER_LETTERS_ENABLED: boolean = false;"), "paused");
assert.equal(parseSubscriberDeliveryPolicy("export const SUBSCRIBER_LETTERS_ENABLED: boolean = /* reviewed */ true;"), "open");
assert.equal(parseSubscriberDeliveryPolicy("export // reviewed\n const SUBSCRIBER_LETTERS_ENABLED: boolean = false;"), "paused");

assert.deepEqual(decide(), { mode: "paused", reason: "matched" });
assert.deepEqual(decide({ policySource: openPolicy, healthBody: health("open") }), { mode: "open", reason: "matched" });
assert.equal(decide({ policySource: "" }).mode, "unknown");
assert.equal(decide({ expectedSha: undefined }).reason, "checkout_release_ref_mismatch");
assert.equal(decide({ checkoutSha: otherSha }).reason, "checkout_release_ref_mismatch");
assert.equal(decide({ healthHttpStatus: 503 }).reason, "live_health_unavailable");
assert.equal(decide({ healthBody: "not json" }).reason, "live_health_malformed");
assert.equal(decide({ healthBody: "x".repeat(8193) }).reason, "live_health_invalid_size");
assert.equal(decide({ healthBody: "{}" }).reason, "live_health_unhealthy_or_unrecognized");
assert.equal(decide({ healthBody: JSON.stringify({ ok: false, accessMode: "invite", subscriberDeliveryMode: "paused", release: sha }) }).mode, "unknown");
assert.equal(decide({ healthBody: JSON.stringify({ ok: true, accessMode: "paid", subscriberDeliveryMode: "paused", release: sha }) }).mode, "unknown");
assert.equal(decide({ healthBody: health("paused", otherSha) }).reason, "live_release_ref_mismatch");
assert.equal(decide({ healthBody: health("unknown") }).reason, "live_delivery_mode_unrecognized");
assert.equal(decide({ healthBody: health("open") }).reason, "live_source_policy_mismatch");
assert.equal(decide({ policySource: openPolicy }).reason, "live_source_policy_mismatch");

// Exercise the actual CLI through a relative script path, with only the three
// required environment values and temporary local policy input. No network.
const helperPath = resolve(dirname(fileURLToPath(import.meta.url)), "alpha-watchdog-delivery-mode.mjs");
const runCli = (policySource, liveMode) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "alpha-watchdog-"));
  assert.ok(resolve(fixtureDir).startsWith(resolve(tmpdir()) + sep));
  try {
    if (policySource !== null) {
      mkdirSync(join(fixtureDir, "lib"));
      writeFileSync(join(fixtureDir, "lib", "subscriber-delivery-policy.ts"), policySource);
    }
    return spawnSync(process.execPath, [relative(fixtureDir, helperPath)], {
      cwd: fixtureDir,
      input: health(liveMode),
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 4096,
      windowsHide: true,
      env: {
        GITHUB_SHA: sha,
        WATCHDOG_CHECKOUT_SHA: sha,
        WATCHDOG_HEALTH_HTTP_STATUS: "200",
      },
    });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
};
const pausedCli = runCli(pausedPolicy, "paused");
assert.equal(pausedCli.error, undefined);
assert.equal(pausedCli.status, 0);
assert.equal(pausedCli.stdout, "paused");
assert.equal(pausedCli.stderr, "");
const openCli = runCli(openPolicy, "open");
assert.equal(openCli.error, undefined);
assert.equal(openCli.status, 0);
assert.equal(openCli.stdout, "open");
assert.equal(openCli.stderr, "");
const manualFirstCli = runCli(manualFirstPolicy, "open");
assert.equal(manualFirstCli.error, undefined);
assert.equal(manualFirstCli.status, 0);
assert.equal(manualFirstCli.stdout, "open");
assert.equal(manualFirstCli.stderr, "");
const mismatchCli = runCli(pausedPolicy, "open");
assert.equal(mismatchCli.error, undefined);
assert.equal(mismatchCli.status, 2);
assert.equal(mismatchCli.stdout, "");
assert.match(mismatchCli.stderr, /^Watchdog release state unverified: live_source_policy_mismatch\r?\n$/);
const missingPolicyCli = runCli(null, "paused");
assert.equal(missingPolicyCli.error, undefined);
assert.equal(missingPolicyCli.status, 2);
assert.equal(missingPolicyCli.stdout, "");
assert.match(missingPolicyCli.stderr, /^Watchdog release state unverified: local_input_unreadable\r?\n$/);

const currentPolicy = readFileSync("lib/subscriber-delivery-policy.ts", "utf8");
assert.equal(parseSubscriberDeliveryPolicy(currentPolicy), "open");
const workflow = readFileSync(".github/workflows/letter-watchdog.yml", "utf8");
assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /check-delivery:[\s\S]*?permissions:\n\s+contents: read[^\n]*\n\s+issues: write/);
assert.doesNotMatch(workflow.slice(0, workflow.indexOf("jobs:")), /contents: read/);
assert.match(workflow, /- name: Check Supabase for real, complete delivery today UTC\n[^\n]*\n\s+if: \$\{\{ !cancelled\(\) \}\}/);
assert.match(workflow, /--max-time 15 --connect-timeout 5 --max-filesize 8192/);
assert.match(workflow, /node scripts\/alpha-watchdog-delivery-mode\.mjs/);
assert.match(workflow, /Daily letter release state unverified/);
assert.match(workflow, /if \[ "\$\{MODE\}" = "paused" \]; then[\s\S]*?exit 0[\s\S]*?watchdog_delivery_check/);
assert.match(workflow, /if \[ "\$\{DELIVERED_COUNT\}" -lt 0 \]; then[\s\S]*?open_or_update_issue/);
assert.match(workflow, /if \[ "\$\{UNCOVERED_COUNT\}" -gt 0 \]; then[\s\S]*?open_or_update_issue/);
assert.match(workflow, /check-resilience-secrets:/);
assert.match(workflow, /heartbeat:[\s\S]*?needs: \[check-delivery, check-resilience-secrets\][\s\S]*?if: always\(\)/);

console.log("PASS verify-watchdog-paused-mode (paused/open, malformed, missing, drift, and preserved alert paths)");
