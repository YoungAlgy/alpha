// Offline guard: historical mock snapshots remain test fixtures and cannot
// enter source resolution or production issue assembly.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getSignal } from "../lib/engine/mock-signals.ts";
import { selectLetterSections } from "../lib/engine/select-sections.ts";

const sourceResolver = readFileSync(
  new URL("../lib/engine/source-resolver.ts", import.meta.url),
  "utf8"
);
const assemble = readFileSync(
  new URL("../lib/engine/assemble.ts", import.meta.url),
  "utf8"
);

assert.doesNotMatch(sourceResolver, /mock-signals|resolveMockSignal|getSignal\s*\(/);
assert.doesNotMatch(assemble, /resolveMockSignal|genFiller/);
assert.match(
  assemble,
  /selectLetterSections\(genPool, size, genLive, null, extractBlurbUrls\)/
);

const fixture = getSignal("ai-news", "2026-05-17");
assert.ok(fixture, "the dated fixture should remain available to offline tests");
assert.equal(fixture.weekOf, "2026-05-17");

const selection = await selectLetterSections<string>(
  ["ai-news"],
  1,
  async () => null,
  null
);
assert.deepEqual(selection.chosen, []);
assert.deepEqual(selection.usedFiller, []);
assert.deepEqual(selection.skippedDry, ["ai-news"]);

console.log("PASS verify-mock-fallback (offline, 8 assertions)");
