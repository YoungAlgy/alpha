// Generic offline fixtures only. Actual resolver/writer code runs with strict
// dependency allow-lists. No external source, model, database or send is called.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createStatCanLabourSearch, STATCAN_LABOUR_ENDPOINT, statCanLabourFallbackEnabled } from "../lib/engine/statcan-labour-search";
import { buildDeterministicBlurb } from "../lib/engine/deterministic-fallback";
import * as attribution from "../lib/source-attribution";
import * as topics from "../lib/topics";
import * as queries from "../lib/engine/topic-queries";
import * as rank from "../lib/engine/source-rank";
import * as urlGuard from "../lib/engine/url-guard";
import * as textClean from "../lib/engine/text-clean";
import * as promptFence from "../lib/prompt-fence";
import * as voiceGuard from "../lib/engine/voice-guard";
import * as sourceEvidence from "../lib/engine/source-evidence";
import { issueIsReaderVisible } from "../lib/issue-visibility";
import { selectLetterSections } from "../lib/engine/select-sections";
import { withDeadline } from "../lib/with-deadline";
import type { BraveResult } from "../lib/brave";
import type { Issue, TopicId, UserProfile } from "../lib/types";
import type { TopicBlurb, TopicSignal } from "../lib/engine/types";

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => { checks++; assert.deepEqual(actual, expected, message); };
const ok = (value: unknown, message: string) => { checks++; assert.ok(value, message); };
const now = Date.parse("2026-10-10T12:00:00.000Z");
const issueDate = "2026-10-10";
const timestamp = "2026-10-09T12:00:00.000Z";
const canonical = "https://www.statcan.gc.ca/daily-quotidien/261009/dq261009a-eng.htm";
const alias = "https://www150.statcan.gc.ca/n1/daily-quotidien/261009/dq261009a-eng.htm";
const acceptedUrl = "https://www.statcan.gc.ca/daily-quotidien/261009/dq261009c-eng.htm";
const originalTitle = ("Employment indicators for the labour force survey, with exact original wording and reported month-to-month comparisons " + "across industries and regions in Canada ".repeat(3)).trimEnd();
assert.ok(originalTitle.length > 160 && originalTitle.length <= 300);
const invalidHost = "https://outside.example.invalid/daily-quotidien/261009/dq261009z-eng.htm";
const xmlEntry = (title: string, url: string, updated = timestamp) =>
  `<entry><title>${title}</title><updated>${updated}</updated><link href="${url}"/></entry>`;
const feed = [
  xmlEntry("Employment indicators, first release", canonical),
  xmlEntry("Employment indicators, alternate legacy path", alias),
  xmlEntry(originalTitle, acceptedUrl),
  xmlEntry("Employment indicators from unsafe host", invalidHost),
  xmlEntry("Employment https://example.invalid/injected", "https://www.statcan.gc.ca/daily-quotidien/261009/dq261009d-eng.htm"),
].join("");
const atom = `<feed xmlns="http://www.w3.org/2005/Atom">${feed}</feed>`;
const flagNames = ["ALPHA_NO_MODEL_MODE", "ALPHA_STATCAN_LABOUR_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET", "ALPHA_DURABLE_SOURCE_COOLDOWN"];
const originals = new Map(flagNames.map(name => [name, process.env[name]]));
const oldFetch = globalThis.fetch;
const oldWarn = console.warn;
let forbidden = 0;
const deny = () => { forbidden++; throw new Error("External work denied by offline fixture"); };
let requests = 0;
let googleHealthy = false;
let statCanFails = false;
let gdeltHealthy = false;
let mutation: "none" | "title" | "description" | "age" = "none";
const events: string[] = [];
const observations: sourceEvidence.SourceObservation[] = [];
let receivedExclusions: ReadonlySet<string> | undefined;
const makeSearch = (fails = false) => createStatCanLabourSearch({
  now: () => now,
  reserve: async provider => { eq(provider, "statcan-labour", "dedicated shared budget identity"); },
  attempt: async (provider, reserve, work) => {
    eq(provider, "statcan-labour", "dedicated cross-run circuit identity");
    await reserve();
    return work();
  },
  fetcher: async (input, init) => {
    requests++;
    eq(String(input), STATCAN_LABOUR_ENDPOINT, "fixed Atom request has no reader/topic search");
    eq(init?.credentials, "omit", "no ambient credentials");
    eq(init?.redirect, "error", "redirects are rejected");
    if (fails) return new Response("unavailable", { status: 503 });
    return new Response(atom, { status: 200, headers: { "content-type": "application/atom+xml; charset=utf-8" } });
  },
});
const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const resolver: { resolveTopicSignal?: (topic: TopicId, date: string, opts?: any) => Promise<TopicSignal | undefined> } = {};
const empty = (label: string) => async () => { events.push(label); return []; };

