// Generic offline fixtures for the actual cache and assembler. Every database,
// source and writer edge is inert. No environment file or real account is read.
// --baseline uses the unedited local checkpoint and should fail strict-history
// assertions until the assembler can distinguish unknown history from empty.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { normalizeUrl } from "../lib/engine/url-guard.ts";
import { validatedSourceAttribution } from "../lib/source-attribution.ts";
import { issueIsReaderVisible } from "../lib/issue-visibility.ts";

assert.ok(process.argv.length <= 3 && process.argv.slice(2).every(arg => arg === "--baseline"), "unsupported verifier argument");
const baseline = process.argv.includes("--baseline");
const root = fileURLToPath(new URL("../", import.meta.url));
const checkpoint = "5e8a0042417763df812fc1d3c9e94d28f3e3a49f";
function compiled(path: string): string {
  const source = baseline
    ? execFileSync("git", ["-c", "core.fsmonitor=false", "show", `${checkpoint}:${path}`], {
      cwd: root, encoding: "utf8", maxBuffer: 256 * 1024,
    })
    : readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const cacheCode = compiled("lib/engine/blurb-cache.ts");
const assemblerCode = compiled("lib/engine/assemble.ts");
const selectionCode = compiled("lib/engine/select-sections.ts");
const issueHistoryCode = ts.transpileModule(readFileSync(new URL("../lib/engine/issue-citation-history.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type SavedRow = { topic_id: string; week_of: string; intro: string; items: unknown };
type Blurb = { topicId: string; topicLabel: string; weekOf: string; intro: string; items: ReturnType<typeof item>[] };
type Signal = { topicId: string; weekOf: string; citableUrls: Set<string>; sources: { title: string; url: string; excerpt: string }[] };
type Issue = { sections: { topicId: string; items: ReturnType<typeof item>[] }[] };
type CitationHistory = { state: "available" | "disabled" | "unavailable"; urlsByTopic: Map<string, Set<string>>; unavailableTopicIds: Set<string> };
type HistoryFault = "query" | "reject" | "client" | "non-array";
const yesterday = "2026-10-02";
const today = "2026-10-03";
const privateError = "generic-private-history-error-marker";
const oldLink = "https://example.test/yesterday-story";
const savedLink = "https://example.test/already-finished-today";
const freshLink = "https://example.test/current-story";
const ref = (url: string) => ({ label: "Generic source", url });
function item(url: string) {
  return { kind: "read", headline: "Generic source headline", body: "Generic source excerpt.", primaryRef: ref(url), supplementaryRefs: [] };
}
const row = (topic: string, period: string, url: string): SavedRow => ({ topic_id: topic, week_of: period, intro: "Generic saved intro.", items: [item(url)] });

function harness(options: {
  rows?: SavedRow[];
  historyFault?: HistoryFault;
  historyData?: unknown;
  candidates?: Record<string, string>;
  issueHistoryEnabled?: boolean;
  issueHistoryResponse?: unknown;
  issueHistoryReject?: boolean;
  cacheWriteFails?: boolean;
} = {}) {
  const rows = options.rows ?? [];
  const diagnostics: unknown[][] = [];
  const sourceCalls: { topic: string; period: string; excluded: string[] }[] = [];
  const writerCalls: string[] = [];
  const queryCalls: { history: boolean; period: string | undefined }[] = [];
  let clientLoads = 0;
  let unexpectedNetwork = 0;
  let rpcCalls = 0;
  const rejectNetwork = () => { unexpectedNetwork++; throw new Error("offline network denied"); };
  const logger = { warn: (...args: unknown[]) => diagnostics.push(args), log: (...args: unknown[]) => diagnostics.push(args) };

  function load(code: string, filename: string, require: (name: string) => unknown) {
    const module = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(code, {
      module, exports: module.exports, require, console: logger, fetch: rejectNetwork,
      setTimeout, clearTimeout,
      // These are fixed inert markers, not the running process environment.
      process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test", SUPABASE_SECRET_KEY: "inert-fixture-marker",
        ALPHA_ISSUE_CITATION_HISTORY: options.issueHistoryEnabled ? "1" : "0" } },
    }, { timeout: 1000, filename });
    return module.exports;
  }

  function query() {
    let period: string | undefined;
    let since: string | undefined;
    let before: string | undefined;
    let topics: string[] = [];
    const builder = {
      select(_columns: string) { return this; },
      eq(column: string, value: string) { assert.equal(column, "week_of"); period = value; return this; },
      in(column: string, values: string[]) { assert.equal(column, "topic_id"); topics = values; return this; },
      gte(column: string, value: string) { assert.equal(column, "week_of"); since = value; return this; },
      lt(column: string, value: string) { assert.equal(column, "week_of"); before = value; return this; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve().then(() => {
          const history = before !== undefined;
          queryCalls.push({ history, period: history ? before : period });
          if (history && options.historyFault === "query") return { data: null, error: { message: privateError } };
          if (history && options.historyFault === "reject") throw new Error(privateError);
          if (history && options.historyFault === "non-array") return { data: { malformed: true }, error: null };
          if (history && Object.hasOwn(options, "historyData")) return { data: options.historyData, error: null };
          const selected = rows.filter(value => topics.includes(value.topic_id) && (history
            ? value.week_of >= since! && value.week_of < before!
            : value.week_of === period));
          return { data: selected, error: null };
        }).then(resolve, reject);
      },
      upsert(value: SavedRow, conflict: { onConflict: string }) {
        assert.equal(conflict.onConflict, "topic_id,week_of");
        if (options.cacheWriteFails) return Promise.resolve({ data: null, error: { message: privateError } });
        const index = rows.findIndex(existing => existing.topic_id === value.topic_id && existing.week_of === value.week_of);
        if (index >= 0) rows[index] = value;
        else rows.push(value);
        return Promise.resolve({ data: null, error: null });
      },
    };
    return builder;
  }

  const issueHistory = load(issueHistoryCode, "issue-citation-history-fixture.cjs", name => {
    if (name === "./url-guard") return { normalizeUrl };
    throw new Error(`unexpected issue history VM import: ${name}`);
  });
  const cache = load(cacheCode, "citation-history-cache-fixture.cjs", name => {
    if (name === "@/lib/source-attribution") return { validatedSourceAttribution };
    if (name === "./url-guard") return { normalizeUrl };
    if (name === "./issue-citation-history") return issueHistory;
    if (name === "@/lib/supabase/server") return { supabaseServiceClient: async () => {
      clientLoads++;
      // The assembler starts the same-day read first and history read second.
      // Fail only the history client's load so saved sections remain available.
      if (options.historyFault === "client" && clientLoads === 2) throw new Error(privateError);
      return { from(table: string) { assert.equal(table, "topic_blurbs"); return query(); }, rpc(name: string, args: { p_topic_ids: string[]; p_since: string; p_before: string }) {
        rpcCalls++;
        assert.equal(name, "get_alpha_issue_citation_history");
        assert.ok(args.p_since < args.p_before);
        if (options.issueHistoryReject) return Promise.reject(new Error(privateError));
        return Promise.resolve(Object.hasOwn(options, "issueHistoryResponse") ? options.issueHistoryResponse
          : { data: args.p_topic_ids.map(topic_id => ({ topic_id, urls: [], complete: true })), error: null });
      } };
    } };
    throw new Error(`unexpected cache VM import: ${name}`);
  });
  const selection = load(selectionCode, "citation-history-selection-fixture.cjs", name => { throw new Error(`unexpected selection VM import: ${name}`); });
  function fromSignal(signal: Signal): Blurb {
    return { topicId: signal.topicId, topicLabel: signal.topicId, weekOf: signal.weekOf, intro: "Generic current intro.", items: signal.sources.map(source => item(source.url)) };
  }
  const assembler = load(assemblerCode, "citation-history-assemble-fixture.cjs", name => {
    if (name === "./blurb-cache") return cache;
    if (name === "./select-sections") return selection;
    if (name === "./url-guard") return { normalizeUrl };
    if (name === "@/lib/issue-visibility") return { issueIsReaderVisible };
    if (name === "@/lib/topics") return { topicLabel: (id: string) => id, mapTopicsForUser: (ids: string[]) => ids, GENERIC_FALLBACK_TOPICS: ["macro-markets"] };
    if (name === "@/lib/with-deadline") return { withDeadline: (work: Promise<unknown>) => work };
    if (name === "./editor-note") return { generateEditorNote: async () => "Generic local editor intro." };
    if (name === "./deterministic-fallback") return { buildDeterministicBlurb: fromSignal };
    if (name === "./topic-blurb") return { generateTopicBlurb: async (_id: string, _period: string, signal: Signal) => { writerCalls.push(signal.topicId); return fromSignal(signal); } };
    if (name === "./source-resolver") return { resolveTopicSignal: async (topic: string, period: string, opts: { excludeUrls?: Set<string> }) => {
      const excluded = [...opts.excludeUrls ?? []];
      sourceCalls.push({ topic, period, excluded });
      const url = options.candidates?.[topic];
      if (!url || opts.excludeUrls?.has(normalizeUrl(url)!)) return undefined;
      return { topicId: topic, weekOf: period, context: "Generic source metadata.", citableUrls: new Set([normalizeUrl(url)!]), sources: [{ title: "Generic source headline", url, excerpt: "Generic source excerpt." }] };
    } };
    throw new Error(`unexpected assembler VM import: ${name}`);
  });
  return {
    rows, diagnostics, sourceCalls, writerCalls, queryCalls,
    unexpectedNetwork: () => unexpectedNetwork,
    rpcCalls: () => rpcCalls,
    history: async (topics = ["ai-news", "music"]): Promise<CitationHistory> => {
      if (typeof cache.getCitationHistory === "function") {
        return (cache.getCitationHistory as (...args: unknown[]) => Promise<CitationHistory>)(topics, "2026-09-19", today);
      }
      // Baseline compatibility makes the strict regression visible without
      // replacing the current assembler or inventing a fake strict result.
      const urlsByTopic = await (cache.getRecentlyCitedUrls as (...args: unknown[]) => Promise<Map<string, Set<string>>>)(topics, "2026-09-19", today);
      return { state: "available", urlsByTopic, unavailableTopicIds: new Set() };
    },
    generate: (period = today, topics = ["ai-news"], size = topics.length) => (assembler.generateIssue as (...args: unknown[]) => Promise<Issue>)(
      { firstName: "Generic", city: "", topics, theme: "forest" }, period, size, "pd"
    ),
  };
}

let passed = 0;
let failed = 0;
async function check(label: string, work: () => Promise<void>) {
  try { await work(); passed++; }
  catch { failed++; console.error(`FAIL ${label}`); }
}
async function outcome(fixture: ReturnType<typeof harness>, topics = ["ai-news"], size = topics.length) {
  try { return await fixture.generate(today, topics, size); }
  catch { return undefined; }
}
function noPrivateDiagnostics(fixture: ReturnType<typeof harness>) {
  assert.equal(JSON.stringify(fixture.diagnostics).includes(privateError), false);
  assert.equal(fixture.unexpectedNetwork(), 0);
}

await check("consecutive dates exclude the previously saved story", async () => {
  const rows: SavedRow[] = [];
  const first = harness({ rows, candidates: { "ai-news": oldLink } });
  assert.equal((await first.generate(yesterday)).sections[0].items[0].primaryRef.url, oldLink);
  assert.ok(rows.some(value => value.week_of === yesterday));
  const second = harness({ rows, candidates: { "ai-news": oldLink } });
  assert.equal(await outcome(second), undefined);
  assert.ok(second.sourceCalls.length > 0);
  assert.ok(second.sourceCalls.filter(call => call.topic === "ai-news").every(call => call.excluded.includes(normalizeUrl(oldLink)!)));
  assert.equal(second.writerCalls.length, 0);
  noPrivateDiagnostics(second);
});

for (const historyFault of ["query", "reject", "client", "non-array"] as const) {
  await check(`${historyFault} history failure cannot reopen yesterday's story`, async () => {
    const fixture = harness({ rows: [row("ai-news", yesterday, oldLink)], historyFault, candidates: { "ai-news": oldLink } });
    assert.equal(await outcome(fixture), undefined);
    assert.equal(fixture.sourceCalls.length, 0, "unknown prior history must stop before source resolution");
    assert.equal(fixture.writerCalls.length, 0);
    noPrivateDiagnostics(fixture);
  });
  await check(`${historyFault} history failure preserves partial same-day saved work`, async () => {
    const fixture = harness({ rows: [row("ai-news", yesterday, oldLink), row("music", today, savedLink)], historyFault, candidates: { "ai-news": oldLink } });
    const issue = await fixture.generate(today, ["ai-news", "music"], 2);
    assert.equal(issue.sections.length, 1);
    assert.equal(issue.sections[0].topicId, "music");
    assert.equal(issue.sections[0].items[0].primaryRef.url, savedLink);
    assert.equal(fixture.sourceCalls.length, 0);
    assert.equal(fixture.writerCalls.length, 0);
    noPrivateDiagnostics(fixture);
  });
}

await check("verified empty prior history permits fresh source resolution", async () => {
  const fixture = harness({ historyData: [], candidates: { "ai-news": freshLink } });
  const issue = await fixture.generate();
  assert.equal(issue.sections[0].items[0].primaryRef.url, freshLink);
  assert.equal(fixture.sourceCalls.filter(call => call.topic === "ai-news").length, 1);
  assert.equal(fixture.writerCalls.length, 1);
  assert.ok(fixture.queryCalls.some(call => call.history && call.period === today));
  noPrivateDiagnostics(fixture);
});

await check("strict verified-empty history reports available rather than unknown", async () => {
  const fixture = harness({ historyData: [] });
  const history = await fixture.history();
  assert.equal(history.state, "available");
  assert.equal(history.urlsByTopic.size, 0);
  assert.equal(history.unavailableTopicIds.size, 0);
  noPrivateDiagnostics(fixture);
});

await check("malformed topic history retains known citations and isolates its unknown topic", async () => {
  const fixture = harness({ historyData: [
    row("ai-news", yesterday, oldLink),
    { topic_id: "music", week_of: yesterday, items: [null, item(savedLink)] },
  ] });
  const history = await fixture.history();
  assert.equal(history.state, "available");
  assert.ok(history.urlsByTopic.get("ai-news")?.has(oldLink));
  assert.ok(history.urlsByTopic.get("music")?.has(savedLink));
  assert.equal(history.unavailableTopicIds.has("ai-news"), false);
  assert.equal(history.unavailableTopicIds.has("music"), true);
  noPrivateDiagnostics(fixture);
});

await check("malformed history cannot count as verified empty or discard today's cache", async () => {
  for (const malformed of [null, {}, false, { topic_id: "ai-news", week_of: yesterday, items: {} },
    { topic_id: "ai-news", week_of: yesterday, items: [null] },
    { topic_id: "ai-news", week_of: yesterday, items: [{}] },
    { topic_id: "ai-news", week_of: yesterday, items: [{ headline: "Partial" }] }]) {
    const fixture = harness({ rows: [row("music", today, savedLink)], historyData: [malformed], candidates: { "ai-news": oldLink } });
    const issue = await fixture.generate(today, ["ai-news", "music"], 2);
    assert.equal(issue.sections.length, 1);
    assert.equal(issue.sections[0].items[0].primaryRef.url, savedLink);
    assert.equal(fixture.sourceCalls.some(call => call.topic === "ai-news"), false);
    assert.equal(fixture.writerCalls.length, 0);
    noPrivateDiagnostics(fixture);
  }
});

await check("object-shaped incomplete items report unknown history before fresh generation", async () => {
  for (const incomplete of [{}, { headline: "Partial" }]) {
    const fixture = harness({ historyData: [{ topic_id: "ai-news", week_of: yesterday, items: [incomplete] }], candidates: { "ai-news": oldLink } });
    const history = await fixture.history();
    assert.equal(history.state, "available");
    assert.equal(history.unavailableTopicIds.has("ai-news"), true);
    assert.equal(history.unavailableTopicIds.has("music"), false);
    assert.equal(await outcome(fixture), undefined);
    assert.equal(fixture.sourceCalls.some(call => call.topic === "ai-news"), false);
    assert.equal(fixture.writerCalls.length, 0);
    noPrivateDiagnostics(fixture);
  }
});

await check("valid linkless note and read items remain readable history", async () => {
  for (const kind of ["note", "read"]) {
    const linkless = { kind, headline: "Generic saved headline", body: "Generic saved body." };
    const fixture = harness({ historyData: [{ topic_id: "ai-news", week_of: yesterday, items: [linkless] }], candidates: { "ai-news": freshLink } });
    const history = await fixture.history();
    assert.equal(history.state, "available");
    assert.equal(history.unavailableTopicIds.size, 0);
    assert.equal(history.urlsByTopic.get("ai-news")?.size ?? 0, 0);
    const issue = await fixture.generate();
    assert.equal(issue.sections[0].items[0].primaryRef.url, freshLink);
    assert.equal(fixture.sourceCalls.filter(call => call.topic === "ai-news").length, 1);
    assert.equal(fixture.writerCalls.length, 1);
    noPrivateDiagnostics(fixture);
  }
});

await check("invalid primary and supplemental URL shapes make only their topic unknown", async () => {
  const malformedItems = [
    { ...item(oldLink), primaryRef: null },
    { ...item(oldLink), primaryRef: { label: "Generic source", url: 42 } },
    { ...item(oldLink), primaryRef: ref("invalid-url") },
    { ...item(oldLink), primaryRef: ref("javascript:invalidFixture()") },
    { ...item(oldLink), supplementaryRefs: {} },
    { ...item(oldLink), supplementaryRefs: [null] },
    { ...item(oldLink), supplementaryRefs: [{ label: "Generic source", url: false }] },
    { ...item(oldLink), supplementaryRefs: [ref("invalid-url")] },
    { ...item(oldLink), supplementaryRefs: [ref("javascript:invalidFixture()")] },
  ];
  for (const malformedItem of malformedItems) {
    const fixture = harness({ rows: [row("music", today, savedLink)], historyData: [{ topic_id: "ai-news", week_of: yesterday, items: [malformedItem] }], candidates: { "ai-news": oldLink } });
    const history = await fixture.history();
    assert.equal(history.state, "available");
    assert.equal(history.unavailableTopicIds.has("ai-news"), true);
    assert.equal(history.unavailableTopicIds.has("music"), false);
    // A bad supplemental reference must not erase its valid primary citation.
    if (malformedItem.primaryRef?.url === oldLink) assert.ok(history.urlsByTopic.get("ai-news")?.has(oldLink));
    const issue = await fixture.generate(today, ["ai-news", "music"], 2);
    assert.equal(issue.sections.length, 1);
    assert.equal(issue.sections[0].topicId, "music");
    assert.equal(issue.sections[0].items[0].primaryRef.url, savedLink);
    assert.equal(fixture.sourceCalls.some(call => call.topic === "ai-news"), false);
    assert.equal(fixture.writerCalls.length, 0);
    noPrivateDiagnostics(fixture);
  }
});

await check("malformed music history leaves fresh ai-news generation available", async () => {
  const fixture = harness({ historyData: [
    { topic_id: "music", week_of: yesterday, items: [{}] },
    row("ai-news", yesterday, oldLink),
  ], candidates: { music: oldLink, "ai-news": freshLink } });
  const history = await fixture.history();
  assert.equal(history.state, "available");
  assert.equal(history.unavailableTopicIds.has("music"), true);
  assert.equal(history.unavailableTopicIds.has("ai-news"), false);
  assert.ok(history.urlsByTopic.get("ai-news")?.has(oldLink));
  const issue = await fixture.generate(today, ["music", "ai-news"], 2);
  assert.equal(issue.sections.length, 1);
  assert.equal(issue.sections[0].topicId, "ai-news");
  assert.equal(issue.sections[0].items[0].primaryRef.url, freshLink);
  assert.equal(fixture.sourceCalls.some(call => call.topic === "music"), false);
  const aiCalls = fixture.sourceCalls.filter(call => call.topic === "ai-news");
  assert.equal(aiCalls.length, 1);
  assert.ok(aiCalls[0].excluded.includes(normalizeUrl(oldLink)!));
  assert.deepEqual(fixture.writerCalls, ["ai-news"]);
  noPrivateDiagnostics(fixture);
});

await check("malformed same-day cache cannot grant a history-failure bypass", async () => {
  const fixture = harness({ rows: [row("ai-news", today, savedLink), row("music", today, savedLink)], historyFault: "query", candidates: { "ai-news": oldLink } });
  fixture.rows[0].items = [{ ...item(savedLink), primaryRef: { label: "Generic source", url: "javascript:invalidFixture()" } }];
  const issue = await fixture.generate(today, ["ai-news", "music"], 2);
  assert.equal(issue.sections.length, 1);
  assert.equal(issue.sections[0].topicId, "music");
  assert.equal(fixture.sourceCalls.length, 0);
  noPrivateDiagnostics(fixture);
});

await check("legacy source URL remains an exclusion identity", async () => {
  const fixture = harness({ historyData: [{ topic_id: "ai-news", week_of: yesterday,
    items: [{ kind: "read", headline: "Generic older headline", body: "Generic older body.", source: "Generic source", sourceUrl: oldLink }] }],
    candidates: { "ai-news": oldLink } });
  const history = await fixture.history();
  assert.equal(history.unavailableTopicIds.size, 0);
  assert.ok(history.urlsByTopic.get("ai-news")?.has(oldLink));
  assert.equal(await outcome(fixture), undefined);
  assert.equal(fixture.writerCalls.length, 0);
  noPrivateDiagnostics(fixture);
});

await check("malformed legacy source URL holds only its topic", async () => {
  const fixture = harness({ rows: [row("music", today, savedLink)], historyData: [{ topic_id: "ai-news", week_of: yesterday,
    items: [{ kind: "read", headline: "Generic older headline", body: "Generic older body.", sourceUrl: "javascript:invalidFixture()" }] }],
    candidates: { "ai-news": oldLink } });
  const issue = await fixture.generate(today, ["ai-news", "music"], 2);
  assert.equal(issue.sections.length, 1);
  assert.equal(issue.sections[0].topicId, "music");
  assert.equal(fixture.sourceCalls.some(call => call.topic === "ai-news"), false);
  noPrivateDiagnostics(fixture);
});

await check("persisted issue excludes story when the optional cache write was lost", async () => {
  const rows: SavedRow[] = [];
  const first = harness({ rows, cacheWriteFails: true, candidates: { "ai-news": oldLink } });
  const priorIssue = await first.generate(yesterday);
  assert.equal(rows.length, 0);
  assert.equal(priorIssue.sections[0].items[0].primaryRef.url, oldLink);
  const second = harness({ rows, issueHistoryEnabled: true, candidates: { "ai-news": oldLink },
    issueHistoryResponse: { data: ["ai-news", "macro-markets"].map(topic_id => ({ topic_id, complete: true,
      urls: topic_id === "ai-news" ? [oldLink] : [] })), error: null } });
  assert.equal(await outcome(second), undefined);
  assert.ok(second.sourceCalls.filter(call => call.topic === "ai-news").every(call => call.excluded.includes(normalizeUrl(oldLink)!)));
  assert.equal(second.writerCalls.length, 0);
  assert.ok(second.rpcCalls() > 0);
  noPrivateDiagnostics(first);
  noPrivateDiagnostics(second);
});

await check("persisted and cache history merge without dropping either exclusion", async () => {
  const fixture = harness({ historyData: [row("ai-news", yesterday, oldLink)], issueHistoryEnabled: true,
    issueHistoryResponse: { data: [{ topic_id: "ai-news", urls: [savedLink], complete: true }, { topic_id: "music", urls: [], complete: true }], error: null } });
  const history = await fixture.history();
  assert.equal(history.state, "available");
  assert.ok(history.urlsByTopic.get("ai-news")?.has(oldLink));
  assert.ok(history.urlsByTopic.get("ai-news")?.has(savedLink));
  noPrivateDiagnostics(fixture);
});

for (const issueHistoryReject of [false, true]) {
  await check(`persisted history ${issueHistoryReject ? "rejection" : "missing RPC"} preserves today's work and holds new sourcing`, async () => {
    const fixture = harness({ rows: [row("music", today, savedLink)], issueHistoryEnabled: true, issueHistoryReject,
      issueHistoryResponse: { data: null, error: { message: privateError } }, candidates: { "ai-news": oldLink } });
    const issue = await fixture.generate(today, ["ai-news", "music"], 2);
    assert.equal(issue.sections.length, 1);
    assert.equal(issue.sections[0].topicId, "music");
    assert.equal(fixture.sourceCalls.length, 0);
    assert.equal(fixture.writerCalls.length, 0);
    noPrivateDiagnostics(fixture);
  });
}

await check("persisted topic uncertainty remains isolated", async () => {
  const fixture = harness({ issueHistoryEnabled: true, candidates: { music: oldLink, "ai-news": freshLink },
    issueHistoryResponse: { data: [{ topic_id: "music", urls: [oldLink], complete: false },
      { topic_id: "ai-news", urls: [], complete: true }, { topic_id: "macro-markets", urls: [], complete: true }], error: null } });
  const issue = await fixture.generate(today, ["music", "ai-news"], 2);
  assert.equal(issue.sections.length, 1);
  assert.equal(issue.sections[0].topicId, "ai-news");
  assert.equal(fixture.sourceCalls.some(call => call.topic === "music"), false);
  noPrivateDiagnostics(fixture);
});

await check("off-default persisted history makes no RPC", async () => {
  const fixture = harness({ candidates: { "ai-news": freshLink } });
  assert.equal((await fixture.generate()).sections.length, 1);
  assert.equal(fixture.rpcCalls(), 0);
  noPrivateDiagnostics(fixture);
});

console.log(`verify-citation-history-resilience (${baseline ? "unedited baseline" : "working files"}): ${passed} passed, ${failed} failed, offline VM`);
if (failed) process.exitCode = 1;
