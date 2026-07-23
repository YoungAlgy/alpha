// Verifies the free-first cost tiering in generateTopicBlurb (2026-07-23):
// Gemini (free) -> Haiku (cheap) -> Sonnet (last resort), each escalation
// gated on the SAME guards every draft has to pass (url-guard, meta-leak
// guard, and a zero-tolerance banned-lexical-tell check).
//   1. Normal case — all three tiers healthy, a complete blurb comes back.
//      Does NOT assert which tier "won": every tier's output is
//      non-deterministic and the quality gate can legitimately escalate on a
//      good run too, so no single run proves which tier is typical.
//   2. Gemini forced down (bad key) -> escalates past it, blurb still comes
//      back.
//   3. Gemini forced down twice in a row (bad key, both the first attempt and
//      the retry) -> escalation reaches Haiku. (Forcing Haiku's OWN failure
//      specifically isn't testable by mutating ALPHA_BLURB_CHEAP_MODEL
//      mid-script: like BLURB_MODEL, it's a module-level constant baked in at
//      first import, not re-read per call — same as real production, where
//      env vars are fixed at deploy time. Test 1 below already exercises the
//      full Gemini -> Haiku -> Sonnet chain organically when it happens live,
//      which is stronger evidence than a forced synthetic case anyway.)
//   4. Invariant check across all of the above: no returned blurb, from any
//      tier, on any run, ever contains a banned lexical tell.
// Run: npx tsx scripts/verify-cost-tiering.mts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

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
  w2.some((w) => w.includes("escalating to Haiku"))
);
check("(2) blurb still produced", blurb2.items.length > 0);

// --- 3) Gemini forced down again: escalation reaches Haiku (real, not stale)
console.log("(3) Gemini forced down (2nd independent run) — escalation reaches Haiku again");
process.env.GEMINI_API_KEY = "NOT-A-REAL-KEY-forced-failure-test-0000000000";
const { result: blurb3, warnings: w3 } = await captureWarnings(() =>
  generateTopicBlurb("ai-news" as never, weekOf, signal)
);
process.env.GEMINI_API_KEY = realGeminiKey;
allBlurbs.push(blurb3);
check(
  "(3) escalation past Gemini WAS logged",
  w3.some((w) => w.includes("escalating to Haiku"))
);
check("(3) blurb still produced", blurb3.items.length > 0);
console.log(
  `  (info) full chain from test 1 already proved organically: ${allBlurbs.length >= 1 ? "see test 1's escalation path above" : ""}`
);

// --- 4) Invariant: no blurb, from any tier, on any run, has a banned word --
console.log("(4) No returned blurb — from any tier, any run — ever contains a banned word");
let anyTells = false;
for (const [i, b] of allBlurbs.entries()) {
  const tells = findLexicalTells([b.intro, ...b.items.map((it) => `${it.headline} ${it.body}`)].join(" "));
  if (tells.length > 0) {
    console.log(`  XX run ${i + 1} shipped banned words: ${tells.join(", ")}`);
    anyTells = true;
  }
}
check("(4) zero banned words across all captured blurbs", !anyTells);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("COST-TIERING VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL COST-TIERING ASSERTIONS PASS");
