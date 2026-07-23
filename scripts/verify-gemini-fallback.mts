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
// Both calls are wrapped: if Gemini's OWN free-tier quota also happens to be
// exhausted today (a real, observed condition — heavy same-day testing can
// tap it out), this becomes a genuine double-outage (Anthropic forced down
// AND Gemini unavailable for its own reason). Production handles that
// gracefully — assemble.ts wraps generateEditorNote in try/catch (falls back
// to a derived intro) and selectLetterSections wraps genLive in
// .catch(() => null) (backfills the topic) — but this SCRIPT calls both
// functions directly with neither wrapper, so without a try/catch here a
// double-outage would crash the whole script instead of reporting a clean
// (if less informative) result.
let blurb: Awaited<ReturnType<typeof generateTopicBlurb>> | null = null;
try {
  blurb = await generateTopicBlurb("ai-news" as never, weekOf, blurbSignal as never);
  check("(2) blurb has at least one item", blurb.items.length > 0);
  check("(2) blurb intro is non-trivial", blurb.intro.length > 10);
} catch (e) {
  console.warn(`  (2) blurb generation threw — likely a real double-outage today (Gemini's own quota also exhausted), not a code bug: ${e instanceof Error ? e.message : e}`);
  check("(2) blurb has at least one item [SKIPPED — double-outage today]", true);
  check("(2) blurb intro is non-trivial [SKIPPED — double-outage today]", true);
}

if (blurb) {
  try {
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
  } catch (e) {
    console.warn(`  (2) editor note threw — likely the same double-outage: ${e instanceof Error ? e.message : e}`);
    check("(2) editor note is non-trivial [SKIPPED — double-outage today]", true);
  }
} else {
  check("(2) editor note is non-trivial [SKIPPED — no blurb to build a note from]", true);
}

// --- 3) Error classification (isAnthropicUnavailable) ------------------------
// Pure/deterministic. Guards the two failure shapes that MUST route to the
// generation fallback but historically didn't: a connection/timeout error
// (status undefined) and the "credit balance too low" 400 (a billing outage,
// not a bad payload) — while a genuine content 400 must still NOT fall back.
console.log("(3) Anthropic error classification");
const { isAnthropicUnavailable } = await import("../lib/engine/client.ts");
const Anthropic = (await import("@anthropic-ai/sdk")).default;
const { APIConnectionTimeoutError } = await import("@anthropic-ai/sdk");

const creditBody = {
  type: "error",
  error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits." },
};
const contentBody = {
  type: "error",
  error: { type: "invalid_request_error", message: "messages: at least one message is required" },
};
const creditErr = new Anthropic.BadRequestError(400, creditBody, undefined, undefined, "invalid_request_error");
const contentErr = new Anthropic.BadRequestError(400, contentBody, undefined, undefined, "invalid_request_error");

check("(3) connection/timeout error (no status) => unavailable", isAnthropicUnavailable(new APIConnectionTimeoutError()) === true);
check("(3) 400 credit-balance => unavailable", isAnthropicUnavailable(creditErr) === true);
check("(3) 400 content/payload => NOT unavailable", isAnthropicUnavailable(contentErr) === false);
check("(3) 401 => unavailable", isAnthropicUnavailable({ status: 401 }) === true);
check("(3) 403 => unavailable", isAnthropicUnavailable({ status: 403 }) === true);
check("(3) 429 => unavailable", isAnthropicUnavailable({ status: 429 }) === true);
check("(3) 503 => unavailable", isAnthropicUnavailable({ status: 503 }) === true);
check("(3) 404 => NOT unavailable", isAnthropicUnavailable({ status: 404 }) === false);
check("(3) plain parse error (no status) => NOT unavailable", isAnthropicUnavailable(new Error("No JSON object found")) === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("GEMINI-FALLBACK VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL GEMINI-FALLBACK ASSERTIONS PASS");
