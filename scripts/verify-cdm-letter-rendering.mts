// Generic offline fixtures only. The VM allowlist denies real services, secrets, models and transport.
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
import * as sourceEvidence from "../lib/engine/source-evidence";
import * as sectionSelection from "../lib/engine/select-sections";
import { validatedCdmMetadata, type CdmMetadata } from "../lib/engine/cdm-metadata";
import type { DigestItem, Issue, UserProfile } from "../lib/types";
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
  typeof import("../lib/engine/deterministic-fallback") & typeof import("../lib/engine/blurb-cache") &
  typeof import("../lib/engine/assemble") & { preview: (issue: Issue) => string; valid: (item: unknown) => boolean };
const quietConsole = { log() {}, info() {}, warn() {}, error() {} };
const load = (source: string, dependencies: Record<string, unknown>, extras: Record<string, unknown> = {}) => {
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports, URL, console: quietConsole, fetch: forbidden, ...extras, require(name: string) {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected verifier import: ${name}`);
    return dependencies[name];
  } }, { timeout: 1000 });
  return exports as VmExports;
};

try {
  const metadata: CdmMetadata = {
    title: 'Music production, Generic "quoted" & original synthesizer title ' + "metadata headline ".repeat(10).trimEnd(),
    url: "https://cdm.link/2026/10/generic-synthesizer-story/", author: "Generic Writer",
    publishedAt: "2026-10-12T16:00:00.000Z", publisher: "cdm", kind: "music-production-metadata", dateBasis: "feed-pubdate",
  };
  const topicId = "custom:music production";
  const label = "Music Production";
  const intro = "Music-production headline metadata from CDM. Dates are feed publication timestamps.";
  const body = `CDM headline metadata. Feed publication timestamp: ${metadata.publishedAt}. Original article publication and music release time are unproven.`;
  equal("valid exact seven-field metadata", validatedCdmMetadata(metadata), metadata);
  equal("exact metadata field count", Object.keys(metadata).length, 7);
  equal("rights notice states site policy without asserting per-item permission", attribution.CDM_RIGHTS_NOTE,
    "CDM states its content is CC BY-SA 3.0. Item-specific and third-party rights are unverified. Article text, audio and artwork are excluded.");
  ok("title exercises long-title rendering", metadata.title.length > 160 && metadata.title.length <= 300);
  const stored = json(attribution.cdmItemFields(metadata)) as DigestItem;
  equal("stored JSON preserves exact metadata", stored, attribution.cdmItemFields(metadata));
  equal("exact item guard accepts", attribution.validatedAttributedItem(stored), true);
  equal("exact full title", stored.headline, metadata.title);
  equal("exact full reference label", stored.primaryRef?.label, metadata.title);
  equal("exact story link", stored.primaryRef?.url, metadata.url);
  equal("exact fixed body", stored.body, body);
  equal("no supplementary story references", stored.supplementaryRefs, []);
  equal("exact rendering credit", attribution.sourceAttributionCredit(metadata.url, metadata), {
    kind: "cdm", articleUrl: metadata.url, originalTitle: metadata.title, author: metadata.author,
    publishedAt: metadata.publishedAt, publisherLabel: "CDM, Create Digital Music",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/", licenseLabel: "CC BY-SA 3.0",
    changes: attribution.CDM_CHANGES_NOTE, limitations: attribution.CDM_RIGHTS_NOTE,
  });
  const issueFor = (items: DigestItem[]): Issue => ({ id: "offline", volume: 1, number: 1,
    weekOf: "2026-10-13", recipientFirstName: "Generic Reader", recipientCity: "",
    editorIntro: "Generic offline preview.", sections: [{ topicId, topicLabel: label, intro, items }] });
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
  equal("deterministic fixed CDM intro", deterministicBlurb.intro, intro);
  for (const change of [{ title: "Rewritten headline" }, { excerpt: "DISCARDED_BODY" },
    { url: "https://cdm.link/different-story/" }, { attribution: { ...metadata, body: "DISCARDED_BODY" } }]) {
    equal("altered source cannot become deterministic metadata", deterministic.buildDeterministicBlurb({ ...signal,
      sources: [{ ...signal.sources![0], ...change }] }), null);
  }
  equal("license cannot authorize the story", deterministic.buildDeterministicBlurb({ ...signal,
    citableUrls: new Set([urlGuard.normalizeUrl(attribution.CDM_LICENSE_URL)!]) }), null);
  const storyRefs = [stored.primaryRef!, ...stored.supplementaryRefs!].map(ref => ref.url);
  equal("story references contain only original article", storyRefs, [metadata.url]);
  equal("license stays outside story references", storyRefs.includes(attribution.CDM_LICENSE_URL), false);
  equal("license stays outside citable set", signal.citableUrls!.has(urlGuard.normalizeUrl(attribution.CDM_LICENSE_URL)!), false);

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
  equal("preview retains full metadata headline", previewEmail.preview(issueFor([stored])), metadata.title);
  const prepared = previewEmail.prepareLetterNotification({ to: "reader@example.invalid", firstName: "Generic Reader",
    issue: issueFor([stored]), inboxUrl: "https://example.invalid/inbox" });
  ok("notification text preserves full title in section list", prepared.payload.text.includes(`${label}: ${metadata.title}`));
  ok("notification HTML escapes title", prepared.payload.html.includes('Generic &quot;quoted&quot; &amp; original synthesizer title'));
  ok("notification HTML preserves suffix beyond 160 characters", prepared.payload.html.includes("metadata headline ".repeat(10).trimEnd()));
  const digest = load(read("components/Digest.tsx"), {
    "react/jsx-runtime": jsxRuntime, "@/lib/source-attribution": attribution,
    "./ScrollFadeIn": { ScrollFadeIn: ({ children }: { children: ReactNode }) => children },
    "./Wordmark": { Wordmark: () => "Alpha" },
    "@/lib/cadence": { SEND_HOUR_UTC: 14, SEND_MINUTE_UTC: 17 },
    "@/lib/topics": { topicEmoji: () => "", topicAnchor: () => "offline", TOPIC_BY_ID: {} },
  });
  const renderWeb = (items: DigestItem[]) => renderToStaticMarkup(createElement(digest.Digest, { issue: issueFor(items) }));
  const credits = email.sourceCreditsForIssue(issueFor([stored]));
  equal("source credits preserve exact metadata", json(credits), [{ url: metadata.url, attribution: metadata }]);
  equal("license separate from source-credit story URL", credits.some((credit: { url: string }) => credit.url === attribution.CDM_LICENSE_URL), false);
  const args = { firstName: "Generic Reader", teaser: "Generic offline preview.", sectionList: "OFFLINE_SECTION",
    inboxUrl: "https://example.invalid/inbox", weekOf: "2026-10-13", unsubscribeUrl: null, sourceCredits: credits };
  const html = email.renderHTML(args), text = email.renderText(args), web = renderWeb([stored]);
  for (const [surface, output] of Object.entries({ html, text, web, notificationHTML: prepared.payload.html, notificationText: prepared.payload.text })) {
    ok(`${surface} exact story URL`, output.includes(metadata.url));
    ok(`${surface} author credit`, output.includes(`By ${metadata.author}`));
    ok(`${surface} publisher label`, output.includes("CDM, Create Digital Music"));
    ok(`${surface} feed publication timestamp`, output.includes(`Feed publication timestamp: ${metadata.publishedAt}`));
    ok(`${surface} timestamp and release caveats`, output.includes("Original article publication and music release time are unproven."));
    ok(`${surface} exact changes note`, output.includes(attribution.CDM_CHANGES_NOTE));
    ok(`${surface} exact metadata rights note`, output.includes(attribution.CDM_RIGHTS_NOTE));
    check(`${surface} no per-item legal permission assertion`, () => assert.doesNotMatch(output,
      /This CDM metadata item is provided under/));
    ok(`${surface} correct share-alike license label`, output.includes("CC BY-SA 3.0"));
    ok(`${surface} separate license link`, output.includes(attribution.CDM_LICENSE_URL));
    check(`${surface} no discarded body or unproven release claims`, () => assert.doesNotMatch(output,
      /DISCARDED_|By undefined|Published today|Released today|Headline formatted from source metadata|Invented summary/));
  }
  ok("web renders exact fixed body", web.includes(body));
  ok("web escapes exact headline", web.includes('Generic &quot;quoted&quot; &amp; original synthesizer title'));
  ok("email HTML escapes exact headline", html.includes('Generic &quot;quoted&quot; &amp; original synthesizer title'));
  ok("web retains suffix after 160 characters", web.includes("metadata headline ".repeat(10).trimEnd()));
  ok("email HTML retains suffix after 160 characters", html.includes("metadata headline ".repeat(10).trimEnd()));
  ok("plain text retains complete exact headline", text.includes(metadata.title));
  equal("identical source credit deduplicated", email.sourceCreditsForIssue(issueFor([stored, stored])).length, 1);
  for (const changed of [{ title: "Music production alternate metadata title" }, { author: "Other Writer" },
    { publishedAt: "2026-10-12T17:00:00.000Z" }]) {
    const other = attribution.cdmItemFields({ ...metadata, ...changed });
    rejects("conflicting saved credits rejected", () => email.sourceCreditsForIssue(issueFor([stored, other])), /Conflicting .*source attribution/);
    const conflictingArgs = { ...args, sourceCredits: [...credits, { url: metadata.url, attribution: other.attribution }] };
    rejects("conflicting HTML credits rejected", () => email.renderHTML(conflictingArgs), /Conflicting .*source attribution/);
    rejects("conflicting text credits rejected", () => email.renderText(conflictingArgs), /Conflicting .*source attribution/);
  }

  const mutations: DigestItem[] = [
    { ...stored, attribution: undefined }, { ...stored, headline: "Rewritten headline" }, { ...stored, body: "Invented summary" },
    { ...stored, body: stored.body.replace("Feed publication timestamp", "Released") }, { ...stored, kind: "note" },
    { ...stored, primaryRef: { label: "Renamed reference", url: metadata.url } },
    { ...stored, primaryRef: { label: metadata.title, url: "https://cdm.link/different-story/" } },
    { ...stored, primaryRef: { ...stored.primaryRef!, note: "Unapproved excerpt" } },
    { ...stored, supplementaryRefs: [{ label: "License", url: attribution.CDM_LICENSE_URL }] },
    { ...stored, supplementaryRefs: [{ label: "Extra story", url: metadata.url }] },
    { ...stored, source: "Legacy credit" }, { ...stored, sourceUrl: metadata.url },
    { ...stored, attribution: { ...metadata, title: "Music production changed" } },
    { ...stored, attribution: { ...metadata, author: "" } },
    { ...stored, attribution: { ...metadata, publishedAt: "2026-10-12T17:00:00.000Z" } },
    { ...stored, attribution: { ...metadata, publishedAt: "2026-10-12" } },
    { ...stored, attribution: { ...metadata, publishedAt: "2026-02-30T16:00:00.000Z" } },
    { ...stored, attribution: { ...metadata, dateBasis: "release-time" } as unknown as DigestItem["attribution"] },
    { ...stored, attribution: { ...metadata, publisher: "govuk" } as unknown as DigestItem["attribution"] },
    { ...stored, attribution: { ...metadata, kind: "article" } as unknown as DigestItem["attribution"] },
    { ...stored, attribution: { ...metadata, url: "javascript:alert(1)" } },
    { ...stored, attribution: { ...metadata, body: "Invented article" } as unknown as DigestItem["attribution"] },
    { ...stored, attribution: { ...metadata, license: "CC BY 4.0" } as unknown as DigestItem["attribution"] },
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
  equal("persisted final guard accepts exact item", cronGuard.valid(stored), true);
  for (const [index, invalid] of mutations.entries()) {
    equal(`mutated item ${index} attributed item rejected`, attribution.validatedAttributedItem(invalid), false);
    rejects(`mutated item ${index} email rejected`, () => email.sourceCreditsForIssue(issueFor([invalid])));
    equal(`mutated item ${index} persisted final guard rejected`, cronGuard.valid(invalid), false);
    equal(`mutated item ${index} web suppressed`, renderWeb([invalid]).includes(metadata.url), false);
  }
  const inherited = Object.create(metadata);
  const accessor = { ...metadata };
  Object.defineProperty(accessor, "title", { enumerable: true, get() { getterCalls++; throw new Error("Getter must never run"); } });
  const publisherAccessor = { ...metadata };
  Object.defineProperty(publisherAccessor, "publisher", { enumerable: true, get() { getterCalls++; throw new Error("Getter must never run"); } });
  const symbolExtra = { ...metadata, [Symbol("unexpected")]: "extra" };
  const hiddenExtra = { ...metadata };
  Object.defineProperty(hiddenExtra, "body", { value: "hidden extra" });
  const brokenProxy = new Proxy(metadata, { ownKeys: () => { throw new Error("Rejected proxy"); } });
  const revoked = Proxy.revocable(metadata, {}); revoked.revoke();
  for (const [index, badCredit] of [null, inherited, accessor, publisherAccessor, symbolExtra, hiddenExtra, brokenProxy, revoked.proxy,
    { ...metadata, title: '<script>alert("x")</script>' }, { ...metadata, title: "Music production\nInjected header" }].entries()) {
    equal(`hostile credit ${index} pure metadata rejected`, validatedCdmMetadata(badCredit), undefined);
    equal(`hostile credit ${index} source rejected`, attribution.validatedSourceAttribution(metadata.url, badCredit), undefined);
    const badAttribution = badCredit as unknown as NonNullable<DigestItem["attribution"]>;
    rejects(`hostile credit ${index} HTML rejected`, () => email.renderHTML({ ...args, sourceCredits: [{ url: metadata.url, attribution: badAttribution }] }));
    rejects(`hostile credit ${index} text rejected`, () => email.renderText({ ...args, sourceCredits: [{ url: metadata.url, attribution: badAttribution }] }));
  }

  let writes = 0, written: unknown;
  const cache = load(read("lib/engine/blurb-cache.ts"), {
    "@/lib/source-attribution": attribution, "./url-guard": urlGuard,
    "./issue-citation-history": { readIssueCitationHistory: forbidden },
    "@/lib/supabase/server": { supabaseServiceClient: async () => ({ from: () => ({
      select: () => ({ eq: () => ({ in: async () => ({ data: [{ topic_id: topicId, week_of: "2026-10-13",
        intro, items: [stored, ...mutations] }], error: null }) }) }),
      upsert: async (value: unknown) => { writes++; written = value; return { error: null }; },
    }) }) },
  }, { process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid", SUPABASE_SECRET_KEY: "offline-stub" } } });
  const cached = await cache.getCachedBlurbs([topicId], "2026-10-13");
  const cachedBlurb = cached.get(topicId);
  assert.ok(cachedBlurb);
  equal("saved-cache read keeps only exact item", json(cachedBlurb.items), [stored]);
  const blurb: TopicBlurb = { topicId, topicLabel: label, weekOf: "2026-10-13", intro, items: [stored] };
  await cache.setCachedBlurb(blurb);
  equal("valid saved-cache write uses injected stub", writes, 1);
  equal("saved-cache write preserves exact item", json(written as { items: DigestItem[] }).items, [stored]);
  for (const invalid of mutations) await cache.setCachedBlurb({ ...blurb, items: [invalid] });
  equal("invalid saved-cache writes rejected", writes, 1);

  // Run actual final assembly against the validated injected saved-cache path.
  const assembly = load(read("lib/engine/assemble.ts"), {
    "./topic-blurb": { generateTopicBlurb: forbidden },
    "./editor-note": { generateEditorNote: async () => "Generic offline editor note." },
    "./source-resolver": { resolveTopicSignal: forbidden },
    "./blurb-cache": { getCachedBlurbs: async () => cached,
      getCitationHistory: async () => ({ state: "available", urlsByTopic: new Map(), unavailableTopicIds: new Set() }), setCachedBlurb: forbidden },
    "@/lib/issue-visibility": visibility, "./url-guard": urlGuard,
    "./select-sections": sectionSelection, "./deterministic-fallback": deterministic,
    "@/lib/topics": { topicLabel: () => label, mapTopicsForUser: (topics: string[]) => topics, GENERIC_FALLBACK_TOPICS: [] },
    "@/lib/with-deadline": { withDeadline: async (work: Promise<unknown>) => work }, "./source-evidence": sourceEvidence,
  });
  const genericProfile = { firstName: "Generic Reader", city: "", topics: [topicId] } as UserProfile;
  const assembled = await assembly.generateIssue(genericProfile, "2026-10-13", 1);
  equal("final assembly preserves exact metadata item", json(assembled.sections[0]?.items), [stored]);
  equal("final assembly preserves fixed CDM intro", assembled.sections[0]?.intro, intro);
  equal("final assembly item passes persisted guard", cronGuard.valid(assembled.sections[0]?.items[0]), true);
  equal("assembled exact source credit", json(email.sourceCreditsForIssue(assembled)), [{ url: metadata.url, attribution: metadata }]);
  equal("zero hostile getter calls", getterCalls, 0);
  equal("zero forbidden network model provider history env calls", forbiddenCalls, 0);
  console.log(JSON.stringify({ status: failures.length ? "offline_fail" : "offline_pass", assertions: checks,
    passed: checks - failures.length, failed: failures.length, failures, networkAttempts: forbiddenCalls, getterCalls }));
  if (failures.length) process.exitCode = 1;
} finally { globalThis.fetch = originalFetch; }
