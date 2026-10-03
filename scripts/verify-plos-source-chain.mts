// Offline execution of the real resolver with injected public adapters. No
// service client, provider account, reader, letter persistence or send.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createElement, type ReactNode } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { createPlosMetadataSearch } from "../lib/engine/plos-metadata-search";
import * as attribution from "../lib/source-attribution";
import * as topics from "../lib/topics";
import * as queries from "../lib/engine/topic-queries";
import * as rank from "../lib/engine/source-rank";
import * as urlGuard from "../lib/engine/url-guard";
import * as textClean from "../lib/engine/text-clean";
import * as promptFence from "../lib/prompt-fence";
import { generateTopicBlurb } from "../lib/engine/topic-blurb";
import { sourceCreditsForIssue, renderHTML, renderText } from "../lib/email";
import type { Issue, TopicId } from "../lib/types";
import type { TopicSignal } from "../lib/engine/types";

const savedModel = process.env.ALPHA_NO_MODEL_MODE;
const oldFetch = globalThis.fetch, oldWarn = console.warn;
const events: string[] = [];
let sourceRequests = 0, forbidden = 0;
let plosUnavailable = false;
const now = Date.now(), published = new Date(now - 60_000).toISOString();
const issueDate = published.slice(0, 10);
const item = (id: string, title: string) => ({ id: `10.1371/journal.pone.${id}`, title_display: title,
  publication_date: published, article_type: "Research Article", author_display: ["Offline Writer"],
  copyright: "Creative Commons Attribution License (CC BY 4.0)" });
