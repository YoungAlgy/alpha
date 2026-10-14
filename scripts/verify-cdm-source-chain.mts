// Generic offline fixtures only. The actual CDM parser, selector, search adapter,
// source resolver and deterministic formatter run with strict dependency allow-lists.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createCdmMetadataSearch, CDM_METADATA_ENDPOINT, cdmMetadataFallbackEnabled } from "../lib/engine/cdm-metadata-search";
import * as cdm from "../lib/engine/cdm-metadata";
import { buildDeterministicBlurb } from "../lib/engine/deterministic-fallback";
import * as attribution from "../lib/source-attribution";
import * as topics from "../lib/topics";
import * as queries from "../lib/engine/topic-queries";
import * as rank from "../lib/engine/source-rank";
import * as urlGuard from "../lib/engine/url-guard";
import * as textClean from "../lib/engine/text-clean";
import * as promptFence from "../lib/prompt-fence";
import * as sourceEvidence from "../lib/engine/source-evidence";
import type { BraveResult } from "../lib/brave";
import type { TopicId } from "../lib/types";
import type { TopicSignal } from "../lib/engine/types";

let checks = 0;
let external = 0;
const eq = (actual: unknown, expected: unknown, message: string) => { checks++; assert.deepEqual(actual, expected, message); };
const ok = (value: unknown, message: string) => { checks++; assert.ok(value, message); };
const deny = () => { external++; throw new Error("External work denied by offline CDM fixture"); };
const now = Date.parse("2026-10-13T12:00:00.000Z");
const weekOf = "2026-10-13";
const topic = "custom:music production" as TopicId;
const originalTitle = "Music production: an exact studio workflow for independent producers";
const priorUrl = "https://cdm.link/2026/10/12/music-production-history-fixture/";
const selectedUrl = "https://cdm.link/2026/10/12/music-production-current-fixture/";
const laterUrl = "https://cdm.link/2026/10/12/music-production-later-fixture/";
const pubDate = "Mon, 12 Oct 2026 09:30:00 +0000";
const timestamp = "2026-10-12T09:30:00.000Z";
const flagNames = ["ALPHA_NO_MODEL_MODE", "ALPHA_CDM_METADATA_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET", "ALPHA_DURABLE_SOURCE_COOLDOWN"];
const originals = new Map(flagNames.map(name => [name, process.env[name]]));
const oldFetch = globalThis.fetch;
const oldWarn = console.warn;
let requests = 0;
let reservations = 0;
let attempts = 0;
let cdmCalls = 0;
let reserveFails = false;
let googleHealthy = false;
let gdeltHealthy = false;
let receivedExclusions: ReadonlySet<string> | undefined;
let cdmMode: "valid" | "empty" | "incomplete" | "failure" = "valid";
let mutation: "none" | "title" | "description" | "age" | "credit" | "url" = "none";
const events: string[] = [];
const observations: sourceEvidence.SourceObservation[] = [];

const item = (title: string, url: string, date = pubDate, category = "Music tech") =>
  `<item><title>${title}</title><link>${url}</link><pubDate>${date}</pubDate><dc:creator>Casey Example</dc:creator><category>${category}</category></item>`;
const rss = (items: string[]) => `<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>${items.join("")}</channel></rss>`;
const rawFeed = () => rss([
  item("Music production: previously sent workflow", priorUrl),
  item(originalTitle, selectedUrl),
  item("Music production: later valid fixture", laterUrl),
]);
const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const resolver: { resolveTopicSignal?: (topic: TopicId, date: string, opts?: any) => Promise<TopicSignal | undefined> } = {};
const empty = (name: string) => async () => { events.push(name); return []; };

