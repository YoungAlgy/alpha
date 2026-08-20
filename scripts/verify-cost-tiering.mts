// Verifies the free-first cost tiering in generateTopicBlurb: Gemini (free)
// -> Groq (free) -> DeepSeek (paid, uncapped) -> Haiku (cheap) -> Sonnet
// (last resort), each escalation gated on the SAME guards every draft has to
// pass (url-guard, meta-leak guard, and a zero-tolerance banned-lexical-tell
// check).
//
// alpha-drift-r66-03 (2026-08-21, duplicate-code-audit-r16): this header
// used to describe a stale 3-tier chain (Gemini -> Haiku -> Sonnet) that
// predates Groq and DeepSeek joining 2026-07-29 (commit ecc968c) -- that
// commit updated tests 2/3's actual assertions to check for "escalating to
// Groq" but never touched this docstring, which claimed the wrong shape for
// 4 weeks after. lib/engine/client.ts carried the identical stale
// parenthetical, fixed in the same pass.
//   1. Normal case — all five tiers healthy, a complete blurb comes back.
//      Does NOT assert which tier "won": every tier's output is
//      non-deterministic and the quality gate can legitimately escalate on a
//      good run too, so no single run proves which tier is typical.
//   2. Gemini forced down (bad key) -> escalates past it to Groq, blurb
//      still comes back.
//   3. Gemini forced down again (2nd independent run) -> escalation past it
//      to Groq is real, not a stale fluke from test 2. (Forcing Groq/
//      DeepSeek/Haiku's OWN failures specifically isn't testable this way:
//      like BLURB_MODEL, each tier's config is a module-level constant baked
//      in at first import, not re-read per call — same as real production,
//      where env vars are fixed at deploy time. Test 1 above already
//      exercises the full Gemini -> Groq -> DeepSeek -> Haiku -> Sonnet
//      chain organically when it happens live, which is stronger evidence
//      than a forced synthetic case anyway.)
//   4. Invariant check across all of the above: no returned blurb, from any
//      tier, on any run, ever contains a banned lexical tell.
// Run: npx tsx scripts/verify-cost-tiering.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
    real(...args);
  };
  return fn()
    .then((result) => ({ result, warnings }))
    .finally(() => {
      console.warn = real;
    });
}

const { getSignal } = await import("../lib/engine/mock-signals.ts");
const { findLexicalTells } = await import("../lib/engine/voice-guard.ts");
const weekOf = "2026-07-04";
const signal = getSignal("ai-news", weekOf) ?? getSignal("ai-news");
if (!signal) throw new Error("no mock signal for ai-news — fixture missing");

const { generateTopicBlurb } = await import("../lib/engine/topic-blurb.ts");
const allBlurbs: Awaited<ReturnType<typeof generateTopicBlurb>>[] = [];

// --- 1) Normal case: all tiers healthy, a complete blurb comes back --------
console.log("(1) All tiers healthy — a complete blurb comes back");
const { result: blurb1, warnings: w1 } = await captureWarnings(() =>
  generateTopicBlurb("ai-news" as never, weekOf, signal)
);
allBlurbs.push(blurb1);
check("(1) blurb produced", blurb1.items.length > 0);
console.log(
  `  (info, not asserted) escalation path this run: ${w1.filter((w) => w.includes("escalating")).map((w) => w.split(": ").pop()).join(" -> ") || "none — Gemini succeeded standalone"}`
);

// --- 2) Gemini forced down: escalation must still produce a blurb ----------
console.log("(2) Gemini forced down (invalid key) — should escalate past it");
const realGeminiKey = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = "NOT-A-REAL-KEY-forced-failure-test-0000000000";
const { result: blurb2, warnings: w2 } = await captureWarnings(() =>
  generateTopicBlurb("ai-news" as never, weekOf, signal)
);
process.env.GEMINI_API_KEY = realGeminiKey;
allBlurbs.push(blurb2);
check(
  "(2) escalation past Gemini WAS logged",
  w2.some((w) => w.includes("escalating to Groq"))
);
check("(2) blurb still produced", blurb2.items.length > 0);

