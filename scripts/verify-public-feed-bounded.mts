// Execute the actual public RSS parser with pure allowlisted dependencies.
// No environment, app, database, provider or network boundary is available.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const WATCHDOG_MS = 2_000;
const MAX_FIXTURE_BYTES = 256 * 1024;
type Loaded = { context: vm.Context; exports: Record<string, any> };
const loaded = new Map<string, Loaded>();
const paths = new Set([
  "lib/prompt-fence.ts", "lib/text-entities.ts", "lib/engine/text-clean.ts",
  "lib/engine/public-feed-search.ts", "lib/engine/rss-xml.ts",
]);
const dependencies: Record<string, Record<string, string>> = {
  "lib/engine/text-clean.ts": {
    "@/lib/prompt-fence": "lib/prompt-fence.ts",
    "@/lib/text-entities": "lib/text-entities.ts",
  },
  "lib/engine/rss-xml.ts": {
    "./text-clean": "lib/engine/text-clean.ts",
    "@/lib/text-entities": "lib/text-entities.ts",
  },
  "lib/engine/public-feed-search.ts": {
    "./text-clean": "lib/engine/text-clean.ts",
    "@/lib/text-entities": "lib/text-entities.ts",
    // This pure module is loaded only if the production parser imports it.
    "./rss-xml": "lib/engine/rss-xml.ts",
  },
};
function denied(): never { throw new Error("unapproved RSS fixture operation"); }
const publicMocks: Record<string, unknown> = {
  "./provider-policy": { noKeySourcesEnabled: () => false },
  "./public-source-response": { readPublicSourceText: denied },
  "./public-source-freshness": { freshPublicResults: denied, publicSourceWindow: denied },
  "./public-source-cache": { createPublicSourceCache: () => denied },
  "./public-source-budget": { reservePublicSourceRequest: denied },
  "./public-source-circuit": { runPublicSourceAttempt: denied },
};

