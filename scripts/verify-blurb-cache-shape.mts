// Generic saved-JSON fixtures only. The real cache module runs in a VM with
// an inert Supabase query builder and fixed non-secret configuration markers.
// No server client, environment-file loader, source, reader or send is imported.
// --baseline / --privacy-baseline read pinned unedited files with git show and are expected
// to fail the same regression assertions that pass against the working file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { validatedSourceAttribution } from "../lib/source-attribution.ts";
import { normalizeUrl } from "../lib/engine/url-guard.ts";

const privacyBaseline = process.argv.includes("--privacy-baseline");
const baseline = process.argv.includes("--baseline") || privacyBaseline;
assert.ok(process.argv.length <= 3 && process.argv.slice(2).every((arg) => arg === "--baseline" || arg === "--privacy-baseline"), "unsupported verifier argument");
const root = fileURLToPath(new URL("../", import.meta.url));
const source = baseline
  ? execFileSync("git", ["-c", "core.fsmonitor=false", "show", `${privacyBaseline ? "dcee47dc1c3757e06d892057daf3765558965c9e" : "e58db8d72950a8669c4e731cc139007d567d5506"}:lib/engine/blurb-cache.ts`], {
      cwd: root, encoding: "utf8", maxBuffer: 256 * 1024,
    })
  : readFileSync(new URL("../lib/engine/blurb-cache.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type CacheModule = {
  getCachedBlurbs(ids: string[], period: string): Promise<Map<string, { intro: string; items: unknown[] }>>;
  getRecentlyCitedUrls(ids: string[], since: string, before: string): Promise<Map<string, Set<string>>>;
  setCachedBlurb(value: unknown): Promise<void>;
};
function harness(options: { data?: unknown; error?: { message: string }; reject?: boolean; loadFails?: boolean; enabled?: boolean; failureText?: string } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const warnings: unknown[][] = [];
  let loads = 0;
  const response = () => {
    if (options.reject) throw new Error(options.failureText ?? "generic fixture request failure");
    return { data: options.data ?? [], error: options.error ?? null };
  };
  const query = {
    select(...args: unknown[]) { calls.push({ method: "select", args }); return this; },
    eq(...args: unknown[]) { calls.push({ method: "eq", args }); return this; },
    in(...args: unknown[]) { calls.push({ method: "in", args }); return this; },
    gte(...args: unknown[]) { calls.push({ method: "gte", args }); return this; },
    lt(...args: unknown[]) { calls.push({ method: "lt", args }); return this; },
    then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
      return Promise.resolve().then(response).then(resolve, reject);
    },
    upsert(...args: unknown[]) { calls.push({ method: "upsert", args }); return Promise.resolve().then(response); },
  };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports,
    process: { env: options.enabled === false ? {} : {
      NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test",
      SUPABASE_SECRET_KEY: "inert-fixture-marker",
    } },
    console: { warn: (...args: unknown[]) => warnings.push(args) },
    fetch: () => { throw new Error("network denied"); },
    require(name: string) {
      if (name === "@/lib/source-attribution") return { validatedSourceAttribution };
      if (name === "./url-guard") return { normalizeUrl };
      if (name === "@/lib/supabase/server") return { supabaseServiceClient: async () => {
        loads++;
        if (options.loadFails) throw new Error(options.failureText ?? "generic fixture client failure");
        return { from(table: string) { assert.equal(table, "topic_blurbs"); return query; } };
      } };
      throw new Error(`unexpected VM import: ${name}`);
    },
  };
  vm.runInNewContext(compiled, sandbox, { timeout: 1000, filename: "blurb-cache-fixture.cjs" });
  return { cache: module.exports as CacheModule, calls, warnings, loads: () => loads };
}