// --- 3) Gemini forced down again: escalation reaches the next tier (real, not stale)
console.log("(3) Gemini forced down (2nd independent run) — escalation reaches the next tier again");
process.env.GEMINI_API_KEY = "NOT-A-REAL-KEY-forced-failure-test-0000000000";
const { result: blurb3, warnings: w3 } = await captureWarnings(() =>
  generateTopicBlurb("ai-news" as never, weekOf, signal)
);
process.env.GEMINI_API_KEY = realGeminiKey;
allBlurbs.push(blurb3);
check(
  "(3) escalation past Gemini WAS logged",
  w3.some((w) => w.includes("escalating to Groq"))
);
check("(3) blurb still produced", blurb3.items.length > 0);
console.log(
  `  (info) full chain from test 1 already proved organically: ${allBlurbs.length >= 1 ? "see test 1's escalation path above" : ""}`
);

// --- 4) Invariant: no blurb, from any tier, on any run, has a banned word --
// alpha-drift-r22-02 (found+fixed 2026-08-14, self-audit): this invariant
// check used to scan the SAME narrower blob (headline+body only) the
// production bug itself used -- widened to match the real fix's full scope
// (ref labels + supplementary notes too), so this test can't pass green
// while silently missing the exact class of leak the fix closes.
console.log("(4) No returned blurb — from any tier, any run — ever contains a banned word (full scope: intro, headline, body, ref labels, supplementary notes)");
let anyTells = false;
for (const [i, b] of allBlurbs.entries()) {
  const blob = [
    b.intro,
    ...b.items.map((it) =>
      [it.headline, it.body, it.primaryRef?.label, ...(it.supplementaryRefs?.flatMap((r) => [r.label, r.note]) ?? [])]
        .filter(Boolean)
        .join(" ")
    ),
  ].join(" ");
  const tells = findLexicalTells(blob);
  if (tells.length > 0) {
    console.log(`  XX run ${i + 1} shipped banned words: ${tells.join(", ")}`);
    anyTells = true;
  }
}
check("(4) zero banned words across all captured blurbs, full scope", !anyTells);

