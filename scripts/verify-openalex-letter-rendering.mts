// Injected generic fixtures only. No subscriber, provider, model, history or network access.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createElement, type ReactNode } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as attribution from "../lib/source-attribution";
import * as urlGuard from "../lib/engine/url-guard";
import * as textClean from "../lib/engine/text-clean";
import * as voiceGuard from "../lib/engine/voice-guard";
import * as truncate from "../lib/text-truncate";
import * as visibility from "../lib/issue-visibility";
import { validatedOpenAlexMetadata, openAlexCitationKeys, type OpenAlexMetadata } from "../lib/engine/openalex-metadata";
import type { DigestItem, Issue } from "../lib/types";
import type { TopicBlurb, TopicSignal } from "../lib/engine/types";

let checks = 0, forbiddenCalls = 0, getterCalls = 0;
const failures: string[] = [];
const check = (name: string, work: () => void) => {
  checks++;
  try { work(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : "failed"}`); }
};
const equal = (name: string, actual: unknown, expected: unknown) => check(name, () => assert.deepEqual(actual, expected));
const ok = (name: string, value: unknown) => check(name, () => assert.ok(value));
const rejects = (name: string, work: () => unknown, pattern = /Invalid licensed/) => check(name, () => assert.throws(work, pattern));
const forbidden = () => { forbiddenCalls++; throw new Error("Offline verifier forbids private services, providers, models and network"); };
const originalFetch = globalThis.fetch;
globalThis.fetch = forbidden as typeof fetch;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type VmExports = typeof import("../lib/email") & typeof import("../components/Digest") &
  typeof import("../lib/engine/deterministic-fallback") & typeof import("../lib/engine/blurb-cache") & {
    preview: (issue: Issue) => string;
    valid: (item: unknown) => boolean;
  };
const load = (source: string, dependencies: Record<string, unknown>, extras: Record<string, unknown> = {}) => {
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports, URL, console, fetch: forbidden, ...extras, require(name: string) {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected verifier import: ${name}`);
    return dependencies[name];
  } }, { timeout: 1000 });
  return exports as VmExports;
};

