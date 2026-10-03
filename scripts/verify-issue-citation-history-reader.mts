// Offline fixtures for the actual reader. Only its local source and URL guard
// are loaded. The VM has an empty environment and an inert database edge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { normalizeUrl } from "../lib/engine/url-guard.ts";

assert.equal(process.argv.length, 2, "unsupported verifier argument");
const source = readFileSync(new URL("../lib/engine/issue-citation-history.ts", import.meta.url), "utf8");
assert.ok(source.length < 64 * 1024, "unexpected reader source size");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type History = {
  state: "disabled" | "available" | "unavailable";
  urlsByTopic: Map<string, Set<string>>;
  unavailableTopicIds: Set<string>;
};
type Reader = (sb: unknown, ids: unknown, since: unknown, before: unknown) => Promise<History>;
type Dependencies = { enabled?: () => boolean; warn?: (message: string) => void; timeoutMs?: number };
type ReaderModule = {
  createIssueCitationHistoryReader: (deps?: Dependencies) => Reader;
  readIssueCitationHistory: Reader;
};
const since = "2026-10-02";
const before = "2026-10-03";
const goodUrl = "https://example.test/saved?utm_source=generic";
const otherUrl = "https://example.test/other";
const privateMarker = "generic-private-reader-marker";
const row = (topic = "music", urls: unknown = [], complete: unknown = true) => ({ topic_id: topic, urls, complete });
const success = (data: unknown) => ({ data, error: null });

function harness() {
  const diagnostics: unknown[][] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const scheduled: number[] = [];
  const pending = new Set<ReturnType<typeof setTimeout>>();
  let networkCalls = 0;
  const env: Record<string, string | undefined> = {};
  const module = { exports: {} as ReaderModule };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(name: string) {
      assert.equal(name, "./url-guard", "reader loaded an unexpected runtime dependency");
      return { normalizeUrl };
    },
    process: { env },
    console: { warn: (...args: unknown[]) => diagnostics.push(args) },
    fetch() { networkCalls++; throw new Error("offline network denied"); },
    setTimeout(callback: () => void, delay: number) {
      scheduled.push(delay);
      // Capture the actual production delay, then accelerate only the fixture
      // clock so a default/max deadline never holds this verifier for seconds.
      const timer = setTimeout(() => { pending.delete(timer); callback(); }, Math.min(delay, 10));
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) {
      pending.delete(timer);
      clearTimeout(timer);
    },
  }, { timeout: 1_000, filename: "issue-citation-history-reader-fixture.cjs" });
  const reader = (deps: Dependencies = {}) => module.exports.createIssueCitationHistoryReader({
    enabled: () => true, warn: (...args: unknown[]) => diagnostics.push(args), ...deps,
  });
  const client = (respond: (args: Record<string, unknown>) => unknown) => ({
    rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, "get_alpha_issue_citation_history");
      assert.deepEqual(Object.keys(args).sort(), ["p_before", "p_since", "p_topic_ids"]);
      rpcCalls.push({ name, args });
      return respond(args);
    },
  });
  const finish = () => {
    assert.equal(networkCalls, 0);
    assert.equal(pending.size, 0, "reader left a deadline timer active");
    const allowed = new Set([
      "[issue-citation-history] invalid read input",
      "[issue-citation-history] read unavailable",
      "[issue-citation-history] response correlation unavailable",
      "[issue-citation-history] incomplete topic history",
      "[issue-citation-history] read failed",
    ]);
    for (const diagnostic of diagnostics) {
      assert.equal(diagnostic.length, 1, "diagnostic contains extra payload");
      assert.ok(typeof diagnostic[0] === "string" && allowed.has(diagnostic[0]), "diagnostic was not fixed");
      assert.ok(!JSON.stringify(diagnostic).includes(privateMarker), "diagnostic leaked private data");
    }
  };
  return { module: module.exports, reader, client, env, rpcCalls, diagnostics, scheduled, finish };
}

function held(result: History, topics: string[], state: History["state"] = "unavailable") {
  assert.equal(result.state, state);
  assert.deepEqual([...result.unavailableTopicIds].sort(), [...topics].sort());
}
function onlyHistoryFields(result: History) {
  assert.deepEqual(Object.keys(result).sort(), ["state", "unavailableTopicIds", "urlsByTopic"]);
}
let groups = 0;
async function check(work: () => Promise<void>) { await work(); groups++; }

await check(async () => {
  const h = harness();
  const result = await h.module.readIssueCitationHistory(h.client(() => { throw new Error(privateMarker); }), ["music"], since, before);
  assert.equal(result.state, "disabled");
  assert.equal(result.urlsByTopic.size, 0);
  assert.equal(result.unavailableTopicIds.size, 0);
  assert.equal(h.rpcCalls.length, 0);
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.diagnostics.length, 0);
  h.finish();
});

