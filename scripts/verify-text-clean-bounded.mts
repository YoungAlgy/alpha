// Pure offline sanitizer regressions. Only three allowlisted source files enter
// the VM. Stress calls run inside its watchdog, with no environment or network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const WATCHDOG_MS = 2_000;
const MAX_FIXTURE_BYTES = 256 * 1024;
const MODULES = {
  "lib/prompt-fence.ts": {},
  "lib/text-entities.ts": {},
  "lib/engine/text-clean.ts": {
    "@/lib/prompt-fence": "lib/prompt-fence.ts",
    "@/lib/text-entities": "lib/text-entities.ts",
  },
} as const;
type ModulePath = keyof typeof MODULES;
type Loaded = { context: vm.Context; exports: Record<string, any> };
const loaded = new Map<ModulePath, Loaded>();

function denied(): never { throw new Error("unapproved fixture operation"); }

function load(path: ModulePath): Loaded {
  const existing = loaded.get(path);
  if (existing) return existing;
  assert.ok(Object.hasOwn(MODULES, path), "only allowlisted pure modules may load");
  const imports = MODULES[path] as Record<string, ModulePath>;
  const module = { exports: {} as Record<string, any> };
  const context = vm.createContext({
    module, exports: module.exports,
    process: new Proxy({}, { get: denied, set: denied }),
    fetch: denied,
    console: new Proxy({}, { get: denied }),
    require(name: string) {
      if (!Object.hasOwn(imports, name)) return denied();
      return load(imports[name]).exports;
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

const sanitizer = load("lib/engine/text-clean.ts");
const { stripPromptFenceChars } = load("lib/prompt-fence.ts").exports;
const { decodeTextEntities } = load("lib/text-entities.ts").exports;
let checks = 0;
let failures = 0;

function check(label: string, work: () => boolean): void {
  checks++;
  try {
    if (work()) {
      console.log(`PASS ${label}`);
      return;
    }
  } catch (error) {
    // Never print the exception or fixture text. A timeout is an ordinary
    // failed assertion, so later independent cases still run on the baseline.
    const timeout = error !== null && typeof error === "object" &&
      "code" in error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
    console.error(`FAIL ${label}: ${timeout ? "CPU watchdog exceeded" : "fixture operation failed"}`);
    failures++;
    return;
  }
  console.error(`FAIL ${label}: unexpected sanitized output`);
  failures++;
}

function cleanInsideWatchdog(input: string): string {
  sanitizer.context.fixtureInput = input;
  try {
    return vm.runInContext("module.exports.cleanField(fixtureInput)", sanitizer.context, {
      timeout: WATCHDOG_MS, filename: "offline-sanitizer-call",
    });
  } finally { delete sanitizer.context.fixtureInput; }
}

// The legacy expression is used only on small compatibility inputs, never on
// the adversarial stress strings. Keep the surrounding transforms identical.
function legacyClean(input: string): string {
  return stripPromptFenceChars(decodeTextEntities(input).replace(/<[^>]+>/g, "").trim())
    .replace(/https?:\/\/[^\s)\]]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

const named: Array<[string, string, string]> = [
  ["ordinary text", "  Generic headline  ", "Generic headline"],
  ["tag delimiters leave inner prose", "<script>Generic text</script> after", "Generic text after"],
  ["first open to next close", "before<<>>after", "beforeafter"],
  ["empty brackets and adjacent tags", "left<><b>middle</b>right", "leftmiddleright"],
  ["unmatched suffix survives fence removal", "left<unfinished", "leftunfinished"],
  ["whitespace normalization", "left\n\t  right", "left right"],
  ["encoded tags and URL scheme", "&lt;b&gt;Real&lt;/b&gt; https&#58;//example.test/path", "Real"],
  ["double encoded tags and URL", "&amp;lt;b&amp;gt;Real&amp;lt;/b&amp;gt; &amp;#104;ttps://example.test/path", "Real"],
  ["mixed case URL removal", "left HTTPS://example.test/path right", "left right"],
  ["Unicode fence characters", "left＜tag＞⟨tag⟩〈tag〉right", "lefttagtagtagright"],
  ["astral numeric entity", "Generic &#x1F4F0; headline", "Generic 📰 headline"],
  ["invalid numeric entity", "Generic &#xD800; headline", "Generic \uFFFD headline"],
];
for (const [label, input, expected] of named) {
  check(label, () => legacyClean(input) === expected && cleanInsideWatchdog(input) === expected);
}

const alphabet = ["<", ">", "a", " ", "\n"];
const compatibility: Array<{ input: string; expected: string }> = [];
let frontier = [""];
for (let length = 0; length <= 6; length++) {
  for (const input of frontier) compatibility.push({ input, expected: legacyClean(input) });
  if (length < 6) frontier = frontier.flatMap(prefix => alphabet.map(char => prefix + char));
}
assert.equal(compatibility.length, 19_531);
check("19,531 short exhaustive compatibility inputs", () => {
  sanitizer.context.compatibilityFixtures = compatibility;
  try {
    return vm.runInContext(
      "compatibilityFixtures.every(({ input, expected }) => module.exports.cleanField(input) === expected)",
      sanitizer.context, { timeout: WATCHDOG_MS, filename: "offline-sanitizer-compatibility" },
    );
  } finally { delete sanitizer.context.compatibilityFixtures; }
});

const stress: Array<[string, string]> = [
  ["bounded unmatched opening brackets", "<".repeat(240_000) + "Generic headline"],
  ["bounded empty bracket pairs", "<>".repeat(100_000) + "Generic headline"],
  ["bounded encoded opening brackets", "&lt;".repeat(60_000) + "Generic headline"],
];
for (const [label, input] of stress) {
  assert.ok(Buffer.byteLength(input, "utf8") <= MAX_FIXTURE_BYTES, "stress stays within public response ceiling");
  check(label, () => cleanInsideWatchdog(input) === "Generic headline");
}

console.log(`verify-text-clean-bounded: ${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
