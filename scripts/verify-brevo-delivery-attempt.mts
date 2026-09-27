import assert from "node:assert/strict";
import { BrevoDeliveryAttemptError, sendWithBrevoDeliveryAttempt } from "../lib/brevo-delivery-attempt.ts";
import { prepareBrevoCandidateEmail, type BrevoHttpTransport, type BrevoPreparedEmail } from "../lib/brevo-transport.ts";

// All collaborators are in-memory. This file never opens a database connection,
// reads an environment file, or uses a real HTTP transport.
const draft = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  sender: { email: "alpha@everyday.report", name: "alpha." },
  recipient: "reader@example.com",
  replyTo: "alpha@everyday.report",
  subject: "Offline issue",
  html: "<p>Offline body</p>",
  text: "Offline body",
};
const preparedResult = prepareBrevoCandidateEmail(draft);
assert.equal(preparedResult.status, "prepared");
if (preparedResult.status !== "prepared") throw new Error("unexpected preparation result");
const prepared = preparedResult.prepared;
const userId = "22222222-2222-4222-8222-222222222222";
const weekOf = "2026-09-26";
const expectedClaimedAt = new Date().toISOString();
const options = { apiKey: "offline-only-key" };
const acceptedAt = new Date().toISOString();
const messageId = "Case.Sensitive@Brevo";

type RpcArgs = Record<string, unknown>;
type RpcResult = { data: unknown; error: unknown };
type RpcCall = { name: string; args: RpcArgs };
type ClaimOverride = (args: RpcArgs) => RpcResult | Promise<RpcResult>;
type FinalizeOverride = (args: RpcArgs) => RpcResult | Promise<RpcResult>;

function claimedRow(): Record<string, unknown> {
  return {
    delivery_status: "claimed",
    stored_recipient: prepared.recipient,
    stored_attempt_id: prepared.attemptId,
    stored_message_id: null,
    stored_accepted_at: null,
    stored_lease_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

function finalizedRow(): Record<string, unknown> {
  return {
    delivery_status: "recorded",
    stored_accepted_at: acceptedAt,
    suppression_review_required: false,
  };
}

function harness(config: {
  claim?: ClaimOverride;
  finalize?: FinalizeOverride;
  transport?: BrevoHttpTransport;
  mark?: () => RpcResult | Promise<RpcResult>;
  prepared?: BrevoPreparedEmail;
} = {}) {
  const calls: RpcCall[] = [];
  let dispatches = 0;
  const sb = {
    async rpc(name: string, args: RpcArgs): Promise<RpcResult> {
      calls.push({ name, args });
      if (name === "claim_brevo_delivery_attempt") {
        return config.claim ? config.claim(args) : { data: [claimedRow()], error: null };
      }
      if (name === "finalize_brevo_delivery_attempt") {
        return config.finalize ? config.finalize(args) : { data: [finalizedRow()], error: null };
      }
      if (name === "mark_brevo_delivery_unconfirmed") {
        return config.mark ? config.mark() : { data: null, error: null };
      }
      throw new Error("unexpected RPC");
    },
  };
  const transport: BrevoHttpTransport = async (url, init) => {
    dispatches++;
    if (config.transport) return config.transport(url, init);
    assert.equal(url, "https://api.brevo.com/v3/smtp/email");
    assert.equal(init.body, prepared.serializedBody);
    return Response.json({ messageId: `<${messageId}>` }, { status: 201 });
  };
  const params = {
    sb: sb as never,
    userId,
    weekOf,
    expectedClaimedAt,
    prepared: config.prepared ?? prepared,
    options,
    transport,
  };
  return { params, calls, dispatches: () => dispatches };
}

async function expectFailure(
  run: () => Promise<unknown>, stage: BrevoDeliveryAttemptError["stage"], code: string,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof BrevoDeliveryAttemptError);
    assert.equal(error.stage, stage);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes("raw-private"));
    return true;
  });
}

let cases = 0;
async function check(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  cases++;
  console.log(`PASS ${name}`);
}