function makeSearch() {
  return createCdmMetadataSearch({
    now: () => now,
    reserve: async provider => {
      reservations++;
      eq(provider, "cdm-music", "fixed request budget identity");
      if (reserveFails) throw new Error("Bounded fixture budget exhausted");
    },
    attempt: async (provider, reserve, work) => {
      attempts++;
      eq(provider, "cdm-music", "fixed circuit identity");
      await reserve();
      return work();
    },
    fetcher: async (input, init) => {
      requests++;
      eq(String(input), CDM_METADATA_ENDPOINT, "one fixed feed URL carries no topic or reader query");
      eq(init?.credentials, "omit", "request sends no ambient credentials");
      eq(init?.redirect, "error", "request rejects redirects");
      eq(init?.cache, "no-store", "feed response is not delegated to a shared HTTP cache");
      if (cdmMode === "failure") return new Response("unavailable", { status: 503 });
      const xml = cdmMode === "empty" ? rss([item("Studio interview without production evidence", "https://cdm.link/2026/10/12/unrelated-interview/", pubDate, "Interviews")]) :
        cdmMode === "incomplete" ? rss([
          item("Music production: previously sent workflow", priorUrl),
          item(originalTitle, selectedUrl), item("Music production: later valid fixture", laterUrl),
          item("Music production with impossible date", "https://cdm.link/2026/10/12/impossible-date/", "Mon, 32 Oct 2026 09:30:00 +0000"),
        ]) : rawFeed();
      return new Response(xml, { status: 200, headers: { "content-type": "application/rss+xml; charset=utf-8" } });
    },
  });
}

