// Pure Brave quota-circuit checks. Every request is intercepted locally.
import assert from "node:assert/strict";
import { braveRateLimitedCount, braveSearch, type BraveQuotaState } from "../lib/brave.ts";

const originalFetch = globalThis.fetch;
const originalKey = process.env.BRAVE_SEARCH_API_KEY;
const monthly = { status: 402, code: "USAGE_LIMIT_EXCEEDED", meta: { usage_limit_type: "monthly" } };
const success = () => new Response(JSON.stringify({ web: { results: [
  { title: "A real source", url: "https://example.org/story", description: "Excerpt" },
] } }), { status: 200 });
const errorResponse = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

try {
  process.env.BRAVE_SEARCH_API_KEY = "offline-test-only";
  let calls = 0;
  let callbacks = 0;
  const quotaState: BraveQuotaState = { monthlyExhausted: false };
  const baseline = braveRateLimitedCount();
  globalThis.fetch = async () => { calls++; return errorResponse(402, monthly); };
  await assert.rejects(braveSearch("first", { quotaState, onRateLimited: () => { callbacks++; } }), /Brave Search 402/);
  assert.equal(quotaState.monthlyExhausted, true, "confirmed top-level monthly 402 trips this scope");
  assert.equal(braveRateLimitedCount() - baseline, 1, "real 402 increments provider-response counter");
  await assert.rejects(braveSearch("later", { quotaState, onRateLimited: () => { callbacks++; } }), /monthly quota exhausted.*request skipped/);
  assert.equal(calls, 1, "later query in the same scope never reaches fetch");
  assert.equal(callbacks, 2, "both real 402 and local skip tell resolver to fall back");
  assert.equal(braveRateLimitedCount() - baseline, 1, "local skip is not a second provider response");

  const fresh: BraveQuotaState = { monthlyExhausted: false };
  globalThis.fetch = async () => { calls++; return success(); };
  assert.equal((await braveSearch("new request", { quotaState: fresh })).length, 1);
  assert.equal(calls, 2, "a fresh request scope permits Brave again");
  assert.equal(fresh.monthlyExhausted, false);

  for (const [label, status, body] of [
    ["generic 402", 402, { status: 402, code: "PAYMENT_REQUIRED" }],
    ["transient 429", 429, monthly],
    ["malformed 402", 402, "{not-json"],
    ["other usage limit", 402, { ...monthly, meta: { usage_limit_type: "daily" } }],
  ] as const) {
    const state: BraveQuotaState = { monthlyExhausted: false };
    let localCalls = 0;
    globalThis.fetch = async () => {
      localCalls++;
      return localCalls === 1 ? errorResponse(status, body) : success();
    };
    await assert.rejects(braveSearch(label, { quotaState: state }), new RegExp(`Brave Search ${status}`));
    assert.equal(state.monthlyExhausted, false, `${label} does not trip monthly circuit`);
    assert.equal((await braveSearch(`${label} retry`, { quotaState: state })).length, 1);
    assert.equal(localCalls, 2, `${label} allows a later provider query`);
  }

  const oversized: BraveQuotaState = { monthlyExhausted: false };
  let oversizedCalls = 0;
  globalThis.fetch = async () => {
    oversizedCalls++;
    return oversizedCalls === 1
      ? errorResponse(402, { ...monthly, padding: "x".repeat(8192) })
      : success();
  };
  await assert.rejects(braveSearch("oversized body", { quotaState: oversized }), /Brave Search 402/);
  assert.equal(oversized.monthlyExhausted, false, "oversized 402 body cannot trip bounded parser");
  assert.equal((await braveSearch("after oversized", { quotaState: oversized })).length, 1);
  assert.equal(oversizedCalls, 2, "oversized response allows a later provider query");

  const transport: BraveQuotaState = { monthlyExhausted: false };
  let transportCalls = 0;
  globalThis.fetch = async () => {
    transportCalls++;
    if (transportCalls === 1) throw new Error("fixture transport failure");
    return success();
  };
  await assert.rejects(braveSearch("transport error", { quotaState: transport }), /fixture transport failure/);
  assert.equal(transport.monthlyExhausted, false, "transport failure cannot establish monthly cap");
  assert.equal((await braveSearch("after transport", { quotaState: transport })).length, 1);
  assert.equal(transportCalls, 2, "transport failure allows a later provider query");

  const nested: BraveQuotaState = { monthlyExhausted: false };
  globalThis.fetch = async () => errorResponse(402, { error: monthly });
  await assert.rejects(braveSearch("nested error", { quotaState: nested }), /Brave Search 402/);
  assert.equal(nested.monthlyExhausted, true, "nested error object also confirms monthly cap");

  const unreadable: BraveQuotaState = { monthlyExhausted: false };
  let unreadableCalls = 0;
  globalThis.fetch = async () => {
    unreadableCalls++;
    if (unreadableCalls > 1) return success();
    return { ok: false, status: 402, text: async () => { throw new Error("body read failed"); } } as Response;
  };
  await assert.rejects(braveSearch("unreadable body", { quotaState: unreadable }), /Brave Search 402/);
  assert.equal(unreadable.monthlyExhausted, false, "unreadable error body cannot establish monthly cap");
  assert.equal((await braveSearch("after unreadable", { quotaState: unreadable })).length, 1);
  assert.equal(unreadableCalls, 2);

  const shared: BraveQuotaState = { monthlyExhausted: false };
  let releaseSlow!: (response: Response) => void;
  const slowResponse = new Promise<Response>((resolve) => { releaseSlow = resolve; });
  let parallelCalls = 0;
  globalThis.fetch = async (input) => {
    parallelCalls++;
    const query = new URL(String(input)).searchParams.get("q");
    return query === "slow" ? slowResponse : errorResponse(402, monthly);
  };
  const inFlight = braveSearch("slow", { quotaState: shared });
  await assert.rejects(braveSearch("monthly", { quotaState: shared }), /Brave Search 402/);
  assert.equal(shared.monthlyExhausted, true);
  releaseSlow(success());
  assert.equal((await inFlight).length, 1, "in-flight success remains usable after sibling trips circuit");
  assert.equal(parallelCalls, 2, "both requests were already in flight");
  await assert.rejects(braveSearch("after parallel", { quotaState: shared }), /request skipped/);
  assert.equal(parallelCalls, 2, "subsequent request is skipped");

  console.log("PASS verify-brave-monthly-quota (mocked requests only)");
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalKey;
}
