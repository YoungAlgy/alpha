// Generic offline fixtures only. Actual resolver/writer code runs with strict
// dependency allow-lists. No external source, model, database or send is called.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createGovUkNewsSearch, GOVUK_NEWS_ENDPOINT, govUkNewsFallbackEnabled } from "../lib/engine/govuk-news-search";
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
const timestamp = "2026-10-10T09:00:00.000Z";
const usedUrl = "https://www.gov.uk/government/news/generic-artificial-intelligence-first";
const acceptedUrl = "https://www.gov.uk/government/news/generic-artificial-intelligence-second";
const originalTitle = 'Artificial intelligence [research] "update" with exact original wording ' + "for public services and new research announcements ".repeat(3) + "https://example.invalid/untrusted-link";
assert.ok(originalTitle.length > 160 && originalTitle.length <= 300);
const rows = [
  { title: "Artificial intelligence research first announcement", link: usedUrl, public_timestamp: timestamp, format: "news_story" },
  { title: originalTitle, link: acceptedUrl, public_timestamp: timestamp, format: "press_release",
    body: "DISCARDED_BODY", author: "DISCARDED_AUTHOR", media: "DISCARDED_MEDIA" },
  { title: "Housing market generic announcement", link: "/government/news/generic-housing-market", public_timestamp: timestamp, format: "news_story" },
];
const flagNames = ["ALPHA_NO_MODEL_MODE", "ALPHA_GOVUK_NEWS_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET", "ALPHA_DURABLE_SOURCE_COOLDOWN"];
const originals = new Map(flagNames.map(name => [name, process.env[name]]));
const oldFetch = globalThis.fetch;
const oldWarn = console.warn;
let forbidden = 0;
const deny = () => { forbidden++; throw new Error("External work denied by offline fixture"); };
let requests = 0;
let googleHealthy = false;
let govFails = false;
let gdeltHealthy = false;
let mutation: "none" | "title" | "description" | "age" = "none";
const events: string[] = [];
const observations: sourceEvidence.SourceObservation[] = [];
const makeSearch = (fails = false) => createGovUkNewsSearch({
  now: () => now,
  reserve: async provider => { eq(provider, "govuk-news", "dedicated shared budget"); },
  attempt: async (provider, reserve, work) => {
    eq(provider, "govuk-news", "dedicated cross-run circuit");
    await reserve();
    return work();
  },
  fetcher: async (input, init) => {
    requests++;
    eq(String(input), GOVUK_NEWS_ENDPOINT, "fixed request has no reader/topic search");
    eq(init?.credentials, "omit", "no ambient credentials");
    eq(init?.redirect, "error", "no redirect follow");
    if (fails) return new Response("unavailable", { status: 503 });
    return Response.json({ results: rows });
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
          return googleHealthy ? [{ title: "Artificial intelligence research", url: "https://example.org/generic-ai-report", description: "Current generic report." }] : [];
        } },
        "./publisher-feed-search": { publisherFeedFallbackEnabled: () => true, publisherFeedSearch: async () => {
          events.push("publisher"); throw new Error("Generic earlier source unavailable");
        } },
        "./open-news-feed-search": { openNewsFeedFallbackEnabled: () => true, openNewsFeedSearch: empty("global-voices") },
        "./research-metadata-search": { researchMetadataFallbackEnabled: () => true, researchMetadataSearch: empty("crossref") },
        "./plos-metadata-search": { plosMetadataFallbackEnabled: () => true, plosMetadataSearch: empty("plos") },
        "./ccmixter-metadata-search": { ccmixterMetadataFallbackEnabled: () => true, ccmixterMetadataSearch: deny },
        "./federal-register-finance-search": { federalRegisterFinanceFallbackEnabled: () => true, federalRegisterFinanceSearch: deny },
        "./govuk-news-search": { govUkNewsFallbackEnabled, govUkNewsSearch: async (...args: Parameters<typeof search>) => {
          events.push("govuk");
          const results = await (govFails ? makeSearch(true) : search)(...args);
          return results.map((result): BraveResult => mutation === "title" ? { ...result, title: "Rewritten AI headline" } :
            mutation === "description" ? { ...result, description: "Invented summary" } :
            mutation === "age" ? { ...result, age: "2026-10-10" } : result);
        } },
        "./gdelt-search": { gdeltFallbackEnabled: () => gdeltHealthy, gdeltSearch: async () => {
          events.push("gdelt");
          return [{ title: "Artificial intelligence independent report", url: "https://example.org/independent-ai-report", description: "Generic later source." }];
        } },
        "@/lib/source-attribution": attribution, "./source-evidence": sourceEvidence,
      };
      ok(Object.hasOwn(modules, name), `bounded resolver import ${name}`);
      return modules[name];
    },
  }, { timeout: 1000 });

  const resolve = (topic: TopicId = "ai-news", excludeUrls = new Set<string>()) => resolver.resolveTopicSignal!(topic, issueDate, {
    freshness: "pd", excludeUrls, onSourceObservation: (event: sourceEvidence.SourceObservation) => observations.push(event),
  });
  const signal = await resolve("ai-news", new Set([urlGuard.normalizeUrl(usedUrl)!]));
  ok(signal, "earlier failure falls through to government metadata");
  eq(requests, 1, "one fixed pool request");
  ok(events.indexOf("govuk") > events.indexOf("plos"), "late source retains existing order");
  eq(signal!.sources?.length, 1, "one result after prior-link exclusion");
  eq(signal!.sources![0]!.url, acceptedUrl, "prior item does not consume source slot");
  eq(signal!.sources![0]!.title, originalTitle, "original title stays exact beyond 160 characters");
  eq(signal!.sources![0]!.excerpt, "", "no article summary");
  eq([...signal!.citableUrls!], [urlGuard.normalizeUrl(acceptedUrl)], "only admitted story is citable");
  ok(!signal!.citableUrls!.has(urlGuard.normalizeUrl(attribution.GOVUK_LICENSE_URL)!), "license is separate from story references");
  ok(!signal!.citableUrls!.has(urlGuard.normalizeUrl("https://example.invalid/untrusted-link")!), "title cannot add a citable link");
  ok(!/DISCARDED_(BODY|AUTHOR|MEDIA)/.test(JSON.stringify(signal!.sources)), "API extras discarded");
  eq(observations.find(event => event.provider === "govuk-news"), {
    provider: "govuk-news", outcome: "signal", admittedSources: 1, mode: "no-key", selection: "after-unavailable",
  }, "bounded source evidence describes actual selection");

  const blurb = buildDeterministicBlurb(signal!)!;
  eq(blurb.items.length, 1, "safe deterministic metadata item");
  eq(blurb.items[0], attribution.govUkItemFields(signal!.sources![0]!.attribution as any), "exact metadata-only item contract");
  ok(attribution.validatedAttributedItem(blurb.items[0]), "item valid for saved-letter boundaries");

  // Run the actual writer entry point with every model call forbidden. Even a
  // policy change after discovery cannot send government credit to a rewriter.
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
  eq(await writer.generateTopicBlurb!("ai-news", issueDate, signal!), blurb, "no-model writer uses fixed item");
  noModel = false;
  eq(await writer.generateTopicBlurb!("ai-news", issueDate, signal!), blurb, "credited source bypasses model despite policy drift");
  for (const field of ["title", "excerpt"] as const) {
    const bad = { ...signal!, sources: [{ ...signal!.sources![0]!, [field]: "Rewritten unsupported text" }] };
    eq(buildDeterministicBlurb(bad), null, `formatter drops rewritten ${field}`);
  }

  // Actual assembly must carry the item untouched on both fresh generation and
  // saved-section reuse. All private cache I/O is replaced by JSON round trips.
  const assembly: { generateIssue?: (user: UserProfile, date: string, size: number, freshness: "pd") => Promise<Issue> } = {};
  let cachedBlurbs = new Map<string, TopicBlurb>();
  let writes = 0;
  const summaries: string[] = [];
  vm.runInNewContext(compile("../lib/engine/assemble.ts"), {
    exports: assembly, Set, Map, Date,
    console: { warn: () => {}, info: (label: string, value: string) => {
      eq(label, "[source-evidence]", "only aggregate assembly evidence"); summaries.push(value);
    } },
    require(name: string) {
      const modules: Record<string, unknown> = {
        "./topic-blurb": writer,
        "./editor-note": { generateEditorNote: async () => "Generic offline intro." },
        "./source-resolver": { resolveTopicSignal: (topic: TopicId, date: string, options: any) =>
          resolver.resolveTopicSignal!(topic, date, { ...options, excludeUrls: new Set([urlGuard.normalizeUrl(usedUrl)!]) }) },
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
  const user = { firstName: "Generic", city: "", topics: ["ai-news"], theme: "linen" } as UserProfile;
  const freshIssue = await assembly.generateIssue!(user, issueDate, 1, "pd");
  const savedIssue = await assembly.generateIssue!(user, issueDate, 1, "pd");
  eq(JSON.parse(JSON.stringify(freshIssue.sections[0]?.items)), blurb.items, "fresh assembly preserves exact credit/item fields");
  eq(JSON.parse(JSON.stringify(savedIssue.sections[0]?.items)), blurb.items, "cached assembly preserves exact credit/item fields");
  eq(writes, 1, "saved section avoids another generation/write");
  eq(JSON.parse(summaries[0]!).selected["govuk-news"].sections, 1, "fresh assembly records selected government tier");
  eq(JSON.parse(summaries[1]!).cachedProvenanceUnknown, 1, "cached provenance is not falsely claimed as fresh fallback");
  ok(summaries.every(summary => !summary.includes(acceptedUrl) && !summary.includes(originalTitle)), "aggregate logs exclude source title/link");

  eq(await resolve("ai-news", new Set([usedUrl, acceptedUrl].map(url => urlGuard.normalizeUrl(url)!))), undefined, "used pool is quiet");
  eq(requests, 1, "prior-link exhaustion does not refetch pool");
  ok(await resolve("real-estate"), "another supported topic shares pool");
  eq(requests, 1, "different topic never burns another request");
  const beforeCustom = events.filter(event => event === "govuk").length;
  eq(await resolve("custom:generic railway topic" as TopicId), undefined, "custom topic stays unsupported");
  eq(events.filter(event => event === "govuk").length, beforeCustom, "no personal custom query reaches government source");
  for (const bad of ["title", "description", "age"] as const) {
    mutation = bad;
    eq(await resolve(), undefined, `resolver drops mismatched government ${bad}`);
  }
  mutation = "none";
  googleHealthy = true;
  events.length = 0;
  ok(await resolve(), "useful earlier result retained");
  ok(!events.includes("govuk"), "earlier success bypasses optional source");
  googleHealthy = false;
  govFails = true;
  gdeltHealthy = true;
  events.length = 0;
  const observationStart = observations.length;
  const afterFailure = await resolve();
  eq(afterFailure?.sources?.[0]?.url, "https://example.org/independent-ai-report", "government failure retains later useful result");
  ok(events.indexOf("gdelt") > events.indexOf("govuk"), "failure falls through in source order");
  ok(observations.slice(observationStart).some(event => event.provider === "govuk-news" && event.outcome === "unavailable"), "failure is unavailable, never quiet or success");
  eq(forbidden, 0, "zero model, keyed, article, database or external calls");
  console.log(`PASS GOV.UK source chain: ${checks} offline assertions. No external calls.`);
} finally {
  globalThis.fetch = oldFetch;
  console.warn = oldWarn;
  for (const name of flagNames) {
    const value = originals.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