const period = "2026-10-02";
const priorPeriod = "2026-10-01";
const since = "2026-09-18";
const topics = ["ai-news", "music", "macro-markets"];
const ref = (path: string) => ({ label: "Generic source", url: `https://example.test/${path}`, note: "Generic note" });
const item = (path: string) => ({ kind: "read", headline: "Generic saved headline", body: "Generic saved body.", primaryRef: ref(path), supplementaryRefs: [] });
const row = (topic: string, items: unknown, week = period, intro: unknown = "Generic saved intro.") => ({ topic_id: topic, week_of: week, intro, items });
const plos = {
  ...item("unused"),
  primaryRef: { label: "PLOS", url: "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.1234567" },
  attribution: { publisher: "plos", author: "Generic Author", publishedAt: "2026-10-01T12:00:00.000Z" },
};
const globalVoices = {
  ...item("unused"),
  primaryRef: { label: "Global Voices", url: "https://globalvoices.org/2026/10/01/generic-fixture/" },
  attribution: { publisher: "global-voices", author: "Generic Author", publishedAt: "2026-10-01T12:00:00.000Z" },
};

let passed = 0;
let failed = 0;
async function check(label: string, work: () => Promise<void>) {
  try { await work(); passed++; }
  catch { failed++; console.error(`FAIL ${label}`); }
}

