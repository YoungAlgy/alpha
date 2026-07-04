// Verifies the Gemini dual fallback for real:
//   1. Search fallback — resolveTopicSignalViaGemini produces a real,
//      guard-passing TopicSignal (grounded search -> redirect-resolved ->
//      paywall/junk filtered).
//   2. Generation fallback — with Anthropic FORCED DOWN (an invalid key, a
//      real 401 from the real API, not a mock), generateTopicBlurb and
//      generateEditorNote both still produce a real, complete result via
//      Gemini instead of failing the topic/letter outright.
// Run: npx tsx scripts/verify-gemini-fallback.mts
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

const { resolveTopicSignalViaGemini } = await import("../lib/engine/gemini-search.ts");

// --- 1) Search fallback ------------------------------------------------------
console.log("(1) Gemini grounded-search fallback");
const weekOf = "2026-07-04";
const searchSignal = await resolveTopicSignalViaGemini(
  "macro-markets" as never,
  weekOf,
  "Fed rate decisions; CPI inflation print; Treasury yields",
  new Set()
);
check("(1) returns a signal", !!searchSignal);
check("(1) has real citable URLs", (searchSignal?.citableUrls?.size ?? 0) > 0);
check(
  "(1) context does not mention the redirect host",
  !searchSignal?.context.includes("vertexaisearch.cloud.google.com")
);
// Regression guard: no known paywalled domain should ever survive into citableUrls.
const KNOWN_PAYWALLS = ["wsj.com", "nytimes.com", "bloomberg.com", "ft.com"];
const anyPaywallSurvived = [...(searchSignal?.citableUrls ?? [])].some((u) =>
  KNOWN_PAYWALLS.some((d) => u.includes(d))
);
check("(1) no known paywalled domain in survivors", !anyPaywallSurvived);

// excludeUrls actually excludes: re-run with every survivor from pass 1 excluded.
if (searchSignal?.citableUrls?.size) {
  const excludeAll = new Set(searchSignal.citableUrls);
  const searchSignal2 = await resolveTopicSignalViaGemini(
    "macro-markets" as never,
    weekOf,
    "Fed rate decisions; CPI inflation print; Treasury yields",
    excludeAll
  );
  const overlap = searchSignal2
    ? [...searchSignal2.citableUrls!].some((u) => excludeAll.has(u))
    : false;
  check("(1) excludeUrls are never re-cited on a second call", !overlap);
} else {
  check("(1) excludeUrls are never re-cited on a second call", false);
}

// --- 2) Generation fallback (Anthropic forced down) -------------------------
console.log("(2) Generation fallback (Anthropic forced down with an invalid key)");
process.env.ANTHROPIC_API_KEY = "sk-ant-invalid-key-to-force-401";

const { generateTopicBlurb } = await import("../lib/engine/topic-blurb.ts");
const { generateEditorNote } = await import("../lib/engine/editor-note.ts");

const blurbSignal =
  searchSignal ?? {
    topicId: "ai-news" as never,
    weekOf,
    context: "Anthropic released Claude Sonnet 5. (https://www.anthropic.com/news)",
    citableUrls: new Set(["anthropic.com/news"]),
  };
const blurb = await generateTopicBlurb("ai-news" as never, weekOf, blurbSignal as never);
check("(2) blurb has at least one item", blurb.items.length > 0);
check("(2) blurb intro is non-trivial", blurb.intro.length > 10);

const note = await generateEditorNote(
  {
    firstName: "Sam",
    city: "Austin",
    topics: ["ai-news"] as never,
    jobBlurb: undefined,
    projectBlurb: undefined,
    funBlurb: undefined,
    gender: undefined,
    birthday: undefined,
  } as never,
  [blurb]
);
check("(2) editor note is non-trivial", note.length > 20);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("GEMINI-FALLBACK VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL GEMINI-FALLBACK ASSERTIONS PASS");