await check("fresh exact claim dispatches once then finalizes", async () => {
  const h = harness();
  const result = await sendWithBrevoDeliveryAttempt(h.params);
  assert.deepEqual(result, {
    providerSent: true, messageId, acceptedAt, suppressionReviewRequired: false,
  });
  assert.equal(h.dispatches(), 1);
  assert.deepEqual(h.calls.map((call) => call.name), [
    "claim_brevo_delivery_attempt", "finalize_brevo_delivery_attempt",
  ]);
  assert.equal(h.calls[0].args.p_request_fingerprint, prepared.requestFingerprint);
  assert.equal(h.calls[0].args.p_recipient, prepared.recipient);
  assert.equal(h.calls[0].args.p_attempt_id, prepared.attemptId);
  assert.equal(h.calls[1].args.p_message_id, messageId);
  assert.equal(h.calls[0].args.p_lease_token, h.calls[1].args.p_lease_token);
  assert.equal("p_provider" in h.calls[0].args, false);
  assert.equal("p_lane" in h.calls[0].args, false);
});

await check("lost claim response never dispatches", async () => {
  const failures: Array<[ClaimOverride, string]> = [
    [async () => { throw new Error("raw-private-db-error"); }, "claim_failed"],
    [async () => ({ data: null, error: { message: "raw-private-db-error" } }), "claim_failed"],
    [async () => ({ data: null, error: null }), "not_claimed"],
  ];
  for (const [claim, code] of failures) {
    const h = harness({ claim });
    await expectFailure(() => sendWithBrevoDeliveryAttempt(h.params), "claim", code);
    assert.deepEqual(h.calls.map((call) => call.name), ["claim_brevo_delivery_attempt"]);
    assert.equal(h.dispatches(), 0);
  }
});

await check("existing provider or wrong claim identity never dispatches", async () => {
  const changes: Array<[string, Record<string, unknown>]> = [
    ["existing provider", { delivery_status: "provider_conflict" }],
    ["existing attempt", { delivery_status: "manual_review" }],
    ["recipient", { stored_recipient: "other@example.com" }],
    ["attempt", { stored_attempt_id: "33333333-3333-4333-8333-333333333333" }],
    ["short lease", { stored_lease_expires_at: new Date(Date.now() + 3 * 60_000).toISOString() }],
    ["malformed lease", { stored_lease_expires_at: "nonsense" }],
  ];
  for (const [label, change] of changes) {
    const h = harness({ claim: async () => ({ data: [{ ...claimedRow(), ...change }], error: null }) });
    await expectFailure(() => sendWithBrevoDeliveryAttempt(h.params), "claim", "not_claimed");
    assert.equal(h.dispatches(), 0, label);
  }
});

await check("accepted proof skips provider and finalizer", async () => {
  const h = harness({ claim: async () => ({
    data: [{
      ...claimedRow(), delivery_status: "accepted",
      stored_message_id: messageId, stored_accepted_at: acceptedAt,
    }], error: null,
  }) });
  const result = await sendWithBrevoDeliveryAttempt(h.params);
  assert.deepEqual(result, {
    providerSent: false, messageId, acceptedAt, suppressionReviewRequired: true,
  });
  assert.equal(h.dispatches(), 0);
  assert.deepEqual(h.calls.map((call) => call.name), ["claim_brevo_delivery_attempt"]);
});

await check("accepted proof requires same recipient and valid proof", async () => {
  for (const change of [
    { stored_recipient: "other@example.com" },
    { stored_message_id: "<bad-angle@Brevo>" },
    { stored_accepted_at: "bad-clock" },
  ]) {
    const h = harness({ claim: async () => ({ data: [{
      ...claimedRow(), delivery_status: "accepted", stored_message_id: messageId,
      stored_accepted_at: acceptedAt, ...change,
    }], error: null }) });
    await expectFailure(() => sendWithBrevoDeliveryAttempt(h.params), "claim", "invalid_accepted_state");
    assert.equal(h.dispatches(), 0);
  }
});

await check("accepted proof from prior attempt skips changed payload", async () => {
  const newDraft = prepareBrevoCandidateEmail({
    ...draft, attemptId: "33333333-3333-4333-8333-333333333333", text: "Changed body",
  });
  assert.equal(newDraft.status, "prepared");
  if (newDraft.status !== "prepared") throw new Error("unexpected preparation result");
  const h = harness({
    prepared: newDraft.prepared,
    claim: async () => ({ data: [{
      delivery_status: "accepted", stored_recipient: prepared.recipient,
      stored_attempt_id: prepared.attemptId, stored_message_id: messageId,
      stored_accepted_at: acceptedAt, stored_lease_expires_at: null,
    }], error: null }),
  });
  const result = await sendWithBrevoDeliveryAttempt(h.params);
  assert.equal(result.providerSent, false);
  assert.equal(result.messageId, messageId);
  assert.equal(h.dispatches(), 0);
});