await check(async () => {
  const h = harness();
  for (const value of ["1", "true", "yes", " TRUE "]) {
    h.env.ALPHA_ISSUE_CITATION_HISTORY = value;
    const result = await h.module.createIssueCitationHistoryReader()(h.client(() => success([row()])), ["music"], since, before);
    assert.equal(result.state, "available");
  }
  for (const value of ["0", "false", "", "unexpected"]) {
    h.env.ALPHA_ISSUE_CITATION_HISTORY = value;
    const calls = h.rpcCalls.length;
    assert.equal((await h.module.createIssueCitationHistoryReader()(h.client(() => success([row()])), ["music"], since, before)).state, "disabled");
    assert.equal(h.rpcCalls.length, calls);
  }
  h.finish();
});

await check(async () => {
  const h = harness();
  const ids = Array.from({ length: 64 }, (_, index) => `legacy-topic-${index}`);
  const result = await h.reader()(h.client(args => success((args.p_topic_ids as string[]).map(id => row(id)))), ids, "2026-09-19", before);
  assert.equal(result.state, "available");
  assert.equal(result.urlsByTopic.size, 64);
  const opaque = "x".repeat(512);
  assert.equal((await h.reader()(h.client(() => success([row(opaque)])), [opaque], since, before)).state, "available");
  const emptyCalls = h.rpcCalls.length;
  assert.equal((await h.reader()(h.client(() => success([])), [], since, before)).state, "available");
  assert.equal(h.rpcCalls.length, emptyCalls);
  h.finish();
});

await check(async () => {
  const h = harness();
  const badIds: unknown[] = [null, {}, [null], [42], [""], [" "], [" music"], ["music "], ["x".repeat(513)], ["music\u0000"], ["music\u007f"], new Array(1), Array.from({ length: 65 }, (_, i) => `legacy-${i}`)];
  for (const ids of badIds) {
    assert.equal((await h.reader()(h.client(() => success([])), ids, since, before)).state, "unavailable");
  }
  const dates: [unknown, unknown][] = [
    [since, since], [before, since], ["2026-09-18", before], ["2026-02-30", "2026-03-01"],
    ["2026-13-01", before], ["2026-10-2", before], ["2026-10-02T00:00:00Z", before],
    [null, before], [since, undefined], [" 2026-10-02", before],
  ];
  for (const [start, end] of dates) held(await h.reader()(h.client(() => success([])), ["music"], start, end), ["music"]);
  assert.equal(h.rpcCalls.length, 0, "invalid input reached the database");
  h.finish();
});

await check(async () => {
  const h = harness();
  const result = await h.reader()(h.client(() => success([row("music"), row("legacy-mapped-topic")])), ["music", "music", "legacy-mapped-topic"], since, before);
  assert.equal(result.state, "available");
  assert.deepEqual(Array.from(h.rpcCalls[0].args.p_topic_ids as string[]), ["music", "legacy-mapped-topic"]);
  assert.equal(h.rpcCalls[0].args.p_since, since);
  assert.equal(h.rpcCalls[0].args.p_before, before);
  h.finish();
});

await check(async () => {
  const h = harness();
  const badRows = [
    [row("music", [goodUrl]), row("other-topic")],
    [row("music", [goodUrl])],
    [row("music", [goodUrl]), row("music", [otherUrl]), row("ai-news")],
    [row("music", [goodUrl]), null],
    [row("music", [goodUrl]), { topic_id: 42, urls: [], complete: true }],
    [row("music", [goodUrl]), { topic_id: " ai-news", urls: [], complete: true }],
    [row("music", [goodUrl]), ...Array.from({ length: 64 }, () => row("ai-news"))],
  ];
  for (const data of badRows) {
    const result = await h.reader()(h.client(() => success(data)), ["music", "ai-news"], since, before);
    held(result, ["music", "ai-news"]);
    assert.ok(result.urlsByTopic.get("music")?.has(goodUrl), "good references were discarded after a correlation fault");
    onlyHistoryFields(result);
  }
  h.finish();
});

await check(async () => {
  const h = harness();
  const result = await h.reader()(h.client(() => success([row("music", [goodUrl, goodUrl], false), row("ai-news")])), ["music", "ai-news"], since, before);
  held(result, ["music"], "available");
  assert.deepEqual([...result.urlsByTopic.get("music")!], [goodUrl]);
  assert.equal(result.urlsByTopic.get("ai-news")?.size, 0);
  assert.equal(normalizeUrl(goodUrl), "example.test/saved");
  assert.ok(result.urlsByTopic.get("music")?.has(goodUrl), "reader rewrote the raw reference");
  h.finish();
});

await check(async () => {
  const h = harness();
  const malformed = [
    row("music", [goodUrl, null, 42, "javascript:alert(1)", "", "not a URL"]),
    row("music", "not-an-array"), row("music", null), row("music", [goodUrl], "true"),
    { topic_id: "music", urls: [goodUrl] }, { topic_id: "music", complete: true },
  ];
  for (const badRow of malformed) {
    const result = await h.reader()(h.client(() => success([badRow, row("ai-news", [otherUrl])])), ["music", "ai-news"], since, before);
    held(result, ["music"], "available");
    assert.ok(result.urlsByTopic.get("ai-news")?.has(otherUrl));
    if (Array.isArray(badRow.urls) && badRow.urls.includes(goodUrl)) assert.ok(result.urlsByTopic.get("music")?.has(goodUrl));
  }
  h.finish();
});

