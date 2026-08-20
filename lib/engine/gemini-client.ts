// Thin client over the Gemini API (raw REST, no SDK dependency needed for the
// two calls this app makes). A genuinely separate vendor from Anthropic/Brave,
// with two DISTINCT roles depending on the caller.
//
// alpha-drift-r47-05 (2026-08-20): this comment used to say Gemini is "used
// ONLY as a fallback... never the primary path" -- true before the
// 2026-07-23 cost-tiering flip (commit a88a0e7), wrong since. Round 46
// already fixed the identical stale claim in 3 other places (app/api/health/
// route.ts, README.md's Stack table, README.md's directory listing) but
// missed this file, the client those descriptions actually point at.
//
// Real roles: (1) PRIMARY generation tier for topic blurbs -- topic-blurb.ts's
// tryGemini() is called FIRST for every blurb, unconditionally (gated only on
// geminiConfigured(), not on Anthropic's status); Claude only escalates when
// Gemini's own draft fails the quality guards. (2) a genuine FALLBACK in
// editor-note.ts (tried only after Claude fails/is unconfigured) and in
// gemini-search.ts (tried only after Brave signals quota exhaustion) -- the
// "fallback path off a primary provider" framing on callGemini's own comment
// below only describes these two call sites, not topic-blurb.ts's.
//
// Free tier via AI Studio (youngalgy@gmail.com).

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function geminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY?.trim();
}

// Env override so an operator can A/B models without a code change, same
// pattern as lib/engine/client.ts's BLURB_MODEL/EDITOR_NOTE_MODEL.
function pickModel(envVar: string, fallback: string): string {
  return process.env[envVar]?.trim() || fallback;
}

// gemini-2.5-flash: verified working against the real API before this file
// was wired into anything. Free tier is generous at this app's volume (see
// memory — 5,000 grounded prompts/month on Gemini 3.x; 2.5 Flash's own free
// allowance comfortably covers occasional-fallback use).
export const GEMINI_TEXT_MODEL = pickModel("ALPHA_GEMINI_TEXT_MODEL", "gemini-2.5-flash");
export const GEMINI_SEARCH_MODEL = pickModel("ALPHA_GEMINI_SEARCH_MODEL", "gemini-2.5-flash");

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY missing from environment");
  return key;
}

// alpha-drift-r60-09 (2026-08-20, duplicate-code-audit-r10): Brave (lib/
// brave.ts), You.com (lib/you-search.ts), Groq, and DeepSeek all have this
// exact monotonic-counter pattern, each explicitly commented as mirroring
// the others, and all four feed weekly-send/route.ts's ops-alert baseline/
// trigger/message. Gemini -- the PRIMARY, first-tried generation tier for
// every topic blurb, not a downstream fallback like Groq/DeepSeek -- had no
// equivalent, despite topic-blurb.ts's tryGemini() already detecting a
// Gemini 429/402 via isRateLimited(e) (it just never counted it). A
// sustained Gemini-only outage (quota exhaustion, an invalid/rotated key --
// both real, previously-observed incidents per lib/you-search.ts's and
// lib/engine/source-resolver.ts's own comments) silently shifted 100% of
// blurb load onto Groq then DeepSeek with zero signal in the one alert
// email Algy actually reads. Incremented directly in callGemini() below
// (this file's single shared error path for every caller) rather than
// threaded as a per-caller callback like the openai-compat.ts siblings --
// Gemini's raw-REST client has no equivalent shared helper to hook into,
// and every caller (geminiGenerateText, geminiGroundedSearch) already
// funnels through this one function, so this is the correct centralization
// point here.
let rateLimitedCount = 0;
export function geminiRateLimitedCount(): number {
  return rateLimitedCount;
}

interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  groundingMetadata?: {
    groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
  };
  finishReason?: string;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

// Thrown when Gemini hit its own output ceiling — verified live against the
// real API (finishReason:"MAX_TOKENS" on a forced-truncated response), so
// callers can treat this the same way topic-blurb.ts's BlurbTruncatedError
// treats a truncated Claude response: never silently ship a cut-off result.
export class GeminiTruncatedError extends Error {}

