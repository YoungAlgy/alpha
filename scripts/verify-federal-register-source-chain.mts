// Local generic Federal Register-shaped metadata only. No public source, model,
// article, database, reader or send is contacted by this verification.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createElement, type ReactNode } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createFederalRegisterFinanceSearch,
  FEDERAL_REGISTER_FINANCE_ENDPOINT,
  federalRegisterFinanceFallbackEnabled,
} from "../lib/engine/federal-register-finance-search";
import { buildDeterministicBlurb } from "../lib/engine/deterministic-fallback";
import * as attribution from "../lib/source-attribution";
import * as topics from "../lib/topics";
import * as queries from "../lib/engine/topic-queries";
import * as rank from "../lib/engine/source-rank";
import * as urlGuard from "../lib/engine/url-guard";
import * as textClean from "../lib/engine/text-clean";
import * as promptFence from "../lib/prompt-fence";
import * as sourceEvidence from "../lib/engine/source-evidence";
import { renderHTML, sourceCreditsForIssue } from "../lib/email";
import type { Issue, TopicId } from "../lib/types";
import type { TopicBlurb, TopicSignal } from "../lib/engine/types";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const flags = [
  "ALPHA_NO_MODEL_MODE",
  "ALPHA_FEDERAL_REGISTER_FINANCE_FALLBACK",
  "ALPHA_DURABLE_SOURCE_BUDGET",
  "ALPHA_DURABLE_SOURCE_COOLDOWN",
];
const originalFlags = new Map(flags.map(name => [name, process.env[name]]));
const now = Date.parse("2026-10-09T12:00:00.000Z");
const issueDate = "2026-10-09";
const acceptedUrl = "https://www.federalregister.gov/documents/2026/10/09/2026-12345/sec-proposes-new-safeguards-for-investment-adviser-custody";
const excludedUrl = "https://www.federalregister.gov/documents/2026/10/09/2026-12344/sec-proposes-updated-retirement-account-reporting-rules";
const fixtureRows = [
  {
    title: "SEC proposes updated retirement account reporting rules",
    type: "Proposed Rule",
    document_number: "2026-12344",
    html_url: excludedUrl,
    publication_date: issueDate,
    agencies: [{ name: "Securities and Exchange Commission", slug: "securities-and-exchange-commission" }],
    body: "DISCARDED_ARTICLE_BODY_FIXTURE",
    abstract: "DISCARDED_ABSTRACT_FIXTURE",
  },
  {
    title: "SEC proposes new safeguards for investment adviser custody",
    type: "Proposed Rule",
    document_number: "2026-12345",
    html_url: acceptedUrl,
    publication_date: issueDate,
    agencies: [{ name: "Securities and Exchange Commission", slug: "securities-and-exchange-commission" }],
    body: "DISCARDED_ARTICLE_BODY_FIXTURE",
    abstract: "DISCARDED_ABSTRACT_FIXTURE",
  },
  {
    title: "SEC announces routine administrative meeting",
    type: "Notice",
    document_number: "2026-12346",
    html_url: "https://www.federalregister.gov/documents/2026/10/09/2026-12346/sec-announces-routine-administrative-meeting",
    publication_date: issueDate,
    agencies: [{ name: "Securities and Exchange Commission", slug: "securities-and-exchange-commission" }],
    body: "DISCARDED_ARTICLE_BODY_FIXTURE",
  },
];

let forbidden = 0;
const forbiddenCall = () => { forbidden++; throw new Error("External work denied by offline test"); };
let adapterRequests = 0;
let failFederalRegister = false;
let googleHealthy = false;
let gdeltHealthy = false;
const events: string[] = [];
const observations: Array<sourceEvidence.SourceObservation> = [];
const topicId = "personal-finance" as const;

