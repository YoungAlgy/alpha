// Offline assembly/selection regression. Only generic local fixtures enter
// these VM calls. No environment loader, service client, provider or send is
// imported. --baseline reads the pinned unedited assembly/selector with Git.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import type { TopicBlurb, TopicSignal } from "../lib/engine/types.ts";
import type { Issue, TopicId, UserProfile } from "../lib/types.ts";
import type { SelectionResult } from "../lib/engine/select-sections.ts";

assert.ok(process.argv.length <= 3 && process.argv.slice(2).every(arg => arg === "--baseline"),
  "usage: tsx scripts/verify-assembly-diagnostics-privacy.mts [--baseline]");
const baseline = process.argv.includes("--baseline");
const baselineRef = "f37b4d35ce3556f4ceccb65c53f3f7af3437bd32";
const root = new URL("../", import.meta.url);
const period = "2026-10-03";
const quiet = "custom:generic-private-quiet-marker" as TopicId;
const duplicate = "custom:generic-private-duplicate-marker" as TopicId;
const rejected = "custom:generic-private-rejected-marker" as TopicId;
const fallback = "custom:generic-private-fallback-marker" as TopicId;
const cleanup = "custom:generic-private-cleanup-marker" as TopicId;
const timedOut = "custom:generic-private-deadline-marker" as TopicId;
const ordinary = "ai-news" as TopicId;
const backup = "music" as TopicId;
const providerDetail = "generic-private-provider-response-marker";
const editorDetail = "generic-private-editor-response-marker";
const readerName = "GenericPrivateReaderMarker";
const readerCity = "GenericPrivateCityMarker";

function source(path: string): string {
  if (baseline && ["lib/engine/assemble.ts", "lib/engine/select-sections.ts"].includes(path)) {
    return execFileSync("git", ["-c", "core.fsmonitor=false", "show", `${baselineRef}:${path}`], {
      cwd: fileURLToPath(root), encoding: "utf8", maxBuffer: 256 * 1024,
    });
  }
  return readFileSync(new URL(path, root), "utf8");
}

function runModule(path: string, imports: Record<string, unknown>, warnings: unknown[][]): Record<string, any> {
  const module = { exports: {} };
  const compiled = ts.transpileModule(source(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    module, exports: module.exports, URL, Error,
    console: { warn: (...args: unknown[]) => warnings.push(args) },
    process: new Proxy({}, { get() { throw new Error("environment access denied in fixture VM"); } }),
    fetch() { throw new Error("network denied in fixture VM"); },
    require(name: string) {
      if (!Object.hasOwn(imports, name)) throw new Error("unapproved fixture VM dependency");
      return imports[name];
    },
  }, { timeout: 1000, filename: `offline-${path.replaceAll("/", "-")}` });
  return module.exports;
}

function fixtureUrl(path: string): string { return `https://example.test/${path}`; }
function fixtureBlurb(topicId: TopicId, path = "current-source", body = "Generic current source detail."): TopicBlurb {
  return { topicId, topicLabel: "Generic topic", weekOf: period, intro: "Generic intro.", items: [{
    kind: "read", headline: "Generic source headline", body,
    primaryRef: { label: "Generic source", url: fixtureUrl(path) }, supplementaryRefs: [],
  }] };
}
function fixtureSignal(topicId: TopicId, path = "current-source", empty = false): TopicSignal {
  return { topicId, weekOf: period, context: "Generic local source context.",
    citableUrls: new Set([`example.test/${path}`]),
    sources: empty ? [] : [{ title: "Generic source headline", url: fixtureUrl(path), excerpt: "Generic current source detail." }],
  };
}

type Scenario = {
  topics: TopicId[];
  size?: number;
  signals?: Map<TopicId, TopicSignal | undefined>;
  drafts?: Map<TopicId, TopicBlurb | Error>;
  cached?: Map<TopicId, TopicBlurb>;
  recent?: Map<TopicId, Set<string>>;
  editorFails?: boolean;
  expireFirstTopic?: boolean;
};