// Bounded fetch (20s attempt, no retry — a slow Gemini call should fail fast
// into whatever comes next, not stack more wait time on top. For
// editor-note.ts/gemini-search.ts this "next" is a fallback off a primary
// provider; for topic-blurb.ts, where Gemini is tried FIRST, it's Groq).
async function callGemini(
  model: string,
  body: Record<string, unknown>
): Promise<GeminiCandidate | undefined> {
  const res = await fetch(`${API_BASE}/${model}:generateContent?key=${apiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    // alpha-drift-r60-09: matches the sibling providers' 429-or-402
    // trigger condition (openai-compat.ts's throwCompatError) -- 402 covers
    // a genuinely balance/quota-exhausted response, not just a rate limit.
    if (res.status === 429 || res.status === 402) rateLimitedCount += 1;
    const text = await res.text().catch(() => "");
    const err = new Error(`Gemini ${model} ${res.status}: ${text.slice(0, 300)}`);
    // Attach the real numeric status so callers can check e.status === 429
    // directly (topic-blurb.ts's isRateLimited, shared across all five
    // generation tiers) instead of pattern-matching the message string.
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const data = (await res.json()) as GeminiResponse;
  return data.candidates?.[0];
}

// Plain text generation, used by two callers with opposite tier order:
// topic-blurb.ts calls this FIRST, before Anthropic; editor-note.ts calls it
// only as a fallback once Anthropic fails or is unconfigured. No grounding
// tool: by the time this runs, the caller already has real signal to write
// from and just needs a model to turn it into prose.
export async function geminiGenerateText(
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number
): Promise<string> {
  const candidate = await callGemini(GEMINI_TEXT_MODEL, {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    // thinkingBudget:0 disables Gemini's extended-thinking spend, same
    // reasoning as Claude's thinking:{type:"disabled"} on the blurb call —
    // this is a templated JSON/prose task, not one that benefits from it.
    generationConfig: { maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } },
  });
  // A truncated response can still parse as valid (if unbalanced-brace luck
  // runs out) or worse, as valid-but-SHORTENED JSON — check BEFORE the text
  // is trusted, same reasoning as Claude's stop_reason==="max_tokens" guard.
  //
  // alpha-drift-r28-10 (2026-08-15): this used to only special-case
  // finishReason==="MAX_TOKENS" -- any OTHER non-clean finish (SAFETY,
  // RECITATION, PROHIBITED_CONTENT, OTHER, SPII, BLOCKLIST, LANGUAGE) fell
  // straight through and got trusted as if generation finished normally,
  // inconsistent with this file's own geminiGroundedSearch below, which
  // correctly whitelists ONLY "STOP" (undefined and "STOP" are the only
  // clean finishes) rather than blacklisting one specific bad value. Fixed
  // to match: any present, non-STOP finish reason throws. Reusing
  // GeminiTruncatedError (not a new class) is deliberate, not just
  // convenient -- topic-blurb.ts's tryGemini() catches it specifically to
  // SKIP the retry-once and escalate straight to Groq, on the reasoning
  // that a truncation is deterministic (an immediate retry hits the same
  // wall). The same reasoning holds for SAFETY/RECITATION/etc: they trip on
  // the SAME input a retry would resend, so treating them identically
  // (skip the wasted retry, escalate immediately) is correct, not just
  // reused for convenience.
  const finish = candidate?.finishReason;
  if (finish && finish !== "STOP") {
    throw new GeminiTruncatedError(`Gemini finished with reason "${finish}" (not STOP) at a ${maxOutputTokens}-token ceiling`);
  }
  const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) throw new Error("Gemini returned no text");
  return text;
}

export interface GeminiGroundedResult {
  answerText: string;
  citations: Array<{ url: string; title: string }>;
}

// Grounded search: search + write happen in ONE atomic call on Gemini's side
// (see gemini-search.ts's header comment for why this means we can only
// post-filter citations, never pre-filter what Gemini is allowed to search).
export async function geminiGroundedSearch(query: string): Promise<GeminiGroundedResult | undefined> {
  const candidate = await callGemini(GEMINI_SEARCH_MODEL, {
    contents: [{ parts: [{ text: query }] }],
    tools: [{ google_search: {} }],
  });
  // Unlike geminiGenerateText (whose OWN output is truncation-guarded), this
  // text becomes the RESEARCH the blurb writer trusts as fact — so a grounded
  // answer that didn't finish cleanly (MAX_TOKENS, SAFETY, RECITATION, ...) is
  // worse than none: a mid-thought cut can drop the qualifying clause or the
  // number that changes the meaning. Bail so the topic falls through to a
  // fresher backup instead of being written from a half-answer. (undefined and
  // "STOP" are the only clean finishes; anything else is a partial stop.)
  const finish = candidate?.finishReason;
  if (finish && finish !== "STOP") return undefined;
  const answerText = candidate?.content?.parts?.map((p) => p.text ?? "").join("\n").trim() ?? "";
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const citations = chunks
    .map((c) => ({ url: c.web?.uri ?? "", title: c.web?.title ?? "" }))
    .filter((c) => c.url);
  if (!answerText || citations.length === 0) return undefined;
  return { answerText, citations };
}
