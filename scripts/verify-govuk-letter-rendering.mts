// Offline generic fixtures. Private clients, providers, models and network are denied.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createElement, type ReactNode } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as attribution from "../lib/source-attribution";
import * as urlGuard from "../lib/engine/url-guard";
import { parseGovUkNewsMetadata } from "../lib/engine/govuk-news-metadata";
import type { DigestItem, Issue } from "../lib/types";
import type { TopicBlurb } from "../lib/engine/types";

let checks = 0, forbiddenCalls = 0;
const equal = (actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected); checks++; };
const ok = (value: unknown) => { assert.ok(value); checks++; };
const rejects = (work: () => unknown, pattern = /Invalid licensed/) => { assert.throws(work, pattern); checks++; };
const forbidden = () => { forbiddenCalls++; throw new Error("Offline verifier forbids private services, providers and network"); };
const originalFetch = globalThis.fetch;
globalThis.fetch = forbidden as typeof fetch;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
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
  const metadata = parseGovUkNewsMetadata({ results: [{
    title: '  Generic "AI" & government announcement  ', link: "/government/news/generic-ai-announcement",
    public_timestamp: "2026-10-09T10:15:00Z", format: "news_story",
    body: "DISCARDED_BODY", author: "DISCARDED_AUTHOR", image: "DISCARDED_MEDIA",
  }] })[0]!;
  ok(metadata);
  const item = attribution.govUkItemFields(metadata);
  const stored = JSON.parse(JSON.stringify(item)) as DigestItem;
  equal(stored, item);
  equal(attribution.validatedAttributedItem(stored), true);
  const issueFor = (items: DigestItem[]): Issue => ({ id: "offline", volume: 1, number: 1,
    weekOf: "2026-10-09", recipientFirstName: "Generic Reader", recipientCity: "",
    editorIntro: "Generic offline preview.", sections: [{ topicId: "ai-news", topicLabel: "AI",
      intro: "", items }] });

  // Compile actual renderers with a strict dependency allowlist. No real email
  // provider or credential-bearing dependency is imported or initialized.
  const email = load(read("lib/email.ts"), {
    resend: { Resend: forbidden }, "node:crypto": { createHash: forbidden },
    "@/lib/source-attribution": attribution, "@/lib/unsubscribe": { unsubscribeUrl: forbidden },
    "@/lib/text-truncate": { codePointSafeTruncate: forbidden },
    "@/lib/resend-response": { requireResendMessageId: forbidden },
    "@/lib/resend-suppression-response": { removeResendSuppressionWithTransport: forbidden },
    "@/lib/suppression-recovery-policy": { MANUAL_PROVIDER_SUPPRESSION_REMOVAL_ENABLED: false },
    "@/lib/subscriber-delivery-policy": { SUBSCRIBER_LETTERS_ENABLED: false },
  }, { process: { env: new Proxy({}, { get: forbidden }) } });
  const digest = load(read("components/Digest.tsx"), {
    "react/jsx-runtime": jsxRuntime, "@/lib/source-attribution": attribution,
    "./ScrollFadeIn": { ScrollFadeIn: ({ children }: { children: ReactNode }) => children },
    "./Wordmark": { Wordmark: () => "Alpha" },
    "@/lib/cadence": { SEND_HOUR_UTC: 14, SEND_MINUTE_UTC: 17 },
    "@/lib/topics": { topicEmoji: () => "", topicAnchor: () => "offline", TOPIC_BY_ID: {} },
  });
  const renderWeb = (items: DigestItem[]) => renderToStaticMarkup(createElement(digest.Digest, { issue: issueFor(items) }));
  const credits = email.sourceCreditsForIssue(issueFor([stored]));
  equal(JSON.parse(JSON.stringify(credits)), [{ url: metadata.url, attribution: metadata }]);
  const args = { firstName: "Generic Reader", teaser: "Generic offline preview.", sectionList: "OFFLINE_SECTION",
    inboxUrl: "https://example.invalid/inbox", weekOf: "2026-10-09", unsubscribeUrl: null, sourceCredits: credits };
  const html = email.renderHTML(args), text = email.renderText(args), web = renderWeb([stored]);
  for (const output of [html, text, web]) {
    ok(output.includes(metadata.url));
    ok(output.includes("GOV.UK, United Kingdom"));
    ok(output.includes(`Published or updated: ${metadata.publicTimestamp}`));
    ok(output.includes(attribution.GOVUK_LICENSE_URL));
    ok(output.includes(attribution.GOVUK_METADATA_CREDIT));
    ok(output.includes(attribution.GOVUK_RIGHTS_NOTE));
    assert.doesNotMatch(output, /DISCARDED_|By undefined|CC BY|Headline formatted from source metadata/); checks++;
  }
  ok(html.includes('  Generic &quot;AI&quot; &amp; government announcement  '));
  ok(web.includes('  Generic &quot;AI&quot; &amp; government announcement  '));
  ok(text.includes(metadata.title));
  ok(!html.includes(metadata.title));
  equal(credits.some((credit: { url: string }) => credit.url === attribution.GOVUK_LICENSE_URL), false);
  equal(email.sourceCreditsForIssue(issueFor([stored, stored])).length, 1);
  for (const changed of [{ title: "Generic AI alternate title" }, { publicTimestamp: "2026-10-09T11:15:00.000Z" }, { format: "press_release" }]) {
    const other = attribution.govUkItemFields({ ...metadata, ...changed } as typeof metadata);
    rejects(() => email.sourceCreditsForIssue(issueFor([stored, other])), /Conflicting government/);
    const conflictingArgs = { ...args, sourceCredits: [...credits, { url: metadata.url, attribution: other.attribution }] };
    rejects(() => email.renderHTML(conflictingArgs), /Conflicting government/);
    rejects(() => email.renderText(conflictingArgs), /Conflicting government/);
  }

  const mutations: DigestItem[] = [
    { ...stored, attribution: undefined },
    { ...stored, headline: "Rewritten headline" }, { ...stored, body: "Invented summary" },
    { ...stored, kind: "note" }, { ...stored, primaryRef: { label: "Renamed reference", url: metadata.url } },
    { ...stored, primaryRef: { label: metadata.title, url: "https://www.gov.uk/government/news/different-story" } },
    { ...stored, primaryRef: { ...stored.primaryRef!, note: "Unapproved excerpt" } },
    { ...stored, supplementaryRefs: [{ label: "Extra", url: metadata.url }] },
    { ...stored, source: "Legacy credit" }, { ...stored, sourceUrl: metadata.url },
    { ...stored, attribution: { ...metadata, title: "Different attribution title" } },
    { ...stored, attribution: { ...metadata, publicTimestamp: "2026-10-09T11:15:00.000Z" } },
    { ...stored, attribution: { ...metadata, publicTimestamp: "2026-10-09" } },
    { ...stored, attribution: { ...metadata, url: "javascript:alert(1)" } },
    { ...stored, attribution: { ...metadata, author: "Invented author" } as any },
  ];
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
  for (const badCredit of [null, { ...metadata, title: '<script>alert("x")</script>' },
    { ...metadata, title: "Generic\nInjected header" }, { ...metadata, url: 'https://www.gov.uk/government/news/a"onload="x' }]) {
    const badArgs = { ...args, sourceCredits: [{ url: metadata.url, attribution: badCredit }] };
    rejects(() => email.renderHTML(badArgs));
    rejects(() => email.renderText(badArgs));
  }

  // Exercise saved-cache read/write through a generic in-memory query object.
  // No environment loader, Supabase runtime or reader data enters the VM.
  let writes = 0, written: unknown;
  const cache = load(read("lib/engine/blurb-cache.ts"), {
    "@/lib/source-attribution": attribution, "./url-guard": urlGuard,
    "./issue-citation-history": { readIssueCitationHistory: forbidden },
    "@/lib/supabase/server": { supabaseServiceClient: async () => ({ from: () => ({
      select: () => ({ eq: () => ({ in: async () => ({ data: [{ topic_id: "ai-news", week_of: "2026-10-09",
        intro: "", items: [stored, ...mutations] }], error: null }) }) }),
      upsert: async (value: unknown) => { writes++; written = value; return { error: null }; },
    }) }) },
  }, { process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid", SUPABASE_SECRET_KEY: "offline-stub" } } });
  const cached = await cache.getCachedBlurbs(["ai-news"], "2026-10-09");
  equal(JSON.parse(JSON.stringify(cached.get("ai-news").items)), [stored]);
  const blurb: TopicBlurb = { topicId: "ai-news", topicLabel: "AI", weekOf: "2026-10-09", intro: "", items: [stored] };
  await cache.setCachedBlurb(blurb);
  equal(writes, 1);
  equal(JSON.parse(JSON.stringify(written)).items, [stored]);
  await cache.setCachedBlurb({ ...blurb, items: [mutations[0]!] });
  equal(writes, 1);

  for (const [url, authorCredit, publisher, license] of [
    ["https://globalvoices.org/2026/10/09/generic-story/", { publisher: "global-voices", author: "Generic Writer", publishedAt: "2026-10-09T10:15:00.000Z" }, "Global Voices", attribution.GLOBAL_VOICES_LICENSE_URL],
    ["https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0123456", { publisher: "plos", author: "Generic Writer", publishedAt: "2026-10-09T10:15:00.000Z" }, "PLOS", attribution.PLOS_LICENSE_URL],
  ] as const) {
    const authored: DigestItem = { kind: "read", headline: "Generic research or news", body: "Generic metadata item.",
      primaryRef: { label: "Original story", url }, supplementaryRefs: [], attribution: authorCredit };
    const sourceCredits = email.sourceCreditsForIssue(issueFor([authored]));
    for (const output of [email.renderHTML({ ...args, sourceCredits }), email.renderText({ ...args, sourceCredits }), renderWeb([authored])]) {
      ok(output.includes("By Generic Writer")); ok(output.includes(publisher)); ok(output.includes(license));
      ok(output.includes(attribution.GLOBAL_VOICES_CHANGES_NOTE));
      assert.doesNotMatch(output, /Published or updated|Public metadata credit only/); checks++;
    }
  }
  equal(forbiddenCalls, 0);
  console.log(`PASS ${checks} GOV.UK serialization, web/email credits, mutation guards, cache boundaries and authored-credit regressions. Zero network, model or provider calls.`);
} finally {
  globalThis.fetch = originalFetch;
}