try {
  globalThis.fetch = deny as typeof fetch;
  console.warn = () => {};
  for (const name of flagNames) process.env[name] = "1";
  const search = makeSearch();
  vm.runInNewContext(compile("../lib/engine/source-resolver.ts"), {
    exports: resolver, console, Set,
    require(name: string) {
      const modules: Record<string, unknown> = {
        "@/lib/brave": { braveConfigured: deny, braveSearch: deny },
        "@/lib/you-search": { youConfigured: deny, youSearch: deny },
        "./source-rank": rank, "./fetch-content": { fetchArticleText: deny, deepReadEnabled: () => true },
        "./topic-queries": queries, "./url-guard": urlGuard,
        "./gemini-client": { geminiConfigured: deny }, "./gemini-search": { resolveTopicSignalViaGemini: deny },
        "@/lib/topics": topics, "@/lib/prompt-fence": promptFence, "./text-clean": textClean,
        "./provider-policy": { noModelModeEnabled: () => true, noKeySourcesEnabled: () => true },
        "./public-feed-search": { publicFeedFallbackEnabled: () => true, publicFeedSearch: async () => {
          events.push("google");
          return googleHealthy ? [{ title: "Current macroeconomic report", url: "https://example.org/current-macro-report", description: "Current generic report." }] : [];
        } },
        "./publisher-feed-search": { publisherFeedFallbackEnabled: () => true, publisherFeedSearch: async () => {
          events.push("publisher"); throw new Error("Generic earlier source unavailable");
        } },
        "./open-news-feed-search": { openNewsFeedFallbackEnabled: () => true, openNewsFeedSearch: empty("global-voices") },
        "./research-metadata-search": { researchMetadataFallbackEnabled: () => true, researchMetadataSearch: empty("crossref") },
        "./plos-metadata-search": { plosMetadataFallbackEnabled: () => true, plosMetadataSearch: empty("plos") },
        "./ccmixter-metadata-search": { ccmixterMetadataFallbackEnabled: () => true, ccmixterMetadataSearch: deny },
        "./federal-register-finance-search": { federalRegisterFinanceFallbackEnabled: () => true, federalRegisterFinanceSearch: deny },
        "./govuk-news-search": { govUkNewsFallbackEnabled: () => true, govUkNewsSearch: async () => { events.push("govuk"); return []; } },
        "./statcan-labour-search": { statCanLabourFallbackEnabled, statCanLabourSearch: async (...args: Parameters<typeof search>) => {
          events.push("statcan-labour");
          receivedExclusions = args[2];
          const results = await (statCanFails ? makeSearch(true) : search)(...args);
          return results.map((result): BraveResult => mutation === "title" ? { ...result, title: "Rewritten headline" } :
            mutation === "description" ? { ...result, description: "Invented excerpt" } :
            mutation === "age" ? { ...result, age: "2026-10-10T12:00:00.000Z" } : result);
        } },
        "./gdelt-search": { gdeltFallbackEnabled: () => gdeltHealthy, gdeltSearch: async () => {
          events.push("gdelt");
          return [{ title: "Independent economic report", url: "https://example.org/independent-economic-report", description: "Generic later source." }];
        } },
        "@/lib/source-attribution": attribution, "./source-evidence": sourceEvidence,
      };
      ok(Object.hasOwn(modules, name), `bounded resolver import ${name}`);
      return modules[name];
    },
  }, { timeout: 1000 });

  const resolve = (topic: TopicId = "macro-markets", excludeUrls = new Set<string>()) => resolver.resolveTopicSignal!(topic, issueDate, {
    freshness: "pd", excludeUrls, onSourceObservation: (event: sourceEvidence.SourceObservation) => observations.push(event),
  });
  const normalizedExcluded = new Set([canonical, alias].map(url => urlGuard.normalizeUrl(url)!));
  const signal = await resolve("macro-markets", normalizedExcluded);
  ok(signal, "StatCan source follows unavailable earlier sources");
  eq(requests, 1, "one fixed Atom pool request");
  ok(events.indexOf("statcan-labour") > events.indexOf("govuk"), "StatCan keeps its configured late-fallback position");
  ok(receivedExclusions === normalizedExcluded, "resolver forwards reader exclusions through wrapper third argument");
  eq(signal!.sources?.length, 1, "two previously used aliases are excluded before the one-source cap");
  eq(signal!.sources![0]!.url, acceptedUrl, "first unused current story is selected");
  eq(signal!.sources![0]!.title, originalTitle, "original headline stays exact beyond 160 characters");
  eq(signal!.sources![0]!.excerpt, "", "no article excerpt");
  eq(signal!.sources![0]!.attribution?.updatedInstant, timestamp, "feed update timestamp remains the source clock");
  eq([...signal!.citableUrls!], [urlGuard.normalizeUrl(acceptedUrl)], "only selected story is citable");
  ok(!signal!.citableUrls!.has(urlGuard.normalizeUrl(attribution.STATCAN_LICENSE_URL)!), "license remains separate from story references");
  ok(!signal!.citableUrls!.has(urlGuard.normalizeUrl("https://example.invalid/injected")!), "source title cannot add a citable link");
  ok(!signal!.sources!.some(source => source.url === invalidHost), "unsafe external story URL is excluded");
  eq(observations.find(event => event.provider === "statcan-labour"), {
    provider: "statcan-labour", outcome: "signal", admittedSources: 1, mode: "no-key", selection: "after-unavailable",
  }, "fixed aggregate source evidence records actual selection");

  const blurb = buildDeterministicBlurb(signal!)!;
  eq(blurb.items.length, 1, "one deterministic metadata item");
  eq(blurb.items[0], attribution.statCanItemFields(signal!.sources![0]!.attribution as any), "exact metadata-only render contract");
  ok(attribution.validatedAttributedItem(blurb.items[0]), "item passes saved-letter attribution guard");
  const credit = attribution.sourceAttributionCredit(acceptedUrl, signal!.sources![0]!.attribution);
  eq(credit?.kind, "statcan", "source credit has a distinct publisher record");
  eq(credit?.articleUrl, acceptedUrl, "credit points to the original story URL");
  eq(credit?.originalTitle, originalTitle, "credit retains the exact original title");
  eq(credit?.updatedInstant, timestamp, "credit identifies feed update time");
  eq(credit?.licenseUrl, attribution.STATCAN_LICENSE_URL, "credit carries the separate open licence link");
  eq(credit?.dateBasis, "feed-entry-updated", "credit does not claim original publication time");
  ok(!JSON.stringify(blurb.items[0]).includes(invalidHost), "rendered item contains no unsafe source URL");

  // The real writer must keep the exact metadata item even if policy changes
  // after discovery. Provider calls are denied in the strict VM.
  const writer: { generateTopicBlurb?: (topic: TopicId, date: string, signal: TopicSignal) => Promise<TopicBlurb> } = {};
  let noModel = true;
  vm.runInNewContext(compile("../lib/engine/topic-blurb.ts"), {
    exports: writer, console,
    require(name: string) {
      const modules: Record<string, unknown> = {
        "./client": { anthropicClient: deny, anthropicConfigured: deny },
        "./gemini-client": { geminiConfigured: deny, geminiGenerateText: deny },
        "./groq-client": { groqConfigured: deny, groqGenerateText: deny },
        "./deepseek-client": { deepseekConfigured: deny, deepseekGenerateText: deny },
        "./provider-policy": { noModelModeEnabled: () => noModel, paidAiEnabled: deny },
        "./deterministic-fallback": { buildDeterministicBlurb }, "@/lib/topics": topics,
        "./url-guard": urlGuard, "./voice-guard": voiceGuard, "@/lib/prompt-fence": promptFence,
      };
      ok(Object.hasOwn(modules, name), `bounded writer import ${name}`);
      return modules[name];
    },
  }, { timeout: 1000 });
  eq(await writer.generateTopicBlurb!("macro-markets", issueDate, signal!), blurb, "no-model writer returns fixed metadata item");
  noModel = false;
  eq(await writer.generateTopicBlurb!("macro-markets", issueDate, signal!), blurb, "credited metadata bypasses a later writer-policy change");
  for (const field of ["title", "description", "age"] as const) {
    mutation = field;
    eq(await resolve(), undefined, `resolver rejects mutated credited source ${field}`);
  }
  mutation = "none";

  // Assembly cache reads/writes use JSON round trips. A cached section keeps
  // its validated credit while its original discovery provenance stays unknown.
  const assembly: { generateIssue?: (user: UserProfile, date: string, size: number, freshness: "pd") => Promise<Issue> } = {};
  let cachedBlurbs = new Map<string, TopicBlurb>();
  let writes = 0;
  const summaries: string[] = [];
  vm.runInNewContext(compile("../lib/engine/assemble.ts"), {
    exports: assembly, Set, Map, Date,
    console: { warn: () => {}, info: (label: string, value: string) => {
      eq(label, "[source-evidence]", "assembly emits only aggregate source evidence"); summaries.push(value);
    } },
    require(name: string) {
      const modules: Record<string, unknown> = {
        "./topic-blurb": writer,
        "./editor-note": { generateEditorNote: async () => "Generic offline intro." },
        "./source-resolver": { resolveTopicSignal: (topic: TopicId, date: string, options: any) =>
          resolver.resolveTopicSignal!(topic, date, { ...options, excludeUrls: new Set([urlGuard.normalizeUrl(canonical)! , urlGuard.normalizeUrl(alias)!]) }) },
        "./blurb-cache": { getCachedBlurbs: async () => cachedBlurbs,
          getCitationHistory: async () => ({ state: "available", urlsByTopic: new Map(), unavailableTopicIds: new Set() }),
          setCachedBlurb: async (value: TopicBlurb) => { writes++; cachedBlurbs.set(value.topicId, JSON.parse(JSON.stringify(value))); } },
        "@/lib/issue-visibility": { issueIsReaderVisible }, "./url-guard": urlGuard,
        "./select-sections": { selectLetterSections }, "./deterministic-fallback": { buildDeterministicBlurb },
        "@/lib/topics": { topicLabel: topics.topicLabel, mapTopicsForUser: (ids: TopicId[]) => ids, GENERIC_FALLBACK_TOPICS: [] },
        "@/lib/with-deadline": { withDeadline }, "./source-evidence": sourceEvidence,
      };
      ok(Object.hasOwn(modules, name), `bounded assembly import ${name}`);
      return modules[name];
    },
  }, { timeout: 1000 });
  noModel = true;
  const user = { firstName: "Generic", city: "", topics: ["macro-markets"], theme: "linen" } as UserProfile;
  const freshIssue = await assembly.generateIssue!(user, issueDate, 1, "pd");
  const savedIssue = await assembly.generateIssue!(user, issueDate, 1, "pd");
  eq(JSON.parse(JSON.stringify(freshIssue.sections[0]?.items)), blurb.items, "fresh assembly keeps exact StatCan credit fields");
  eq(JSON.parse(JSON.stringify(savedIssue.sections[0]?.items)), blurb.items, "saved JSON assembly keeps exact StatCan credit fields");
  ok(attribution.validatedAttributedItem(savedIssue.sections[0]?.items[0]), "cached item keeps valid StatCan attribution");
  eq(writes, 1, "cached section avoids another generation/write");
  eq(JSON.parse(summaries[0]!).selected["statcan-labour"].sections, 1, "fresh assembly records selected StatCan source");
  eq(JSON.parse(summaries[1]!).cachedProvenanceUnknown, 1, "cached provenance remains unknown");
  ok(summaries.every(summary => !summary.includes(acceptedUrl) && !summary.includes(originalTitle)), "aggregate logs omit source content");
  eq(requests, 1, "cached raw metadata avoids a second fixed-feed request");

  // Previously useful sources short-circuit this optional lane. Other topics
  // and malformed controls cannot trigger a StatCan request.
  googleHealthy = true;
  events.length = 0;
  const priorRequests = requests;
  ok(await resolve("macro-markets"), "useful earlier source is retained");
  ok(!events.includes("statcan-labour"), "earlier useful source bypasses StatCan");
  eq(requests, priorRequests, "bypassed optional source makes no request");
  googleHealthy = false;
  const beforeUnsupported = events.filter(event => event === "statcan-labour").length;
  eq(await resolve("ai-news"), undefined, "unsupported topic remains quiet");
  eq(events.filter(event => event === "statcan-labour").length, beforeUnsupported, "unsupported topic makes no StatCan call");

  // A source outage is unavailable, then the independent later GDELT tier can
  // still return useful signal. It must never be reported as a quiet day.
  statCanFails = true;
  gdeltHealthy = true;
  events.length = 0;
  const observationStart = observations.length;
  const afterFailure = await resolve();
  eq(afterFailure?.sources?.[0]?.url, "https://example.org/independent-economic-report", "StatCan failure preserves later useful result");
  ok(events.indexOf("gdelt") > events.indexOf("statcan-labour"), "failure falls through to GDELT in source order");
  ok(observations.slice(observationStart).some(event => event.provider === "statcan-labour" && event.outcome === "unavailable"), "failure is unavailable, never quiet or success");
  eq(forbidden, 0, "zero model, keyed, article, database or external calls");
  console.log(`PASS StatCan source chain: ${checks} offline assertions. No external calls.`);
} finally {
  globalThis.fetch = oldFetch;
  console.warn = oldWarn;
  for (const name of flagNames) {
    const value = originals.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
