// Generic offline fixtures only. Private services, real env, providers and network are denied.
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
import { validatedStatCanLabourMetadata, type StatCanLabourMetadata } from "../lib/engine/statcan-labour-metadata";
import type { DigestItem, Issue } from "../lib/types";
import type { TopicBlurb, TopicSignal } from "../lib/engine/types";

let checks = 0, forbiddenCalls = 0;
const equal = (actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected); checks++; };
const ok = (value: unknown) => { assert.ok(value); checks++; };
const rejects = (work: () => unknown, pattern = /Invalid licensed/) => { assert.throws(work, pattern); checks++; };
const forbidden = () => { forbiddenCalls++; throw new Error("Offline verifier forbids private services, providers and network"); };
const originalFetch = globalThis.fetch;
globalThis.fetch = forbidden as typeof fetch;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const load = (source: string, dependencies: Record<string, unknown>, extras: Record<string, unknown> = {}) => {
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports, URL, console, ...extras, require(name: string) {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected verifier import: ${name}`);
    return dependencies[name];
  } }, { timeout: 1000 });
  return exports;
};

try {
  const metadata: StatCanLabourMetadata = {
    title: 'Labour Force Survey, Generic "labour" & employment bulletin ' + "original headline ".repeat(9),
    url: "https://www150.statcan.gc.ca/n1/daily-quotidien/261009/dq261009a-eng.htm",
    updatedInstant: "2026-10-09T08:30:00.123-04:00", dailyLinkDay: "2026-10-09",
    publisher: "Statistics Canada", kind: "labour-bulletin-metadata-only", dateBasis: "feed-entry-updated",
  };
  equal(validatedStatCanLabourMetadata(metadata), metadata);
  const item = attribution.statCanItemFields(metadata);
  const stored = json(item) as DigestItem;
  equal(stored, item);
  equal(attribution.validatedAttributedItem(stored), true);
  equal(stored.headline, metadata.title);
  equal(stored.primaryRef?.label, metadata.title);
  equal(stored.body, `Canadian labour bulletin metadata. Feed entry updated: ${metadata.updatedInstant}. Daily link day: ${metadata.dailyLinkDay}. Original publication time is unproven.`);
  const issueFor = (items: DigestItem[]): Issue => ({ id: "offline", volume: 1, number: 1,
    weekOf: "2026-10-09", recipientFirstName: "Generic Reader", recipientCity: "",
    editorIntro: "Generic offline preview.", sections: [{ topicId: "macro-markets", topicLabel: "Macro",
      intro: "", items }] });

  const deterministic = load(read("lib/engine/deterministic-fallback.ts"), {
    "@/lib/topics": { topicLabel: () => "Macro" }, "./voice-guard": voiceGuard,
    "./text-clean": textClean, "./url-guard": urlGuard, "@/lib/text-truncate": truncate,
    "@/lib/issue-visibility": visibility, "@/lib/source-attribution": attribution,
  });
  const signal: TopicSignal = { topicId: "macro-markets", weekOf: "2026-10-09", context: "",
    sources: [{ title: metadata.title, url: metadata.url, excerpt: "", attribution: metadata }],
    citableUrls: new Set([urlGuard.normalizeUrl(metadata.url)!]) };
  equal(json(deterministic.buildDeterministicBlurb(signal).items), [stored]);
  for (const change of [{ title: "Rewritten headline" }, { excerpt: "DISCARDED_BODY" },
    { url: "https://www150.statcan.gc.ca/n1/daily-quotidien/261009/dq261009b-eng.htm" },
    { attribution: { ...metadata, author: "DISCARDED_AUTHOR" } }]) {
    equal(deterministic.buildDeterministicBlurb({ ...signal, sources: [{ ...signal.sources![0], ...change }] }), null);
  }
  equal(deterministic.buildDeterministicBlurb({ ...signal, citableUrls: new Set([attribution.STATCAN_LICENSE_URL]) }), null);
  equal(stored.supplementaryRefs, []);
  const storyRefs = [stored.primaryRef!, ...stored.supplementaryRefs!].map(ref => ref.url);
  equal(storyRefs.includes(attribution.STATCAN_LICENSE_URL), false);

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
  equal(previewEmail.preview(issueFor([stored])), metadata.title);
  const prepared = previewEmail.prepareLetterNotification({ to: "reader@example.invalid", firstName: "Generic Reader",
    issue: issueFor([stored]), inboxUrl: "https://example.invalid/inbox" });
  ok(prepared.payload.text.includes(`Macro: ${metadata.title}`));
  ok(prepared.payload.html.includes('Generic &quot;labour&quot; &amp; employment'));
  ok(prepared.payload.html.includes("original headline ".repeat(9)));
  const digest = load(read("components/Digest.tsx"), {
    "react/jsx-runtime": jsxRuntime, "@/lib/source-attribution": attribution,
    "./ScrollFadeIn": { ScrollFadeIn: ({ children }: { children: ReactNode }) => children },
    "./Wordmark": { Wordmark: () => "Alpha" },
    "@/lib/cadence": { SEND_HOUR_UTC: 14, SEND_MINUTE_UTC: 17 },
    "@/lib/topics": { topicEmoji: () => "", topicAnchor: () => "offline", TOPIC_BY_ID: {} },
  });
  const renderWeb = (items: DigestItem[]) => renderToStaticMarkup(createElement(digest.Digest, { issue: issueFor(items) }));
  const credits = email.sourceCreditsForIssue(issueFor([stored]));
  equal(json(credits), [{ url: metadata.url, attribution: metadata }]);
  equal(credits.some((credit: { url: string }) => credit.url === attribution.STATCAN_LICENSE_URL), false);
  const args = { firstName: "Generic Reader", teaser: "Generic offline preview.", sectionList: "OFFLINE_SECTION",
    inboxUrl: "https://example.invalid/inbox", weekOf: "2026-10-09", unsubscribeUrl: null, sourceCredits: credits };
  const html = email.renderHTML(args), text = email.renderText(args), web = renderWeb([stored]);
  for (const output of [html, text, web, prepared.payload.html, prepared.payload.text]) {
    ok(output.includes(metadata.url));
    ok(output.includes(`Feed entry updated: ${metadata.updatedInstant}`));
    ok(output.includes(`Daily link day: ${metadata.dailyLinkDay}`));
    ok(output.includes("Original publication time is unproven."));
    ok(output.includes(`Adapted from Statistics Canada, The Daily, ${metadata.dailyLinkDay}.`));
    ok(output.includes(attribution.STATCAN_NONENDORSEMENT));
    ok(output.includes(attribution.STATCAN_RIGHTS_NOTE));
    ok(output.includes(attribution.STATCAN_LICENSE_URL));
    assert.doesNotMatch(output, /DISCARDED_|By undefined|CC BY|Published or updated|Headline formatted from source metadata|Publication date/); checks++;
  }
  ok(html.includes('Generic &quot;labour&quot; &amp; employment'));
  ok(web.includes('Generic &quot;labour&quot; &amp; employment'));
  ok(text.includes(metadata.title));
  equal(email.sourceCreditsForIssue(issueFor([stored, stored])).length, 1);
  for (const changed of [{ title: "Labour Force Survey alternate title" }, { updatedInstant: "2026-10-09T09:30:00.123-04:00" }]) {
    const other = attribution.statCanItemFields({ ...metadata, ...changed });
    rejects(() => email.sourceCreditsForIssue(issueFor([stored, other])), /Conflicting government/);
    const conflictingArgs = { ...args, sourceCredits: [...credits, { url: metadata.url, attribution: other.attribution }] };
    rejects(() => email.renderHTML(conflictingArgs), /Conflicting government/);
    rejects(() => email.renderText(conflictingArgs), /Conflicting government/);
  }

  const mutations: DigestItem[] = [
    { ...stored, attribution: undefined }, { ...stored, headline: "Rewritten headline" }, { ...stored, body: "Invented summary" },
    { ...stored, body: stored.body.replace("Feed entry updated", "Published") }, { ...stored, kind: "note" },
    { ...stored, primaryRef: { label: "Renamed reference", url: metadata.url } },
    { ...stored, primaryRef: { label: metadata.title, url: "https://www150.statcan.gc.ca/n1/daily-quotidien/261009/dq261009b-eng.htm" } },
    { ...stored, primaryRef: { ...stored.primaryRef!, note: "Unapproved excerpt" } },
    { ...stored, supplementaryRefs: [{ label: "License", url: attribution.STATCAN_LICENSE_URL }] },
    { ...stored, source: "Legacy credit" }, { ...stored, sourceUrl: metadata.url },
    { ...stored, attribution: { ...metadata, title: "Labour Force Survey changed" } },
    { ...stored, attribution: { ...metadata, updatedInstant: "2026-10-09T09:30:00Z" } },
    { ...stored, attribution: { ...metadata, dailyLinkDay: "2026-10-08" } },
    { ...stored, attribution: { ...metadata, dateBasis: "publication-date" } as any },
    { ...stored, attribution: { ...metadata, publisher: "govuk" } as any },
    { ...stored, attribution: { ...metadata, kind: "article" } as any },
    { ...stored, attribution: { ...metadata, updatedInstant: "2026-10-09" } },
    { ...stored, attribution: { ...metadata, url: "javascript:alert(1)" } },
    { ...stored, attribution: { ...metadata, author: "Invented author" } as any },
    { ...stored, attribution: { ...metadata, publishedAt: metadata.updatedInstant } as any },
  ];
  for (const key of Object.keys(metadata)) {
    const missing = { ...metadata } as Record<string, unknown>;
    delete missing[key];
    mutations.push({ ...stored, attribution: missing as any });
  }
  const cronSource = read("app/api/cron/weekly-send/route.ts");
  const cronGuard = load(cronSource.slice(cronSource.indexOf("const PERSISTED_ITEM_KINDS"),
    cronSource.indexOf("// Shape guard for a persisted")) + "\nexports.valid = isValidPersistedItem", {}, {
      validatedAttributedItem: attribution.validatedAttributedItem,
  });
  equal(cronGuard.valid(stored), true);
  for (const invalid of mutations) {
    equal(attribution.validatedAttributedItem(invalid), false);
    rejects(() => email.sourceCreditsForIssue(issueFor([invalid])));
    equal(cronGuard.valid(invalid), false);
    equal(renderWeb([invalid]).includes(metadata.url), false);
  }
  const inherited = Object.create(metadata);
  const accessor = { ...metadata };
  Object.defineProperty(accessor, "title", { get: () => { throw new Error("Getter must never run"); } });
  const publisherAccessor = { ...metadata };
  Object.defineProperty(publisherAccessor, "publisher", { get: () => { throw new Error("Getter must never run"); } });
  const symbolExtra = { ...metadata, [Symbol("unexpected")]: "extra" };
  const hiddenExtra = { ...metadata };
  Object.defineProperty(hiddenExtra, "author", { value: "hidden extra" });
  const brokenProxy = new Proxy(metadata, { ownKeys: () => { throw new Error("Rejected proxy"); } });
  const revoked = Proxy.revocable(metadata, {}); revoked.revoke();
  for (const badCredit of [null, inherited, accessor, publisherAccessor, symbolExtra, hiddenExtra, brokenProxy, revoked.proxy,
    { ...metadata, title: '<script>alert("x")</script>' }, { ...metadata, title: "Labour\nInjected header" }]) {
    equal(attribution.validatedSourceAttribution(metadata.url, badCredit), undefined);
    rejects(() => email.renderHTML({ ...args, sourceCredits: [{ url: metadata.url, attribution: badCredit }] }));
    rejects(() => email.renderText({ ...args, sourceCredits: [{ url: metadata.url, attribution: badCredit }] }));
  }

  let writes = 0, written: unknown;
  const cache = load(read("lib/engine/blurb-cache.ts"), {
    "@/lib/source-attribution": attribution, "./url-guard": urlGuard,
    "./issue-citation-history": { readIssueCitationHistory: forbidden },
    "@/lib/supabase/server": { supabaseServiceClient: async () => ({ from: () => ({
      select: () => ({ eq: () => ({ in: async () => ({ data: [{ topic_id: "macro-markets", week_of: "2026-10-09",
        intro: "", items: [stored, ...mutations] }], error: null }) }) }),
      upsert: async (value: unknown) => { writes++; written = value; return { error: null }; },
    }) }) },
  }, { process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid", SUPABASE_SECRET_KEY: "offline-stub" } } });
  const cached = await cache.getCachedBlurbs(["macro-markets"], "2026-10-09");
  equal(json(cached.get("macro-markets").items), [stored]);
  const blurb: TopicBlurb = { topicId: "macro-markets", topicLabel: "Macro", weekOf: "2026-10-09", intro: "", items: [stored] };
  await cache.setCachedBlurb(blurb);
  equal(writes, 1); equal(json(written).items, [stored]);
  await cache.setCachedBlurb({ ...blurb, items: [mutations[0]!] }); equal(writes, 1);
  equal(forbiddenCalls, 0);
  console.log(`PASS ${checks} StatCan exact metadata, deterministic fields, saved/final guards, web/email/preview credit and mutation checks. Zero network, model, provider or real environment calls.`);
} finally { globalThis.fetch = originalFetch; }