await check("recent citations survive a malformed middle row", async () => {
  for (const bad of [null, {}, "bad", [null], ["bad"], [{ supplementaryRefs: {} }], [{ supplementaryRefs: [null] }]]) {
    const { cache } = harness({ data: [row(topics[0], [item("earlier")], priorPeriod), row(topics[1], bad, priorPeriod), row(topics[2], [item("later")], priorPeriod)] });
    const result = await cache.getRecentlyCitedUrls(topics, since, period);
    assert.ok(result.get(topics[0])?.has(ref("earlier").url));
    assert.ok(result.get(topics[2])?.has(ref("later").url));
  }
});
await check("malformed rows cannot abort later recent citations", async () => {
  const { cache } = harness({ data: [null, false, [], row(topics[0], [item("later")], priorPeriod)] });
  assert.ok((await cache.getRecentlyCitedUrls(topics, since, period)).get(topics[0])?.has(ref("later").url));
});
await check("recent citations retain good refs within mixed malformed work", async () => {
  const { cache } = harness({ data: [row(topics[0], [
    null, { primaryRef: { url: 42 }, supplementaryRefs: [null, { url: false }, ref("valid-supplement")] },
    { primaryRef: ref("valid-primary"), supplementaryRefs: {} }, item("valid-later-item"),
  ], priorPeriod)] });
  const urls = (await cache.getRecentlyCitedUrls(topics, since, period)).get(topics[0]);
  assert.deepEqual([...urls ?? []].sort(), [ref("valid-supplement").url, ref("valid-primary").url, ref("valid-later-item").url].sort());
});
await check("recent citations enforce requested topics and date bounds", async () => {
  const { cache, calls } = harness({ data: [
    row("outside-pool", [item("outside")], priorPeriod), row(topics[0], [item("old")], "2026-09-17"),
    row(topics[0], [item("same-day")], period), row(topics[0], [item("bad-date")], "2026-09-31"),
    row(topics[0], [item("oldest-valid")], since), row(topics[0], [item("valid")], priorPeriod),
  ] });
  const result = await cache.getRecentlyCitedUrls(topics, since, period);
  assert.equal(result.size, 1);
  assert.deepEqual([...result.get(topics[0]) ?? []].sort(), [ref("valid").url, ref("oldest-valid").url].sort());
  assert.ok(calls.some((call) => call.method === "gte" && call.args[1] === since));
  assert.ok(calls.some((call) => call.method === "lt" && call.args[1] === period));
  assert.ok(calls.some((call) => call.method === "in" && call.args[0] === "topic_id"));
});
await check("same-date cache preserves valid items and skips malformed items", async () => {
  const invalid = [null, false, [], {}, { ...item("bad-kind"), kind: "unknown" },
    { ...item("bad-headline"), headline: 42 }, { ...item("bad-body"), body: null },
    { ...item("bad-primary"), primaryRef: null }, { ...item("bad-label"), primaryRef: { label: 42, url: "https://example.test/bad" } },
    { ...item("bad-url"), primaryRef: { label: "Source", url: 42 } },
    { ...item("bad-note"), primaryRef: { label: "Source", url: "https://example.test/bad", note: false } },
    { ...item("blank-headline"), headline: " \n " }, { ...item("blank-body"), body: " \n " },
    { ...item("blank-label"), primaryRef: { label: " ", url: "https://example.test/bad" } },
    { ...item("unsafe-url"), primaryRef: { label: "Source", url: "javascript:genericFixture()" } },
    { ...item("invalid-url"), primaryRef: { label: "Source", url: "invalid-url" } },
    { ...item("bad-array"), supplementaryRefs: {} }, { ...item("bad-ref"), supplementaryRefs: [null] },
    { ...item("bad-supplement"), supplementaryRefs: [{ label: "Source", url: false }] }];
  const { cache } = harness({ data: [row(topics[0], [item("first"), ...invalid, item("last")]), row(topics[2], [item("another-topic")])] });
  const result = await cache.getCachedBlurbs(topics, period);
  assert.equal(result.get(topics[0])?.items.length, 2);
  assert.equal(result.get(topics[2])?.items.length, 1);
});
await check("all recognized item kinds and optional reference shapes remain usable", async () => {
  const items: unknown[] = ["read", "watch", "listen", "try", "post", "book", "event", "note"].map((kind) => ({ kind, headline: "Generic title", body: "Generic body" }));
  items.push({ ...item("with-refs"), supplementaryRefs: [ref("supplement")] });
  const { cache } = harness({ data: [row(topics[0], items)] });
  assert.equal((await cache.getCachedBlurbs(topics, period)).get(topics[0])?.items.length, items.length);
});
await check("nullable reference notes preserve valid saved items exactly", async () => {
  const saved = {
    ...item("nullable-primary-note"),
    primaryRef: { ...ref("nullable-primary-note"), note: null },
    supplementaryRefs: [{ ...ref("nullable-supplement-note"), note: null }],
  };
  const { cache } = harness({ data: [row(topics[0], [saved])] });
  const items = (await cache.getCachedBlurbs(topics, period)).get(topics[0])?.items;
  assert.deepEqual(JSON.parse(JSON.stringify(items)), [saved]);
});
await check("invalid or empty cached sections are misses", async () => {
  for (const items of [null, {}, "bad", [], [null], [{ ...item("bad"), kind: "unknown" }]]) {
    const { cache } = harness({ data: [row(topics[0], items), row(topics[2], [item("good")])] });
    const result = await cache.getCachedBlurbs(topics, period);
    assert.equal(result.has(topics[0]), false);
    assert.equal(result.get(topics[2])?.items.length, 1);
  }
});
await check("same-date cache skips malformed and out-of-query rows", async () => {
  const { cache, calls } = harness({ data: [null, [], false, row(topics[0], [item("bad-intro")], period, {}),
    row(topics[0], [item("wrong-day")], priorPeriod), row(topics[0], [item("bad-date")], "2026-09-31"),
    row("outside-pool", [item("outside")]), row(topics[2], [item("good")])] });
  const result = await cache.getCachedBlurbs(topics, period);
  assert.equal(result.size, 1);
  assert.equal(result.get(topics[2])?.items.length, 1);
  assert.ok(calls.some((call) => call.method === "eq" && call.args[1] === period));
});
await check("blank optional intros retain otherwise valid saved content", async () => {
  for (const intro of ["", " \n "]) {
    const { cache } = harness({ data: [row(topics[0], [item("valid-with-blank-intro")], period, intro)] });
    const cached = (await cache.getCachedBlurbs(topics, period)).get(topics[0]);
    assert.equal(cached?.intro, intro);
    assert.deepEqual(JSON.parse(JSON.stringify(cached?.items)), [item("valid-with-blank-intro")]);
  }
});
await check("existing licensed source credit survives valid cache reads", async () => {
  const { cache } = harness({ data: [row(topics[0], [plos, globalVoices])] });
  const items = (await cache.getCachedBlurbs(topics, period)).get(topics[0])?.items;
  assert.deepEqual(JSON.parse(JSON.stringify(items)), [plos, globalVoices]);
});
await check("invalid credit is rejected without stripping required attribution", async () => {
  const { cache } = harness({ data: [row(topics[0], [
    { ...plos, attribution: null }, { ...plos, attribution: { ...plos.attribution, publisher: "unknown" } },
    { ...plos, attribution: { ...plos.attribution, author: 42 } }, { ...plos, primaryRef: ref("wrong-host") },
    { ...globalVoices, attribution: { ...globalVoices.attribution, publishedAt: "bad-date" } },
    item("ordinary"), plos,
  ])] });
  const items = (await cache.getCachedBlurbs(topics, period)).get(topics[0])?.items;
  assert.deepEqual(JSON.parse(JSON.stringify(items)), [item("ordinary"), plos]);
});
await check("non-array responses are harmless cache misses", async () => {
  for (const data of [{}, "bad", false]) {
    const { cache } = harness({ data });
    assert.equal((await cache.getCachedBlurbs(topics, period)).size, 0);
    assert.equal((await cache.getRecentlyCitedUrls(topics, since, period)).size, 0);
  }
});
await check("optional query and client errors remain caught", async () => {
  for (const options of [{ error: { message: "generic fixture query failure" } }, { reject: true }, { loadFails: true }]) {
    const { cache, warnings } = harness(options);
    assert.equal((await cache.getCachedBlurbs(topics, period)).size, 0);
    assert.equal((await cache.getRecentlyCitedUrls(topics, since, period)).size, 0);
    await cache.setCachedBlurb({ topicId: topics[0], weekOf: period, intro: "Generic intro", items: [item("write")] });
    assert.equal(warnings.length, 3);
  }
});
await check("ordinary writes keep their payload and conflict policy", async () => {
  const { cache, calls } = harness();
  const blurb = { topicId: topics[0], weekOf: period, intro: "Generic intro", items: [plos] };
  await cache.setCachedBlurb(blurb);
  const write = calls.find((call) => call.method === "upsert");
  assert.deepEqual(JSON.parse(JSON.stringify(write?.args)), [{ topic_id: topics[0], week_of: period, intro: blurb.intro, items: blurb.items }, { onConflict: "topic_id,week_of" }]);
});
await check("cache warnings never disclose custom text or raw failure details", async () => {
  const customTopic = "custom:generic-private-topic-marker";
  const failureText = "generic-private-database-detail-marker";
  for (const options of [{ error: { message: failureText } }, { reject: true, failureText }, { loadFails: true, failureText }]) {
    const { cache, warnings } = harness(options);
    assert.equal((await cache.getCachedBlurbs([customTopic], period)).size, 0);
    assert.equal((await cache.getRecentlyCitedUrls([customTopic], since, period)).size, 0);
    await cache.setCachedBlurb({ topicId: customTopic, weekOf: period, intro: "Generic intro", items: [item("private-log-fixture")] });
    assert.equal(warnings.length, 3);
    for (const warning of warnings) {
      assert.equal(warning.length, 1, "warnings use only one fixed diagnostic");
      assert.match(String(warning[0]), /^\[blurb-cache\] (batch read|cited-urls read|write) (failed|exception)$/);
      assert.equal(JSON.stringify(warning).includes(customTopic), false);
      assert.equal(JSON.stringify(warning).includes(failureText), false);
    }
  }
});
await check("disabled cache and empty topic queries do not load a client", async () => {
  const disabled = harness({ enabled: false });
  assert.equal((await disabled.cache.getCachedBlurbs(topics, period)).size, 0);
  assert.equal((await disabled.cache.getRecentlyCitedUrls(topics, since, period)).size, 0);
  await disabled.cache.setCachedBlurb({});
  assert.equal(disabled.loads(), 0);
  const empty = harness();
  await empty.cache.getCachedBlurbs([], period);
  await empty.cache.getRecentlyCitedUrls([], since, period);
  assert.equal(empty.loads(), 0);
});

console.log(`verify-blurb-cache-shape (${baseline ? "unedited baseline" : "working file"}): ${passed} passed, ${failed} failed, offline VM`);
if (failed) process.exitCode = 1;
