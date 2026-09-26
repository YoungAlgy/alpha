#!/usr/bin/env node
// Local pre-deploy gate. It does not load env files or contact any network.
// The WSL deploy wrapper sets both values from the clean checked-out commit.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Pin the complete checked-in policies. Each delivery mode change requires a
// source review and an updated release gate; no env override is accepted.
const SUPPRESSION_HOLD_SHA256 =
  "d8bdbbb14f0e258fc3d4c58af3c2742ad7671fe663e1556bd8655cbb468ad04b";
const ACCESS_MODE_SHA256 =
  "b9f13a9d129a7884f92f9d3c88f012db0936faaffdcaf1e73cd52ea02768c542";
const DELIVERY_HOLD_SHA256 =
  "8e6d64e863cab0d6569b5acd14fe8a936b9c4f0fee32a52843ff9bdeede97767";
let suppressionHoldVerified = false;
try {
  const policy = readFileSync("lib/suppression-recovery-policy.ts", "utf8")
    .replace(/\r\n/g, "\n");
  suppressionHoldVerified =
    createHash("sha256").update(policy).digest("hex") === SUPPRESSION_HOLD_SHA256;
} catch {
  // Missing or unreadable policy must fail the release gate.
}
if (!suppressionHoldVerified) {
  console.error("::error:: Manual delivery recovery safety hold is missing or changed. Review is required before release.");
  process.exit(1);
}

function pinnedSourceMatches(path, expectedHash) {
  try {
    const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    return createHash("sha256").update(source).digest("hex") === expectedHash;
  } catch {
    return false;
  }
}

if (!pinnedSourceMatches("lib/access-mode.ts", ACCESS_MODE_SHA256)) {
  console.error("::error:: Permanent invite-only access policy is missing or changed. Review is required before release.");
  process.exit(1);
}
if (!pinnedSourceMatches("lib/subscriber-delivery-policy.ts", DELIVERY_HOLD_SHA256)) {
  console.error("::error:: Reviewed enrolled subscriber delivery policy is missing or changed.");
  process.exit(1);
}

let dailySendEventsVerified = false;
try {
  const workflow = readFileSync(".github/workflows/daily-send.yml", "utf8").replace(/\r\n/g, "\n");
  const dailySlots = [...workflow.matchAll(/^    - cron: '([^']+)'/gm)].map((match) => match[1]);
  dailySendEventsVerified = /^  send:\n(?:^ {4}.*\n)*?^ {4}if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule' \}\}$/m.test(workflow) &&
    dailySlots.join("|") === "17 14 * * *|37 15 * * *|47 18 * * *" &&
    /^  workflow_dispatch:\s*$/m.test(workflow) &&
    !/inputs\.weekOf|WEEK_OF_INPUT|URL="\$\{URL\}\?weekOf=/.test(workflow) &&
    (workflow.match(/ALPHA_NO_MODEL_MODE: '1'/g) || []).length === 2 &&
    (workflow.match(/ALPHA_ALLOW_PAID_AI: '0'/g) || []).length === 2;
} catch {
  // Missing or unreadable workflow must fail the release gate.
}
if (!dailySendEventsVerified) {
  console.error("::error:: Delivery job must allow only dispatch or the approved daily slots, with no-model on, paid AI off, and no backfill input.");
  process.exit(1);
}

const publicRelease = process.env.NEXT_PUBLIC_ALPHA_RELEASE_SHA?.trim() || "";
const expectedRelease = process.env.ALPHA_EXPECTED_RELEASE_SHA?.trim() || "";
const expectedCheckoutMode =
  process.env.ALPHA_EXPECTED_CHECKOUT_MODE?.trim() || "";
const fullSha = /^[0-9a-f]{40}$/;

let head = "";
let worktree = "";
try {
  head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  worktree = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
} catch {
  console.error("::error:: Could not read the deployment checkout commit.");
  process.exit(1);
}

const wranglerConfig = readFileSync("wrangler.jsonc", "utf8");
const modeMatches = [
  ...wranglerConfig.matchAll(
    /"ALPHA_CHECKOUT_MODE"\s*:\s*"(open|paused)"/g
  ),
];
const configuredCheckoutMode =
  modeMatches.length === 1 ? modeMatches[0]?.[1] || "" : "";

if (
  !fullSha.test(publicRelease) ||
  !fullSha.test(expectedRelease) ||
  publicRelease !== expectedRelease ||
  publicRelease !== head ||
  worktree !== "" ||
  expectedCheckoutMode !== "paused" ||
  configuredCheckoutMode !== expectedCheckoutMode
) {
  console.error(
    "::error:: Release identity is missing or does not match the checked-out commit. " +
      "The checkout must also be clean and its expected checkout mode must match wrangler.jsonc. " +
      "Run bash scripts/deploy-from-wsl.sh from the WSL-native checkout."
  );
  process.exit(1);
}

console.log(
  `OK: deployment release identity matches ${head}; checkout mode ${configuredCheckoutMode}.`
);
