// Offline integration verification for the opt-in Crossref metadata fallback.
// Every URL, feed and record below is a fabricated fixture. The fetch fence is
// installed before resolver, writer or provider modules are dynamically loaded.
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

type FetchHandler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

const envNames = [
  "ALPHA_NO_MODEL_MODE", "ALPHA_ALLOW_PAID_AI", "ALPHA_NO_KEY_SOURCES",
  "ALPHA_PUBLIC_FEED_FALLBACK", "ALPHA_PUBLISHER_FEED_FALLBACK",
  "ALPHA_OPEN_NEWS_FALLBACK", "ALPHA_RESEARCH_METADATA_FALLBACK",
  "ALPHA_GDELT_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET", "UNSUBSCRIBE_SECRET",
  "BRAVE_SEARCH_API_KEY", "YOU_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY",
  "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY",
] as const;
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]] as const));
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalWarn = console.warn;
let now = Date.parse("2026-09-30T12:00:00.000Z");
Date.now = () => now;

const requests: URL[] = [];
let unexpectedFetches = 0;
let handler: FetchHandler = () => { throw new Error("offline scenario not installed"); };

// This stays deliberately narrow. A keyed search, AI writer, deep read,
// Supabase transport, env loader or unknown URL becomes a failing test.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  const expectedPaths = new Map([
    ["news.google.com", "/rss/search"],
    ["www.fda.gov", "/about-fda/contact-fda/stay-informed/rss-feeds/medwatch/rss.xml"],
    ["globalvoices.org", "/feed/"],
    ["api.crossref.org", "/works"],
  ]);
  requests.push(url);
  if (expectedPaths.get(url.hostname) !== url.pathname) {
    unexpectedFetches++;
    throw new Error(`unexpected offline fetch: ${url.hostname}${url.pathname}`);
  }
  assert.ok(init?.signal instanceof AbortSignal, "every source request remains timeout-bound");
  try {
    return await handler(url, init);
  } catch (error) {
    unexpectedFetches++;
    throw error;
  }
}) as typeof fetch;

function today(): string {
  return new Date(now).toISOString().slice(0, 10);
}

function freshDate(): string {
  return new Date(now - 60_000).toUTCString();
}

function oldDate(): string {
  return new Date(now - 14 * 86_400_000).toUTCString();
}

function rss(items: Array<{ title: string; url: string; date?: string }>): Response {
  const body = items.map((item) => `<item><title>${item.title}</title><link>${item.url}</link><description>Fixture source.</description><pubDate>${item.date ?? freshDate()}</pubDate></item>`).join("");
  return new Response(`<?xml version="1.0"?><rss><channel>${body}</channel></rss>`, {
    status: 200,
    headers: { "content-type": "application/rss+xml" },
  });
}

function emptyRss(): Response {
  return rss([]);
}

function crossrefRecord(title: string, url: string, doiSuffix: string) {
  const date = new Date(now);
  const dateParts = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  return {
    type: "journal-article",
    DOI: `10.5555/${doiSuffix}`,
    title: [title],
    "published-online": { "date-parts": [dateParts] },
    license: [{
      URL: "https://creativecommons.org/licenses/by/4.0/",
      "content-version": "vor",
      start: { "date-parts": [dateParts] },
    }],
    resource: { primary: { URL: url } },
  };
}

