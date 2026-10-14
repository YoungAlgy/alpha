// Generic offline fixtures. Actual source controls run against injected local
// transports and a fake cross-run ledger. No subscriber, provider or env files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { consumeDistributedRateLimit } from "../lib/distributed-rate-limit";
import { createOpenAlexMetadataSearch, openAlexMetadataFallbackEnabled } from "../lib/engine/openalex-metadata-search";
import * as metadata from "../lib/engine/openalex-metadata";
import { createPublicSourceBudget, PublicSourceBudgetError } from "../lib/engine/public-source-budget";
import { createPublicSourceCircuit, PublicSourceCircuitError } from "../lib/engine/public-source-circuit";
import { buildDeterministicBlurb } from "../lib/engine/deterministic-fallback";
import * as attribution from "../lib/source-attribution";
import * as topics from "../lib/topics";
import * as queries from "../lib/engine/topic-queries";
import * as rank from "../lib/engine/source-rank";
import * as urlGuard from "../lib/engine/url-guard";
import * as textClean from "../lib/engine/text-clean";
import * as promptFence from "../lib/prompt-fence";
import * as evidence from "../lib/engine/source-evidence";
import type { BraveSearchOptions } from "../lib/brave";
import type { TopicId } from "../lib/types";
type RpcClient = Pick<SupabaseClient, "rpc">;
type Consume = typeof consumeDistributedRateLimit;

let checks = 0, external = 0;
const eq = (a: unknown, b: unknown) => { assert.deepEqual(a, b); checks++; };
const ok = (a: unknown) => { assert.ok(a); checks++; };
const rejected = async (work: () => Promise<unknown>, predicate?: (e: unknown) => boolean) => {
  await assert.rejects(work, predicate); checks++;
};
const deny = () => { external++; throw new Error("Offline fixture denies external work"); };
const oldFetch = globalThis.fetch, oldWarn = console.warn;
const flags = ["ALPHA_NO_MODEL_MODE", "ALPHA_OPENALEX_METADATA_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET", "ALPHA_DURABLE_SOURCE_COOLDOWN"];
const saved = new Map(flags.map(name => [name, process.env[name]]));
const DAY = 86_400_000;
let clock = Date.parse("2026-10-13T18:00:00Z");
const topic = "custom:artificial intelligence research" as TopicId;
const opts: BraveSearchOptions = { freshness: "2026-10-12to2026-10-13" };
const row = (id = "W123", doi = "10.1234/AI(2026)123", title = "Artificial intelligence research &amp; data") => ({
  id: `https://openalex.org/${id}`, doi: `https://doi.org/${doi}`, title,
  publication_date: "2026-10-12", publication_year: 2026, type: "article", language: "en",
  is_retracted: false, indexed_in: ["crossref"],
});
const envelope = (rows: unknown[] = [row()], count = rows.length) => ({ meta: { count, page: 1, per_page: 20 }, results: rows });
const response = (body: unknown = envelope()) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
let fetches = 0, reservations = 0, admissions = 0;
const make = (fetcher: typeof fetch = async (input, init) => {
  fetches++;
  const url = new URL(String(input));
  eq(url.origin, "https://api.openalex.org"); eq(url.pathname, "/works");
  eq(url.searchParams.get("search.title"), "artificial intelligence");
  eq(url.searchParams.get("filter"), "from_publication_date:2026-10-06,to_publication_date:2026-10-12,type:article,language:en,is_retracted:false,has_doi:true");
  eq(init?.credentials, "omit"); eq(init?.redirect, "error"); eq(init?.cache, "no-store");
  eq(init?.headers, { Accept: "application/json" });
  return response();
}, timeoutMs = 100) => createOpenAlexMetadataSearch({ fetcher, now: () => clock, timeoutMs,
  reserve: async provider => { eq(provider, "openalex-research"); reservations++; },
  attempt: async (provider, reserve, work) => { eq(provider, "openalex-research"); admissions++; await reserve(); return work(); },
});