function harness(options: Scenario) {
  const warnings: unknown[][] = [];
  const deadlines: string[] = [];
  const writes: TopicBlurb[] = [];
  const searches: Array<{ id: TopicId; excludes: string[] }> = [];
  const selections: SelectionResult<TopicBlurb>[] = [];
  const dryCache = new Set<string>();
  const failedCache = new Set<string>();
  const inFlight = new Map<string, Promise<TopicBlurb | null>>();
  const topics = {
    topicLabel: () => "Generic topic",
    mapTopicsForUser: (ids: TopicId[]) => ids.slice(),
    GENERIC_FALLBACK_TOPICS: [],
  };
  // Execute the real pure formatter and validation dependencies as well.
  const visibility = runModule("lib/issue-visibility.ts", {}, warnings);
  const guard = runModule("lib/engine/url-guard.ts", {}, warnings);
  const promptFence = runModule("lib/prompt-fence.ts", {}, warnings);
  const entities = runModule("lib/text-entities.ts", {}, warnings);
  const textClean = runModule("lib/engine/text-clean.ts", {
    "@/lib/prompt-fence": promptFence, "@/lib/text-entities": entities,
  }, warnings);
  const voice = runModule("lib/engine/voice-guard.ts", { "@/lib/issue-visibility": visibility }, warnings);
  const truncate = runModule("lib/text-truncate.ts", {}, warnings);
  const attribution = runModule("lib/source-attribution.ts", { "./engine/text-clean": textClean }, warnings);
  const formatter = runModule("lib/engine/deterministic-fallback.ts", {
    "@/lib/topics": topics, "./voice-guard": voice, "./text-clean": textClean,
    "./url-guard": guard, "@/lib/text-truncate": truncate,
    "@/lib/issue-visibility": visibility, "@/lib/source-attribution": attribution,
  }, warnings);
  const selector = runModule("lib/engine/select-sections.ts", {}, warnings);
  let topicDeadlineCount = 0;
  const assembly = runModule("lib/engine/assemble.ts", {
    "./topic-blurb": { generateTopicBlurb: async (id: TopicId) => {
      const draft = options.drafts?.get(id);
      if (draft instanceof Error) throw draft;
      return draft ?? fixtureBlurb(id, id === backup ? "backup-source" : "current-source");
    } },
    "./editor-note": { generateEditorNote: async () => {
      if (options.editorFails) throw new Error(editorDetail);
      return "Generic editor intro.";
    } },
    "./source-resolver": { resolveTopicSignal: async (id: TopicId, _week: string, opts: { excludeUrls?: Set<string> }) => {
      searches.push({ id, excludes: [...opts.excludeUrls ?? []] });
      if (options.expireFirstTopic && id === timedOut) return new Promise<TopicSignal>(() => {});
      return options.signals?.has(id) ? options.signals.get(id) : fixtureSignal(id);
    } },
    "./blurb-cache": {
      getCachedBlurbs: async () => options.cached ?? new Map(),
      getRecentlyCitedUrls: async () => options.recent ?? new Map(),
      setCachedBlurb: async (blurb: TopicBlurb) => { writes.push(blurb); },
    },
    "@/lib/issue-visibility": visibility, "./url-guard": guard,
    "./select-sections": { selectLetterSections: async (...args: unknown[]) => {
      const result = await selector.selectLetterSections(...args);
      selections.push(result);
      return result;
    } },
    "./deterministic-fallback": formatter, "@/lib/topics": topics,
    "@/lib/with-deadline": { withDeadline: async (work: Promise<unknown>, _ms: number, label: string) => {
      deadlines.push(label);
      if (label !== "editor-note") {
        topicDeadlineCount++;
        if (options.expireFirstTopic && topicDeadlineCount === 1) throw new Error(`${label}: ${providerDetail}`);
      }
      return work;
    } },
  }, warnings);
  const user = { firstName: readerName, city: readerCity, topics: options.topics, theme: "forest" } as UserProfile;
  return {
    warnings, deadlines, writes, searches, selections, dryCache, failedCache, inFlight,
    generate: () => assembly.generateIssue(user, period, options.size ?? options.topics.length,
      "pw", dryCache, inFlight, failedCache) as Promise<Issue>,
  };
}

function privateDiagnostics(h: ReturnType<typeof harness>) {
  assert.ok(h.warnings.every(args => args.length === 1 && typeof args[0] === "string"),
    "diagnostics must contain one fixed string each");
  const diagnostics = JSON.stringify([...h.warnings, h.deadlines]);
  for (const marker of [quiet, duplicate, rejected, fallback, cleanup, timedOut, ordinary, backup,
    providerDetail, editorDetail, readerName, readerCity, fixtureUrl("current-source"),
    "Generic source headline", "generic-private-"]) {
    assert.equal(diagnostics.includes(marker), false, "diagnostics must omit private topics, source and error payloads");
  }
  assert.ok(h.deadlines.every(label => label === "topic-blurb" || label === "editor-note"),
    "deadline labels must be fixed, without topic identity");
}

let passed = 0;
let failed = 0;
async function check(label: string, work: () => Promise<void>) {
  try { await work(); passed++; }
  catch { failed++; console.error(`FAIL ${label}`); }
}

await check("quiet custom topic keeps its internal identity and useful partial section", async () => {
  const h = harness({ topics: [quiet, ordinary], signals: new Map([[quiet, undefined]]) });
  const issue = await h.generate();
  assert.deepEqual([...issue.sections].map(section => section.topicId), [ordinary]);
  assert.equal(issue.sections[0].items[0].primaryRef?.url, fixtureUrl("current-source"));
  assert.ok(h.dryCache.has(`${quiet}|${period}|pw`));
  assert.deepEqual([...h.selections[0].skippedDry], [quiet]);
  assert.ok(h.warnings.some(args => String(args[0]).includes(`${period}: skipped 1 quiet topic(s)`)));
  privateDiagnostics(h);
});

