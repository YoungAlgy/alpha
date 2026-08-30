#!/usr/bin/env node
// Local pre-deploy gate. It does not load env files or contact any network.
// The WSL deploy wrapper sets both values from the clean checked-out commit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
  !["open", "paused"].includes(expectedCheckoutMode) ||
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