await check("ambiguous send marks manual review without retry", async () => {
  const h = harness({ transport: async () => new Response(null, { status: 500 }) });
  await expectFailure(() => sendWithBrevoDeliveryAttempt(h.params), "send", "unconfirmed");
  assert.equal(h.dispatches(), 1);
  assert.deepEqual(h.calls.map((call) => call.name), [
    "claim_brevo_delivery_attempt", "mark_brevo_delivery_unconfirmed",
  ]);
});

await check("second job after ambiguity cannot dispatch", async () => {
  let claims = 0;
  const h = harness({
    claim: async () => ({ data: [{
      ...claimedRow(), delivery_status: ++claims === 1 ? "claimed" : "manual_review",
    }], error: null }),
    transport: async () => new Response(null, { status: 429 }),
  });
  await expectFailure(() => sendWithBrevoDeliveryAttempt(h.params), "send", "unconfirmed");
  await expectFailure(() => sendWithBrevoDeliveryAttempt(h.params), "claim", "not_claimed");
  assert.equal(h.dispatches(), 1);
  assert.deepEqual(h.calls.map((call) => call.name), [
    "claim_brevo_delivery_attempt", "mark_brevo_delivery_unconfirmed",
    "claim_brevo_delivery_attempt",
  ]);
});

await check("caller cannot switch provider or lane", async () => {
  const h = harness();
  const result = await sendWithBrevoDeliveryAttempt({
    ...h.params, provider: "resend", lane: "force-other",
  } as never);
  assert.equal(result.providerSent, true);
  assert.equal(h.dispatches(), 1);
  assert.deepEqual(h.calls.map((call) => call.name), [
    "claim_brevo_delivery_attempt", "finalize_brevo_delivery_attempt",
  ]);
  assert.equal("p_provider" in h.calls[0].args, false);
  assert.equal("p_lane" in h.calls[0].args, false);
});

await check("failed finalization marks review and redacts error", async () => {
  const h = harness({ finalize: async () => { throw new Error("raw-private-db-error"); } });
  await expectFailure(() => sendWithBrevoDeliveryAttempt(h.params), "finalize", "acceptance_write_failed");
  assert.equal(h.dispatches(), 1);
  assert.deepEqual(h.calls.map((call) => call.name), [
    "claim_brevo_delivery_attempt", "finalize_brevo_delivery_attempt", "mark_brevo_delivery_unconfirmed",
  ]);
});

await check("malformed finalization result marks review", async () => {
  for (const badRow of [
    { ...finalizedRow(), delivery_status: "conflict" },
    { ...finalizedRow(), stored_accepted_at: "bad-clock" },
    { ...finalizedRow(), suppression_review_required: "false" },
  ]) {
    const h = harness({ finalize: async () => ({ data: [badRow], error: null }) });
    await expectFailure(() => sendWithBrevoDeliveryAttempt(h.params), "finalize", "acceptance_write_failed");
    assert.equal(h.dispatches(), 1);
    assert.equal(h.calls.at(-1)?.name, "mark_brevo_delivery_unconfirmed");
  }
});

await check("invalid inputs stop before claim", async () => {
  const invalid: Array<Record<string, unknown>> = [
    { prepared: { ...prepared } },
    { prepared: { ...prepared, requestFingerprint: "0".repeat(64) } },
    { userId: "invalid" },
    { weekOf: "2026-02-30" },
    { expectedClaimedAt: "invalid" },
    { options: { apiKey: " " } },
    { transport: undefined },
  ];
  for (const change of invalid) {
    const h = harness();
    await expectFailure(() => sendWithBrevoDeliveryAttempt({ ...h.params, ...change } as never),
      "claim", "invalid_input");
    assert.deepEqual(h.calls, []);
    assert.equal(h.dispatches(), 0);
  }
});

console.log(`PASS verify-brevo-delivery-attempt (${cases} cases, injected RPC and HTTP only)`);