try {
  globalThis.fetch = deny as typeof fetch;
  console.warn = () => {};
  for (const name of flagNames) process.env[name] = "1";
  ok(cdmMetadataFallbackEnabled(), "CDM tier is enabled only by the four explicit offline fixture flags");
  let cdmSearch = makeSearch();

  vm.runInNewContext(compile("../lib/engine/source-resolver.ts"), {
    exports: resolver, console, Set,
    require(name: string) {
      const modules: Record<string, unknown> = {
        "@/lib/brave": { braveConfigured: deny, braveSearch: deny },
        "@/lib/you-search": { youConfigured: deny, youSearch: deny },
        "./source-rank": rank,
        "./fetch-content": { fetchArticleText: deny, deepReadEnabled: () => true },
        "./topic-queries": queries, "./url-guard": urlGuard,
        "./gemini-client": { geminiConfigured: deny }, "./gemini-search": { resolveTopicSignalViaGemini: deny },
        "@/lib/topics": topics, "@/lib/prompt-fence": promptFence, "./text-clean": textClean,
        "./provider-policy": { noModelModeEnabled: () => true, noKeySourcesEnabled: () => true },
        "./public-feed-search": { publicFeedFallbackEnabled: () => true, publicFeedSearch: async () => {
          events.push("google");
          return googleHealthy ? [{ title: "Earlier useful current music technology report", url: "https://example.org/earlier-useful-music-report", description: "Generic source fixture." }] : [];
        } },
        "./publisher-feed-search": { publisherFeedFallbackEnabled: () => true, publisherFeedSearch: async () => {
          events.push("publisher"); throw new Error("Earlier publisher source unavailable");
        } },
        "./open-news-feed-search": { openNewsFeedFallbackEnabled: () => true, openNewsFeedSearch: empty("global-voices") },
        "./research-metadata-search": { researchMetadataFallbackEnabled: () => true, researchMetadataSearch: empty("crossref") },
        "./plos-metadata-search": { plosMetadataFallbackEnabled: () => true, plosMetadataSearch: empty("plos") },
        "./ccmixter-metadata-search": { ccmixterMetadataFallbackEnabled: () => false, ccmixterMetadataSearch: deny },
        "./federal-register-finance-search": { federalRegisterFinanceFallbackEnabled: () => false, federalRegisterFinanceSearch: deny },
        "./govuk-news-search": { govUkNewsFallbackEnabled: () => false, govUkNewsSearch: deny },
        "./statcan-labour-search": { statCanLabourFallbackEnabled: () => false, statCanLabourSearch: deny },
        "./openalex-metadata": { openAlexTopicLane: () => undefined },
        "./openalex-metadata-search": { openAlexMetadataFallbackEnabled: () => false, openAlexMetadataSearch: deny },
        "./cdm-metadata": cdm,
        "./cdm-metadata-search": { cdmMetadataFallbackEnabled: () => true, cdmMetadataSearch: async (...args: Parameters<typeof cdmSearch>) => {
          cdmCalls++;
          events.push("cdm");
          receivedExclusions = args[2];
          const results = await cdmSearch(...args);
          return results.map((result): BraveResult => {
            if (mutation === "title") return { ...result, title: "Rewritten CDM headline" };
            if (mutation === "description") return { ...result, description: "Unexpected excerpt" };
            if (mutation === "age") return { ...result, age: "2026-10-13T12:00:00.000Z" };
            if (mutation === "credit") return { ...result, attribution: { ...(result.attribution as object), publisher: "other" } as any };
            if (mutation === "url") return { ...result, url: "https://cdm.link/2026/10/12/uncredited-other-story/" };
            return result;
          });
        } },
        "./gdelt-search": { gdeltFallbackEnabled: () => gdeltHealthy, gdeltSearch: async () => {
          events.push("gdelt");
          return [{ title: "Independent general music report", url: "https://example.org/independent-music-report", description: "Later generic source fixture." }];
        } },
        "@/lib/source-attribution": attribution,
        "./source-evidence": sourceEvidence,
      };
      ok(Object.hasOwn(modules, name), `bounded resolver dependency ${name}`);
      return modules[name];
    },
  }, { timeout: 1000 });

  const resolve = (topicId: TopicId = topic, excludeUrls = new Set<string>()) =>
    resolver.resolveTopicSignal!(topicId, weekOf, { freshness: "pw", excludeUrls, onSourceObservation: event => observations.push(event) });
  const excluded = new Set([urlGuard.normalizeUrl(priorUrl)!]);
  const signal = await resolve(topic, excluded);
  ok(signal, "CDM returns a signal after earlier sources are empty or unavailable");
  eq(requests, 1, "one fixed feed request on the selected path");
  ok(events.indexOf("cdm") > events.indexOf("publisher"), "CDM retains its later optional fallback position");
  eq(receivedExclusions, excluded, "resolver forwards the recent-link exclusion set to CDM selection");
  eq(signal!.sources?.length, 1, "prior-link exclusion happens before CDM one-source cap");
  eq(JSON.parse(JSON.stringify(signal!.sources![0])), { title: originalTitle, url: selectedUrl, excerpt: "", attribution: {
    publisher: "cdm", kind: "music-production-metadata", title: originalTitle, url: selectedUrl,
    author: "Casey Example", publishedAt: timestamp, dateBasis: "feed-pubdate",
  } }, "selected source contains only exact headline, story URL and metadata attribution");
  eq([...signal!.citableUrls!], [urlGuard.normalizeUrl(selectedUrl)], "only the selected story URL is citable");
  ok(!signal!.citableUrls!.has(urlGuard.normalizeUrl(attribution.CDM_LICENSE_URL)!), "license link stays outside story citations");
  ok(!signal!.context.includes("article text") && !signal!.context.includes("ARTICLE TEXT:"), "resolver context makes no article-text claim");
  eq(observations.find(event => event.provider === "cdm"), {
    provider: "cdm", outcome: "signal", admittedSources: 1, mode: "no-key", selection: "after-unavailable",
  }, "source observation records CDM as the actual selected provider with aggregate counts only");

  let parserIncomplete = false;
  const hundred = Array.from({ length: 100 }, (_, index) => item(`Music production fixture ${index}`, `https://cdm.link/2026/10/12/pool-${index}/`));
  eq(cdm.parseCdmMetadataPool(rss(hundred), () => { parserIncomplete = true; }).length, 100, "exact 100 valid rows fit the metadata pool");
  eq(parserIncomplete, false, "exactly 100 valid rows do not signal truncation");
  parserIncomplete = false;
  eq(cdm.parseCdmMetadataPool(rss([...hundred, item("Music production fixture 100", "https://cdm.link/2026/10/12/pool-100/")]), () => { parserIncomplete = true; }).length, 100,
    "pool returns at most 100 records");
  eq(parserIncomplete, true, "a 101st validated record marks the bounded pool incomplete");

  cdmMode = "incomplete";
  let incompleteCallbackCalls = 0;
  const callbackSearch = makeSearch();
  const partialResults = await callbackSearch(topic, { freshness: "pw", onIncompleteResults: () => {
    incompleteCallbackCalls++;
    throw new Error("Optional diagnostics callback failure");
  } });
  eq(partialResults.length, 1, "valid metadata survives invalid siblings");
  eq(incompleteCallbackCalls, 1, "invalid sibling invokes incomplete-results callback");

  cdmSearch = makeSearch();
  gdeltHealthy = true;
  events.length = 0;
  const excludeEveryValid = new Set([priorUrl, selectedUrl, laterUrl].map(url => urlGuard.normalizeUrl(url)!));
  const incompleteObservationStart = observations.length;
  eq((await resolve(topic, excludeEveryValid))?.sources?.[0]?.url, "https://example.org/independent-music-report",
    "excluded valid rows plus one invalid sibling fall through to later GDELT");
  ok(observations.slice(incompleteObservationStart).some(event => event.provider === "cdm" && event.outcome === "unavailable"),
    "incomplete empty CDM selection is recorded unavailable, never healthy-empty");

  const blurb = buildDeterministicBlurb(signal!)!;
  eq(blurb.intro, "Music-production headline metadata from CDM. Dates are feed publication timestamps.", "fixed metadata-only intro states feed timestamp meaning");
  eq(blurb.items, [attribution.cdmItemFields(signal!.sources![0]!.attribution as cdm.CdmMetadata)], "deterministic formatter uses exact CDM item fields");
  eq(blurb.items[0]?.headline, originalTitle, "formatter preserves exact original headline");
  eq(blurb.items[0]?.body, `CDM headline metadata. Feed publication timestamp: ${timestamp}. Original article publication and music release time are unproven.`, "fixed body carries no article excerpt or release-date claim");
  eq(blurb.items[0]?.primaryRef, { label: originalTitle, url: selectedUrl }, "primary story reference preserves the original headline and URL");
  eq(blurb.items[0]?.supplementaryRefs, [], "license is not added as a story reference");
  ok(attribution.validatedAttributedItem(blurb.items[0]), "saved metadata item passes exact credit validation");
  const credit = attribution.sourceAttributionCredit(selectedUrl, signal!.sources![0]!.attribution);
  eq(credit?.kind, "cdm", "CDM gets its own attribution kind");
  eq(credit?.articleUrl, selectedUrl, "credit points to the original story");
  eq(credit?.originalTitle, originalTitle, "credit retains the exact headline");
  eq(credit?.author, "Casey Example", "credit preserves the byline");
  eq(credit?.publishedAt, timestamp, "credit labels the feed publication timestamp");
  eq(credit?.licenseUrl, attribution.CDM_LICENSE_URL, "CC BY-SA link is present as a separate attribution field");
  ok(!signal!.sources!.some(source => source.url === attribution.CDM_LICENSE_URL), "license URL never becomes a source item");
  for (const [index, altered] of [
    { ...blurb.items[0]!, headline: "Rewritten headline" },
    { ...blurb.items[0]!, body: "Added article excerpt" },
    { ...blurb.items[0]!, primaryRef: { label: "Other story", url: selectedUrl } },
    { ...blurb.items[0]!, primaryRef: { label: originalTitle, url: laterUrl } },
    { ...blurb.items[0]!, attribution: { ...(blurb.items[0]!.attribution as object), title: "Different credited headline" } },
  ].entries()) ok(!attribution.validatedAttributedItem(altered), `modified metadata item variant ${index} is refused`);

  googleHealthy = true;
  events.length = 0;
  const beforeUseful = requests;
  const beforeUsefulCalls = cdmCalls;
  ok(await resolve(topic), "useful earlier feed signal is retained");
  ok(!events.includes("cdm"), "useful earlier source short-circuits CDM");
  eq(requests, beforeUseful, "bypassed CDM makes no feed request");
  eq(cdmCalls, beforeUsefulCalls, "bypassed CDM adapter is never invoked");
  googleHealthy = false;

  for (const alias of ["custom:music", "custom:indie music", "custom:country music", "music-indie"] as TopicId[]) {
    const before = requests;
    const beforeCalls = cdmCalls;
    await resolve(alias);
    eq(requests, before, `unsupported music lane ${alias} makes no CDM feed request`);
    eq(cdmCalls, beforeCalls, `unsupported music lane ${alias} never invokes CDM adapter`);
  }
  eq(cdm.cdmTopicSupported("custom:music"), false, "music genre phrase is not a CDM lane");
  eq(cdm.cdmTopicSupported("custom:country music"), false, "country music is not a CDM lane");

  cdmMode = "failure";
  cdmSearch = makeSearch();
  gdeltHealthy = true;
  events.length = 0;
  const failedObservationStart = observations.length;
  const afterFailure = await resolve();
  eq(afterFailure?.sources?.[0]?.url, "https://example.org/independent-music-report", "failed CDM request falls through to later GDELT source");
  ok(events.indexOf("gdelt") > events.indexOf("cdm"), "GDELT follows the failed CDM attempt");
  ok(observations.slice(failedObservationStart).some(event => event.provider === "cdm" && event.outcome === "unavailable"), "CDM failure is recorded as unavailable");

  cdmMode = "empty";
  cdmSearch = makeSearch();
  events.length = 0;
  const emptyObservationStart = observations.length;
  const afterEmpty = await resolve();
  eq(afterEmpty?.sources?.[0]?.url, "https://example.org/independent-music-report", "empty or off-topic CDM pool falls through to GDELT");
  ok(observations.slice(emptyObservationStart).some(event => event.provider === "cdm" && event.outcome === "healthy-empty"), "empty CDM selection is not misreported as a failure");

  cdmMode = "valid";
  cdmSearch = makeSearch();
  reserveFails = true;
  events.length = 0;
  const beforeExhaustion = requests;
  const exhaustedObservationStart = observations.length;
  eq((await resolve())?.sources?.[0]?.url, "https://example.org/independent-music-report", "budget exhaustion falls through to GDELT");
  eq(requests, beforeExhaustion, "exhausted budget blocks the outbound feed request");
  ok(observations.slice(exhaustedObservationStart).some(event => event.provider === "cdm" && event.outcome === "unavailable"), "budget exhaustion is unavailable, never a quiet feed");
  reserveFails = false;

  cdmMode = "valid";
  cdmSearch = makeSearch();
  for (const field of ["title", "description", "age", "credit", "url"] as const) {
    mutation = field;
    gdeltHealthy = false;
    events.length = 0;
    eq(await resolve(), undefined, `mutated credited CDM ${field} is rejected without a later source`);
    ok(events.includes("cdm"), `mutated ${field} case reaches CDM selection`);
  }
  mutation = "none";

  // CDM exhaustion and an unusable response must not prevent a later source.
  cdmMode = "failure";
  cdmSearch = makeSearch();
  gdeltHealthy = false;
  eq(await resolve(), undefined, "CDM failure with no later candidate produces no signal");
  eq(external, 0, "zero native network, model, database, article-body or account calls");
  ok(requests > 0 && requests <= reservations && attempts === reservations, "all fixed-feed requests pass through injected budget and circuit boundaries");
  console.log(`PASS CDM source chain: ${checks} offline assertions. Zero external calls.`);
} finally {
  globalThis.fetch = oldFetch;
  console.warn = oldWarn;
  for (const name of flagNames) {
    const value = originals.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
