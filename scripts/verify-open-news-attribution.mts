// Entirely offline contract fixtures. No real letters, readers or provider calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createElement, type ReactNode } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import type { Issue } from "../lib/types";
import * as attribution from "../lib/source-attribution";
import { renderHTML, renderText, sourceCreditsForIssue } from "../lib/email";

const flags = ["ALPHA_NO_MODEL_MODE", "ALPHA_NO_KEY_SOURCES", "ALPHA_OPEN_NEWS_FALLBACK", "ALPHA_PUBLIC_FEED_FALLBACK", "ALPHA_PUBLISHER_FEED_FALLBACK", "ALPHA_GDELT_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET"];
const saved = new Map(flags.map((name) => [name, process.env[name]]));
const previousFetch = globalThis.fetch;
const previousWarn = console.warn;
const counts = { google: 0, publisher: 0, forbidden: 0 };
const timestamp = new Date(Date.now() - 60000);
const date = timestamp.toISOString().slice(0, 10);
const prefix = date.replaceAll("-", "/");
const article = (n: number) => `https://globalvoices.org/${prefix}/offline-music-${n}/`;
const feed = `<rss><channel>${Array.from({ length: 12 }, (_, n) => `<item><title>Music culture report ${n}</title><link>${article(n)}</link><dc:creator><![CDATA[Offline Writer]]></dc:creator><pubDate>${timestamp.toUTCString()}</pubDate><category>Music</category><description>BODY_MUST_NOT_BE_COPIED</description><content:encoded>BODY_MUST_NOT_BE_COPIED</content:encoded></item>`).join("")}</channel></rss>`;
try {
  for (const name of flags) delete process.env[name];
  process.env.ALPHA_NO_MODEL_MODE = "1";
  process.env.ALPHA_NO_KEY_SOURCES = "1";
  process.env.ALPHA_PUBLIC_FEED_FALLBACK = "1";
  process.env.ALPHA_OPEN_NEWS_FALLBACK = "1";
  console.warn = () => {};
  globalThis.fetch = (async (input, options) => {
    const url = new URL(String(input));
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.redirect, "error");
    if (url.hostname === "news.google.com") { counts.google++; return new Response(null, { status: 503 }); }
    if (url.href === "https://globalvoices.org/-/topics/music/feed/") { counts.publisher++; return new Response(feed); }
    counts.forbidden++;
    throw new Error("All other outbound calls are forbidden");
  }) as typeof fetch;
  const { resolveTopicSignal } = await import("../lib/engine/source-resolver");
  const { generateTopicBlurb } = await import("../lib/engine/topic-blurb");
  const { buildDeterministicBlurb } = await import("../lib/engine/deterministic-fallback");
  const { normalizeUrl } = await import("../lib/engine/url-guard");
  const excluded = new Set(Array.from({ length: 10 }, (_, n) => normalizeUrl(article(n))!));
  const signal = await resolveTopicSignal("music", date, { freshness: "pd", excludeUrls: excluded });
  assert.ok(signal);
  assert.equal(signal.sources?.length, 2);
  assert.equal(signal.sources?.[0].url, article(10));
  assert.equal(signal.sources?.[0].attribution?.author, "Offline Writer");
  assert.equal(signal.citableUrls?.size, 2);
  assert.equal(signal.citableUrls?.has(normalizeUrl(attribution.GLOBAL_VOICES_LICENSE_URL)!), false);
  assert.doesNotMatch(signal.context, /BODY_MUST_NOT_BE_COPIED/);

  // Config drift cannot put licensed metadata through a model writer.
  process.env.ALPHA_NO_MODEL_MODE = "0";
  const blurb = await generateTopicBlurb("music", date, signal);
  assert.equal(blurb.items[0].attribution?.publisher, "global-voices");
  assert.equal(blurb.items[0].attribution?.author, "Offline Writer");
  assert.deepEqual(blurb.items[0].supplementaryRefs, []);
  assert.equal(counts.forbidden, 0);

  const issue: Issue = { id: "offline", volume: 1, number: 1, weekOf: date, recipientFirstName: "Reader", recipientCity: "", editorIntro: "Offline preview.", sections: [{ topicId: "music", topicLabel: "Music", intro: "", items: blurb.items }] };
  const sourceCredits = sourceCreditsForIssue(issue);
  assert.equal(sourceCredits.length, 2);
  const args = { firstName: "Reader", teaser: "Offline preview.", sectionList: "INCLUDED_HEADLINE", inboxUrl: "https://example.org/inbox", weekOf: date, unsubscribeUrl: null, sourceCredits };
  const html = renderHTML(args);
  const text = renderText(args);
  for (const output of [html, text]) {
    assert.ok(output.includes("Offline Writer"));
    assert.ok(output.includes(article(10)));
    assert.ok(output.includes(attribution.GLOBAL_VOICES_LICENSE_URL));
    assert.ok(output.indexOf("Offline Writer") < output.indexOf("INCLUDED_HEADLINE"));
    assert.doesNotMatch(output, /BODY_MUST_NOT_BE_COPIED/);
  }

  const digestModule: { Digest?: (props: { issue: Issue }) => ReactNode } = {};
  const digestSource = readFileSync(new URL("../components/Digest.tsx", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(digestSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: digestModule, URL,
    require(name: string) {
      if (name === "react/jsx-runtime") return jsxRuntime;
      if (name === "@/lib/source-attribution") return attribution;
      if (name === "./ScrollFadeIn") return { ScrollFadeIn: ({ children }: { children: ReactNode }) => children };
      if (name === "./Wordmark") return { Wordmark: () => "Alpha" };
      if (name === "@/lib/cadence") return { SEND_HOUR_UTC: 14, SEND_MINUTE_UTC: 17 };
      if (name === "@/lib/topics") return { topicEmoji: () => "", topicAnchor: () => "offline", TOPIC_BY_ID: {} };
      throw new Error(`Unexpected render import: ${name}`);
    },
  }, { timeout: 1000 });
  const digest = renderToStaticMarkup(createElement(digestModule.Digest!, { issue }));
  assert.ok(digest.indexOf("By Offline Writer") < digest.indexOf("Music culture report 10"));
  assert.ok(digest.includes(`href="${attribution.GLOBAL_VOICES_LICENSE_URL}"`));
  assert.ok(digest.includes(`href="${article(10)}"`));
  assert.ok(digest.includes(attribution.GLOBAL_VOICES_CHANGES_NOTE));
  const stored = JSON.parse(JSON.stringify(issue));
  assert.deepEqual(sourceCreditsForIssue(stored), sourceCredits);
  assert.equal(attribution.validatedGlobalVoicesAttribution("https://globalvoices.org.evil.test/2026/09/30/story/", "Writer", timestamp.toISOString()), undefined);
  assert.equal(attribution.validatedGlobalVoicesAttribution(article(10), "", timestamp.toISOString()), undefined);
  assert.equal(attribution.validatedGlobalVoicesAttribution(article(10), "Writer", "2026"), undefined);
  assert.equal(attribution.validatedSourceAttribution(article(10), { ...sourceCredits[0].attribution, publisher: "unknown", licenseUrl: "https://evil.test" }), undefined);
  assert.equal(buildDeterministicBlurb({ ...signal, sources: [{ ...signal.sources![0], attribution: { publisher: "unknown" } as any }] }), null);
  for (const invalid of [null, false, ""]) {
    assert.equal(buildDeterministicBlurb({ ...signal, sources: [{ ...signal.sources![0], attribution: invalid as any }] }), null);
    assert.throws(() => sourceCreditsForIssue({ sections: [{ ...issue.sections[0], items: [{ ...issue.sections[0].items[0], attribution: invalid as any }] }] }), /Invalid licensed/);
  }
  assert.equal(attribution.validatedGlobalVoicesAttribution(article(10), "Writer", "2026-02-30T12:00:00Z"), undefined);
  assert.equal(attribution.validatedGlobalVoicesAttribution("https://globalvoices.org/2026/02/30/story/", "Writer", timestamp.toISOString()), undefined);
  assert.throws(() => sourceCreditsForIssue({ sections: [{ ...issue.sections[0], items: [{ ...issue.sections[0].items[0], attribution: { publisher: "unknown" } as any }] }] }), /Invalid licensed/);
  const guardSource = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
  const itemGuard = guardSource.slice(guardSource.indexOf("const PERSISTED_ITEM_KINDS"), guardSource.indexOf("// Shape guard for a persisted"));
  const guardModule = { valid: (_: unknown) => false };
  vm.runInNewContext(ts.transpileModule(`${itemGuard}\nexports.valid = isValidPersistedItem`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: guardModule, validatedSourceAttribution: attribution.validatedSourceAttribution, validatedAttributedItem: attribution.validatedAttributedItem });
  assert.equal(guardModule.valid(issue.sections[0].items[0]), true);
  assert.equal(guardModule.valid({ ...issue.sections[0].items[0], attribution: { publisher: "unknown" } }), false);
  assert.equal(guardModule.valid({ ...issue.sections[0].items[0], primaryRef: { label: "Spoof", url: "https://evil.test/story" } }), false);
  const assemblySource = readFileSync(new URL("../lib/engine/assemble.ts", import.meta.url), "utf8");
  assert.match(assemblySource, /attribution:\s*it\.attribution/);
  assert.equal(counts.publisher, 1);
  assert.equal(counts.forbidden, 0);
  console.log("PASS licensed feed failover, reader exclusions, attribution preservation, actual web/email render, persisted guard and zero model/provider calls (offline)");
} finally {
  globalThis.fetch = previousFetch;
  console.warn = previousWarn;
  for (const name of flags) { const value = saved.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}