function load(path: string): Loaded {
  assert.ok(paths.has(path), "only allowlisted parser/pure modules may load");
  const existing = loaded.get(path);
  if (existing) return existing;
  const imports = dependencies[path] ?? {};
  const module = { exports: {} as Record<string, any> };
  const context = vm.createContext({
    module, exports: module.exports,
    process: new Proxy({}, { get: denied, set: denied }),
    fetch: denied,
    console: new Proxy({}, { get: denied }),
    require(name: string) {
      if (Object.hasOwn(imports, name)) return load(imports[name]).exports;
      if (path === "lib/engine/public-feed-search.ts" && Object.hasOwn(publicMocks, name)) return publicMocks[name];
      return denied();
    },
  });
  const compiled = ts.transpileModule(readFileSync(new URL(path, root), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInContext(compiled, context, {
    timeout: WATCHDOG_MS, filename: `offline-${path.replaceAll("/", "-")}`,
  });
  const result = { context, exports: module.exports };
  loaded.set(path, result);
  return result;
}

const parser = load("lib/engine/public-feed-search.ts");
let checks = 0;
let failures = 0;
function isTimeout(error: unknown): boolean {
  return error !== null && typeof error === "object" &&
    "code" in error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
}
function check(label: string, work: () => boolean): void {
  checks++;
  try {
    if (work()) {
      console.log(`PASS ${label}`);
      return;
    }
  } catch (error) {
    // Exceptions, response fields and fixture contents never enter output.
    console.error(`FAIL ${label}: ${isTimeout(error) ? "CPU watchdog exceeded" : "fixture operation failed"}`);
    failures++;
    return;
  }
  console.error(`FAIL ${label}: unexpected parser output`);
  failures++;
}

type Item = { title: string; url: string; description: string; age?: string };
function parse(xml: string, maxResults: number | null = 100): Item[] {
  assert.ok(Buffer.byteLength(xml, "utf8") <= MAX_FIXTURE_BYTES, "fixture stays within public response ceiling");
  parser.context.fixtureXml = xml;
  parser.context.fixtureMaxResults = maxResults;
  try {
    const call = maxResults === null ? "module.exports.parsePublicFeedXml(fixtureXml)" :
      "module.exports.parsePublicFeedXml(fixtureXml, fixtureMaxResults)";
    return vm.runInContext(call, parser.context, {
      timeout: WATCHDOG_MS, filename: "offline-public-feed-parse",
    });
  } finally {
    delete parser.context.fixtureXml;
    delete parser.context.fixtureMaxResults;
  }
}
function matches(xml: string, expected: Item[], maxResults = 100): boolean {
  return JSON.stringify(parse(xml, maxResults)) === JSON.stringify(expected);
}
function rejectsMalformed(xml: string): boolean {
  try { return parse(xml).length === 0; }
  catch (error) {
    if (isTimeout(error)) throw error;
    // Synchronous parse rejection or an empty result both fail closed.
    return true;
  }
}

const date = "Sat, 03 Oct 2026 10:00:00 GMT";
const wrap = (content: string) => `<?xml version="1.0"?><rss><channel>${content}</channel></rss>`;
function item(title = "Generic source", path = "story", description = "Generic detail"): string {
  return `<item><title>${title}</title><link>https://example.test/${path}</link><description>${description}</description><pubDate>${date}</pubDate></item>`;
}
const ordinary: Item = {
  title: "Generic source", url: "https://example.test/story", description: "Generic detail", age: date,
};

check("ordinary RSS retains fields", () => matches(wrap(item()), [ordinary]));
check("valid empty RSS", () => matches(wrap("<title>Generic channel</title>"), []));
check("empty self-closing item retains earlier usable entries", () => matches(wrap(item() + "<item/>"), [ordinary]));
check("spaced empty self-closing item retains earlier usable entries", () => matches(wrap(item() + "<item />"), [ordinary]));
check("quoted attributes and closing whitespace retain fields", () => matches(wrap(item()
  .replace("<title>", `<title label="Generic > detail" other='quoted'>`)
  .replace("</title>", "</title >")), [ordinary]));
check("CDATA and entities retain source text", () => matches(wrap(item(
  "<![CDATA[Generic &amp; source]]>", "story?a=1&amp;b=2",
  "<![CDATA[The &lt;b&gt;generic&lt;/b&gt; detail. https://example.test/unlisted]]>",
)), [{ title: "Generic & source", url: "https://example.test/story?a=1&b=2", description: "The generic detail.", age: date }]));
check("CDATA cannot create a fake RSS item", () => matches(wrap(
  `<description><![CDATA[${item("Fake source", "fake")}]]></description>${item()}`,
), [ordinary]));
check("comments cannot create a fake RSS item", () => matches(wrap(
  `<!--${item("Fake source", "fake")}-->${item()}`,
), [ordinary]));
check("nested metadata cannot replace direct fields", () => matches(wrap(
  `<item><description><title>Fake title</title><link>https://example.test/fake</link></description>` +
  `<title>Generic source</title><link>https://example.test/story</link><pubDate>${date}</pubDate></item>`,
), [{ ...ordinary, description: "Fake title" }]));
check("multiple valid items retain order and cap", () => matches(wrap(
  item("Generic one", "one") + item("Generic two", "two") + item("Generic three", "three"),
), [
  { ...ordinary, title: "Generic one", url: "https://example.test/one" },
  { ...ordinary, title: "Generic two", url: "https://example.test/two" },
], 2));
check("repeated raw links and date fields survive parsing", () => matches(wrap(item() + item()), [ordinary, ordinary]));
check("rejected raw items cannot consume the accepted-result cap", () => matches(wrap(
  "<item><title>Generic item without a link</title></item>".repeat(100) + item(),
), [ordinary]));
check("public parser retains its default ten-result cap", () => parse(wrap(item().repeat(12)), null).length === 10);
check("public parser retains its hard hundred-result ceiling", () => parse(wrap(item().repeat(105)), 105).length === 100);

const malformed: Array<[string, string]> = [
  ["missing RSS root", `<channel>${item()}</channel>`],
  ["missing RSS closing tag", `<rss><channel>${item()}</channel>`],
  ["mismatched channel closing tag", `<rss><channel>${item()}</wrong></rss>`],
  ["incomplete second item rejects partial feed", `<rss><channel>${item()}<item><title>Incomplete</channel></rss>`],
  ["unterminated CDATA rejects partial feed", `<rss><channel>${item()}<description><![CDATA[Incomplete</channel></rss>`],
  ["unsupported declaration rejects feed", `<!DOCTYPE rss><rss><channel>${item()}</channel></rss>`],
  ["nameless malformed tag rejects partial feed", wrap(item() + "<>")],
  ["nested unquoted opening bracket rejects partial feed", wrap(item() + "<item <invalid><title>Broken</title></item>")],
  ["closing tag cannot carry trailing attributes", wrap(item().replace("</title>", "</title junk>"))],
  ["slash fragment cannot create a metadata child", wrap(item().replace("<title>", "<title/garbage>"))],
  ["slash fragment cannot create an RSS root", wrap(item()).replace("<rss>", "<rss/foo>")],
  ["unquoted attributes reject partial feed", wrap(item().replace("<title>", "<title label=unquoted>"))],
  ["duplicate attributes reject partial feed", wrap(item().replace("<title>", `<title label="one" label="two">`))],
];
for (const [label, xml] of malformed) check(label, () => rejectsMalformed(xml));

const stress: Array<[string, string]> = [
  ["bounded unclosed item tokens", wrap("<item>".repeat(30_000))],
  ["bounded malformed item attributes", wrap("<item ".repeat(30_000))],
  ["bounded unclosed title tokens", wrap(`<item><link>https://example.test/story</link>${"<title>".repeat(20_000)}</item>`)],
  ["bounded whitespace without a tag name", wrap(`<${" ".repeat(200_000)}>`)],
];
for (const [label, xml] of stress) check(label, () => rejectsMalformed(xml));
check("bounded CDATA-like prefixes inside an opaque comment", () => matches(wrap(item(
  "Generic source", "story", `<!--${"<![CDATA[".repeat(20_000)}-->Generic detail`,
)), [ordinary]));
check("bounded distinct quoted attributes retain usable metadata", () => matches(wrap(item().replace(
  "<title>", `<title${Array.from({ length: 15_000 }, (_, index) => ` a${index}="x"`).join("")}>`,
)), [ordinary]));

console.log(`verify-public-feed-bounded: ${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
