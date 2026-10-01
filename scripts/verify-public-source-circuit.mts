// Offline fixtures. No server client, subscriber, source or email request.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPublicSourceCircuit, durablePublicSourceCircuitEnabled,
  PUBLIC_SOURCE_CIRCUIT_PROVIDERS, PublicSourceCircuitError } from "../lib/engine/public-source-circuit.ts";
import { createPublicSourceCache } from "../lib/engine/public-source-cache.ts";
import { createPublicFeedSearch } from "../lib/engine/public-feed-search.ts";
import { createPublisherFeedSearch } from "../lib/engine/publisher-feed-search.ts";
import { createOpenNewsFeedSearch } from "../lib/engine/open-news-feed-search.ts";
import { createResearchMetadataSearch } from "../lib/engine/research-metadata-search.ts";
import { createGdeltSearch } from "../lib/engine/gdelt-search.ts";

const savedFetch = globalThis.fetch;
const names = ["ALPHA_DURABLE_SOURCE_COOLDOWN", "ALPHA_NO_MODEL_MODE", "ALPHA_OPEN_NEWS_FALLBACK"];
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
let unexpectedFetches = 0;
globalThis.fetch = async () => { unexpectedFetches++; throw new Error("network denied"); };
type State = { generation: string; count: number; until: number; last: number; token: string | null; lease: number };
let now = Date.UTC(2026, 8, 30, 12);
const rows = new Map<string, State>();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const warnings: string[] = [];
const row = (provider: string) => {
  let state = rows.get(provider);
  if (!state) { state = { generation: randomUUID(), count: 0, until: 0, last: 0, token: null, lease: 0 }; rows.set(provider, state); }
  return state;
};
function mockClient() {
  return { rpc: async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    assert.ok(PUBLIC_SOURCE_CIRCUIT_PROVIDERS.includes(args.p_provider as never));
    const state = row(String(args.p_provider));
    if (name === "begin_alpha_public_source") {
      assert.deepEqual(Object.keys(args), ["p_provider"]);
      let admitted = true;
      let delay = 0;
      if (state.count) {
        if (state.lease > now || state.until > now) {
          admitted = false;
          delay = Math.ceil((Math.max(state.lease, state.until) - now) / 1000);
        } else if (now - state.last >= 86400000) {
          Object.assign(state, { count: 0, until: 0, last: 0, token: null, lease: 0, generation: randomUUID() });
        } else { state.token = randomUUID(); state.lease = now + 30000; }
      }
      return { data: [{ admitted, generation: state.generation, probe_token: admitted ? state.token : null, retry_after_sec: delay }], error: null };
    }
    assert.equal(name, "complete_alpha_public_source");
    assert.deepEqual(Object.keys(args), ["p_provider", "p_generation", "p_probe_token", "p_outcome"]);
    const owned = state.generation === args.p_generation && (args.p_probe_token === null
      ? state.count === 0 && state.token === null
      : state.token === args.p_probe_token && state.lease > now);
    if (!owned) return { data: false, error: null };
    if (args.p_outcome === "neutral") Object.assign(state, { token: null, lease: 0 });
    else if (args.p_outcome === "success") Object.assign(state, { count: 0, until: 0, last: 0, token: null, lease: 0, generation: randomUUID() });
    else {
      const count = now - state.last >= 86400000 ? 1 : Math.min(5, state.count + 1);
      Object.assign(state, { count, until: now + 900000 * 2 ** (count - 1), last: now, token: null, lease: 0, generation: randomUUID() });
    }
    return { data: true, error: null };
  } } as unknown as Pick<SupabaseClient, "rpc">;
}
const circuit = () => createPublicSourceCircuit({ enabled: () => true, loadClient: async () => mockClient(), warn: msg => warnings.push(msg) });
const noReserve = async () => {};
const fail = async () => { throw new Error("fixture provider failure"); };
const cooling = (error: unknown) => error instanceof PublicSourceCircuitError && error.code === "cooling_down";
const unavailable = (error: unknown) => error instanceof PublicSourceCircuitError && error.code === "unavailable";

