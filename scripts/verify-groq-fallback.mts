// Verifies the Groq content-generation fallback for real:
//   1. groqGenerateText itself returns real, usable prose from the real API.
//   2. truncateForGroq actually trims an oversized context (the safety net
//      for topic-blurb's full deep-read path, which wasn't measurable live
//      when this tier was built — Brave was capped at build time).
//   3. topic-blurb.ts's real escalation chain reaches Groq and produces a
//      real blurb when Gemini is forced down (mirrors verify-you-fallback.mts's
//      "force it, don't assume" pattern).
//   4. editor-note.ts's real fallback chain reaches Groq when BOTH Anthropic
//      and Gemini are forced down.
// Run: npx tsx scripts/verify-groq-fallback.mts
//
// NOTE on ordering (learned the hard way building verify-inflight-rejection-
// cleanup.mts): anthropicClient() caches its client at first construction, so
// forcing ANTHROPIC_API_KEY invalid must happen before ANY real Anthropic
// call in this process, not just before the specific test that needs it.
// This script forces it invalid from the very top for that reason - there is
// no test here that needs a REAL Anthropic call.
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
process.env.ANTHROPIC_API_KEY = "sk-ant-invalid-key-to-force-401";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const { groqGenerateText, groqConfigured, truncateForGroq } = await import("../lib/engine/groq-client.ts");

// --- 1) Raw client -----------------------------------------------------------
console.log("(1) groqGenerateText raw client");
check("(1) groqConfigured() is true (GROQ_API_KEY set)", groqConfigured());

const text = await groqGenerateText(
  "You are a helpful assistant. Respond in plain prose, no markdown.",
  "In one short sentence, what is the capital of France?",
  200
);
check("(1) returns non-empty real text", text.trim().length > 0);
check("(1) mentions Paris (a real, sensible answer, not garbage)", /paris/i.test(text));

// --- 2) truncateForGroq actually keeps REAL content under Groq's real cap ---
// Real regression test: a first version of this cap trusted gpt-tokenizer's
// raw count for URL-heavy signal content and still got a genuine live 413
// from Groq ("Limit 8000, Requested 9495") on real topic-blurb content —
// gpt-tokenizer's encoding doesn't match gpt-oss-120b's real tokenizer for
// that kind of text (measured live: ~2.07x off). A local token estimate
// alone can't be trusted after that — this test actually SENDS the trimmed
// real content to Groq and checks for a real 200, not just a local count.
console.log("(2) truncateForGroq: real signal content, actually sent to Groq (not just locally estimated)");
const topicBlurbSrc = readFileSync("lib/engine/topic-blurb.ts", "utf8");
const realSystemPromptMatch = topicBlurbSrc.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
if (!realSystemPromptMatch) {
  check("(2) could extract topic-blurb.ts's real SYSTEM_PROMPT", false);
} else {
  const realSystemPrompt = realSystemPromptMatch[1];
  const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
  const realSignal = await resolveTopicSignal("ai-news" as never, "2026-07-29", { freshness: "pw" });
  const realContext =
    realSignal?.context ??
    // Fall back to a large synthetic URL-heavy blob (mirrors real signal
    // shape: lots of "SOURCE: https://..." lines) if every live provider is
    // dry/down this run — still exercises the SAME URL-tokenization risk.
    Array.from({ length: 150 }, (_, i) => `[${i}] Some headline about a real story\n    SOURCE: https://www.example-real-news-site.com/2026/07/29/some-article-slug-${i}\n\n`).join("");
  try {
    const trimmed = truncateForGroq(realSystemPrompt, realContext);
    const { groqGenerateText } = await import("../lib/engine/groq-client.ts");
    await groqGenerateText(realSystemPrompt, trimmed, 4000); // matches topic-blurb.ts's real maxOutputTokens
    check("(2) real system prompt + trimmed real signal content — Groq accepted it (no 413)", true);
  } catch (e) {
    console.error(`  (2) real content still failed against Groq: ${e instanceof Error ? e.message : e}`);
    check("(2) real system prompt + trimmed real signal content — Groq accepted it (no 413)", false);
  }
}

const small = "a short context that fits comfortably under any real cap";
check(
  "(2) a small context passes through unchanged",
  truncateForGroq("a short system prompt", small) === small
);

// --- 3) topic-blurb.ts's real escalation reaches Groq -----------------------
// Gemini forced down (invalid key); Anthropic already forced down from the
// top of this script. A real blurb can ONLY come from Groq in this state.
console.log("(3) topic-blurb.ts escalation: Gemini down, Anthropic down -> Groq produces the blurb");
const realGeminiKey = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = "NOT-A-REAL-KEY-forced-failure-test";
try {
  const { generateTopicBlurb } = await import("../lib/engine/topic-blurb.ts");
  const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
  const weekOf = "2026-07-04";
  const signal = await resolveTopicSignal("ai-news" as never, weekOf, { freshness: "pw" });
  const usableSignal =
    signal ?? {
      topicId: "ai-news" as never,
      weekOf,
      context: "Anthropic released Claude Sonnet 5, a new flagship model. (https://www.anthropic.com/news)",
      citableUrls: new Set(["anthropic.com/news"]),
    };
  const blurb = await generateTopicBlurb("ai-news" as never, weekOf, usableSignal as never);
  check("(3) a real blurb came back with items", blurb.items.length > 0);
  check("(3) intro is non-trivial", blurb.intro.length > 10);
} catch (e) {
  console.error(`  (3) generateTopicBlurb threw: ${e instanceof Error ? e.message : e}`);
  check("(3) a real blurb came back with items", false);
  check("(3) intro is non-trivial", false);
} finally {
  process.env.GEMINI_API_KEY = realGeminiKey;
}

// --- 4) editor-note.ts's real fallback reaches Groq -------------------------
console.log("(4) editor-note.ts fallback: Anthropic down, Gemini down -> Groq writes the note");
process.env.GEMINI_API_KEY = "NOT-A-REAL-KEY-forced-failure-test";
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
        weekOf: "2026-07-04",
        intro: "A quick look at what shipped this week in AI.",
        items: [],
      } as never,
    ]
  );
  check("(4) a real editor note came back", note.trim().length > 20);
} catch (e) {
  console.error(`  (4) generateEditorNote threw: ${e instanceof Error ? e.message : e}`);
  check("(4) a real editor note came back", false);
} finally {
  process.env.GEMINI_API_KEY = realGeminiKey;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("GROQ-FALLBACK VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL GROQ-FALLBACK ASSERTIONS PASS");