try {
  globalThis.fetch = deny as typeof fetch; console.warn = () => {};
  for (const flag of flags) process.env[flag] = "1";
  const adapter = make();
  for (const flag of flags) {
    delete process.env[flag]; eq(openAlexMetadataFallbackEnabled(), false); eq(await adapter(topic, opts), []);
    process.env[flag] = "1";
  }
  eq(await adapter("music-hiphop", opts), []);
  eq(await adapter("ai-news", opts), []);
  eq(await adapter("custom:private reader interests", opts), []);
  eq(await adapter(topic, { freshness: "pd" }), []);
  eq(await adapter(topic, { freshness: "impossible" }), []);
  eq(fetches, 0); eq(reservations, 0); eq(admissions, 0);
  const [first, coalesced] = await Promise.all([adapter(topic, opts), adapter(topic, opts)]);
  eq(fetches, 1); eq(reservations, 1); eq(admissions, 1); eq(first, coalesced);
  eq(first[0]?.age, "2026-10-12"); eq(first[0]?.description, "");
  eq(first[0]?.url, "https://doi.org/10.1234/AI(2026)123");
  assert.throws(() => { (first[0]!.attribution as { title: string }).title = "Mutated reader result"; }, TypeError); checks++;
  first[0]!.title = "Mutated reader result";
  eq((await adapter(topic, opts))[0]?.title, "Artificial intelligence research & data");
  eq(await adapter(topic, opts, new Set(["doi.org/10.1234/ai(2026)123"])), []);
  eq(await adapter(topic, opts, new Set(["openalex.org/w123"])), []);
  eq(fetches, 1);
  for (const denial of ["budget", "admission"] as const) {
    let transports = 0, reserves = 0;
    const blocked = createOpenAlexMetadataSearch({ now: () => clock,
      fetcher: async () => { transports++; return response(); },
      reserve: async () => { reserves++; throw new PublicSourceBudgetError("exhausted", "openalex-research"); },
      attempt: async (_provider, reserve, work) => {
        if (denial === "admission") throw new PublicSourceCircuitError("cooling_down", "openalex-research");
        await reserve(); return work();
      },
    });
    await rejected(() => blocked(topic, opts)); eq(transports, 0); eq(reserves, denial === "budget" ? 1 : 0);
  }
  const filtered = make(async () => response(envelope([row(), row("W124", "10.1234/unused", "Artificial intelligence unused research")])));
  eq((await filtered(topic, opts, new Set(["openalex.org/w123"])))[0]?.url, "https://doi.org/10.1234/unused");
  const plos = make(async () => response(envelope([row("W125", "10.1371/journal.pdig.1234567")])));
  eq(await plos(topic, opts, new Set(["journals.plos.org/digitalhealth/article?id=10.1371%2Fjournal.pdig.1234567"])), []);
  const partial = make(async () => response(envelope([row(), { ...row("W126", "10.1234/bad"), language: "fr" }])));
  let incomplete = 0;
  eq((await partial(topic, { ...opts, onIncompleteResults: () => { incomplete++; } })).length, 1);
  eq((await partial(topic, { ...opts, onIncompleteResults: () => { incomplete++; } })).length, 1); eq(incomplete, 2);
  const missingPage = make(async () => response(envelope([], 4)));
  eq(await missingPage(topic, { ...opts, onIncompleteResults: () => { incomplete++; } }), []); eq(incomplete, 3);
  const fresh = make(async () => response(envelope([{ ...row(), publication_date: "2026-10-13" }])));
  eq(await fresh(topic, opts), []);
  const outdated = make(async () => response(envelope([{ ...row(), publication_date: "2026-10-01" }])));
  eq(await outdated(topic, opts), []);
  for (const invalid of [new Response("{}", { status: 503 }), new Response("{}", { status: 200 }),
    response({ ...envelope(), results: [{ ...row(), abstract_inverted_index: { PRIVATE: [0] } }] }),
    response(envelope([{ ...row(), doi: null }])),
    new Response("{".repeat(262_145), { headers: { "content-type": "application/json" } }),
    new Response("{bad-json}", { headers: { "content-type": "application/json" } })]) {
    let calls = 0;
    const bad = make(async () => { calls++; return invalid; });
    await rejected(() => bad(topic, opts)); await rejected(() => bad(topic, opts)); eq(calls, 1);
  }
  let lateSignal: AbortSignal | undefined, finish: ((response: Response) => void) | undefined, lateCancelled = 0;
  const timeout = make(async (_input, init) => {
    lateSignal = init?.signal as AbortSignal;
    return new Promise<Response>(resolve => { finish = resolve; });
  }, 5);
  await rejected(() => timeout(topic, opts)); eq(lateSignal?.aborted, true);
  finish!(new Response(new ReadableStream({ cancel() { lateCancelled++; } }), { headers: { "content-type": "application/json" } }));
  await new Promise(resolve => setTimeout(resolve, 5)); eq(lateCancelled, 1);
  await rejected(() => timeout(topic, opts));
  let streamCancelled = 0;
  const stall = make(async () => new Response(new ReadableStream({ pull() {}, cancel() { streamCancelled++; } }),
    { headers: { "content-type": "application/json" } }), 5);
  await rejected(() => stall(topic, opts)); eq(streamCancelled, 1);

  // Two independently constructed budgets share one fixed UTC-window ledger.
  const counters = new Map<string, number>(); const calls: { scope: string; identity: string; limit: number; windowMs: number }[] = [];
  const consume = async (_client: unknown, scope: string, identity: string, limits: { limit: number; windowMs: number }) => {
    calls.push({ scope, identity, ...limits });
    const key = `${scope}|${Math.floor(clock / limits.windowMs)}`;
    const count = (counters.get(key) ?? 0) + 1; counters.set(key, count);
    return { available: true, ok: count <= limits.limit, retryAfterSeconds: 1, remaining: Math.max(0, limits.limit - count) };
  };
  const budgetDeps = { enabled: () => true, loadClient: async () => ({ rpc: deny }) as unknown as RpcClient, consume: consume as unknown as Consume };
  const budgetA = createPublicSourceBudget(budgetDeps), budgetB = createPublicSourceBudget(budgetDeps);
  for (let i = 0; i < 3; i++) await (i % 2 ? budgetA : budgetB)("openalex-research");
  await rejected(() => budgetA("openalex-research"), e => e instanceof PublicSourceBudgetError && e.code === "exhausted");
  eq(calls.slice(0, 2), [
    { scope: "public_source:openalex_minute", identity: "openalex-research", limit: 3, windowMs: 60_000 },
    { scope: "public_source:openalex_day", identity: "openalex-research", limit: 60, windowMs: DAY },
  ]);
  clock += 60_000; await budgetB("openalex-research");
  for (let i = 4; i < 60; i++) { clock += 60_000; await (i % 2 ? budgetA : budgetB)("openalex-research"); }
  clock += 60_000;
  await rejected(() => budgetB("openalex-research"), e => e instanceof PublicSourceBudgetError && e.code === "exhausted");
  clock = Date.parse("2026-10-14T00:00:00Z"); await budgetA("openalex-research");
  eq(counters.get(`public_source:openalex_day|${Math.floor(clock / DAY)}`), 1);
  let delayedCalls = 0, unblock: ((value: unknown) => void) | undefined;
  const slow = createPublicSourceBudget({ ...budgetDeps, timeoutMs: 5,
    consume: (() => { delayedCalls++; return new Promise(resolve => { unblock = resolve; }); }) as unknown as Consume });
  await rejected(() => slow("openalex-research"), e => e instanceof PublicSourceBudgetError && e.code === "unavailable");
  unblock!({ available: true, ok: true }); await new Promise(resolve => setTimeout(resolve, 5)); eq(delayedCalls, 1);
  let startedLate = 0, finishLoad: ((value: RpcClient) => void) | undefined;
  const lateLoad = createPublicSourceBudget({ ...budgetDeps, timeoutMs: 5,
    loadClient: () => new Promise(resolve => { finishLoad = resolve; }), consume: (() => { startedLate++; return Promise.resolve({ available: true, ok: true }); }) as unknown as Consume });
  await rejected(() => lateLoad("openalex-research")); finishLoad!({ rpc: deny });
  await new Promise(resolve => setTimeout(resolve, 5)); eq(startedLate, 0);

  // The real circuit admits before budget. Failure persists across independent
  // instances. Only one recovery probe owns reset and optional reset failure
  // cannot discard a useful metadata pool.
  let cooling = false, probe = false, completions = 0, failCompletion = false;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    eq(args.p_provider, "openalex-research");
    if (name === "begin_alpha_public_source") return { error: null, data: [{ admitted: !cooling || probe,
      generation: "00000000-0000-4000-8000-000000000001", probe_token: probe ? "00000000-0000-4000-8000-000000000002" : null, retry_after_sec: cooling && !probe ? 60 : 0 }] };
    eq(name, "complete_alpha_public_source"); completions++;
    if (failCompletion) return { error: { message: "local fixture" }, data: null };
    if (args.p_outcome === "failure") cooling = true;
    if (args.p_outcome === "success") { cooling = false; probe = false; }
    return { error: null, data: true };
  };
  const deps = { enabled: () => true, loadClient: async () => ({ rpc }) as unknown as RpcClient, warn: () => {} };
  const circuitA = createPublicSourceCircuit(deps), circuitB = createPublicSourceCircuit(deps);
  let outbound = 0, reserved = 0;
  await rejected(() => circuitA("openalex-research", async () => { reserved++; }, async () => { outbound++; throw new Error("Generic source outage"); }));
  await rejected(() => circuitB("openalex-research", async () => { reserved++; }, async () => { outbound++; return []; }), e => e instanceof PublicSourceCircuitError && e.code === "cooling_down");
  eq(outbound, 1); eq(reserved, 1); eq(completions, 1);
  probe = true;
  await rejected(() => circuitB("openalex-research", async () => { throw new PublicSourceBudgetError("exhausted", "openalex-research"); }, async () => { outbound++; return []; }));
  eq(outbound, 1); eq(cooling, true);
  failCompletion = true;
  eq(await circuitA("openalex-research", async () => {}, async () => ["useful local pool"]), ["useful local pool"]);
  eq(cooling, true);

  // Run the actual resolver. Only the new transport is injected, and every
  // keyed search, body fetch, model or other service is a forbidden call.
  clock = Date.parse("2026-10-13T18:00:00Z");
  let earlier = false, later = false, fails = false, useIncomplete = false, mutation = "";
  const events: string[] = [], observations: evidence.SourceObservation[] = [];
  const empty = (label: string) => async () => { events.push(label); return []; };
  const search = make(async () => fails ? new Response("unavailable", { status: 503 }) : response());
  const exports: { resolveTopicSignal?: typeof import("../lib/engine/source-resolver").resolveTopicSignal } = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/engine/source-resolver.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Set, console, require(name: string) {
    const modules: Record<string, unknown> = {
      "@/lib/brave": { braveConfigured: deny, braveSearch: deny }, "@/lib/you-search": { youConfigured: deny, youSearch: deny },
      "./source-rank": rank, "./fetch-content": { fetchArticleText: deny, deepReadEnabled: () => true },
      "./topic-queries": queries, "./url-guard": urlGuard, "./gemini-client": { geminiConfigured: deny },
      "./gemini-search": { resolveTopicSignalViaGemini: deny }, "@/lib/topics": topics, "@/lib/prompt-fence": promptFence,
      "./text-clean": textClean, "./provider-policy": { noModelModeEnabled: () => true, noKeySourcesEnabled: () => true },
      "./public-feed-search": { publicFeedFallbackEnabled: () => true, publicFeedSearch: async () => { events.push("google"); return earlier ? [{ title: "Generic research source", url: "https://example.org/current", description: "Generic public metadata" }] : []; } },
      "./publisher-feed-search": { publisherFeedFallbackEnabled: () => true, publisherFeedSearch: empty("publisher") },
      "./open-news-feed-search": { openNewsFeedFallbackEnabled: () => true, openNewsFeedSearch: empty("globalvoices") },
      "./research-metadata-search": { researchMetadataFallbackEnabled: () => true, researchMetadataSearch: empty("crossref") },
      "./plos-metadata-search": { plosMetadataFallbackEnabled: () => true, plosMetadataSearch: empty("plos") },
      "./openalex-metadata": metadata,
      "./openalex-metadata-search": { openAlexMetadataFallbackEnabled, openAlexMetadataSearch: async (...args: Parameters<typeof search>) => {
        events.push("openalex");
        const results = await (useIncomplete ? partial : search)(...args);
        return results.map(r => mutation === "title" ? { ...r, title: "rewritten" } : mutation === "age" ? { ...r, age: "2026-10-13" } : mutation === "excerpt" ? { ...r, description: "unapproved article" } : r);
      } },
      "./ccmixter-metadata-search": { ccmixterMetadataFallbackEnabled: () => false, ccmixterMetadataSearch: deny },
      "./federal-register-finance-search": { federalRegisterFinanceFallbackEnabled: () => false, federalRegisterFinanceSearch: deny },
      "./govuk-news-search": { govUkNewsFallbackEnabled: () => false, govUkNewsSearch: deny },
      "./statcan-labour-search": { statCanLabourFallbackEnabled: () => false, statCanLabourSearch: deny },
      "./cdm-metadata": { cdmTopicSupported: () => false },
      "./cdm-metadata-search": { cdmMetadataFallbackEnabled: () => false, cdmMetadataSearch: deny },
      "./gdelt-search": { gdeltFallbackEnabled: () => later, gdeltSearch: async () => { events.push("gdelt"); return [{ title: "Independent current research", url: "https://example.org/independent", description: "Generic public material" }]; } },
      "@/lib/source-attribution": attribution, "./source-evidence": evidence,
    };
    ok(Object.hasOwn(modules, name)); return modules[name];
  } }, { timeout: 1000 });
  const resolve = (excludeUrls = new Set<string>(), chosenTopic = topic) => exports.resolveTopicSignal!(chosenTopic, "2026-10-13", {
    ...opts, excludeUrls, onSourceObservation: (e: evidence.SourceObservation) => observations.push(e),
  });
  const signal = await resolve(); ok(signal);
  eq(events, ["google", "google", "google", "publisher", "globalvoices", "crossref", "plos", "openalex"]);
  eq([...signal.citableUrls], ["doi.org/10.1234/ai(2026)123"]);
  eq(signal.sources.length, 1); eq(signal.sources[0].excerpt, "");
  eq(buildDeterministicBlurb(signal)?.items, [attribution.openAlexItemFields(signal.sources[0].attribution)]);
  eq(observations.find(e => e.provider === "openalex")?.outcome, "signal");
  ok(!signal.citableUrls.has(urlGuard.normalizeUrl(attribution.OPENALEX_LICENSE_URL)));
  ok(!signal.citableUrls.has("openalex.org/w123"));
  events.length = 0; earlier = true;
  ok(await resolve()); ok(!events.includes("openalex")); earlier = false;
  eq(await resolve(new Set(["openalex.org/w123"])), undefined);
  later = true;
  eq((await resolve(new Set(["openalex.org/w123"]))).sources[0].url, "https://example.org/independent");
  useIncomplete = true; observations.length = 0;
  eq((await resolve(new Set(["openalex.org/w123"]))).sources[0].url, "https://example.org/independent");
  eq(observations.find(e => e.provider === "openalex")?.outcome, "unavailable");
  useIncomplete = false;
  for (mutation of ["title", "age", "excerpt"]) eq((await resolve()).sources[0].url, "https://example.org/independent");
  mutation = ""; fails = true; clock += 300_001;
  eq((await resolve()).sources[0].url, "https://example.org/independent");
  events.length = 0;
  await resolve(new Set(), "music-hiphop" as TopicId); ok(!events.includes("openalex"));
  eq(external, 0);
  console.log(`PASS ${checks} OpenAlex adapter, resolver, timeout, cache, quota and cross-run cooldown checks. Zero external calls.`);
} finally {
  globalThis.fetch = oldFetch; console.warn = oldWarn;
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}
