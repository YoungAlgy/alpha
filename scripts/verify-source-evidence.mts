// Generic offline fixtures. No subscriber, database, model, provider or send.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as evidenceModule from "../lib/engine/source-evidence";
import { createSourceEvidence, createSourceObserver, type SourceObservation } from "../lib/engine/source-evidence";
import { selectLetterSections } from "../lib/engine/select-sections";
import { normalizeUrl } from "../lib/engine/url-guard";
import { issueIsReaderVisible } from "../lib/issue-visibility";
import { withDeadline } from "../lib/with-deadline";
import * as topics from "../lib/topics";
import * as queries from "../lib/engine/topic-queries";
import * as rank from "../lib/engine/source-rank";
import * as urlGuard from "../lib/engine/url-guard";
import * as textClean from "../lib/engine/text-clean";
import * as promptFence from "../lib/prompt-fence";
import * as attribution from "../lib/source-attribution";
import { publisherFeedTopicSupported } from "../lib/engine/publisher-feed-search";
import { openNewsFeedTopicSupported } from "../lib/engine/open-news-feed-search";
import { researchMetadataTopicSupported } from "../lib/engine/research-metadata-search";
import { plosMetadataTopicSupported } from "../lib/engine/plos-metadata-search";
import type { TopicBlurb } from "../lib/engine/types";
import type { TopicId, UserProfile } from "../lib/types";
import type { TopicResolution } from "../lib/engine/source-resolver";

const events: Readonly<SourceObservation>[] = [];
const observer = createSourceObserver(value => events.push(value));
observer("google-rss", "healthy-empty", 0, "no-key");
observer("publisher-rss", "unavailable", 0, "no-key");
observer("globalvoices-rss", "signal", 2, "no-key");
assert.equal(events[0].selection, "first-enabled", "no-key primary is not an outage fallback");
assert.equal(events[1].selection, "after-empty");
assert.equal(events[2].selection, "after-unavailable");
assert.ok(events.every(Object.isFrozen));
const independent: Readonly<SourceObservation>[] = [];
createSourceObserver(value => independent.push(value))("google-rss", "signal", 1, "no-key");
assert.equal(independent[0].selection, "first-enabled", "resolver calls do not share state");
assert.doesNotThrow(() => createSourceObserver(() => { throw new Error("fixture observer failure"); })("google-rss", "signal", 1, "no-key"));
const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
try {
  createSourceObserver(async () => { throw new Error("fixture async observer failure"); })("google-rss", "signal", 1, "no-key");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unhandled.length, 0, "async observer rejection is consumed without waiting on telemetry");
} finally { process.off("unhandledRejection", onUnhandled); }
const uncertain: Readonly<SourceObservation>[] = [];
const uncertainObserver = createSourceObserver(value => uncertain.push(value));
uncertainObserver("gemini", "no-signal-unconfirmed", 0, "keyed");
uncertainObserver("you", "signal", 1, "keyed");
assert.equal(uncertain[1].selection, "after-unconfirmed");
const uncertainEvidence = createSourceEvidence<object>();
uncertain.forEach(uncertainEvidence.observe);
const uncertainBlurb = {};
uncertainEvidence.mark(uncertainBlurb, uncertain[1]);
const uncertainSnapshot = uncertainEvidence.snapshot([uncertainBlurb]);
assert.equal(uncertainSnapshot.attempts.gemini.noSignalUnconfirmed, 1);
assert.equal(uncertainSnapshot.attempts.gemini.healthyEmpty, 0);
assert.equal(uncertainSnapshot.attempts.gemini.unavailable, 0);
assert.equal(uncertainSnapshot.selected.you.afterUnconfirmed, 1);

