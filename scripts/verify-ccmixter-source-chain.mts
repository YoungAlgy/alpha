// Local generic metadata fixtures. No source, model, database, reader or send.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createElement, type ReactNode } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { createCcmixterMetadataSearch } from "../lib/engine/ccmixter-metadata-search";
import { buildDeterministicBlurb } from "../lib/engine/deterministic-fallback";
import * as attribution from "../lib/source-attribution";
import * as topics from "../lib/topics";
import * as queries from "../lib/engine/topic-queries";
import * as rank from "../lib/engine/source-rank";
import * as urlGuard from "../lib/engine/url-guard";
import * as textClean from "../lib/engine/text-clean";
import * as promptFence from "../lib/prompt-fence";
import * as sourceEvidence from "../lib/engine/source-evidence";
import { sourceCreditsForIssue } from "../lib/email";
import type { Issue, TopicId } from "../lib/types";
import type { TopicBlurb, TopicSignal } from "../lib/engine/types";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const flags = ["ALPHA_NO_MODEL_MODE", "ALPHA_CCMIXTER_METADATA_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET", "ALPHA_DURABLE_SOURCE_COOLDOWN"];
const originalFlags = new Map(flags.map(name => [name, process.env[name]]));
let forbidden = 0;
const forbiddenCall = () => { forbidden++; throw new Error("External work denied by offline test"); };
const events: string[] = [];
const now = Date.parse("2026-10-08T17:30:00Z");
const issueDate = "2026-10-08";
const fixture = (id: number, name: string) => `<item><title>Generic hip-hop fixture ${id}</title><link>https://ccmixter.org/files/generic_fixture/${id}</link><pubDate>08 Oct 2026 16:00:00 +0000</pubDate><dc:creator>${name}</dc:creator><category>hip_hop, remix</category><description>DISCARDED_BODY_FIXTURE</description><enclosure url="https://example.invalid/forbidden-audio"/></item>`;
let requests = 0;
let available = true;
let enabled = true;
let googleHealthy = false;
const ccmixter = createCcmixterMetadataSearch({ now: () => now, reserve: async provider => {
  assert.equal(provider, "ccmixter-uploads");
}, attempt: async (provider, reserve, work) => {
  assert.equal(provider, "ccmixter-uploads");
  await reserve();
  return work();
}, fetcher: async () => {
  requests++;
  return new Response(`<rss><channel>${fixture(10001, "Earlier fixture creator")}${fixture(10002, "Current fixture creator")}${fixture(10003, "Third fixture creator")}</channel></rss>`);
} });
const emptyTier = (label: string) => async () => { events.push(label); return []; };
const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