function crossref(items: unknown[]): Response {
  return new Response(JSON.stringify({ status: "ok", "message-type": "work-list", message: { items } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function count(host: string): number {
  return requests.filter((request) => request.hostname === host).length;
}

function resetScenario(nextHandler: FetchHandler, flags: { research?: boolean } = {}): void {
  // Public source result caches and any provider cooldown have expired.
  now += 16 * 60_000;
  for (const name of envNames) delete process.env[name];
  process.env.ALPHA_NO_MODEL_MODE = "1";
  process.env.ALPHA_ALLOW_PAID_AI = "0";
  process.env.ALPHA_NO_KEY_SOURCES = "1";
  process.env.ALPHA_PUBLIC_FEED_FALLBACK = "1";
  process.env.ALPHA_PUBLISHER_FEED_FALLBACK = "1";
  process.env.ALPHA_OPEN_NEWS_FALLBACK = "1";
  process.env.ALPHA_GDELT_FALLBACK = "0";
  process.env.ALPHA_DURABLE_SOURCE_BUDGET = "0";
  if (flags.research !== false) process.env.ALPHA_RESEARCH_METADATA_FALLBACK = "1";
  // These fake values prove explicit no-key/no-model policy wins over
  // configured credentials. The network fence rejects their endpoints.
  process.env.BRAVE_SEARCH_API_KEY = "fixture-brave-key";
  process.env.YOU_API_KEY = "fixture-you-key";
  process.env.GEMINI_API_KEY = "fixture-gemini-key";
  process.env.GROQ_API_KEY = "fixture-groq-key";
  process.env.DEEPSEEK_API_KEY = "fixture-deepseek-key";
  process.env.ANTHROPIC_API_KEY = "fixture-anthropic-key";
  requests.length = 0;
  handler = nextHandler;
}

try {
  const [
    { normalizeUrl },
    { resolveTopicSignal },
    { buildDeterministicBlurb },
    { researchMetadataFallbackEnabled, createResearchMetadataSearch },
    { createPublisherFeedSearch },
    { createPublicSourceBudget, PublicSourceBudgetError },
  ] = await Promise.all([
    import("../lib/engine/url-guard.ts"),
    import("../lib/engine/source-resolver.ts"),
    import("../lib/engine/deterministic-fallback.ts"),
    import("../lib/engine/research-metadata-search.ts"),
    import("../lib/engine/publisher-feed-search.ts"),
    import("../lib/engine/public-source-budget.ts"),
  ]);

  const firstPublisherUrl = "https://publisher-fixture.example.org/nutrition/one";
  const secondPublisherUrl = "https://publisher-fixture.example.org/nutrition/two";
  const thirdPublisherUrl = "https://publisher-fixture.example.org/nutrition/three";
  const otherPublisherUrl = "https://another-fixture.example.net/nutrition/four";

  // Default-off stays literal even with no-model/no-key modes enabled.
  resetScenario(() => emptyRss(), { research: false });
  assert.equal(researchMetadataFallbackEnabled(), false);
  assert.equal(await resolveTopicSignal("nutrition-food", today(), { liveOnly: true, freshness: "pd" }), undefined);
  assert.equal(count("api.crossref.org"), 0, "Crossref remains off without its explicit flag");

  // Google outage, stale FDA material and an empty Global Voices feed flow to
  // fresh CC-BY version-of-record metadata with direct publisher links.
  resetScenario((url) => {
    if (url.hostname === "news.google.com") return new Response(null, { status: 503 });
    if (url.hostname === "www.fda.gov") {
      return rss([{ title: "Nutrition fixture that is intentionally stale", url: "https://www.fda.gov/fixture/nutrition", date: oldDate() }]);
    }
    if (url.hostname === "globalvoices.org") return emptyRss();
    assert.equal(url.hostname, "api.crossref.org");
    assert.equal(url.searchParams.get("query"), "nutrition");
    assert.match(url.searchParams.get("filter") ?? "", /has-license:true/);
    return crossref([
      crossrefRecord("Nutrition journal fixture one", firstPublisherUrl, "fixture-one"),
      crossrefRecord("Nutrition journal fixture two", secondPublisherUrl, "fixture-two"),
      crossrefRecord("Nutrition journal fixture three", thirdPublisherUrl, "fixture-three"),
      crossrefRecord("Nutrition journal fixture four", otherPublisherUrl, "fixture-four"),
    ]);
  });
  const excludedFirst = new Set([normalizeUrl(firstPublisherUrl)!]);
  const crossrefSignal = await resolveTopicSignal("nutrition-food", today(), {
    liveOnly: true,
    freshness: "pd",
    excludeUrls: excludedFirst,
  });
  assert.ok(crossrefSignal, "fresh Crossref metadata recovers the quiet no-key ladder");
  assert.match(crossrefSignal.context, /Crossref Research Metadata/);
  assert.equal(count("news.google.com"), 3, "Google keeps its existing three catalog-query attempts before failover");
  assert.equal(count("www.fda.gov"), 1);
  assert.equal(count("globalvoices.org"), 1);
  assert.equal(count("api.crossref.org"), 1);
  assert.ok(!crossrefSignal.citableUrls.has(normalizeUrl(firstPublisherUrl)!), "prior reader links are removed before ranking");
  const cappedSameHost = [...crossrefSignal.citableUrls].filter((url) => url.startsWith("publisher-fixture.example.org/"));
  assert.ok(cappedSameHost.length <= 2, "host cap still applies to Crossref publisher links");
  const deterministic = buildDeterministicBlurb(crossrefSignal);
  assert.ok(deterministic && deterministic.items.length > 0, "no-model writer formats only resolved source material");
  assert.ok(deterministic!.items.every((item) => item.primaryRef && crossrefSignal.citableUrls.has(normalizeUrl(item.primaryRef.url)!)));
  assert.ok(deterministic!.items.every((item) => !/https?:\/\//i.test(`${item.headline} ${item.body}`)), "writer invents no prose URLs");

  // A second reader gets the unfiltered raw metadata without a new Crossref
  // request. Mutating one resolver result cannot poison the cached raw pool.
  crossrefSignal.sources![0]!.title = "caller mutation";
  const secondReader = await resolveTopicSignal("nutrition-food", today(), { liveOnly: true, freshness: "pd", excludeUrls: new Set() });
  assert.ok(secondReader);
  assert.equal(count("api.crossref.org"), 1, "shared raw Crossref cache avoids a second request");
  assert.ok(secondReader.citableUrls.has(normalizeUrl(firstPublisherUrl)!), "reader exclusions stay local");
  assert.ok(secondReader.sources!.every((source) => source.title !== "caller mutation"), "resolver output is not shared by reference");

  // A usable Google result ends the ladder before the FDA and Crossref tiers.
  resetScenario((url) => {
    assert.equal(url.hostname, "news.google.com");
    return rss([{ title: "Nutrition fixture from Google", url: "https://google-fixture.example.com/nutrition/current" }]);
  });
  const viaGoogle = await resolveTopicSignal("nutrition-food", today(), { liveOnly: true, freshness: "pd" });
  assert.ok(viaGoogle);
  assert.equal(count("news.google.com"), 3, "Google returns a usable result for each existing catalog query");
  assert.equal(count("www.fda.gov"), 0);
  assert.equal(count("api.crossref.org"), 0, "usable Google data does not open Crossref");

  // A usable direct FDA item also ends the ladder before Crossref.
  resetScenario((url) => {
    if (url.hostname === "news.google.com") return emptyRss();
    assert.equal(url.hostname, "www.fda.gov");
    return rss([{ title: "Nutrition food fixture from FDA", url: "https://www.fda.gov/fixture/nutrition/current" }]);
  });
  const viaFda = await resolveTopicSignal("nutrition-food", today(), { liveOnly: true, freshness: "pd" });
  assert.ok(viaFda);
  assert.equal(count("www.fda.gov"), 1);
  assert.equal(count("globalvoices.org"), 0);
  assert.equal(count("api.crossref.org"), 0, "usable FDA data does not open Crossref");

  // The pure search factory verifies raw cache cloning separately from the
  // resolver's reader-specific filtering.
  let factoryCalls = 0;
  const clonedSearch = createResearchMetadataSearch({
    now: () => now,
    sleep: async () => {},
    reserve: async () => {},
    fetcher: async () => {
      factoryCalls++;
      return crossref([crossrefRecord("Nutrition clone fixture", firstPublisherUrl, "clone")]);
    },
  });
  const cloneOne = await clonedSearch("nutrition-food", { freshness: "pd" });
  cloneOne[0]!.title = "mutated returned result";
  const cloneTwo = await clonedSearch("nutrition-food", { freshness: "pd" });
  assert.equal(factoryCalls, 1, "factory cache shares one raw request");
  assert.notEqual(cloneTwo[0]!.title, "mutated returned result", "cached metadata is cloned for every caller");

  // Crossref failures, a valid empty result and an unsupported response fail
  // closed. They stay quiet and the provider cooldown prevents an error loop.
  resetScenario((url) => {
    if (url.hostname === "news.google.com" || url.hostname === "www.fda.gov" || url.hostname === "globalvoices.org") return emptyRss();
    return new Response(null, { status: 429 });
  });
  assert.equal(await resolveTopicSignal("nutrition-food", today(), { liveOnly: true, freshness: "pd" }), undefined);
  assert.equal(count("api.crossref.org"), 1);
  assert.equal(await resolveTopicSignal("nutrition-food", today(), { liveOnly: true, freshness: "pd" }), undefined);
  assert.equal(count("api.crossref.org"), 1, "Crossref 429 enters a bounded cooldown instead of retrying");

  resetScenario((url) => {
    if (url.hostname === "news.google.com" || url.hostname === "www.fda.gov" || url.hostname === "globalvoices.org") return emptyRss();
    return crossref([]);
  });
  assert.equal(await resolveTopicSignal("nutrition-food", today(), { liveOnly: true, freshness: "pd" }), undefined);
  assert.equal(count("api.crossref.org"), 1, "an empty metadata response cannot invent a signal");

  resetScenario((url) => {
    if (url.hostname === "news.google.com" || url.hostname === "www.fda.gov" || url.hostname === "globalvoices.org") return emptyRss();
    return new Response("fixture HTML is unsupported", { status: 200, headers: { "content-type": "text/html" } });
  });
  assert.equal(await resolveTopicSignal("nutrition-food", today(), { liveOnly: true, freshness: "pd" }), undefined);
  assert.equal(count("api.crossref.org"), 1, "unsupported Crossref content stays quiet");

  // A fake RPC proves a fully exhausted Google reservation does not consume
  // the independent publisher ceiling. The publisher search is injected with
  // that reservation and an offline FDA response, so this needs no database.
  process.env.ALPHA_DURABLE_SOURCE_BUDGET = "1";
  process.env.UNSUBSCRIBE_SECRET = "offline-fixture-secret-for-source-budget";
  const budgetCounts = new Map<string, number>();
  const fakeClient = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, "consume_alpha_rate_limit");
      const scope = String(args.p_scope);
      const count = (budgetCounts.get(scope) ?? 0) + 1;
      budgetCounts.set(scope, count);
      const limit = Number(args.p_limit);
      return { data: [{ allowed: count <= limit, remaining: Math.max(0, limit - count), retry_after_sec: count <= limit ? 0 : 900 }], error: null };
    },
  } as unknown as Pick<SupabaseClient, "rpc">;
  const reserve = createPublicSourceBudget({ enabled: () => true, loadClient: async () => fakeClient });
  for (let index = 0; index < 60; index++) await reserve("google-rss");
  await assert.rejects(reserve("google-rss"), (error: unknown) => error instanceof PublicSourceBudgetError && error.code === "exhausted");
  await reserve("publisher-rss");
  let publisherFetches = 0;
  const publisherSearch = createPublisherFeedSearch({
    now: () => now,
    reserve,
    fetcher: async () => {
      publisherFetches++;
      return rss([{ title: "Nutrition food publisher budget fixture", url: "https://www.fda.gov/fixture/nutrition/budget" }]);
    },
  });
  assert.equal((await publisherSearch("nutrition-food", { freshness: "pd" })).length, 1);
  assert.equal(publisherFetches, 1, "publisher reservation remains usable after Google is exhausted");
  assert.equal(budgetCounts.get("public_source:google_rss"), 61);
  assert.equal(budgetCounts.get("public_source:publisher_rss"), 2);

  // Separate factories stand in for separate processes. Crossref consumes the
  // same durable publisher ceiling even though their raw caches are separate.
  let researchBudgetFetches = 0;
  const makeBudgetedResearch = (reservation: typeof reserve) => createResearchMetadataSearch({
    now: () => now, reserve: reservation,
    fetcher: async () => {
      researchBudgetFetches++;
      return crossref([crossrefRecord("Nutrition durable budget fixture", firstPublisherUrl, "budget")]);
    },
  });
  assert.equal((await makeBudgetedResearch(reserve)("nutrition-food")).length, 1);
  const otherRunReserve = createPublicSourceBudget({ enabled: () => true, loadClient: async () => fakeClient });
  assert.equal((await makeBudgetedResearch(otherRunReserve)("nutrition-food")).length, 1);
  assert.equal(budgetCounts.get("public_source:publisher_rss"), 4);
  for (let index = 0; index < 8; index++) await reserve("publisher-rss");
  await assert.rejects(makeBudgetedResearch(otherRunReserve)("nutrition-food"),
    (error: unknown) => error instanceof PublicSourceBudgetError && error.provider === "publisher-rss" && error.code === "exhausted");
  assert.equal(researchBudgetFetches, 2, "exhausted shared publisher budget blocks Crossref before outbound fetch");
  assert.equal(budgetCounts.get("public_source:publisher_rss"), 13);

  assert.equal(unexpectedFetches, 0, "the full fetch fence saw no unapproved request");
  console.log("PASS verify-research-metadata-failover (offline Crossref no-key/no-model ladder)");
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  console.warn = originalWarn;
  for (const name of envNames) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
