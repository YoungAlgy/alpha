// Standalone, offline regression for provider-environment restoration.
// This intentionally uses only known sentinels and never loads .env files,
// performs network requests, or prints any environment value.
import assert from "node:assert/strict";
import {
  PROVIDER_ENV_NAMES,
  clearProviderEnv,
  restoreProviderEnv,
  snapshotProviderEnv,
} from "./provider-env-snapshot.mts";

assert.deepEqual([...PROVIDER_ENV_NAMES], [
  "BRAVE_SEARCH_API_KEY",
  "GEMINI_API_KEY",
  "YOU_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
]);

const original = snapshotProviderEnv();
const unrelatedName = "ALPHA_PROVIDER_ENV_RESTORE_UNRELATED";
const originalUnrelated = process.env[unrelatedName];
const sentinels = new Map<
  (typeof PROVIDER_ENV_NAMES)[number],
  string | undefined
>([
  [PROVIDER_ENV_NAMES[0], "offline-sentinel-brave"],
  [PROVIDER_ENV_NAMES[1], ""],
  [PROVIDER_ENV_NAMES[2], undefined],
  [PROVIDER_ENV_NAMES[3], "offline-sentinel-groq"],
  [PROVIDER_ENV_NAMES[4], undefined],
  [PROVIDER_ENV_NAMES[5], "offline-sentinel-anthropic"],
]);

function assertMatchesSentinelSnapshot(): void {
  for (const name of PROVIDER_ENV_NAMES) {
    assert.equal(process.env[name], sentinels.get(name), `${name} should restore exact presence and value`);
  }
}

function applySentinels(): void {
  for (const name of PROVIDER_ENV_NAMES) {
    const value = sentinels.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function mutateAndThrow(snapshot: ReturnType<typeof snapshotProviderEnv>): void {
  try {
    clearProviderEnv();
    for (const name of PROVIDER_ENV_NAMES) process.env[name] = "offline-sentinel-mutated";
    throw new Error("intentional restoration failure-path");
  } finally {
    restoreProviderEnv(snapshot);
  }
}

try {
  process.env[unrelatedName] = "offline-sentinel-unrelated";
  clearProviderEnv();
  applySentinels();

  const snapshot = snapshotProviderEnv();
  clearProviderEnv();
  for (const name of PROVIDER_ENV_NAMES) {
    assert.equal(process.env[name], undefined, `${name} should be absent after clearing`);
  }
  assert.equal(process.env[unrelatedName], "offline-sentinel-unrelated", "unrelated environment should be untouched");

  restoreProviderEnv(snapshot);
  assertMatchesSentinelSnapshot();
  assert.equal(process.env[unrelatedName], "offline-sentinel-unrelated", "unrelated environment should remain untouched");

  clearProviderEnv();
  for (const name of PROVIDER_ENV_NAMES) process.env[name] = "offline-sentinel-before-throw";
  let thrown: unknown;
  try {
    mutateAndThrow(snapshot);
  } catch (error) {
    thrown = error;
  }
  assert.equal((thrown as Error)?.message, "intentional restoration failure-path");
  assertMatchesSentinelSnapshot();

  console.log("PASS verify-provider-env-restore (offline, six-key exact restore and finally failure path)");
} finally {
  restoreProviderEnv(original);
  if (originalUnrelated === undefined) delete process.env[unrelatedName];
  else process.env[unrelatedName] = originalUnrelated;
}
