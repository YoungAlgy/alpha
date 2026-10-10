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
import type { TopicBlurb } from "../lib/engine/types";
import type { TopicId, UserProfile } from "../lib/types";

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
  const resolver: { resolveTopicSignal?: (...args: any[]) => Promise<unknown> } = {};
  const resolverCode = ts.transpileModule(readFileSync(new URL("../lib/engine/source-resolver.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const forbidden = () => { throw new Error("Unexpected fixture provider or article request"); };
  vm.runInNewContext(resolverCode, { exports: resolver, console: { warn: () => {} }, Set, require(name: string) {
    const modules: Record<string, unknown> = {
      "@/lib/brave": { braveConfigured: () => false, braveSearch: forbidden },
      "@/lib/you-search": { youConfigured: () => true, youSearch: async () => [{ title: "Artificial intelligence research fixture", url: "https://example.org/fixture-ai", description: "Offline metadata" }] },
      "./source-rank": rank, "./source-evidence": evidenceModule,
      "./fetch-content": { fetchArticleText: forbidden, deepReadEnabled: () => false },
      "./topic-queries": queries, "./url-guard": urlGuard,
      "./gemini-client": { geminiConfigured: () => true }, "./gemini-search": { resolveTopicSignalViaGemini: async () => undefined },
      "@/lib/topics": topics, "@/lib/prompt-fence": promptFence, "./text-clean": textClean,
      "./provider-policy": { noModelModeEnabled: () => false, noKeySourcesEnabled: () => false },
      "./public-feed-search": { publicFeedFallbackEnabled: () => false, publicFeedSearch: forbidden },
      "./publisher-feed-search": { publisherFeedFallbackEnabled: () => false, publisherFeedSearch: forbidden },
      "./open-news-feed-search": { openNewsFeedFallbackEnabled: () => false, openNewsFeedSearch: forbidden },
      "./research-metadata-search": { researchMetadataFallbackEnabled: () => false, researchMetadataSearch: forbidden },
      "./plos-metadata-search": { plosMetadataFallbackEnabled: () => false, plosMetadataSearch: forbidden },
      "./ccmixter-metadata-search": { ccmixterMetadataFallbackEnabled: () => false, ccmixterMetadataSearch: forbidden },
      "./federal-register-finance-search": { federalRegisterFinanceFallbackEnabled: () => false, federalRegisterFinanceSearch: forbidden },
      "./govuk-news-search": { govUkNewsFallbackEnabled: () => false, govUkNewsSearch: forbidden },
      "./statcan-labour-search": { statCanLabourFallbackEnabled: () => false, statCanLabourSearch: forbidden },
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
  const assembly: { generateIssue?: (...args: any[]) => Promise<unknown> } = {};
  const code = ts.transpileModule(readFileSync(new URL("../lib/engine/assemble.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(code, { exports: assembly, console: {
    warn: () => {}, info: (label: string, value: string) => { assert.equal(label, "[source-evidence]"); summaries.push(value); },
  }, Set, Map, WeakMap, Date, require(name: string) {
    const modules: Record<string, unknown> = {
      "./source-evidence": evidenceModule,
      "./topic-blurb": { generateTopicBlurb: async (id: TopicId) => { generated++; return id === "mental-health" ? finalBlurb : blurb(id, "collision-fixture"); } },
      "./editor-note": { generateEditorNote: async () => "Generic offline intro" },
      "./source-resolver": { resolveTopicSignal: async (id: TopicId, _date: string, opts: any) => {
        const notify = createSourceObserver(opts.onSourceObservation);
        notify("google-rss", id === "mental-health" ? "unavailable" : "healthy-empty", 0, "no-key");
        notify(id === "mental-health" ? "plos" : "publisher-rss", "signal", 1, "no-key");
        return { topicId: id, weekOf: date, context: "PRIVATE_CONTEXT_MARKER" };
      } },
      "./blurb-cache": { getCachedBlurbs: async () => saved,
        getCitationHistory: async () => ({ state: "available", urlsByTopic: new Map(), unavailableTopicIds: new Set() }),
        setCachedBlurb: async () => { writes++; } },
      "@/lib/issue-visibility": { issueIsReaderVisible }, "./url-guard": { normalizeUrl },
      "./select-sections": { selectLetterSections }, "./deterministic-fallback": { buildDeterministicBlurb: () => { throw new Error("Unexpected formatter fallback"); } },
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
  console.log("PASS source evidence: fixed privacy shape, post-exclusion outcomes, isolated immutable counts, fresh/cached/reused assembly and discarded candidates (offline)");
} finally {
  globalThis.fetch = savedFetch;
  console.warn = savedWarn;
  for (const [name, value] of old) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}
