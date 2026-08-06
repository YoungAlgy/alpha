// Deterministic (no live provider calls) verification of the two
// "empty/lost response still means failure" branches added alongside this
// finding: editor-note.ts's tryTextTier now treats a trimmed-empty string as
// a failure (undefined, not ""), and topic-blurb.ts's Sonnet-retry only
// replaces the original draft when the retry itself has items. The existing
// verify-deepseek-fallback.mts / verify-groq-fallback.mts / verify-gemini-
// fallback.mts scripts only ever reach these branches by chance, if a live
// provider organically returns empty text during a manual run — this script
// calls the branch logic directly with fake inputs instead, so a regression
// (e.g. checking `=== undefined` instead of falsy-after-trim, or an inverted
// `retryFinalized.items.length > 0` condition) fails every run, not just the
// rare one where a live provider happens to go empty.
// Run: npx tsx scripts/verify-empty-response-branches.mts
let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// --- 1) editor-note.ts's tryTextTier: empty/whitespace generate() -> undefined, not "" ---
console.log("(1) tryTextTier treats empty/whitespace output as failure, not as a real note");
const { tryTextTier } = await import("../lib/engine/editor-note.ts");

const empty = await tryTextTier("fake-empty", true, async () => "");
check('(1a) fully empty string -> undefined (not "")', empty === undefined);

const whitespace = await tryTextTier("fake-whitespace", true, async () => "   \n\t  ");
check("(1b) whitespace-only string -> undefined (not the untrimmed original)", whitespace === undefined);

const real = await tryTextTier("fake-real", true, async () => "  a real note.  ");
check("(1c) real text still passes through, trimmed", real === "a real note.");

const notConfigured = await tryTextTier("fake-unconfigured", false, async () => "should never run");
check("(1d) configured=false short-circuits to undefined without calling generate", notConfigured === undefined);

// --- 2) topic-blurb.ts's keepRetryOrOriginal: a 0-item retry must not overwrite a good original ---
console.log("(2) keepRetryOrOriginal keeps the original draft when the retry loses everything");
const { keepRetryOrOriginal } = await import("../lib/engine/topic-blurb.ts");

const original = { items: ["real item"] };
const emptyRetry = { items: [] as string[] };
const keptOriginal = keepRetryOrOriginal(original, emptyRetry);
check("(2a) retry with 0 items -> original is kept", keptOriginal === original);

const goodRetry = { items: ["retried item"] };
const tookRetry = keepRetryOrOriginal(original, goodRetry);
check("(2b) retry with items -> retry replaces the original", tookRetry === goodRetry);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("EMPTY-RESPONSE-BRANCHES VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL EMPTY-RESPONSE-BRANCHES ASSERTIONS PASS");