await check("duplicate custom citation keeps selection identities and backfills with unseen work", async () => {
  const h = harness({ topics: [ordinary, duplicate, backup], size: 2,
    cached: new Map([[ordinary, fixtureBlurb(ordinary)], [duplicate, fixtureBlurb(duplicate)],
      [backup, fixtureBlurb(backup, "backup-source")]]) });
  const issue = await h.generate();
  assert.deepEqual([...issue.sections].map(section => section.topicId), [ordinary, backup]);
  assert.deepEqual([...h.selections[0].dedupedByUrl], [duplicate]);
  assert.deepEqual([...issue.sections].map(section => section.items[0].primaryRef?.url),
    [fixtureUrl("current-source"), fixtureUrl("backup-source")]);
  assert.equal(h.searches.length, 0);
  assert.ok(h.warnings.some(args => String(args[0]).includes(`${period}: deduped 1 topic(s)`)));
  privateDiagnostics(h);
});

await check("rejected custom generation retains hard-failure cache and other finished work", async () => {
  const h = harness({ topics: [rejected, ordinary], signals: new Map([[rejected, fixtureSignal(rejected, "empty", true)]]),
    drafts: new Map([[rejected, new Error(providerDetail)]]) });
  const issue = await h.generate();
  assert.deepEqual([...issue.sections].map(section => section.topicId), [ordinary]);
  assert.ok(h.failedCache.has(`${rejected}|${period}|pw`));
  assert.deepEqual(h.writes.map(blurb => blurb.topicId), [ordinary]);
  assert.deepEqual([...h.selections[0].skippedDry], [rejected]);
  privateDiagnostics(h);
});

await check("deadline rejection keeps fixed label and useful partial result", async () => {
  const h = harness({ topics: [timedOut, ordinary], expireFirstTopic: true });
  const issue = await h.generate();
  assert.deepEqual([...issue.sections].map(section => section.topicId), [ordinary]);
  assert.ok(h.inFlight.has(`${timedOut}|${period}|pw`), "pending work retains its internal custom identity");
  assert.equal(h.failedCache.has(`${timedOut}|${period}|pw`), false);
  assert.deepEqual([...h.selections[0].skippedDry], [timedOut]);
  privateDiagnostics(h);
});

await check("model failure preserves custom source and normalized prior-link exclusions", async () => {
  const h = harness({ topics: [fallback], drafts: new Map([[fallback, new Error(providerDetail)]]),
    recent: new Map([[fallback, new Set(["https://example.test/previous-source?utm_source=fixture"])]]),
  });
  const issue = await h.generate();
  assert.equal(issue.sections[0].topicId, fallback);
  assert.equal(issue.sections[0].items[0].body, "Generic current source detail.");
  assert.equal(issue.sections[0].items[0].primaryRef?.url, fixtureUrl("current-source"));
  assert.deepEqual(h.searches, [{ id: fallback, excludes: ["example.test/previous-source"] }]);
  assert.equal(h.writes[0].topicId, fallback);
  assert.ok(h.warnings.some(args => String(args[0]).includes("model generation failed, using deterministic source fallback")));
  privateDiagnostics(h);
});

await check("source-note cleanup preserves custom identity and safe source excerpt", async () => {
  const h = harness({ topics: [cleanup], drafts: new Map([[cleanup,
    fixtureBlurb(cleanup, "current-source", "(full text unavailable, snippet: Generic source detail.)")]]) });
  const issue = await h.generate();
  assert.equal(issue.sections[0].topicId, cleanup);
  assert.equal(issue.sections[0].items[0].body, "Generic current source detail.");
  assert.equal(issue.sections[0].items[0].primaryRef?.url, fixtureUrl("current-source"));
  assert.equal(h.writes[0].topicId, cleanup);
  assert.ok(h.warnings.some(args => String(args[0]).includes("generated section leaked the source note, using deterministic sources")));
  privateDiagnostics(h);
});

await check("editor failure preserves the issue and omits raw error details", async () => {
  const h = harness({ topics: [ordinary], editorFails: true });
  const issue = await h.generate();
  assert.equal(issue.sections[0].topicId, ordinary);
  assert.match(issue.editorIntro, /^A few things worth your time today/);
  assert.equal(issue.recipientFirstName, readerName);
  assert.equal(issue.recipientCity, readerCity);
  assert.ok(h.warnings.some(args => String(args[0]).includes("editor note failed, using fallback intro")));
  privateDiagnostics(h);
});

console.log(`${failed ? "FAIL" : "PASS"} assembly diagnostics privacy ${baseline ? "baseline" : "working source"}: ${passed} passed, ${failed} failed (offline)`);
if (failed) process.exitCode = 1;
