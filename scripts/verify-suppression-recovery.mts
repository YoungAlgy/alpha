// Exercises the DEFERRED durable recovery protocol in a memory-only VM.
// The policy is enabled only in this isolated test module. Production keeps
// a checked-in hold. verify-resend-suppression-removal.mts tests that real hold.
// No configuration, external services, or runtime override is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { recoverResendSuppression as RecoveryFunction } from "../lib/suppression-recovery";

const helperExports: { recoverResendSuppression?: typeof RecoveryFunction } = {};
vm.runInNewContext(ts.transpileModule(
  readFileSync(new URL("../lib/suppression-recovery.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText, {
  exports: helperExports,
  require(name: string) {
    if (name === "./suppression-recovery-policy" || name === "@/lib/suppression-recovery-policy") {
      return { MANUAL_PROVIDER_SUPPRESSION_REMOVAL_ENABLED: true };
    }
    throw new Error(`Unexpected deferred helper import: ${name}`);
  },
}, { timeout: 1000 });
const recoverResendSuppression = helperExports.recoverResendSuppression!;

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const EMAIL = "reader@fixture.invalid";
const STARTED_AT = "2026-09-04T12:34:56.789Z";
const noClaimData = {
  recovery_token: null,
  recovery_started_at: null,
  recipient_email: null,
};

type RpcReply = { data: unknown; error: unknown } | "throw";
type Scenario = {
  name: string;
  configured?: boolean;
  claim?: RpcReply;
  final?: RpcReply;
  provider?: "true" | "false" | "throw";
  expect:
    | "cleared"
    | "already_clear"
    | "deletion_pending"
    | "provider_unavailable"
    | "provider_failed"
    | "state_changed"
    | "settlement_unconfirmed";
  claimCalls: number;
  providerCalls: number;
  finalCalls: number;
};

async function run(scenario: Scenario) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const providerRecipients: string[] = [];
  const rpc = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const reply = name === "claim_resend_suppression_recovery"
      ? scenario.claim ?? { data: [{ recovery_status: "already_clear", ...noClaimData }], error: null }
      : scenario.final ?? { data: "cleared", error: null };
    if (reply === "throw") throw new Error("fixture rpc failure");
    return reply;
  };
  const status = await recoverResendSuppression({
    sb: { rpc } as never,
    userId: USER_ID,
    providerConfigured: scenario.configured !== false,
    removeSuppression: async (recipientEmail) => {
      providerRecipients.push(recipientEmail);
      if (scenario.provider === "throw") throw new Error("fixture provider failure");
      return scenario.provider !== "false";
    },
  });
  return { status, calls, providerRecipients };
}

const claimed = {
  recovery_status: "claimed",
  recovery_token: TOKEN,
  recovery_started_at: STARTED_AT,
  recipient_email: EMAIL,
};

const scenarios: Scenario[] = [
  {
    name: "configuration is checked before a durable claim",
    configured: false,
    expect: "provider_unavailable",
    claimCalls: 0,
    providerCalls: 0,
    finalCalls: 0,
  },
  {
    name: "already clear does not contact the provider",
    expect: "already_clear",
    claimCalls: 1,
    providerCalls: 0,
    finalCalls: 0,
  },
  {
    name: "deletion pending remains fenced",
    claim: { data: [{ recovery_status: "deletion_pending", ...noClaimData }], error: null },
    expect: "deletion_pending",
    claimCalls: 1,
    providerCalls: 0,
    finalCalls: 0,
  },
  {
    name: "non-claimed rows with recipient data fail closed",
    claim: {
      data: [{ recovery_status: "already_clear", ...noClaimData, recipient_email: EMAIL }],
      error: null,
    },
    expect: "settlement_unconfirmed",
    claimCalls: 1,
    providerCalls: 0,
    finalCalls: 0,
  },
  {
    name: "non-claimed rows with a token fail closed",
    claim: {
      data: [{ recovery_status: "review_required", ...noClaimData, recovery_token: TOKEN }],
      error: null,
    },
    expect: "settlement_unconfirmed",
    claimCalls: 1,
    providerCalls: 0,
    finalCalls: 0,
  },
  {
    name: "malformed claim never contacts the provider",
    claim: { data: [{ recovery_status: "claimed", recipient_email: EMAIL }], error: null },
    expect: "settlement_unconfirmed",
    claimCalls: 1,
    providerCalls: 0,
    finalCalls: 0,
  },
  {
    name: "noncanonical recipient never contacts the provider",
    claim: { data: [{ ...claimed, recipient_email: "Reader@fixture.invalid" }], error: null },
    expect: "settlement_unconfirmed",
    claimCalls: 1,
    providerCalls: 0,
    finalCalls: 0,
  },
  {
    name: "non-ISO start time never contacts the provider",
    claim: { data: [{ ...claimed, recovery_started_at: "September 4, 2026" }], error: null },
    expect: "settlement_unconfirmed",
    claimCalls: 1,
    providerCalls: 0,
    finalCalls: 0,
  },
  {
    name: "provider false retains the durable claim",
    claim: { data: [claimed], error: null },
    provider: "false",
    expect: "provider_failed",
    claimCalls: 1,
    providerCalls: 1,
    finalCalls: 0,
  },
  {
    name: "provider failure retains the durable claim",
    claim: { data: [claimed], error: null },
    provider: "throw",
    expect: "provider_failed",
    claimCalls: 1,
    providerCalls: 1,
    finalCalls: 0,
  },
  {
    name: "strict provider success finalizes once",
    claim: { data: [claimed], error: null },
    final: { data: "cleared", error: null },
    expect: "cleared",
    claimCalls: 1,
    providerCalls: 1,
    finalCalls: 1,
  },
  {
    name: "state changes remain blocked after provider success",
    claim: { data: [claimed], error: null },
    final: { data: "state_changed", error: null },
    expect: "state_changed",
    claimCalls: 1,
    providerCalls: 1,
    finalCalls: 1,
  },
  {
    name: "unknown finalization result remains fenced",
    claim: { data: [claimed], error: null },
    final: { data: "not_owner", error: null },
    expect: "settlement_unconfirmed",
    claimCalls: 1,
    providerCalls: 1,
    finalCalls: 1,
  },
  {
    name: "finalization error remains fenced",
    claim: { data: [claimed], error: null },
    final: { data: "cleared", error: { message: "fixture error" } },
    expect: "settlement_unconfirmed",
    claimCalls: 1,
    providerCalls: 1,
    finalCalls: 1,
  },
];

let assertions = 0;
for (const scenario of scenarios) {
  const result = await run(scenario);
  assert.equal(result.status.status, scenario.expect, `${scenario.name}: result`);
  assert.equal(
    result.calls.filter((call) => call.name === "claim_resend_suppression_recovery").length,
    scenario.claimCalls,
    `${scenario.name}: claim calls`
  );
  assert.equal(result.providerRecipients.length, scenario.providerCalls, `${scenario.name}: provider calls`);
  assert.equal(
    result.calls.filter((call) => call.name === "finalize_resend_suppression_recovery").length,
    scenario.finalCalls,
    `${scenario.name}: final calls`
  );
  if (scenario.finalCalls === 1) {
    const finalCall = result.calls.find((call) => call.name === "finalize_resend_suppression_recovery");
    assert.deepEqual(JSON.parse(JSON.stringify(finalCall?.args)), { p_user_id: USER_ID, p_recovery_token: TOKEN }, `${scenario.name}: final args`);
    assertions += 1;
  }
  assertions += 4;
}

console.log(`PASS verify-suppression-recovery (${assertions} assertions, DEFERRED protocol only, isolated test policy)`);
