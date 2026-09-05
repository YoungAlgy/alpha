// Actual search helpers with controlled clocks and response bodies. No live
// credentials, requests, environment files, or provider clients are used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

type Provider = "brave" | "you";
type Behavior = "success" | "stalled_headers" | "stalled_success" | "stalled_error" | "malformed" | "fetch_error";
type Result = { title: string; url: string; description: string };
let assertions = 0;
function equal(actual: unknown, expected: unknown, label: string) {
  assertions++;
  assert.equal(actual, expected, label);
}
async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  assertions++;
  await assert.rejects(promise, pattern);
}

function harness(provider: Provider, behavior: Behavior, status = 429, configured = true) {
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let signal: AbortSignal | undefined;
  let bodyReads = 0;
  let fetchCalls = 0;
  let quotaCallbacks = 0;
  const abortError = new Error("fixture body aborted");
  const endpoint = provider === "brave" ? "https://api.search.brave.com/res/v1/web/search" : "https://ydc-index.io/v1/search";
  const exports: Record<string, unknown> = {};
  function waitForAbort(): Promise<never> {
    return new Promise((_, reject) => {
      if (signal!.aborted) reject(abortError);
      else signal!.addEventListener("abort", () => reject(abortError), { once: true });
    });
  }
  vm.runInNewContext(ts.transpileModule(
    readFileSync(new URL(provider === "brave" ? "../lib/brave.ts" : "../lib/you-search.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText, {
    exports,
    URL,
    URLSearchParams,
    AbortController,
    process: { env: configured ? { BRAVE_SEARCH_API_KEY: "offline", YOU_API_KEY: "offline" } : {} },
    setTimeout(callback: () => void, delay: number) {
      delays.push(delay);
      timers.set(1, callback);
      return 1;
    },
    clearTimeout(id: number) { timers.delete(id); },
    async fetch(input: string, init: { signal: AbortSignal }) {
      fetchCalls++;
      const url = new URL(input);
      equal(`${url.origin}${url.pathname}`, endpoint, "only expected provider URL");
      signal = init.signal;
      if (behavior === "fetch_error") throw new Error("fixture fetch failed");
      if (behavior === "stalled_headers") return waitForAbort();
      return {
        ok: behavior !== "stalled_error", status: behavior === "stalled_error" ? status : 200,
        async json() {
          bodyReads++;
          if (behavior === "stalled_success") return waitForAbort();
          if (behavior === "malformed") throw new Error("fixture invalid JSON");
          const result = { title: "Source", url: "https://example.org/source", description: "Source excerpt" };
          return provider === "brave" ? { web: { results: [result] } } : { results: { web: [result] } };
        },
        async text() { bodyReads++; return waitForAbort(); },
      };
    },
    require(name: string) { throw new Error(`Unexpected search import: ${name}`); },
  }, { timeout: 1000 });
  const search = exports[provider === "brave" ? "braveSearch" : "youSearch"] as
    (query: string, options: { onRateLimited: () => void }) => Promise<Result[]>;
  const count = exports[provider === "brave" ? "braveRateLimitedCount" : "youRateLimitedCount"] as () => number;
  return {
    start: () => search("offline query", { onRateLimited: () => { quotaCallbacks++; } }),
    fire: () => { for (const callback of [...timers.values()]) callback(); },
    snapshot: () => ({ timers: timers.size, delays, aborted: signal?.aborted, bodyReads, fetchCalls, quota: count(), quotaCallbacks }),
  };
}

for (const provider of ["brave", "you"] as const) {
  for (const behavior of ["stalled_headers", "stalled_success", "stalled_error"] as const) {
    for (const status of behavior === "stalled_error" ? [402, 429, 503] : [200]) {
      const test = harness(provider, behavior, status);
      const promise = test.start();
      const rejected = rejects(promise, behavior === "stalled_error" ? new RegExp(`Search ${status}:`) : /fixture body aborted/);
      // Let the immediate headers arrive and body consumption start.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const pending = test.snapshot();
      equal(pending.fetchCalls, 1, "one provider attempt");
      equal(pending.timers, 1, "timer remains active through stalled response");
      equal(pending.delays[0], 5000, "existing five-second budget retained");
      equal(pending.bodyReads, behavior === "stalled_headers" ? 0 : 1, "body read reached after headers");
      test.fire();
      await rejected;
      const done = test.snapshot();
      equal(done.aborted, true, "underlying provider signal aborted");
      equal(done.timers, 0, "timer cleared on failure");
      const quota = behavior === "stalled_error" && (status === 402 || status === 429) ? 1 : 0;
      equal(done.quota, quota, "global quota count preserved");
      equal(done.quotaCallbacks, quota, "per-call quota callback preserved");
    }
  }
  const success = harness(provider, "success");
  const results = await success.start();
  equal(results.length, 1, "successful results retained");
  equal(results[0].url, "https://example.org/source", "exact source URL retained");
  equal(results[0].description, "Source excerpt", "source description retained");
  equal(success.snapshot().timers, 0, "success clears timer");
  equal(success.snapshot().aborted, false, "success does not abort finished response");
  for (const behavior of ["malformed", "fetch_error"] as const) {
    const failed = harness(provider, behavior);
    await rejects(failed.start(), /fixture (invalid JSON|fetch failed)/);
    equal(failed.snapshot().timers, 0, "parse and header failures clear timer");
  }
  const unavailable = harness(provider, "success", 200, false);
  await rejects(unavailable.start(), /API_KEY missing/);
  equal(unavailable.snapshot().fetchCalls, 0, "missing configuration makes no request");
  equal(unavailable.snapshot().timers, 0, "missing configuration creates no timer");
}
console.log(`PASS verify-search-body-deadlines (${assertions} assertions, controlled clocks and response bodies)`);