try {
  const metadata: OpenAlexMetadata = {
    title: 'Artificial intelligence research, Generic "quoted" & original title ' + "metadata headline ".repeat(10),
    url: "https://doi.org/10.1234/AI(2026)123", workUrl: "https://openalex.org/W123",
    publicationDay: "2026-10-12", publisher: "openalex", kind: "research-metadata-citation-only",
    dateBasis: "reported-publication-day",
  };
  const topicId = "custom:artificial intelligence research";
  const label = "Artificial Intelligence Research";
  const body = "Research citation metadata. Reported publication day: 2026-10-12. Publication time and article access are unproven.";
  equal("valid seven-field metadata", validatedOpenAlexMetadata(metadata), metadata);
  ok("title exercises long-title rendering", metadata.title.length > 160 && metadata.title.length <= 1500);
  const item = attribution.openAlexItemFields(metadata);
  const stored = json(item) as DigestItem;
  equal("stored JSON preserves exact metadata", stored, item);
  equal("exact item guard accepts", attribution.validatedAttributedItem(stored), true);
  equal("exact full title", stored.headline, metadata.title);
  equal("exact full reference label", stored.primaryRef?.label, metadata.title);
  equal("supplied DOI parentheses preserved", stored.primaryRef?.url, metadata.url);
  equal("full known body", stored.body, body);
  equal("no supplementary story references", stored.supplementaryRefs, []);
  equal("DOI and work identities retained", openAlexCitationKeys(metadata), ["doi.org/10.1234/ai(2026)123", "openalex.org/w123"]);
  const issueFor = (items: DigestItem[]): Issue => ({ id: "offline", volume: 1, number: 1,
    weekOf: "2026-10-13", recipientFirstName: "Generic Reader", recipientCity: "",
    editorIntro: "Generic offline preview.", sections: [{ topicId, topicLabel: label,
      intro: "Recent research citations. Publication days are reported by OpenAlex.", items }] });

  const deterministic = load(read("lib/engine/deterministic-fallback.ts"), {
    "@/lib/topics": { topicLabel: () => label }, "./voice-guard": voiceGuard,
    "./text-clean": textClean, "./url-guard": urlGuard, "@/lib/text-truncate": truncate,
    "@/lib/issue-visibility": visibility, "@/lib/source-attribution": attribution,
  });
  const signal: TopicSignal = { topicId, weekOf: "2026-10-13", context: "",
    sources: [{ title: metadata.title, url: metadata.url, excerpt: "", attribution: metadata }],
    citableUrls: new Set([urlGuard.normalizeUrl(metadata.url)!]) };
  const deterministicBlurb = deterministic.buildDeterministicBlurb(signal);
  assert.ok(deterministicBlurb);
  equal("deterministic item stays exact", json(deterministicBlurb.items), [stored]);
  equal("research intro uses reported publication days", deterministicBlurb.intro,
    "Recent research citations. Publication days are reported by OpenAlex.");
  check("research intro never claims today publication", () => assert.doesNotMatch(deterministicBlurb.intro, /today|published today|new today/i));
  for (const change of [{ title: "Rewritten headline" }, { excerpt: "DISCARDED_BODY" },
    { url: "https://doi.org/10.1234/different" },
    { attribution: { ...metadata, author: "DISCARDED_AUTHOR" } }]) {
    equal("altered source cannot become deterministic citation", deterministic.buildDeterministicBlurb({ ...signal,
      sources: [{ ...signal.sources![0], ...change }] }), null);
  }
  for (const nonstory of [metadata.workUrl, attribution.OPENALEX_LICENSE_URL]) {
    equal("provenance or license cannot authorize DOI story", deterministic.buildDeterministicBlurb({ ...signal,
      citableUrls: new Set([urlGuard.normalizeUrl(nonstory)!]) }), null);
  }
  const storyRefs = [stored.primaryRef!, ...stored.supplementaryRefs!].map(ref => ref.url);
  equal("primary DOI only in story references", storyRefs, [metadata.url]);
  equal("license never becomes story ref", storyRefs.includes(attribution.OPENALEX_LICENSE_URL), false);
  equal("work provenance never becomes story ref", storyRefs.includes(metadata.workUrl), false);
  equal("license never enters citable set", signal.citableUrls!.has(urlGuard.normalizeUrl(attribution.OPENALEX_LICENSE_URL)!), false);
  equal("provenance never enters citable set", signal.citableUrls!.has(urlGuard.normalizeUrl(metadata.workUrl)!), false);

  const emailDependencies = {
    resend: { Resend: forbidden }, "node:crypto": { createHash },
    "@/lib/source-attribution": attribution, "@/lib/unsubscribe": { unsubscribeUrl: forbidden },
    "@/lib/text-truncate": truncate, "@/lib/resend-response": { requireResendMessageId: forbidden },
    "@/lib/resend-suppression-response": { removeResendSuppressionWithTransport: forbidden },
    "@/lib/suppression-recovery-policy": { MANUAL_PROVIDER_SUPPRESSION_REMOVAL_ENABLED: false },
    "@/lib/subscriber-delivery-policy": { SUBSCRIBER_LETTERS_ENABLED: false },
  };
  const email = load(read("lib/email.ts"), emailDependencies, { process: { env: new Proxy({}, { get: forbidden }) } });
  const previewEmail = load(read("lib/email.ts") + "\nexports.preview = previewFromIssue", emailDependencies,
    { process: { env: {} } });
  equal("preview full metadata title", previewEmail.preview(issueFor([stored])), metadata.title);
  const prepared = previewEmail.prepareLetterNotification({ to: "reader@example.invalid", firstName: "Generic Reader",
    issue: issueFor([stored]), inboxUrl: "https://example.invalid/inbox" });
  ok("notification text retains full title in section list", prepared.payload.text.includes(`${label}: ${metadata.title}`));
  ok("notification HTML retains escaped title", prepared.payload.html.includes('Generic &quot;quoted&quot; &amp; original title'));
  ok("notification HTML retains full long title", prepared.payload.html.includes("metadata headline ".repeat(10)));
  const digest = load(read("components/Digest.tsx"), {
    "react/jsx-runtime": jsxRuntime, "@/lib/source-attribution": attribution,
    "./ScrollFadeIn": { ScrollFadeIn: ({ children }: { children: ReactNode }) => children },
    "./Wordmark": { Wordmark: () => "Alpha" },
    "@/lib/cadence": { SEND_HOUR_UTC: 14, SEND_MINUTE_UTC: 17 },
    "@/lib/topics": { topicEmoji: () => "", topicAnchor: () => "offline", TOPIC_BY_ID: {} },
  });
  const renderWeb = (items: DigestItem[]) => renderToStaticMarkup(createElement(digest.Digest, { issue: issueFor(items) }));
  const credits = email.sourceCreditsForIssue(issueFor([stored]));
  equal("source credits retain exact source metadata", json(credits), [{ url: metadata.url, attribution: metadata }]);
  equal("license is separate from source credit URL", credits.some((credit: { url: string }) => credit.url === attribution.OPENALEX_LICENSE_URL), false);
  equal("work provenance separate from story credit URL", credits.some((credit: { url: string }) => credit.url === metadata.workUrl), false);
  const args = { firstName: "Generic Reader", teaser: "Generic offline preview.", sectionList: "OFFLINE_SECTION",
    inboxUrl: "https://example.invalid/inbox", weekOf: "2026-10-13", unsubscribeUrl: null, sourceCredits: credits };
  const html = email.renderHTML(args), text = email.renderText(args), web = renderWeb([stored]);
  for (const [surface, output] of Object.entries({ html, text, web, notificationHTML: prepared.payload.html, notificationText: prepared.payload.text })) {
    ok(`${surface} exact supplied DOI URI`, output.includes(metadata.url));
    ok(`${surface} explicit publication day`, output.includes(`Reported publication day: ${metadata.publicationDay}`));
    ok(`${surface} separate work provenance`, output.includes(metadata.workUrl));
    ok(`${surface} named OpenAlex metadata source`, output.includes("Metadata source:") && output.includes("OpenAlex"));
    ok(`${surface} time precision caveat`, output.includes("Publication time is unproven."));
    ok(`${surface} CC0 metadata label`, output.includes("CC0 metadata"));
    ok(`${surface} original title DOI credit`, output.includes("Original title and supplied DOI link from OpenAlex metadata."));
    ok(`${surface} exact rights note`, output.includes(attribution.OPENALEX_RIGHTS_NOTE));
    ok(`${surface} separate CC0 license link`, output.includes(attribution.OPENALEX_LICENSE_URL));
    check(`${surface} no introduced body or publication claim`, () => assert.doesNotMatch(output,
      /DISCARDED_|By undefined|CC BY|Published or updated|Published today|Published: 2026-10-12|Headline formatted from source metadata/i));
  }
  ok("web renders full known body", web.includes(body));
  ok("web escaped title", web.includes('Generic &quot;quoted&quot; &amp; original title'));
  ok("HTML escaped title", html.includes('Generic &quot;quoted&quot; &amp; original title'));
  ok("web keeps title suffix after 160 chars", web.includes("metadata headline ".repeat(10)));
  ok("HTML keeps title suffix after 160 chars", html.includes("metadata headline ".repeat(10)));
  ok("plain text preserves full exact title", text.includes(metadata.title));
  equal("duplicate exact credit deduplicated", email.sourceCreditsForIssue(issueFor([stored, stored])).length, 1);
  for (const changed of [{ title: "Artificial intelligence alternate metadata title" }, { publicationDay: "2026-10-11" }, { workUrl: "https://openalex.org/W124" }]) {
    const other = attribution.openAlexItemFields({ ...metadata, ...changed });
    rejects("conflicting saved credits refused", () => email.sourceCreditsForIssue(issueFor([stored, other])), /Conflicting .*source attribution/);
    const conflictingArgs = { ...args, sourceCredits: [...credits, { url: metadata.url, attribution: other.attribution }] };
    rejects("conflicting HTML credits refused", () => email.renderHTML(conflictingArgs), /Conflicting .*source attribution/);
    rejects("conflicting text credits refused", () => email.renderText(conflictingArgs), /Conflicting .*source attribution/);
  }

  const mutations: DigestItem[] = [
    { ...stored, attribution: undefined }, { ...stored, headline: "Rewritten headline" }, { ...stored, body: "Invented summary" },
    { ...stored, body: stored.body.replace("Reported publication day", "Published") }, { ...stored, kind: "note" },
    { ...stored, primaryRef: { label: "Renamed reference", url: metadata.url } },
    { ...stored, primaryRef: { label: metadata.title, url: "https://doi.org/10.1234/different" } },
    { ...stored, primaryRef: { label: metadata.title, url: metadata.workUrl } },
    { ...stored, primaryRef: { ...stored.primaryRef!, note: "Unapproved excerpt" } },
    { ...stored, supplementaryRefs: [{ label: "License", url: attribution.OPENALEX_LICENSE_URL }] },
    { ...stored, supplementaryRefs: [{ label: "Provenance", url: metadata.workUrl }] },
    { ...stored, source: "Legacy credit" }, { ...stored, sourceUrl: metadata.url },
    { ...stored, attribution: { ...metadata, title: "Artificial intelligence changed" } },
    { ...stored, attribution: { ...metadata, publicationDay: "2026-10-11" } },
    { ...stored, attribution: { ...metadata, publicationDay: "2026-02-30" } },
    { ...stored, attribution: { ...metadata, dateBasis: "publication-time" } as unknown as DigestItem["attribution"] },
    { ...stored, attribution: { ...metadata, publisher: "govuk" } as unknown as DigestItem["attribution"] },
    { ...stored, attribution: { ...metadata, kind: "article" } as unknown as DigestItem["attribution"] },
    { ...stored, attribution: { ...metadata, url: "javascript:alert(1)" } },
    { ...stored, attribution: { ...metadata, workUrl: "https://example.invalid/W123" } },
    { ...stored, attribution: { ...metadata, author: "Invented author" } as unknown as DigestItem["attribution"] },
    { ...stored, attribution: { ...metadata, body: "Invented abstract" } as unknown as DigestItem["attribution"] },
    { ...stored, attribution: { ...metadata, publishedAt: "2026-10-12T00:00:00Z" } as unknown as DigestItem["attribution"] },
  ];
  for (const key of Object.keys(metadata)) {
    const missing = { ...metadata } as Record<string, unknown>;
    delete missing[key];
    mutations.push({ ...stored, attribution: missing as unknown as DigestItem["attribution"] });
  }
  const cronSource = read("app/api/cron/weekly-send/route.ts");
  const cronGuard = load(cronSource.slice(cronSource.indexOf("const PERSISTED_ITEM_KINDS"),
    cronSource.indexOf("// Shape guard for a persisted")) + "\nexports.valid = isValidPersistedItem", {}, {
    validatedAttributedItem: attribution.validatedAttributedItem,
  });
  equal("persisted final guard accepts exact metadata", cronGuard.valid(stored), true);
  for (const [index, invalid] of mutations.entries()) {
    equal(`mutated item ${index} attribution refused`, attribution.validatedAttributedItem(invalid), false);
    rejects(`mutated item ${index} email refused`, () => email.sourceCreditsForIssue(issueFor([invalid])));
    equal(`mutated item ${index} persisted guard refused`, cronGuard.valid(invalid), false);
    equal(`mutated item ${index} web suppressed`, renderWeb([invalid]).includes(metadata.url), false);
  }
  const inherited = Object.create(metadata);
  const accessor = { ...metadata };
  Object.defineProperty(accessor, "title", { enumerable: true, get() { getterCalls++; throw new Error("Getter must never run"); } });
  const publisherAccessor = { ...metadata };
  Object.defineProperty(publisherAccessor, "publisher", { enumerable: true, get() { getterCalls++; throw new Error("Getter must never run"); } });
  const symbolExtra = { ...metadata, [Symbol("unexpected")]: "extra" };
  const hiddenExtra = { ...metadata };
  Object.defineProperty(hiddenExtra, "author", { value: "hidden extra" });
  const brokenProxy = new Proxy(metadata, { ownKeys: () => { throw new Error("Rejected proxy"); } });
  const revoked = Proxy.revocable(metadata, {}); revoked.revoke();
  for (const [index, badCredit] of [null, inherited, accessor, publisherAccessor, symbolExtra, hiddenExtra, brokenProxy, revoked.proxy,
    { ...metadata, title: '<script>alert("x")</script>' }, { ...metadata, title: "Artificial intelligence\nInjected header" }].entries()) {
    equal(`hostile credit ${index} source refused`, attribution.validatedSourceAttribution(metadata.url, badCredit), undefined);
    const badAttribution = badCredit as unknown as NonNullable<DigestItem["attribution"]>;
    rejects(`hostile credit ${index} HTML refused`, () => email.renderHTML({ ...args, sourceCredits: [{ url: metadata.url, attribution: badAttribution }] }));
    rejects(`hostile credit ${index} text refused`, () => email.renderText({ ...args, sourceCredits: [{ url: metadata.url, attribution: badAttribution }] }));
  }

  let writes = 0, written: unknown;
  const cache = load(read("lib/engine/blurb-cache.ts"), {
    "@/lib/source-attribution": attribution, "./url-guard": urlGuard,
    "./issue-citation-history": { readIssueCitationHistory: forbidden },
    "@/lib/supabase/server": { supabaseServiceClient: async () => ({ from: () => ({
      select: () => ({ eq: () => ({ in: async () => ({ data: [{ topic_id: topicId, week_of: "2026-10-13",
        intro: "Recent research citations. Publication days are reported by OpenAlex.", items: [stored, ...mutations] }], error: null }) }) }),
      upsert: async (value: unknown) => { writes++; written = value; return { error: null }; },
    }) }) },
  }, { process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid", SUPABASE_SECRET_KEY: "offline-stub" } } });
  const cached = await cache.getCachedBlurbs([topicId], "2026-10-13");
  const cachedBlurb = cached.get(topicId);
  assert.ok(cachedBlurb);
  equal("saved-cache read keeps only exact item", json(cachedBlurb.items), [stored]);
  const blurb: TopicBlurb = { topicId, topicLabel: label, weekOf: "2026-10-13",
    intro: "Recent research citations. Publication days are reported by OpenAlex.", items: [stored] };
  await cache.setCachedBlurb(blurb);
  equal("valid saved-cache write occurs only in injected stub", writes, 1);
  equal("saved-cache write preserves exact item", json(written as { items: DigestItem[] }).items, [stored]);
  for (const invalid of mutations) await cache.setCachedBlurb({ ...blurb, items: [invalid] });
  equal("all invalid saved-cache writes refused", writes, 1);
  equal("zero hostile getter calls", getterCalls, 0);
  equal("zero forbidden network model provider history env calls", forbiddenCalls, 0);
  console.log(JSON.stringify({ status: failures.length ? "offline_fail" : "offline_pass", assertions: checks,
    passed: checks - failures.length, failed: failures.length, failures, networkAttempts: forbiddenCalls, getterCalls }));
  if (failures.length) process.exitCode = 1;
} finally { globalThis.fetch = originalFetch; }
