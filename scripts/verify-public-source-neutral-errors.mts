// Offline control-error fixtures only. No source, database, secret or env read.
import assert from "node:assert/strict";
import { createPublicSourceCache } from "../lib/engine/public-source-cache.ts";
import { PublicSourceBudgetError } from "../lib/engine/public-source-budget.ts";
import { PublicSourceCircuitError } from "../lib/engine/public-source-circuit.ts";
import { PublicSourceControlError } from "../lib/engine/public-source-error-policy.ts";
import { createGdeltSearch } from "../lib/engine/gdelt-search.ts";
import { createResearchMetadataSearch } from "../lib/engine/research-metadata-search.ts";

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("network denied"); };
const baseNow = Date.UTC(2026, 8, 30, 12);
const neutralErrors = () => [
  new PublicSourceCircuitError("unavailable", "google-rss"),
  new PublicSourceCircuitError("cooling_down", "google-rss"),
  new PublicSourceBudgetError("unavailable", "google-rss"),
  new PublicSourceBudgetError("exhausted", "google-rss"),
];
const passThroughAttempt = async <T>(_provider: never, reserve: () => Promise<void>, work: () => Promise<T>): Promise<T> => {
  await reserve();
  return work();
};
const validGdelt = () => new Response("<rss><channel></channel></rss>", {
  status: 200, headers: { "content-type": "application/rss+xml" },
});
const validCrossref = () => new Response(JSON.stringify({
  status: "ok", "message-type": "work-list", message: { items: [] },
}), { status: 200, headers: { "content-type": "application/json" } });