const evidence = createSourceEvidence<object>();
const fresh = {}, discarded = {}, cached = {}, reused = {}, unknown = {};
for (const event of events) evidence.observe(event);
evidence.mark(fresh, events[2]);
evidence.mark(discarded, events[2]);
evidence.mark(cached, "cached");
evidence.mark(reused, "reused");
evidence.observe({ ...events[2], provider: "private invalid provider" } as unknown as SourceObservation);
evidence.observe({ ...events[2], admittedSources: -1 });
evidence.observe({ ...events[2], admittedSources: 101 });
evidence.observe({ ...events[2], admittedSources: NaN });
evidence.mark(unknown, { ...events[2], topic: "PRIVATE_CONTEXT_MARKER", url: "https://private.example.test" } as SourceObservation);
const snapshot = evidence.snapshot([fresh, cached, reused]);
assert.equal(snapshot.selectedSections, 3);
assert.equal(snapshot.selected["globalvoices-rss"].sections, 1, "discarded candidate never counts as final section");
assert.equal(snapshot.selected["globalvoices-rss"].afterUnavailable, 1);
assert.equal(snapshot.cachedProvenanceUnknown, 1);
assert.equal(snapshot.reusedProvenanceUnknown, 1);
assert.equal(evidence.snapshot([{}]).otherProvenanceUnknown, 1, "object clones do not inherit provider identity");
assert.doesNotMatch(JSON.stringify(evidence.snapshot([unknown])), /PRIVATE_CONTEXT_MARKER|private\.example/);
const frozen = JSON.stringify(snapshot);
evidence.observe(events[2]);
evidence.mark(cached, events[2]);
assert.equal(JSON.stringify(snapshot), frozen, "late work cannot mutate an emitted snapshot");
assert.throws(() => { snapshot.selected["globalvoices-rss"].sections++; }, TypeError);
assert.equal(createSourceEvidence().snapshot([]).selectedSections, 0);

// Exercise the real resolver with transport fixtures and reader exclusions.
const flags = ["ALPHA_NO_KEY_SOURCES", "ALPHA_NO_MODEL_MODE", "ALPHA_ALLOW_PAID_AI",
  "ALPHA_PUBLISHER_FEED_FALLBACK", "ALPHA_OPEN_NEWS_FALLBACK", "ALPHA_RESEARCH_METADATA_FALLBACK",
  "ALPHA_PLOS_METADATA_FALLBACK", "ALPHA_CCMIXTER_METADATA_FALLBACK", "ALPHA_GDELT_FALLBACK",
  "ALPHA_FEDERAL_REGISTER_FINANCE_FALLBACK",
  "ALPHA_GOVUK_NEWS_FALLBACK",
  "ALPHA_DURABLE_SOURCE_BUDGET", "ALPHA_DURABLE_SOURCE_COOLDOWN"];