try {
  delete process.env.ALPHA_DURABLE_SOURCE_COOLDOWN;
  assert.equal(durablePublicSourceCircuitEnabled(), false);
  process.env.ALPHA_DURABLE_SOURCE_COOLDOWN = " YES ";
  assert.equal(durablePublicSourceCircuitEnabled(), true);
  delete process.env.ALPHA_DURABLE_SOURCE_COOLDOWN;
  let loads = 0;
  const off = createPublicSourceCircuit({ enabled: () => false, loadClient: async () => { loads++; throw new Error("disabled loaded DB"); } });
  assert.equal(await off("google-rss", noReserve, async () => "valid"), "valid");
  assert.equal(loads, 0);
  await assert.rejects(off("private topic" as never, noReserve, fail), /Unknown/);

  const first = circuit(), second = circuit();
  let reservations = 0, fetches = 0;
  const reserve = async () => { reservations++; };
  await assert.rejects(first("google-rss", reserve, async () => { fetches++; return fail(); }), /fixture/);
  await assert.rejects(second("google-rss", reserve, async () => { fetches++; return []; }), cooling);
  assert.equal(reservations, 1);
  assert.equal(fetches, 1, "separate runner sees durable outage before budget/fetch");
  assert.equal(await second("publisher-fda-medwatch", noReserve, async () => "independent"), "independent");
  assert.equal(await second("publisher-fed-speeches", noReserve, async () => "independent"), "independent");

  now += 900000;
  let finish!: () => void;
  const pending = first("google-rss", noReserve, () => new Promise<string>(resolve => { finish = () => resolve("fresh metadata"); }));
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(second("google-rss", reserve, async () => "competing"), cooling);
  finish();
  assert.equal(await pending, "fresh metadata");
  assert.equal(row("google-rss").count, 0, "owned probe success clears state");

  // Healthy concurrent late success never clears a newer failure.
  let succeed!: () => void;
  const oldSuccess = first("google-rss", noReserve, () => new Promise<void>(resolve => { succeed = resolve; }));
  while (!succeed) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(second("google-rss", noReserve, fail));
  succeed(); await oldSuccess;
  assert.equal(row("google-rss").count, 1);
  // Repeated failures separated by expired cooldowns grow across processes.
  for (let count = 2; count <= 6; count++) {
    now = row("google-rss").until;
    await assert.rejects(circuit()("google-rss", noReserve, fail));
    assert.equal(row("google-rss").count, Math.min(5, count));
    assert.equal(row("google-rss").until - now, 900000 * 2 ** (Math.min(5, count) - 1));
  }

  now = row("google-rss").until;
  const before = { ...row("google-rss") };
  await assert.rejects(second("google-rss", async () => { throw new Error("quota unavailable"); }, async () => { throw new Error("unexpected work"); }), /quota/);
  assert.deepEqual(row("google-rss"), before, "neutral quota error releases only owned lease");

  // A valid raw cache hit remains usable during a subsequent source outage.
  rows.clear();
  const cache = createPublicSourceCache(() => now);
  const item = { title: "Generic source", url: "https://www.nist.gov/generic", description: "" };
  await cache("publisher-nist", "warm", () => first("publisher-nist", noReserve, async () => [item]));
  await assert.rejects(cache("publisher-nist", "new", () => second("publisher-nist", noReserve, fail)));
  const callsBeforeHit = rpcCalls.length;
  assert.deepEqual(await cache("publisher-nist", "warm", () => { throw new Error("unexpected cache miss"); }), [item]);
  assert.equal(rpcCalls.length, callsBeforeHit);
  now += 300000;
  await assert.rejects(cache("publisher-nist", "warm", () => second("publisher-nist", noReserve, async () => [item])), cooling);

  for (const bad of [null, [], [{}], [{ admitted: true, generation: randomUUID(), probe_token: null, retry_after_sec: 1 }],
    [{ admitted: false, generation: randomUUID(), probe_token: randomUUID(), retry_after_sec: 30 }]]) {
    const broken = createPublicSourceCircuit({ enabled: () => true, loadClient: async () => ({ rpc: async () => ({ data: bad, error: null }) }) as never });
    await assert.rejects(broken("gdelt", async () => { throw new Error("unexpected reservation"); }, fail), unavailable);
  }
  const stalled = createPublicSourceCircuit({ enabled: () => true, timeoutMs: 5,
    loadClient: async () => new Promise<Pick<SupabaseClient, "rpc">>(() => {}) });
  await assert.rejects(stalled("gdelt", async () => { throw new Error("unexpected reservation"); }, fail), unavailable);
  let releaseLoad!: (value: Pick<SupabaseClient, "rpc">) => void;
  const late = createPublicSourceCircuit({ enabled: () => true, timeoutMs: 5,
    loadClient: () => new Promise(resolve => { releaseLoad = resolve; }) });
  await assert.rejects(late("gdelt", async () => { throw new Error("unexpected reservation"); }, fail), unavailable);
  releaseLoad(mockClient());
  await new Promise(resolve => setImmediate(resolve));

  // Confirmed retrieval is useful even if optional recovery persistence fails.
  const brokenCompletion = createPublicSourceCircuit({ enabled: () => true, warn: msg => warnings.push(msg),
    loadClient: async () => ({ rpc: async (name: string) => name === "begin_alpha_public_source"
      ? { data: [{ admitted: true, generation: randomUUID(), probe_token: randomUUID(), retry_after_sec: 0 }], error: null }
      : { data: null, error: { message: "never print raw database error" } } }) as never });
  assert.equal(await brokenCompletion("gdelt", noReserve, async () => "validated"), "validated");
  assert.ok(warnings.some(msg => msg.includes("completion unavailable")));
  assert.ok(warnings.every(msg => !msg.includes("never print")));

  // All adapter entry points enforce a denied circuit before reservation/fetch.
  rows.clear(); now = Date.UTC(2026, 8, 30, 12);
  process.env.ALPHA_NO_MODEL_MODE = "1";
  process.env.ALPHA_OPEN_NEWS_FALLBACK = "1";
  for (const provider of PUBLIC_SOURCE_CIRCUIT_PROVIDERS) await assert.rejects(first(provider, noReserve, fail));
  const neverReserve = async () => { throw new Error("unexpected reservation"); };
  const neverFetch = async () => { throw new Error("unexpected outbound fetch"); };
  const deps = { now: () => now, reserve: neverReserve, fetcher: neverFetch, attempt: second };
  await assert.rejects(createPublicFeedSearch(() => now, deps)("generic offline topic"), cooling);
  const publisher = createPublisherFeedSearch(deps);
  await assert.rejects(publisher("ai-news"), cooling);
  await assert.rejects(publisher("longevity-wellness"), cooling);
  await assert.rejects(publisher("macro-markets"), cooling);
  await assert.rejects(createOpenNewsFeedSearch(deps)("music"), cooling);
  await assert.rejects(createResearchMetadataSearch(deps)("nutrition-food"), cooling);
  await assert.rejects(createGdeltSearch(deps)("generic offline topic"), cooling);
  assert.equal(unexpectedFetches, 0);
  assert.ok(!JSON.stringify(rpcCalls).includes("generic offline topic"), "topic text never enters circuit state");
  console.log("PASS public source circuit: cross-run expiry, fenced recovery, cache/privacy and all adapters (offline)");
} finally {
  globalThis.fetch = savedFetch;
  for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
}