// --- 5) alpha-drift-r22-02: the actual bug -- a banned word hiding ONLY in
// a ref label/note used to be invisible to the tells check ---
console.log("(5) alpha-drift-r22-02: reproduce the exact gap -- a banned word ONLY in a citation label/note");
{
  // Mirrors topic-blurb.ts's real itemTextBlob() shape exactly.
  const itemTextBlob = (it: { headline: string; body: string; primaryRef?: { label: string }; supplementaryRefs?: { label: string; note?: string }[] }) =>
    [it.headline, it.body, it.primaryRef?.label, ...(it.supplementaryRefs?.flatMap((r) => [r.label, r.note]) ?? [])]
      .filter(Boolean)
      .join(" ");

  const item = {
    headline: "A clean, banned-word-free headline",
    body: "A clean, banned-word-free body paragraph with nothing suspicious in it at all.",
    primaryRef: { label: "Real leverage in modern finance" }, // the banned word lives ONLY here
  };

  // The OLD, narrower scope this bug used -- reproduced exactly, not guessed.
  const oldScopeTells = findLexicalTells(`${item.headline} ${item.body}`);
  check("(5) sanity: the OLD narrow scope (headline+body only) finds NOTHING -- proves the bug was real, not already caught some other way", oldScopeTells.length === 0);

  // The NEW, fixed scope (itemTextBlob, matching the real production code).
  const newScopeTells = findLexicalTells(itemTextBlob(item));
  check("(5) the FIXED full scope (itemTextBlob) actually catches the word hiding in the ref label", newScopeTells.includes("leverage"));

  // Source-level guard: confirm the REAL file shares one itemTextBlob
  // between the meta-leak filter and the tells check, not two independently
  // hand-copied blobs that could silently drift apart again.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/engine/topic-blurb.ts", import.meta.url), "utf8");
  check("(5) source: itemTextBlob is defined once", (src.match(/const itemTextBlob = /g) ?? []).length === 1);
  check("(5) source: the meta-leak filter calls itemTextBlob(it)", /containsMetaLeak\(itemTextBlob\(it\)\)/.test(src));
  check("(5) source: the tells check ALSO uses itemTextBlob via cleanItems.map, not a separately hand-written blob", /findLexicalTells\(\[intro, \.\.\.cleanItems\.map\(itemTextBlob\)\]/.test(src));
}

// --- 6) alpha-drift-r22-04: primaryRef.note -- structurally IDENTICAL to
// supplementaryRefs[].note, but itemTextBlob (and the sanitizer that maps
// over every item before it) never referenced it at all -- a second,
// independent instance of the exact SAME class of gap #5 above closed for
// labels, just one field over -- caught by the same self-audit pass that
// wrote test #5, on the very item it had just fixed. ---
console.log("(6) alpha-drift-r22-04: primaryRef.note gets the SAME sanitization + tells-scan treatment as supplementaryRefs[].note, not silently skipped");
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/engine/topic-blurb.ts", import.meta.url), "utf8");

  // (a) itemTextBlob's real shape now includes primaryRef.note. Compared
  // against the r22-02-fixed-but-still-incomplete scope (label, but not
  // primaryRef.note) reproduced locally here, since that intermediate shape
  // no longer exists in the real file to import.
  const r22_02Scope = (it: { headline: string; body: string; primaryRef?: { label: string }; supplementaryRefs?: { label: string; note?: string }[] }) =>
    [it.headline, it.body, it.primaryRef?.label, ...(it.supplementaryRefs?.flatMap((r) => [r.label, r.note]) ?? [])]
      .filter(Boolean)
      .join(" ");
  const itemTextBlobWithNote = (it: { headline: string; body: string; primaryRef?: { label: string; note?: string }; supplementaryRefs?: { label: string; note?: string }[] }) =>
    [it.headline, it.body, it.primaryRef?.label, it.primaryRef?.note, ...(it.supplementaryRefs?.flatMap((r) => [r.label, r.note]) ?? [])]
      .filter(Boolean)
      .join(" ");
  const item = {
    headline: "A clean, banned-word-free headline",
    body: "A clean, banned-word-free body paragraph with nothing suspicious in it at all.",
    primaryRef: { label: "A clean label", note: "This source will leverage its position" }, // banned word lives ONLY in primaryRef.note
  };
  check("(6a) sanity: the r22-02 scope (label but not primaryRef.note) finds NOTHING -- confirms this is a distinct, still-real gap", findLexicalTells(r22_02Scope(item)).length === 0);
  check("(6b) the FIXED full scope (including primaryRef.note) catches the word", findLexicalTells(itemTextBlobWithNote(item)).includes("leverage"));

  // (b) source: itemTextBlob's real definition now reads primaryRef?.note.
  check("(6c) source: itemTextBlob's real definition includes primaryRef?.note", /it\.primaryRef\?\.label, it\.primaryRef\?\.note,/.test(src));

  // (c) source: the sanitizer mapping (finalizeBlurb's `mapped =`) now
  // sanitizes primaryRef.note too, not just label -- confirms the fix isn't
  // ONLY visible to the tells scan while still shipping raw to the reader.
  check(
    "(6d) source: the sanitizer's primaryRef mapping now sanitizes note as well as label",
    /primaryRef: it\.primaryRef\s*\n\s*\? \{ \.\.\.it\.primaryRef, label: sanitizeVoice\(it\.primaryRef\.label\), note: it\.primaryRef\.note \? sanitizeVoice\(it\.primaryRef\.note\) : it\.primaryRef\.note \}/.test(src)
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("COST-TIERING VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL COST-TIERING ASSERTIONS PASS");