try {
  globalThis.fetch = forbiddenCall as typeof fetch;
  console.warn = () => {};
  for (const flag of flags) process.env[flag] = "1";
  const resolver: { resolveTopicSignal?: (topic: TopicId, date: string, opts?: any) => Promise<TopicSignal | undefined> } = {};
  vm.runInNewContext(compile("../lib/engine/source-resolver.ts"), {
    exports: resolver, console, Set,
    require(name: string) {
      const modules: Record<string, unknown> = {
        "@/lib/brave": { braveConfigured: forbiddenCall, braveSearch: forbiddenCall },
        "@/lib/you-search": { youConfigured: forbiddenCall, youSearch: forbiddenCall },
        "./source-rank": rank, "./fetch-content": { fetchArticleText: forbiddenCall, deepReadEnabled: () => true },
        "./topic-queries": queries, "./url-guard": urlGuard,
        "./gemini-client": { geminiConfigured: forbiddenCall }, "./gemini-search": { resolveTopicSignalViaGemini: forbiddenCall },
        "@/lib/topics": topics, "@/lib/prompt-fence": promptFence, "./text-clean": textClean,
        "./provider-policy": { noModelModeEnabled: () => true, noKeySourcesEnabled: () => true },
        "./public-feed-search": { publicFeedFallbackEnabled: () => true, publicFeedSearch: async () => {
          events.push("google");
          return googleHealthy ? [{ title: "Generic hip-hop news", url: "https://apnews.com/article/generic-fixture", description: "Generic current headline." }] : [];
        } },
        "./publisher-feed-search": { publisherFeedFallbackEnabled: () => true, publisherFeedSearch: emptyTier("publisher") },
        "./open-news-feed-search": { openNewsFeedFallbackEnabled: () => true, openNewsFeedSearch: emptyTier("global-voices") },
        "./research-metadata-search": { researchMetadataFallbackEnabled: () => true, researchMetadataSearch: emptyTier("crossref") },
        "./plos-metadata-search": { plosMetadataFallbackEnabled: () => true, plosMetadataSearch: emptyTier("plos") },
        "./ccmixter-metadata-search": { ccmixterMetadataFallbackEnabled: () => enabled,
          ccmixterMetadataSearch: async (...args: Parameters<typeof ccmixter>) => {
            events.push("ccmixter");
            if (!available) throw new Error("Generic unavailable fixture");
            return ccmixter(...args);
          } },
        "./gdelt-search": { gdeltFallbackEnabled: () => false, gdeltSearch: forbiddenCall },
        "@/lib/source-attribution": attribution,
        "./source-evidence": sourceEvidence,
      };
      assert.ok(Object.hasOwn(modules, name), "Unexpected resolver import");
      return modules[name];
    },
  }, { timeout: 1000 });
  const firstUrl = "https://ccmixter.org/files/generic_fixture/10001";
  const excluded = urlGuard.normalizeUrl(firstUrl)!;
  const signal = await resolver.resolveTopicSignal!("music-hiphop", issueDate, { freshness: "pd", excludeUrls: new Set([excluded]) });
  assert.ok(signal);
  assert.equal(requests, 1);
  assert.ok(events.indexOf("ccmixter") > events.indexOf("plos"));
  assert.equal(signal.sources?.length, 1, "one visible item after repeat exclusion, not one raw candidate before exclusion");
  assert.equal(signal.sources![0].url, "https://ccmixter.org/files/generic_fixture/10002");
  assert.ok(!signal.citableUrls?.has(excluded));
  assert.equal(signal.citableUrls?.size, 1);
  assert.match(signal.sources![0].excerpt, /Credited creator: Current fixture creator/);
  assert.match(signal.sources![0].excerpt, /Uploaded to ccMixter 2026-10-08/);
  assert.match(signal.sources![0].excerpt, /Tagged hip-hop/);
  assert.doesNotMatch(signal.context, /DISCARDED_BODY_FIXTURE|forbidden-audio|released this week|rising artist|trending/i);
  assert.equal(signal.sources![0].attribution, undefined, "factual creator credit does not gain a guessed track/site license");
  const blurb = buildDeterministicBlurb(signal)!;
  assert.ok(blurb);
  assert.equal(blurb.items.length, 1);
  assert.equal(blurb.items[0].primaryRef?.url, signal.sources![0].url);
  assert.match(blurb.items[0].body, /Current fixture creator/);
  assert.match(blurb.items[0].body, /Uploaded to ccMixter 2026-10-08/);

  // Run actual saved-JSON validation against an inert query fixture.
  const saved = JSON.parse(JSON.stringify(blurb));
  const query = {
    select() { return this; }, eq() { return this; }, in() { return this; },
    then(resolve: (value: unknown) => unknown) {
      return Promise.resolve({ data: [{ topic_id: "music-hiphop", week_of: issueDate, intro: saved.intro, items: saved.items }], error: null }).then(resolve);
    },
  };
  const cache: { getCachedBlurbs?: (ids: TopicId[], date: string) => Promise<Map<string, TopicBlurb>> } = {};
  vm.runInNewContext(compile("../lib/engine/blurb-cache.ts"), {
    exports: cache, console, Set, Map, Date,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test", SUPABASE_SECRET_KEY: "inert-fixture-marker" } },
    require(name: string) {
      if (name === "@/lib/source-attribution") return attribution;
      if (name === "./url-guard") return urlGuard;
      if (name === "./issue-citation-history") return { readIssueCitationHistory: forbiddenCall };
      if (name === "@/lib/supabase/server") return { supabaseServiceClient: async () => ({ from: (table: string) => { assert.equal(table, "topic_blurbs"); return query; } }) };
      throw new Error("Unexpected cache import");
    },
  }, { timeout: 1000 });
  const stored = (await cache.getCachedBlurbs!(["music-hiphop"], issueDate)).get("music-hiphop")!;
  assert.equal(stored.items.length, 1);
  assert.match(stored.items[0].body, /Current fixture creator/);
  assert.equal(stored.items[0].attribution, undefined);
  const issue: Issue = { id: "offline", volume: 1, number: 1, weekOf: issueDate, recipientFirstName: "Reader", recipientCity: "", editorIntro: "Offline fixture", sections: [{ topicId: "music-hiphop", topicLabel: "Hip-hop", intro: "", items: stored.items }] };
  assert.deepEqual(sourceCreditsForIssue(issue), [], "license-bearing email credits must not label ccMixter as PLOS or Global Voices");
  const digest: { Digest?: (props: { issue: Issue }) => ReactNode } = {};
  vm.runInNewContext(compile("../components/Digest.tsx"), {
    exports: digest, URL,
    require(name: string) {
      if (name === "react/jsx-runtime") return jsxRuntime;
      if (name === "@/lib/source-attribution") return attribution;
      if (name === "./ScrollFadeIn") return { ScrollFadeIn: ({ children }: { children: ReactNode }) => children };
      if (name === "./Wordmark") return { Wordmark: () => "Alpha" };
      if (name === "@/lib/cadence") return { SEND_HOUR_UTC: 14, SEND_MINUTE_UTC: 17 };
      if (name === "@/lib/topics") return { topicEmoji: () => "", topicAnchor: () => "offline", TOPIC_BY_ID: {} };
      throw new Error("Unexpected rendering import");
    },
  }, { timeout: 1000 });
  const rendered = renderToStaticMarkup(createElement(digest.Digest!, { issue }));
  assert.match(rendered, /Current fixture creator/);
  assert.match(rendered, /Uploaded to ccMixter 2026-10-08/);
  assert.ok(rendered.includes(signal.sources![0].url));
  assert.doesNotMatch(rendered, /creativecommons.org|Global Voices|PLOS|DISCARDED_BODY_FIXTURE|forbidden-audio/);

  const beforeOtherTopics = events.filter(x => x === "ccmixter").length;
  for (const topic of ["music", "music-edm", "music-indie", "music-country", "custom:generic music history"] as TopicId[]) {
    assert.equal(await resolver.resolveTopicSignal!(topic, issueDate, { freshness: "pd" }), undefined);
  }
  assert.equal(events.filter(x => x === "ccmixter").length, beforeOtherTopics, "no broadened genre/custom lane");
  assert.equal(requests, 1);
  assert.equal(await resolver.resolveTopicSignal!("music-hiphop", issueDate, { freshness: "pd", excludeUrls: new Set([10001, 10002, 10003].map(id => urlGuard.normalizeUrl(`https://ccmixter.org/files/generic_fixture/${id}`)!)) }), undefined);
  assert.equal(requests, 1, "exhausted recent links use cache and cannot repeat an item");
  available = false;
  assert.equal(await resolver.resolveTopicSignal!("music-hiphop", issueDate, { freshness: "pd" }), undefined);
  enabled = false;
  const beforeDisabled = events.filter(x => x === "ccmixter").length;
  assert.equal(await resolver.resolveTopicSignal!("music-hiphop", issueDate), undefined);
  assert.equal(events.filter(x => x === "ccmixter").length, beforeDisabled);
  enabled = true;
  googleHealthy = true;
  assert.ok(await resolver.resolveTopicSignal!("music-hiphop", issueDate));
  assert.equal(events.filter(x => x === "ccmixter").length, beforeDisabled, "useful earlier source bypasses community fallback");
  assert.equal(requests, 1);
  assert.equal(forbidden, 0);
  console.log("PASS ccMixter offline source chain, one visible upload after exclusion, saved credit/date and web rendering. No external calls.");
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  for (const flag of flags) {
    const value = originalFlags.get(flag);
    if (value === undefined) delete process.env[flag]; else process.env[flag] = value;
  }
}
