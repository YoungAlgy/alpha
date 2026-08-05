// Verifies the DeepSeek content-generation fallback for real:
//   1. deepseekGenerateText itself returns real, usable prose from the real
//      API, and thinking mode is genuinely disabled (no reasoning_content
//      eating the output budget the way Groq's default did).
//   2. topic-blurb.ts's real escalation chain reaches DeepSeek and produces
//      a real blurb when Gemini AND Groq are both forced down.
//   3. editor-note.ts's real fallback chain reaches DeepSeek when Anthropic,
//      Gemini, AND Groq are all forced down.
// Run: npx tsx scripts/verify-deepseek-fallback.mts
//
// NOTE on ordering (same lesson as verify-groq-fallback.mts): anthropicClient()
// caches its client at first construction, so forcing ANTHROPIC_API_KEY
// invalid must happen before ANY real Anthropic call in this process. This
// script forces it invalid from the very top for that reason.
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();
process.env.ANTHROPIC_API_KEY = "sk-ant-invalid-key-to-force-401";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const { deepseekGenerateText, deepseekConfigured } = await import("../lib/engine/deepseek-client.ts");

// --- 1) Raw client, and confirm thinking mode is actually disabled ---------
console.log("(1) deepseekGenerateText raw client");
check("(1) deepseekConfigured() is true (DEEPSEEK_API_KEY set)", deepseekConfigured());

// try/catch (not just later sections): an uncaught throw here would crash the
// whole script before sections 2-3 even ran — the same class of bug already
// fixed once in verify-groq-fallback.mts's earlier sections.
try {
  const text = await deepseekGenerateText(
    "You are a helpful assistant. Respond in plain prose, no markdown.",
    "In one short sentence, what is the capital of France?",
    100
  );
  check("(1) returns non-empty real text", text.trim().length > 0);
  check("(1) mentions Paris (a real, sensible answer, not garbage)", /paris/i.test(text));
} catch (e) {
  console.error(`  (1) deepseekGenerateText threw: ${e instanceof Error ? e.message : e}`);
  check("(1) returns non-empty real text", false);
  check("(1) mentions Paris (a real, sensible answer, not garbage)", false);
}

// A trivial "capital of France" question is weak evidence for thinking mode
// specifically: even WITH reasoning enabled, a model can answer that in a
// handful of tokens, so surviving a loose budget doesn't actually prove
// thinking is off. Use DeepSeek's OWN documented reasoning-trigger example
// instead (api-docs.deepseek.com/guides/thinking_mode uses this exact
// question to demonstrate chain-of-thought) under a genuinely tight budget —
// if thinking were still on, the reasoning tokens alone would very likely
// blow through 60 tokens before any answer, throwing DeepSeekTruncatedError.
try {
  const reasoningText = await deepseekGenerateText(
    "You are a helpful assistant. Respond in plain prose, no markdown.",
    "9.11 and 9.8, which is greater? Answer in one short sentence.",
    60
  );
  // Deliberately NOT asserting the answer is correct: deepseek-v4-flash is a
  // fast, non-reasoning-by-default model, and this specific question is a
  // well-known trap that thinking mode exists to help avoid (that's WHY
  // DeepSeek's own docs use it) — a flash-tier model getting it wrong is
  // itself consistent with (even mild evidence FOR) thinking being off, not
  // a bug. Confirmed live: deepseek-v4-flash answered "9.11 is greater than
  // 9.8" (factually wrong) here, which is exactly the failure mode you'd
  // expect WITHOUT chain-of-thought. What actually matters for this check is
  // completing at all under a tight budget without DeepSeekTruncatedError.
  console.log(`  (info) reasoning-trigger answer: ${JSON.stringify(reasoningText.trim())}`);
  check("(1) reasoning-trigger question answered within a tight 60-token budget (thinking is genuinely off)", reasoningText.trim().length > 0);
} catch (e) {
  console.error(`  (1) reasoning-trigger check threw: ${e instanceof Error ? e.message : e}`);
  check("(1) reasoning-trigger question answered within a tight 60-token budget (thinking is genuinely off)", false);
}

// --- 2) topic-blurb.ts's real escalation reaches DeepSeek -------------------
// Gemini AND Groq forced down (invalid key / invalid key); Anthropic already
// forced down from the top of this script. A real blurb can ONLY come from
// DeepSeek in this state.
console.log("(2) topic-blurb.ts escalation: Gemini down, Groq down, Anthropic down -> DeepSeek produces the blurb");
const realGeminiKey = process.env.GEMINI_API_KEY;
const realGroqKey = process.env.GROQ_API_KEY;
process.env.GEMINI_API_KEY = "NOT-A-REAL-KEY-forced-failure-test";
process.env.GROQ_API_KEY = "gsk_invalid00000000000000000000000000000000";
try {
  const { generateTopicBlurb } = await import("../lib/engine/topic-blurb.ts");
  const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
  const weekOf = "2026-06-20";
  const signal = await resolveTopicSignal("ai-news" as never, weekOf, { freshness: "pw" });
  const usableSignal =
    signal ?? {
      topicId: "ai-news" as never,
      weekOf,
      context: "Anthropic released Claude Sonnet 5, a new flagship model. (https://www.anthropic.com/news)",
      citableUrls: new Set(["anthropic.com/news"]),
    };
  const blurb = await generateTopicBlurb("ai-news" as never, weekOf, usableSignal as never);
  check("(2) a real blurb came back with items", blurb.items.length > 0);
  check("(2) intro is non-trivial", blurb.intro.length > 10);
} catch (e) {
  console.error(`  (2) generateTopicBlurb threw: ${e instanceof Error ? e.message : e}`);
  check("(2) a real blurb came back with items", false);
  check("(2) intro is non-trivial", false);
} finally {
  // Restore here (not just after section 3) so section 3 re-forces its OWN
  // precondition instead of silently depending on this section's leftover
  // state — "force it, don't assume" (see verify-groq-fallback.mts's header
  // comment), the same pattern that script's own sections 3/4 already use.
  process.env.GEMINI_API_KEY = realGeminiKey;
  process.env.GROQ_API_KEY = realGroqKey;
}

// --- 3) editor-note.ts's real fallback reaches DeepSeek ---------------------
console.log("(3) editor-note.ts fallback: Anthropic down, Gemini down, Groq down -> DeepSeek writes the note");
process.env.GEMINI_API_KEY = "NOT-A-REAL-KEY-forced-failure-test";
process.env.GROQ_API_KEY = "gsk_invalid00000000000000000000000000000000";
try {
  const { generateEditorNote } = await import("../lib/engine/editor-note.ts");
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
    [
      {
        topicId: "ai-news" as never,
        topicLabel: "AI news",
        weekOf: "2026-06-20",
        intro: "A quick look at what shipped this week in AI.",
        items: [],
      } as never,
    ]
  );
  check("(3) a real editor note came back", note.trim().length > 20);
} catch (e) {
  console.error(`  (3) generateEditorNote threw: ${e instanceof Error ? e.message : e}`);
  check("(3) a real editor note came back", false);
} finally {
  process.env.GEMINI_API_KEY = realGeminiKey;
  process.env.GROQ_API_KEY = realGroqKey;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("DEEPSEEK-FALLBACK VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL DEEPSEEK-FALLBACK ASSERTIONS PASS");
