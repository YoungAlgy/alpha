// Offline replacement for the retired live provider mutation test.
// Loads actual TypeScript source in a VM with an environment tripwire and
// inert collaborators. No env files, provider clients, or requests are used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { recoverResendSuppression as RecoveryFunction } from "../lib/suppression-recovery";

let assertions = 0;
let envReads = 0;
let transportCalls = 0;
let rpcCalls = 0;
let providerCalls = 0;
let fetchCalls = 0;
let clientCreations = 0;
const env = new Proxy({}, { get() { envReads++; throw new Error("Environment access forbidden"); } });
const processTripwire = { env };
const fetchTripwire = () => { fetchCalls++; throw new Error("Network forbidden"); };

function load(sourcePath: string, modules: Record<string, unknown>): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  const compiled = ts.transpileModule(readFileSync(new URL(sourcePath, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports,
    process: processTripwire,
    fetch: fetchTripwire,
    require(name: string) {
      if (Object.hasOwn(modules, name)) return modules[name];
      throw new Error(`Unexpected import: ${name}`);
    },
  }, { timeout: 1000 });
  return exports;
}

const policy = load("../lib/suppression-recovery-policy.ts", {});
assert.equal(policy.MANUAL_PROVIDER_SUPPRESSION_REMOVAL_ENABLED, false);
assertions++;
const deliveryPolicy = load("../lib/subscriber-delivery-policy.ts", {});
assert.equal(deliveryPolicy.SUBSCRIBER_LETTERS_ENABLED, false);
assertions++;
const recovery = load("../lib/suppression-recovery.ts", {
  "./suppression-recovery-policy": policy,
  "@/lib/suppression-recovery-policy": policy,
}).recoverResendSuppression as typeof RecoveryFunction;

// Getters prove the hard hold precedes even reading caller configuration.
for (const configured of [true, false]) {
  let configReads = 0;
  const result = await recovery({
    sb: { rpc: async () => { rpcCalls++; throw new Error("RPC forbidden"); } } as never,
    userId: "11111111-1111-4111-8111-111111111111",
    get providerConfigured() { configReads++; return configured; },
    removeSuppression: async () => { providerCalls++; return true; },
  });
  assert.equal(result.status, "manual_recovery_disabled");
  assert.equal(configReads, 0);
  assertions += 2;
}

const emailModule = load("../lib/email.ts", {
  resend: { Resend: class { constructor() { clientCreations++; throw new Error("Provider client forbidden"); } } },
  "node:crypto": { createHash: () => { throw new Error("Unexpected hashing"); } },
  "@/lib/unsubscribe": {},
  "@/lib/text-truncate": {},
  "@/lib/resend-response": {},
  "@/lib/suppression-recovery-policy": policy,
  "./suppression-recovery-policy": policy,
  "@/lib/subscriber-delivery-policy": deliveryPolicy,
  "./subscriber-delivery-policy": deliveryPolicy,
  "@/lib/resend-suppression-response": {
    removeResendSuppressionWithTransport: async () => { transportCalls++; return true; },
  },
});
const removeSuppression = emailModule.removeResendSuppression as (email: string) => Promise<boolean>;
for (const email of ["reader@fixture.invalid", "", " Reader@fixture.invalid "]) {
  assert.equal(await removeSuppression(email), false);
  assertions++;
}
assert.equal(rpcCalls, 0);
assert.equal(providerCalls, 0);
assert.equal(transportCalls, 0);
assert.equal(fetchCalls, 0);
assert.equal(clientCreations, 0);
assert.equal(envReads, 0);
assertions += 6;
console.log(`PASS verify-resend-suppression-removal (${assertions} assertions, actual hard hold, offline only)`);