try {
  // Durable admission and budget controls do not poison other cache keys.
  for (const error of neutralErrors()) {
    let calls = 0;
    const cache = createPublicSourceCache(() => baseNow);
    await assert.rejects(cache("provider", "blocked", async () => { throw error; }), (caught) => caught === error);
    assert.deepEqual(await cache("provider", "next", async () => { calls++; return []; }), []);
    assert.equal(calls, 1, `${error.name}:${error.code} left no cache cooldown`);
  }

  // Cache capacity and cooling controls do not create or extend backoff.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const capacityCache = createPublicSourceCache(() => baseNow);
  const pending = Array.from({ length: 8 }, (_, index) =>
    capacityCache(`busy-${index}`, "key", async () => { await gate; return []; }));
  await assert.rejects(capacityCache("capacity-target", "blocked", async () => []),
    (error: unknown) => error instanceof PublicSourceControlError && /capacity/.test(error.message));
  release();
  await Promise.all(pending);
  assert.deepEqual(await capacityCache("capacity-target", "next", async () => []), []);

  let cacheNow = baseNow;
  let realCacheFailures = 0;
  const failureCache = createPublicSourceCache(() => cacheNow);
  await assert.rejects(failureCache("real", "first", async () => {
    realCacheFailures++;
    throw new Error("real source failure");
  }), /real source failure/);
  await assert.rejects(failureCache("real", "second", async () => []), /cooling down/);
  cacheNow += 60_000;
  assert.deepEqual(await failureCache("real", "third", async () => []), []);
  assert.equal(realCacheFailures, 1, "real cache failure kept one bounded cooldown");

  // An expired failure era keeps its count through a neutral rejection.
  let historyNow = baseNow;
  const historyCache = createPublicSourceCache(() => historyNow);
  await assert.rejects(historyCache("history", "failure-one", async () => {
    throw new Error("first real source failure");
  }), /first real source failure/);
  historyNow += 60_000;
  await assert.rejects(historyCache("history", "neutral", async () => {
    throw new PublicSourceBudgetError("unavailable", "publisher-rss");
  }), (error: unknown) => error instanceof PublicSourceBudgetError);
  await assert.rejects(historyCache("history", "failure-two", async () => {
    throw new Error("second real source failure");
  }), /second real source failure/);
  historyNow += 60_000;
  await assert.rejects(historyCache("history", "still-cooling", async () => []), /cooling down/);
  historyNow += 60_000;
  assert.deepEqual(await historyCache("history", "recovered", async () => []), []);

  // GDELT leaves circuit and budget controls neutral across different queries.
  for (const error of neutralErrors()) {
    let now = baseNow;
    let calls = 0;
    const mapped = error instanceof PublicSourceBudgetError
      ? new PublicSourceBudgetError(error.code, "gdelt")
      : new PublicSourceCircuitError(error.code, "gdelt");
    const search = createGdeltSearch({
      now: () => now,
      sleep: async (ms) => { now += ms; },
      attempt: async () => { calls++; if (calls === 1) throw mapped; return []; },
    });
    await assert.rejects(search("first neutral topic"), (caught) => caught === mapped);
    assert.deepEqual(await search("second neutral topic"), []);
    assert.equal(calls, 2, `GDELT retried after ${mapped.name}:${mapped.code}`);
  }

  // GDELT queue-full and local-cooling controls do not extend backoff.
  let gdeltNow = baseNow;
  let gdeltAttempts = 0;
  const queuedGdelt = createGdeltSearch({
    now: () => gdeltNow,
    sleep: async () => {},
    attempt: async () => { gdeltAttempts++; return []; },
  });
  for (let index = 0; index < 4; index++) await queuedGdelt(`queued topic ${index}`);
  await assert.rejects(queuedGdelt("queue overflow topic"), /queue is full/);
  gdeltNow += 20_000;
  assert.deepEqual(await queuedGdelt("after queue topic"), []);
  assert.equal(gdeltAttempts, 5, "GDELT queue overflow left no source cooldown");

  let gdeltFetches = 0;
  const failingGdelt = createGdeltSearch({
    now: () => gdeltNow,
    sleep: async (ms) => { gdeltNow += ms; },
    reserve: async () => {},
    attempt: passThroughAttempt as never,
    fetcher: async () => ++gdeltFetches === 1 ? new Response("", { status: 503 }) : validGdelt(),
  });
  await assert.rejects(failingGdelt("real failure one"), /503/);
  await assert.rejects(failingGdelt("real failure two"), /cooling down/);
  gdeltNow += 60_000;
  assert.deepEqual(await failingGdelt("real failure three"), []);
  assert.equal(gdeltFetches, 2, "GDELT real failure kept one bounded cooldown");

  // Crossref leaves circuit and budget controls neutral across cache keys.
  for (const error of neutralErrors()) {
    let now = baseNow;
    let calls = 0;
    const mapped = error instanceof PublicSourceBudgetError
      ? new PublicSourceBudgetError(error.code, "publisher-rss")
      : new PublicSourceCircuitError(error.code, "crossref-research");
    const search = createResearchMetadataSearch({
      now: () => now,
      sleep: async (ms) => { now += ms; },
      attempt: async () => { calls++; if (calls === 1) throw mapped; return []; },
    });
    await assert.rejects(search("nutrition-food", { freshness: "pd" }), (caught) => caught === mapped);
    assert.deepEqual(await search("nutrition-food", { freshness: "pw" }), []);
    assert.equal(calls, 2, `Crossref retried after ${mapped.name}:${mapped.code}`);
  }

  // Crossref queue-full and queue-timeout controls leave provider state neutral.
  let researchNow = baseNow;
  let releaseResearch!: () => void;
  const researchGate = new Promise<void>((resolve) => { releaseResearch = resolve; });
  let researchAttempts = 0;
  const queuedResearch = createResearchMetadataSearch({
    now: () => researchNow,
    sleep: async (ms) => { researchNow += ms; },
    attempt: async () => { researchAttempts++; if (researchAttempts === 1) await researchGate; return []; },
  });
  const freshness = ["pd", "pw", "pm", "2026-09-28to2026-09-30"] as const;
  const researchPending = freshness.map((value) => queuedResearch("nutrition-food", { freshness: value }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(queuedResearch("nutrition-food", { freshness: "2026-09-27to2026-09-30" }), /queue full/);
  releaseResearch();
  await Promise.all(researchPending);
  assert.deepEqual(await queuedResearch("nutrition-food", { freshness: "2026-09-26to2026-09-30" }), []);

  let forceTimeout = false;
  researchNow = baseNow;
  let timeoutAttempts = 0;
  const timedResearch = createResearchMetadataSearch({
    now: () => researchNow,
    sleep: async (ms) => { researchNow += forceTimeout ? 15_000 : ms; },
    attempt: async () => { timeoutAttempts++; return []; },
  });
  await timedResearch("nutrition-food", { freshness: "pd" });
  forceTimeout = true;
  await assert.rejects(timedResearch("nutrition-food", { freshness: "pw" }), /queue timed out/);
  forceTimeout = false;
  assert.deepEqual(await timedResearch("nutrition-food", { freshness: "pm" }), []);
  assert.equal(timeoutAttempts, 2, "timed-out Crossref work never ran and left no cooldown");

  let crossrefFetches = 0;
  researchNow = baseNow;
  const failingResearch = createResearchMetadataSearch({
    now: () => researchNow,
    sleep: async (ms) => { researchNow += ms; },
    reserve: async () => {},
    attempt: passThroughAttempt as never,
    fetcher: async () => ++crossrefFetches === 1 ? new Response("", { status: 503 }) : validCrossref(),
  });
  await assert.rejects(failingResearch("nutrition-food", { freshness: "pd" }), /503/);
  await assert.rejects(failingResearch("nutrition-food", { freshness: "pw" }), /cooling down/);
  researchNow += 60_000;
  assert.deepEqual(await failingResearch("nutrition-food", { freshness: "pm" }), []);
  assert.equal(crossrefFetches, 2, "Crossref real failure kept one bounded cooldown");

  console.log("PASS public source neutral errors, local controls and real-failure cooldowns (offline)");
} finally {
  globalThis.fetch = originalFetch;
}