await check(async () => {
  const h = harness();
  const prefix = "https://example.test/";
  const maximumUrl = prefix + "a".repeat(2_048 - prefix.length);
  const oversizedUrl = maximumUrl + "a";
  let result = await h.reader()(h.client(() => success([row("music", [maximumUrl])])), ["music"], since, before);
  assert.equal(result.state, "available");
  assert.equal(result.unavailableTopicIds.size, 0);
  assert.ok(result.urlsByTopic.get("music")?.has(maximumUrl));
  result = await h.reader()(h.client(() => success([row("music", [goodUrl, oversizedUrl])])), ["music"], since, before);
  held(result, ["music"], "available");
  assert.deepEqual([...result.urlsByTopic.get("music")!], [goodUrl]);
  const urls = Array.from({ length: 2_000 }, (_, index) => `https://example.test/bounded-${index}`);
  result = await h.reader()(h.client(() => success([row("music", urls)])), ["music"], since, before);
  assert.equal(result.unavailableTopicIds.size, 0);
  assert.equal(result.urlsByTopic.get("music")?.size, 2_000);
  result = await h.reader()(h.client(() => success([row("music", [...urls, otherUrl])])), ["music"], since, before);
  held(result, ["music"], "available");
  assert.equal(result.urlsByTopic.get("music")?.size, 2_000);
  assert.ok(!result.urlsByTopic.get("music")?.has(otherUrl), "reader exceeded the collection bound");
  h.finish();
});

await check(async () => {
  const h = harness();
  const responses: unknown[] = [
    null, undefined, [], {}, { data: [] }, success(null), success({ body: privateMarker }),
    { data: [row()], error: { message: privateMarker, details: privateMarker } },
    { data: [row()], error: false },
  ];
  for (const response of responses) held(await h.reader()(h.client(() => response), ["music"], since, before), ["music"]);
  held(await h.reader()(h.client(() => { throw new Error(privateMarker); }), ["music"], since, before), ["music"]);
  held(await h.reader()(h.client(() => Promise.reject(new Error(privateMarker))), ["music"], since, before), ["music"]);
  held(await h.reader()(h.client(() => ({ then() { throw new Error(privateMarker); } })), ["music"], since, before), ["music"]);
  held(await h.reader()({}, ["music"], since, before), ["music"]);
  held(await h.reader({ enabled: () => { throw new Error(privateMarker); } })(h.client(() => success([])), ["music"], since, before), ["music"]);
  h.finish();
});

await check(async () => {
  const h = harness();
  for (const requested of [undefined, 50_000, Infinity, NaN, 0, -1]) {
    held(await h.reader({ timeoutMs: requested })(h.client(() => new Promise(() => {})), ["music"], since, before), ["music"]);
    assert.equal(h.scheduled.at(-1), 3_000, "caller deadline exceeded or differed from its three-second cap");
  }
  let resolveLate!: (value: unknown) => void;
  const late = new Promise(resolve => { resolveLate = resolve; });
  const result = await h.reader({ timeoutMs: 2 })(h.client(() => late), ["music"], since, before);
  held(result, ["music"]);
  assert.equal(h.scheduled.at(-1), 2);
  const diagnosticsBefore = h.diagnostics.length;
  resolveLate(success([row("music", [goodUrl])]));
  await Promise.resolve();
  await Promise.resolve();
  held(result, ["music"]);
  assert.equal(result.urlsByTopic.size, 0, "late completion changed the returned failed history");
  assert.equal(h.diagnostics.length, diagnosticsBefore, "late completion emitted another diagnostic");
  let rejectLate!: (error: unknown) => void;
  const rejected = new Promise((_resolve, reject) => { rejectLate = reject; });
  held(await h.reader({ timeoutMs: 2 })(h.client(() => rejected), ["music"], since, before), ["music"]);
  rejectLate(new Error(privateMarker));
  await Promise.resolve();
  await Promise.resolve();
  h.finish();
});

await check(async () => {
  const h = harness();
  const result = await h.reader()(h.client(() => success([{
    ...row("music", [goodUrl]), id: privateMarker, reader_id: privateMarker,
    body: privateMarker, items: [{ body: privateMarker }], provider_message_id: privateMarker,
  }])), ["music"], since, before);
  assert.equal(result.state, "available");
  onlyHistoryFields(result);
  const returned = JSON.stringify({
    state: result.state,
    urls: [...result.urlsByTopic].map(([id, urls]) => [id, [...urls]]),
    unavailable: [...result.unavailableTopicIds],
  });
  assert.ok(!returned.includes(privateMarker), "reader returned body or record identifiers");
  assert.equal(h.diagnostics.length, 0);
  h.finish();
});

console.log(`issue-citation-history-reader: ${groups} offline check groups passed`);