const old = new Map(flags.map(name => [name, process.env[name]]));
const savedFetch = globalThis.fetch;
const savedWarn = console.warn;
const warnings: string[] = [];
let unexpected = 0;
try {
  for (const flag of flags) process.env[flag] = "0";
  process.env.ALPHA_NO_KEY_SOURCES = "1";
  process.env.ALPHA_NO_MODEL_MODE = "1";
  process.env.ALPHA_PUBLISHER_FEED_FALLBACK = "1";
  console.warn = (...args) => warnings.push(args.join(" "));
  const now = Date.now();
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    const url = new URL(String(input));
    if (url.hostname === "news.google.com") return new Response(null, { status: 503 });
    if (url.hostname !== "www.fda.gov") { unexpected++; throw new Error("Unexpected offline transport"); }
    return new Response(`<rss><channel>${[1, 2].map(n => `<item><title>Medical device safety fixture ${n}</title><link>https://www.fda.gov/evidence-fixture-${n}</link><pubDate>${new Date(now - 60000).toUTCString()}</pubDate><description>DISCARDED_CONTENT_MARKER</description></item>`).join("")}</channel></rss>`);
  };
  const { resolveTopicSignal } = await import("../lib/engine/source-resolver");
  const observed: Readonly<SourceObservation>[] = [];
  const date = new Date(now).toISOString().slice(0, 10);
  const signal = await resolveTopicSignal("longevity-wellness", date, {
    freshness: "pd", excludeUrls: new Set([normalizeUrl("https://www.fda.gov/evidence-fixture-1")!]),
    onSourceObservation: value => observed.push(value),
  });
  assert.ok(signal);
  assert.deepEqual(observed.map(value => [value.provider, value.outcome, value.admittedSources]),
    [["google-rss", "unavailable", 0], ["publisher-rss", "signal", 1]]);
  assert.equal(observed[1].selection, "after-unavailable");
  assert.doesNotMatch(JSON.stringify(observed), /device|fda\.gov|DISCARDED_CONTENT_MARKER|longevity/);
  assert.ok(await resolveTopicSignal("longevity-wellness", date, { onSourceObservation: () => { throw new Error("Optional observer failed"); } }), "observer failure cannot change successful resolution");
  const exhausted: Readonly<SourceObservation>[] = [];
  assert.equal(await resolveTopicSignal("longevity-wellness", date, {
    excludeUrls: new Set([1, 2].map(n => normalizeUrl(`https://www.fda.gov/evidence-fixture-${n}`)!)),
    onSourceObservation: value => exhausted.push(value),
  }), undefined);
  assert.equal(exhausted[1].outcome, "healthy-empty", "prior exclusions precede admitted evidence");
  assert.equal(unexpected, 0);

  // Gemini's real legacy return shape cannot prove healthy-empty or outage.
  // Exercise the actual resolver with injected keyed adapters, never keys.
  const resolver: { resolveTopicSignal?: (...args: any[]) => Promise<unknown>;
    resolveTopicSignalResult?: (...args: any[]) => Promise<TopicResolution> } = {};
  let keyedOutcome: "signal" | "empty" | "failure" = "signal";
  let geminiEnabled = true, youEnabled = true;
  type ApplicabilityLane = "publisher" | "globalvoices" | "crossref" | "plos";
  const applicabilityEnabled = new Set<ApplicabilityLane>();
  const applicabilityCalls: ApplicabilityLane[] = [];
  let applicabilityOutcome: "empty" | "failure" | "signal" = "empty";
  const applicabilitySearch = (lane: ApplicabilityLane) => async () => {
    applicabilityCalls.push(lane);
    if (applicabilityOutcome === "failure") throw new Error("Offline applicable source unavailable");
    return applicabilityOutcome === "signal"
      ? [{ title: "Current music release fixture", url: "https://example.org/fixture-music", description: "Offline metadata" }]
      : [];
  };
  const resolverCode = ts.transpileModule(readFileSync(new URL("../lib/engine/source-resolver.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const forbidden = () => { throw new Error("Unexpected fixture provider or article request"); };
  vm.runInNewContext(resolverCode, { exports: resolver, console: { warn: () => {} }, Set, require(name: string) {
    const modules: Record<string, unknown> = {
      "@/lib/brave": { braveConfigured: () => false, braveSearch: forbidden },
      "@/lib/you-search": { youConfigured: () => youEnabled, youSearch: async () => {
        if (keyedOutcome === "failure") throw Error("Offline search failure");
        return keyedOutcome === "empty" ? [] : [{ title: "Artificial intelligence research fixture", url: "https://example.org/fixture-ai", description: "Offline metadata" }];
      } },
      "./source-rank": rank, "./source-evidence": evidenceModule,
      "./fetch-content": { fetchArticleText: forbidden, deepReadEnabled: () => false },
      "./topic-queries": queries, "./url-guard": urlGuard,
      "./gemini-client": { geminiConfigured: () => geminiEnabled }, "./gemini-search": { resolveTopicSignalViaGemini: async () => undefined },
      "@/lib/topics": topics, "@/lib/prompt-fence": promptFence, "./text-clean": textClean,
      "./provider-policy": { noModelModeEnabled: () => false, noKeySourcesEnabled: () => false },
      "./public-feed-search": { publicFeedFallbackEnabled: () => false, publicFeedSearch: forbidden },
      "./publisher-feed-search": { publisherFeedFallbackEnabled: () => applicabilityEnabled.has("publisher"),
        publisherFeedTopicSupported, publisherFeedSearch: applicabilitySearch("publisher") },
      "./open-news-feed-search": { openNewsFeedFallbackEnabled: () => applicabilityEnabled.has("globalvoices"),
        openNewsFeedTopicSupported, openNewsFeedSearch: applicabilitySearch("globalvoices") },
      "./research-metadata-search": { researchMetadataFallbackEnabled: () => applicabilityEnabled.has("crossref"),
        researchMetadataTopicSupported, researchMetadataSearch: applicabilitySearch("crossref") },
      "./plos-metadata-search": { plosMetadataFallbackEnabled: () => applicabilityEnabled.has("plos"),
        plosMetadataTopicSupported, plosMetadataSearch: applicabilitySearch("plos") },
      "./ccmixter-metadata-search": { ccmixterMetadataFallbackEnabled: () => false, ccmixterMetadataSearch: forbidden },
      "./federal-register-finance-search": { federalRegisterFinanceFallbackEnabled: () => false, federalRegisterFinanceSearch: forbidden },
      "./govuk-news-search": { govUkNewsFallbackEnabled: () => false, govUkNewsSearch: forbidden },
      "./statcan-labour-search": { statCanLabourFallbackEnabled: () => false, statCanLabourSearch: forbidden },
      "./openalex-metadata": { openAlexTopicLane: () => undefined },
      "./openalex-metadata-search": { openAlexMetadataFallbackEnabled: () => false, openAlexMetadataSearch: forbidden },
      "./cdm-metadata": { cdmTopicSupported: () => false },
      "./cdm-metadata-search": { cdmMetadataFallbackEnabled: () => false, cdmMetadataSearch: forbidden },
      "./gdelt-search": { gdeltFallbackEnabled: () => false, gdeltSearch: forbidden },
      "@/lib/source-attribution": attribution,
    };
    assert.ok(Object.hasOwn(modules, name), "Unknown offline resolver import");
    return modules[name];
  } }, { timeout: 1000 });
  const legacy: Readonly<SourceObservation>[] = [];
  assert.ok(await resolver.resolveTopicSignal!("ai-news", date, { onSourceObservation: (value: Readonly<SourceObservation>) => legacy.push(value) }));
  assert.deepEqual(legacy.map(value => [value.provider, value.outcome, value.selection]),
    [["gemini", "no-signal-unconfirmed", "first-enabled"], ["you", "signal", "after-unconfirmed"]]);
  assert.equal((await resolver.resolveTopicSignalResult!("ai-news", date)).state, "signal", "partial fallback work wins over uncertainty");
  keyedOutcome = "empty";
  assert.equal((await resolver.resolveTopicSignalResult!("ai-news", date)).state, "no-signal-unconfirmed", "healthy empty cannot erase another provider's uncertainty");
  keyedOutcome = "failure";
  assert.equal((await resolver.resolveTopicSignalResult!("ai-news", date)).state, "unavailable");
  assert.equal(await resolver.resolveTopicSignal!("ai-news", date), undefined, "legacy signal-only wrapper stays compatible");
  geminiEnabled = false;
  keyedOutcome = "empty";
  assert.equal((await resolver.resolveTopicSignalResult!("ai-news", date)).state, "healthy-empty");
  assert.equal((await resolver.resolveTopicSignalResult!("ai-news", date, { quotaState: { monthlyExhausted: true } })).state,
    "unavailable", "spent search quota cannot become a confirmed quiet verdict");
  youEnabled = false;
  assert.equal((await resolver.resolveTopicSignalResult!("ai-news", date)).state, "no-signal-unconfirmed", "no attempted source cannot prove empty");

  // Actual adapter selectors decide applicability before any observed search.
  assert.equal(publisherFeedTopicSupported("nutrition-food"), true);
  assert.equal(publisherFeedTopicSupported("music"), false);
  assert.equal(publisherFeedTopicSupported("constructor"), false);
  assert.equal(researchMetadataTopicSupported("nutrition-food"), true);
  assert.equal(researchMetadataTopicSupported("mental-health"), false);
  for (const topic of ["nutrition-food", "mental-health", "ai-news"]) {
    assert.equal(plosMetadataTopicSupported(topic), true);
  }
  assert.equal(plosMetadataTopicSupported("music"), false);
  assert.equal(openNewsFeedTopicSupported("music"), true);
  assert.equal(openNewsFeedTopicSupported("custom:country music"), true);
  assert.equal(openNewsFeedTopicSupported("custom:Florida solar research"), true);
  assert.equal(openNewsFeedTopicSupported("custom:news"), false);
  const applicabilityCases = [
    { lane: "publisher", provider: "publisher-rss", unsupported: "music", supported: "nutrition-food" },
    { lane: "globalvoices", provider: "globalvoices-rss", unsupported: "custom:news", supported: "music" },
    { lane: "crossref", provider: "crossref", unsupported: "music", supported: "nutrition-food" },
    { lane: "plos", provider: "plos", unsupported: "music", supported: "ai-news" },
  ] as const;
  for (const scenario of applicabilityCases) {
    applicabilityEnabled.clear();
    applicabilityEnabled.add(scenario.lane);
    applicabilityCalls.length = 0;
    applicabilityOutcome = "empty";
    const unsupportedObservations: Readonly<SourceObservation>[] = [];
    const unsupported = await resolver.resolveTopicSignalResult!(scenario.unsupported, date, {
      onSourceObservation: (value: Readonly<SourceObservation>) => unsupportedObservations.push(value),
    });
    assert.equal(unsupported.state, "no-signal-unconfirmed", `${scenario.lane}: unsupported is not confirmed quiet`);
    assert.equal(unsupportedObservations.length, 0, `${scenario.lane}: unsupported emits no attempted-source evidence`);
    assert.equal(applicabilityCalls.length, 0, `${scenario.lane}: unsupported does not call its search adapter`);
    for (const outcome of ["empty", "failure"] as const) {
      applicabilityOutcome = outcome;
      applicabilityCalls.length = 0;
      const supportedObservations: Readonly<SourceObservation>[] = [];
      const supported = await resolver.resolveTopicSignalResult!(scenario.supported, date, {
        onSourceObservation: (value: Readonly<SourceObservation>) => supportedObservations.push(value),
      });
      const expected = outcome === "empty" ? "healthy-empty" : "unavailable";
      assert.equal(supported.state, expected, `${scenario.lane}: supported ${outcome} retains its actual verdict`);
      assert.deepEqual(applicabilityCalls, [scenario.lane]);
      assert.deepEqual(supportedObservations.map(value => [value.provider, value.outcome, value.selection]),
        [[scenario.provider, expected, "first-enabled"]]);
    }
  }
  applicabilityEnabled.clear();
  applicabilityEnabled.add("publisher");
  applicabilityEnabled.add("globalvoices");
  applicabilityCalls.length = 0;
  applicabilityOutcome = "signal";
  const usefulObservations: Readonly<SourceObservation>[] = [];
  const useful = await resolver.resolveTopicSignalResult!("music", date, {
    onSourceObservation: (value: Readonly<SourceObservation>) => usefulObservations.push(value),
  });
  assert.equal(useful.state, "signal", "useful applicable work survives an unsupported earlier lane");
  assert.deepEqual(applicabilityCalls, ["globalvoices"]);
  assert.deepEqual(usefulObservations.map(value => [value.provider, value.outcome, value.selection]),
    [["globalvoices-rss", "signal", "first-enabled"]], "unsupported publisher must not invent a prior-empty attempt");
  applicabilityEnabled.clear();

  // Actual assembly/selection code, injected inert cache and generation hooks.
  const blurb = (topicId: TopicId, path: string): TopicBlurb => ({ topicId, topicLabel: "Generic fixture", weekOf: date,
    intro: "Generic fixture intro", items: [{ kind: "read", headline: "Generic fixture headline", body: "Generic fixture body",
      primaryRef: { label: "Generic reference", url: `https://www.fda.gov/${path}` } }] });
  const cachedBlurb = blurb("nutrition-food", "collision-fixture");
  const sharedBlurb = blurb("ai-news", "shared-fixture");
  const finalBlurb = blurb("mental-health", "final-fixture");
  const saved = new Map([["nutrition-food", cachedBlurb]]);
  let generated = 0;
  let writes = 0;
  const summaries: string[] = [];
  const assemblyWarnings: string[] = [];
  let resolutionOverride: ((id: TopicId, freshness: string | undefined) => Promise<TopicResolution>) | undefined;
  let generationOverride: ((id: TopicId) => TopicBlurb) | undefined;
  let allowEmptyFormatter = false;
  const assembly: { generateIssue?: (...args: any[]) => Promise<unknown> } = {};
  const code = ts.transpileModule(readFileSync(new URL("../lib/engine/assemble.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(code, { exports: assembly, console: {
    warn: (message: string) => assemblyWarnings.push(message), info: (label: string, value: string) => { assert.equal(label, "[source-evidence]"); summaries.push(value); },
  }, Set, Map, WeakMap, Date, require(name: string) {
    const modules: Record<string, unknown> = {
      "./source-evidence": evidenceModule,
      "./topic-blurb": { generateTopicBlurb: async (id: TopicId) => { generated++; return generationOverride ? generationOverride(id) : id === "mental-health" ? finalBlurb : blurb(id, "collision-fixture"); } },
      "./editor-note": { generateEditorNote: async () => "Generic offline intro" },
      "./source-resolver": { resolveTopicSignalResult: async (id: TopicId, _date: string, opts: any) => {
        if (resolutionOverride) return resolutionOverride(id, opts.freshness);
        const notify = createSourceObserver(opts.onSourceObservation);
        notify("google-rss", id === "mental-health" ? "unavailable" : "healthy-empty", 0, "no-key");
        notify(id === "mental-health" ? "plos" : "publisher-rss", "signal", 1, "no-key");
        return { state: "signal", signal: { topicId: id, weekOf: date, context: "PRIVATE_CONTEXT_MARKER" } };
      } },
      "./blurb-cache": { getCachedBlurbs: async () => saved,
        getCitationHistory: async () => ({ state: "available", urlsByTopic: new Map(), unavailableTopicIds: new Set() }),
        setCachedBlurb: async () => { writes++; } },
      "@/lib/issue-visibility": { issueIsReaderVisible }, "./url-guard": { normalizeUrl },
      "./select-sections": { selectLetterSections }, "./deterministic-fallback": { buildDeterministicBlurb: () => { if (allowEmptyFormatter) return null; throw new Error("Unexpected formatter fallback"); } },
      "@/lib/topics": { topicLabel: () => "Generic fixture", mapTopicsForUser: (ids: TopicId[]) => ids, GENERIC_FALLBACK_TOPICS: [] },
      "@/lib/with-deadline": { withDeadline },
    };
    assert.ok(Object.hasOwn(modules, name), "Unknown offline assembly import");
    return modules[name];
  } }, { timeout: 1000 });
  const user = { firstName: "Fixture", city: "Fixture", topics: ["nutrition-food", "real-estate", "ai-news", "mental-health"], theme: "linen" } as UserProfile;
  const inFlight = new Map([[`ai-news|${date}|pw`, Promise.resolve(sharedBlurb)]]);
  const issue = await assembly.generateIssue!(user, date, 3, "pw", new Set(), inFlight);
  assert.equal(generated, 2);
  assert.equal(writes, 2);
  assert.equal(summaries.length, 1);
  const selected = JSON.parse(summaries[0]);
  assert.equal(selected.stage, "assembled");
  assert.equal(selected.selectedSections, 3);
  assert.equal(selected.attempts["publisher-rss"].signal, 1);
  assert.equal(selected.selected["publisher-rss"].sections, 0, "same-letter collision candidate is excluded from final-use count");
  assert.equal(selected.selected.plos.sections, 1);
  assert.equal(selected.selected.plos.afterUnavailable, 1);
  assert.equal(selected.cachedProvenanceUnknown, 1);
  assert.equal(selected.reusedProvenanceUnknown, 1);
  assert.equal(selected.otherProvenanceUnknown, 0);
  assert.doesNotMatch(summaries[0], /PRIVATE_CONTEXT_MARKER|Fixture|fda\.gov|nutrition-food|real-estate|ai-news|mental-health/);
  assert.doesNotMatch(JSON.stringify(issue), /source-evidence|admittedSources|cachedProvenanceUnknown/);
  // Actual assembly with a failed favorite and healthy backup. Repeat readers
  // share bounded failure/dry caches without converting either verdict.
  const scenarioUser = { ...user, topics: ["mental-health", "ai-news"] };
  for (const terminal of ["unavailable", "no-signal-unconfirmed", "healthy-empty"] as const) {
    const dry = new Set<string>(), failed = new Set<string>();
    const active = new Map<string, Promise<TopicBlurb | null>>();
    const calls: string[] = [];
    resolutionOverride = async (id, freshness) => {
      calls.push(`${id}|${freshness}`);
      return id === "mental-health" ? { state: terminal }
        : { state: "signal", signal: { topicId: id, weekOf: date, context: "Generic fixture" } };
    };
    assemblyWarnings.length = 0;
    for (let reader = 0; reader < 2; reader++) {
      const partial = await assembly.generateIssue!(scenarioUser, date, 1, "pw", dry, active, failed) as { sections: TopicBlurb[] };
      assert.equal(partial.sections.length, 1);
      assert.equal(partial.sections[0].topicId, "ai-news");
    }
    assert.equal(calls.filter(call => call.startsWith("mental-health|")).length, 1, "batch never repeats an exhausted favorite");
    const key = `mental-health|${date}|pw`;
    assert.equal(dry.has(key), terminal === "healthy-empty");
    assert.equal(failed.has(key), terminal !== "healthy-empty");
    assert.equal(assemblyWarnings.some(message => message.includes("quiet topic")), terminal === "healthy-empty");
    assert.equal(assemblyWarnings.some(message => message.includes("failed or remained unconfirmed")), terminal !== "healthy-empty");
  }
  for (const wider of ["signal", "healthy-empty", "unavailable"] as const) {
    const dry = new Set<string>(), failed = new Set<string>();
    const calls: string[] = [];
    resolutionOverride = async (id, freshness) => {
      calls.push(`${id}|${freshness}`);
      if (id === "ai-news" || freshness === "pw" && wider === "signal") {
        return { state: "signal", signal: { topicId: id, weekOf: date, context: "Generic fixture" } };
      }
      return { state: freshness === "pw" && wider === "healthy-empty" ? "healthy-empty" : "unavailable" };
    };
    await assembly.generateIssue!(scenarioUser, date, 1, "pd", dry, new Map(), failed);
    assert.deepEqual(calls.filter(call => call.startsWith("mental-health|")), ["mental-health|pd", "mental-health|pw"], "wider resolution remains bounded to one retry");
    assert.equal(dry.has(`mental-health|${date}|pd`), wider === "healthy-empty");
    assert.equal(failed.has(`mental-health|${date}|pd`), wider === "unavailable");
  }
  // Empty or unrenderable generated output is retryable quality loss, never
  // confirmed quiet and never a hard-failure cache entry.
  for (const quality of ["empty", "hidden"] as const) {
    const dry = new Set<string>(), failed = new Set<string>();
    const active = new Map<string, Promise<TopicBlurb | null>>();
    let favoriteCalls = 0;
    resolutionOverride = async id => {
      if (id === "mental-health") favoriteCalls++;
      return { state: "signal", signal: { topicId: id, weekOf: date, context: "Generic fixture" } };
    };
    generationOverride = id => id !== "mental-health" ? blurb(id, "backup-fixture")
      : quality === "empty" ? { ...finalBlurb, items: [] }
      : { ...finalBlurb, intro: "Full text unavailable, snippet: hidden fixture" };
    allowEmptyFormatter = true;
    assemblyWarnings.length = 0;
    for (let reader = 0; reader < 2; reader++) {
      await assembly.generateIssue!(scenarioUser, date, 1, "pw", dry, active, failed);
    }
    assert.equal(favoriteCalls, 2, "quality misses retain the existing independent later attempt");
    assert.equal(dry.size, 0);
    assert.equal(failed.size, 0);
    assert.equal(active.has(`mental-health|${date}|pw`), false, "quality-null attempt is evicted");
    assert.equal(assemblyWarnings.some(message => message.includes("quiet topic")), false);
    assert.equal(assemblyWarnings.some(message => message.includes("unusable generated output")), true);
  }
  console.log("PASS source evidence: fixed privacy shape, topic applicability, terminal source verdicts, failed/quiet/quality separation, bounded wider resolution, fresh/cached/reused assembly (offline)");
} finally {
  globalThis.fetch = savedFetch;
  console.warn = savedWarn;
  for (const [name, value] of old) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}