function metadataResponse(rows = fixtureRows): Response {
  return new Response(JSON.stringify({ count: rows.length, results: rows }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const makeSearch = (fail = false) => createFederalRegisterFinanceSearch({
  now: () => now,
  reserve: async provider => { assert.equal(provider, "federal-register-finance"); },
  attempt: async (provider, reserve, work) => {
    assert.equal(provider, "federal-register-finance");
    await reserve();
    return work();
  },
  fetcher: async (input, init) => {
    adapterRequests++;
    assert.equal(String(input), FEDERAL_REGISTER_FINANCE_ENDPOINT);
    assert.equal(init?.method, undefined);
    assert.equal(init?.body, undefined);
    assert.equal((init?.headers as Record<string, string>).Accept, "application/json");
    if (fail) throw new Error("Generic transport failure fixture");
    return metadataResponse();
  },
});

const flagsOn = () => { for (const flag of flags) process.env[flag] = "1"; };
const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

try {
  globalThis.fetch = forbiddenCall as typeof fetch;
  console.warn = () => {};

  // All four independent switches are fail-closed, and an unsupported topic
  // cannot turn this fixed financial-rule adapter into a general search path.
  for (const flag of flags) delete process.env[flag];
  assert.equal(federalRegisterFinanceFallbackEnabled(), false, "code default is off");
  let gatedRequests = 0;
  const gated = createFederalRegisterFinanceSearch({
    now: () => now,
    reserve: async () => {},
    attempt: async (_provider, reserve, work) => { await reserve(); return work(); },
    fetcher: async () => { gatedRequests++; return metadataResponse(); },
  });
  for (const missing of flags) {
    flagsOn();
    delete process.env[missing];
    assert.equal(federalRegisterFinanceFallbackEnabled(), false, `${missing} is required`);
    assert.deepEqual(await gated(topicId, { freshness: "pd" }), []);
  }
  flagsOn();
  assert.deepEqual(await gated("nutrition-food", { freshness: "pd" }), []);
  assert.equal(gatedRequests, 0, "disabled gates and unsupported topics make no request");

  const federalRegisterSearch = makeSearch();
  const directRows = await federalRegisterSearch(topicId, { freshness: "pd" });
  assert.equal(adapterRequests, 1);
  assert.equal(directRows.length, 2, "only recognized finance rules are retained");
  assert.equal(directRows[0]?.title, "Federal Register proposed rule: SEC proposes updated retirement account reporting rules");
  assert.equal(directRows[1]?.title, "Federal Register proposed rule: SEC proposes new safeguards for investment adviser custody");
  assert.equal(directRows[1]?.url, acceptedUrl);
  assert.equal(directRows[1]?.age, issueDate, "publication day stays a calendar date, without an invented time");
  assert.match(directRows[1]?.description ?? "", /Proposed-rule document\. This is a proposal\./);
  assert.match(directRows[1]?.description ?? "", /Published 2026-10-09\./);
  assert.match(directRows[1]?.description ?? "", /Issuing agency: Securities and Exchange Commission\./);
  assert.match(directRows[1]?.description ?? "", /Federal Register document 2026-12345\./);
  assert.doesNotMatch(directRows[1]?.description ?? "", /enacted|effective on|takes effect|in force/i);
  assert.doesNotMatch(JSON.stringify(directRows), /DISCARDED_ARTICLE_BODY_FIXTURE|DISCARDED_ABSTRACT_FIXTURE/);
  assert.deepEqual(await federalRegisterSearchForUnsupportedTopic(federalRegisterSearch), []);
  assert.equal(adapterRequests, 1, "unsupported topics do not reuse or broaden the cached search");

  // Actual source-resolver VM. Every earlier no-key source is empty or fails,
  // then the real Federal Register adapter yields a single visible item after
  // the reader's prior-link exclusion. Network, paid/model and article lanes
  // stay forbidden; the adapter alone receives a generic fixture fetcher.
  const firstExcluded = urlGuard.normalizeUrl(excludedUrl)!;
  const resolver: { resolveTopicSignal?: (topic: TopicId, date: string, opts?: any) => Promise<TopicSignal | undefined> } = {};
  const emptyTier = (label: string) => async () => { events.push(label); return []; };
  const resolverSearch = makeSearch();
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
          return googleHealthy ? [{ title: "Personal finance savings news", url: "https://apnews.com/article/generic-finance-fixture", description: "Generic current headline." }] : [];
        } },
        "./publisher-feed-search": { publisherFeedFallbackEnabled: () => true, publisherFeedSearch: async () => {
          events.push("publisher");
          throw new Error("Generic prior-source failure fixture");
        } },
        "./open-news-feed-search": { openNewsFeedFallbackEnabled: () => true, openNewsFeedSearch: emptyTier("global-voices") },
        "./research-metadata-search": { researchMetadataFallbackEnabled: () => true, researchMetadataSearch: emptyTier("crossref") },
        "./plos-metadata-search": { plosMetadataFallbackEnabled: () => true, plosMetadataSearch: emptyTier("plos") },
        "./ccmixter-metadata-search": { ccmixterMetadataFallbackEnabled: () => true, ccmixterMetadataSearch: forbiddenCall },
        "./gdelt-search": { gdeltFallbackEnabled: () => gdeltHealthy, gdeltSearch: async () => {
          events.push("gdelt");
          return [{ title: "Generic personal finance report", url: "https://example.org/generic-finance-report", description: "Generic fallback result." }];
        } },
        "./federal-register-finance-search": {
          federalRegisterFinanceFallbackEnabled,
          federalRegisterFinanceSearch: async (...args: Parameters<typeof resolverSearch>) => {
            events.push("federal-register");
            if (failFederalRegister) return makeSearch(true)(...args);
            return resolverSearch(...args);
          },
        },
        "@/lib/source-attribution": attribution,
        "./source-evidence": sourceEvidence,
        "./govuk-news-search": { govUkNewsFallbackEnabled: () => false, govUkNewsSearch: forbiddenCall },
      };
      assert.ok(Object.hasOwn(modules, name), `Unexpected resolver import ${name}`);
      return modules[name];
    },
  }, { timeout: 1000 });

  const signal = await resolver.resolveTopicSignal!(topicId, issueDate, {
    freshness: "pd",
    excludeUrls: new Set([firstExcluded]),
    onSourceObservation: observation => { observations.push(observation); },
  });
  assert.ok(signal);
  assert.ok(events.indexOf("federal-register") > events.indexOf("plos"), "Federal Register runs after useful earlier sources are empty or unavailable");
  assert.equal(signal.sources?.length, 1, "one item is visible only after prior-link exclusion");
  assert.equal(signal.sources![0]?.url, acceptedUrl);
  assert.equal(signal.citableUrls?.size, 1);
  assert.ok(signal.citableUrls?.has(urlGuard.normalizeUrl(acceptedUrl)!));
  assert.ok(!signal.citableUrls?.has(firstExcluded));
  assert.match(signal.sources![0]?.title ?? "", /^Federal Register proposed rule:/);
  assert.match(signal.sources![0]?.excerpt ?? "", /This is a proposal\./);
  assert.match(signal.sources![0]?.excerpt ?? "", /Published 2026-10-09\./);
  assert.match(signal.sources![0]?.excerpt ?? "", /Issuing agency: Securities and Exchange Commission\./);
  assert.match(signal.sources![0]?.excerpt ?? "", /Federal Register document 2026-12345\./);
  assert.doesNotMatch(signal.context, /DISCARDED_ARTICLE_BODY_FIXTURE|DISCARDED_ABSTRACT_FIXTURE|enacted|effective on|takes effect|in force/i);
  assert.equal(signal.sources![0]?.attribution, undefined, "agency credit is factual metadata, not a guessed content license");
  const registerEvidence = observations.find(item => item.provider === "federal-register");
  assert.deepEqual(registerEvidence, {
    provider: "federal-register", outcome: "signal", admittedSources: 1,
    mode: "no-key", selection: "after-unavailable",
  });

  const blurb = buildDeterministicBlurb(signal)!;
  assert.ok(blurb);
  assert.equal(blurb.items.length, 1);
  assert.equal(blurb.items[0]?.primaryRef?.url, acceptedUrl);
  assert.match(blurb.items[0]?.headline ?? "", /^Federal Register proposed rule:/);
  assert.match(blurb.items[0]?.body ?? "", /This is a proposal\./);
  assert.match(blurb.items[0]?.body ?? "", /Published 2026-10-09\./);
  assert.match(blurb.items[0]?.body ?? "", /Securities and Exchange Commission/);
  assert.match(blurb.items[0]?.body ?? "", /2026-12345/);
  assert.doesNotMatch(blurb.items[0]?.body ?? "", /effective on|takes effect|in force|enacted/i);

  const issue: Issue = {
    id: "offline-federal-register-fixture", volume: 1, number: 1, weekOf: issueDate,
    recipientFirstName: "Reader", recipientCity: "", editorIntro: "Offline fixture",
    sections: [{ topicId, topicLabel: blurb.topicLabel, intro: blurb.intro, items: blurb.items }],
  };
  const serializedIssue = JSON.parse(JSON.stringify(issue)) as Issue;
  assert.equal(serializedIssue.sections[0]?.items.length, 1);
  assert.equal(serializedIssue.sections[0]?.items[0]?.primaryRef?.url, acceptedUrl);
  assert.match(serializedIssue.sections[0]?.items[0]?.headline ?? "", /^Federal Register proposed rule:/);
  for (const marker of ["This is a proposal.", "Published 2026-10-09.", "Securities and Exchange Commission", "2026-12345"]) {
    assert.ok(serializedIssue.sections[0]?.items[0]?.body.includes(marker), `serialized issue keeps ${marker}`);
  }

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
  const rendered = renderToStaticMarkup(createElement(digest.Digest!, { issue: serializedIssue }));
  assert.match(rendered, /Federal Register proposed rule:/);
  assert.match(rendered, /This is a proposal\./);
  assert.match(rendered, /Published 2026-10-09\./);
  assert.match(rendered, /Securities and Exchange Commission/);
  assert.match(rendered, /2026-12345/);
  assert.ok(rendered.includes(acceptedUrl));

  const html = renderHTML({
    firstName: "Reader", teaser: "Offline Federal Register fixture",
    sectionList: `${serializedIssue.sections[0]!.items[0]!.headline}\n${serializedIssue.sections[0]!.items[0]!.body}\n${acceptedUrl}`,
    inboxUrl: "https://alpha.example.test/inbox", weekOf: issueDate, unsubscribeUrl: null,
    sourceCredits: sourceCreditsForIssue(serializedIssue),
  });
  for (const marker of ["Federal Register proposed rule:", "This is a proposal.", "Published 2026-10-09.", "Securities and Exchange Commission", "2026-12345", acceptedUrl]) {
    assert.ok(html.includes(marker), `email HTML keeps ${marker}`);
  }
  assert.doesNotMatch(html, /DISCARDED_ARTICLE_BODY_FIXTURE|DISCARDED_ABSTRACT_FIXTURE/);

  // Other catalog topics never enter the personal-finance lane. Exhausted
  // cached links stay quiet without another source request.
  const beforeUnsupported = events.filter(item => item === "federal-register").length;
  assert.equal(await resolver.resolveTopicSignal!("nutrition-food", issueDate, { freshness: "pd" }), undefined);
  assert.equal(events.filter(item => item === "federal-register").length, beforeUnsupported);
  assert.equal(await resolver.resolveTopicSignal!(topicId, issueDate, {
    freshness: "pd", excludeUrls: new Set([excludedUrl, acceptedUrl].map(url => urlGuard.normalizeUrl(url)!)),
  }), undefined);
  assert.equal(adapterRequests, 2, "one direct adapter check and one resolver request, both cached thereafter");

  // A useful earlier Google result bypasses this optional late lane.
  googleHealthy = true;
  events.length = 0;
  assert.ok(await resolver.resolveTopicSignal!(topicId, issueDate, { freshness: "pd" }));
  assert.ok(events.includes("google"));
  assert.ok(!events.includes("federal-register"));

  // If the optional Federal Register transport fails, the resolver reaches the
  // next configured source and retains that useful result.
  googleHealthy = false;
  gdeltHealthy = true;
  failFederalRegister = true;
  events.length = 0;
  const observationsBeforeFailure = observations.length;
  const afterFailure = await resolver.resolveTopicSignal!(topicId, issueDate, {
    freshness: "pd", onSourceObservation: observation => { observations.push(observation); },
  });
  assert.ok(afterFailure);
  assert.equal(afterFailure.sources?.[0]?.url, "https://example.org/generic-finance-report");
  assert.ok(events.indexOf("gdelt") > events.indexOf("federal-register"));
  assert.ok(observations.slice(observationsBeforeFailure).some(item => item.provider === "federal-register" && item.outcome === "unavailable"));

  assert.equal(forbidden, 0, "no keyed, model, article, database, or external-network work occurred");
  console.log("PASS Federal Register offline source chain, four opt-in gates, provenance and deterministic email path. No external calls.");
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  for (const flag of flags) {
    const value = originalFlags.get(flag);
    if (value === undefined) delete process.env[flag]; else process.env[flag] = value;
  }
}

async function federalRegisterSearchForUnsupportedTopic(
  search: ReturnType<typeof createFederalRegisterFinanceSearch>,
): Promise<Awaited<ReturnType<typeof search>>> {
  return search("nutrition-food", { freshness: "pd" });
}