const plos = createPlosMetadataSearch({ now: () => now, reserve: async () => {},
  attempt: async (_provider, reserve, work) => { await reserve(); return work(); },
  fetcher: async () => { sourceRequests++; return new Response(JSON.stringify({ response: { numFound: 3, docs: [
    item("0123456", "Human nutrition reading"), item("0123457", "Human nutrition reading update"),
    item("0123458", "Artificial intelligence research reading"),
  ] } }), { headers: { "content-type": "application/json" } }); },
});
const fail = (label: string) => async () => { events.push(label); throw new Error("Offline source unavailable"); };
const forbiddenCall = () => { forbidden++; throw new Error("Forbidden provider or body request"); };
try {
  globalThis.fetch = forbiddenCall as typeof fetch;
  console.warn = () => {};
  process.env.ALPHA_NO_MODEL_MODE = "1";
  const module = { resolveTopicSignal: async (_topic: TopicId, _date: string, _opts?: any): Promise<TopicSignal | undefined> => undefined };
  const source = readFileSync(new URL("../lib/engine/source-resolver.ts", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: module, console, Set,
    require(name: string) {
      const modules: Record<string, any> = {
        "@/lib/brave": { braveConfigured: forbiddenCall, braveSearch: forbiddenCall },
        "@/lib/you-search": { youConfigured: forbiddenCall, youSearch: forbiddenCall },
        "./source-rank": rank, "./fetch-content": { fetchArticleText: forbiddenCall, deepReadEnabled: () => true },
        "./topic-queries": queries, "./url-guard": urlGuard,
        "./gemini-client": { geminiConfigured: forbiddenCall }, "./gemini-search": { resolveTopicSignalViaGemini: forbiddenCall },
        "@/lib/topics": topics, "@/lib/prompt-fence": promptFence, "./text-clean": textClean,
        "./provider-policy": { noModelModeEnabled: () => true, noKeySourcesEnabled: () => true },
        "./public-feed-search": { publicFeedFallbackEnabled: () => true, publicFeedSearch: fail("google") },
        "./publisher-feed-search": { publisherFeedFallbackEnabled: () => true, publisherFeedSearch: fail("publisher") },
        "./open-news-feed-search": { openNewsFeedFallbackEnabled: () => true, openNewsFeedSearch: fail("global-voices") },
        "./research-metadata-search": { researchMetadataFallbackEnabled: () => true, researchMetadataSearch: fail("crossref") },
        "./plos-metadata-search": { plosMetadataFallbackEnabled: () => true,
          plosMetadataSearch: (...args: Parameters<typeof plos>) => plosUnavailable
            ? fail("plos")() : plos(...args) },
        "./gdelt-search": { gdeltFallbackEnabled: () => false, gdeltSearch: forbiddenCall },
        "@/lib/source-attribution": attribution,
      };
      assert.ok(Object.hasOwn(modules, name), "Unexpected resolver import");
      return modules[name];
    },
  }, { timeout: 1000 });
  const excluded = urlGuard.normalizeUrl("https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0123456")!;
  const signal = await module.resolveTopicSignal("nutrition-food", issueDate, { freshness: "pd", excludeUrls: new Set([excluded]) });
  assert.ok(signal);
  assert.equal(signal.sources?.length, 1);
  assert.equal(signal.sources?.[0].attribution?.publisher, "plos");
  assert.ok(!signal.citableUrls?.has(excluded));
  assert.ok(!signal.citableUrls?.has(attribution.PLOS_LICENSE_URL));
  assert.ok(events.indexOf("crossref") > events.indexOf("global-voices"));
  assert.equal(sourceRequests, 1);
  const ai = await module.resolveTopicSignal("ai-news", issueDate, { freshness: "pd" });
  assert.ok(ai);
  assert.equal(sourceRequests, 1, "three-topic raw pool is shared before reader exclusions");
  assert.equal(await module.resolveTopicSignal("custom:PRIVATE_OFFLINE_TOPIC", issueDate, { freshness: "pd" }), undefined);
  assert.equal(sourceRequests, 1, "unsupported custom topics do not reach PLOS");
  const blurb = await generateTopicBlurb("nutrition-food", issueDate, signal);
  assert.equal(blurb.items[0].attribution?.author, "Offline Writer");
  assert.equal(blurb.items[0].primaryRef?.url, signal.sources![0].url);
  const issue: Issue = { id: "offline", volume: 1, number: 1, weekOf: issueDate, recipientFirstName: "Reader", recipientCity: "", editorIntro: "Offline preview", sections: [{ topicId: "nutrition-food", topicLabel: "Nutrition", intro: "", items: blurb.items }] };
  const credits = sourceCreditsForIssue(JSON.parse(JSON.stringify(issue)));
  assert.equal(credits.length, 1);
  const args = { firstName: "Reader", teaser: "Offline preview", sectionList: "OFFLINE_INCLUDED_HEADLINE", inboxUrl: "https://example.org/inbox", weekOf: issueDate, unsubscribeUrl: null, sourceCredits: credits };
  for (const rendered of [renderHTML(args), renderText(args)]) {
    assert.ok(rendered.includes("Offline Writer"));
    assert.ok(rendered.includes("PLOS"));
    assert.ok(rendered.includes(attribution.PLOS_LICENSE_URL));
    assert.ok(rendered.indexOf("Offline Writer") < rendered.indexOf("OFFLINE_INCLUDED_HEADLINE"));
    assert.ok(!rendered.includes("Global Voices"));
  }
  const digestModule: { Digest?: (props: { issue: Issue }) => ReactNode } = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../components/Digest.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: digestModule, URL,
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
  const html = renderToStaticMarkup(createElement(digestModule.Digest!, { issue }));
  assert.ok(html.includes("PLOS"));
  assert.ok(html.includes(attribution.PLOS_LICENSE_URL));
  assert.ok(html.indexOf("Offline Writer") < html.indexOf("Human nutrition reading update"));
  assert.ok(!html.includes("Global Voices"));
  for (const url of [signal.sources![0].url + "&id=10.1371/journal.pone.0123456", signal.sources![0].url.replace("plosone", "mentalhealth"), signal.sources![0].url + "#fake", signal.sources![0].url.replace("journals.plos.org", "journals.plos.org.evil.test")]) {
    assert.equal(attribution.validatedSourceAttribution(url, credits[0].attribution), undefined);
  }
  // All five enabled tiers unavailable must remain a visible absence of
  // source signal. It cannot reopen keyed search, paid writers or body reads.
  plosUnavailable = true;
  const failedStart = events.length;
  const requestsBeforeFailure = sourceRequests;
  assert.equal(await module.resolveTopicSignal("ai-news", issueDate, { freshness: "pd" }), undefined);
  const failedTiers = events.slice(failedStart);
  for (const name of ["google", "publisher", "global-voices", "crossref", "plos"]) {
    assert.ok(failedTiers.includes(name), "each enabled tier is reached in the bounded all-down fixture");
  }
  assert.ok(failedTiers.indexOf("publisher") > failedTiers.lastIndexOf("google"));
  assert.ok(failedTiers.indexOf("global-voices") > failedTiers.indexOf("publisher"));
  assert.ok(failedTiers.indexOf("crossref") > failedTiers.indexOf("global-voices"));
  assert.ok(failedTiers.indexOf("plos") > failedTiers.indexOf("crossref"));
  assert.equal(sourceRequests, requestsBeforeFailure, "injected failure cannot perform an extra source request");
  assert.equal(forbidden, 0);
  console.log("PASS PLOS resolver failover, no paid/model/body calls, repeat exclusion, stored credit and web/email rendering (offline)");
} finally {
  globalThis.fetch = oldFetch; console.warn = oldWarn;
  if (savedModel === undefined) delete process.env.ALPHA_NO_MODEL_MODE; else process.env.ALPHA_NO_MODEL_MODE = savedModel;
}
