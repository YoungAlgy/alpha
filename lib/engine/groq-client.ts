// Thin client over the Groq API (OpenAI-compatible REST, no SDK) — a
// genuinely free, genuinely separate content-GENERATION tier (unlike
// Gemini/You.com, this is about WRITING, not search). Added 2026-07-29 per
// Algy: "I want the Anthropic option to exist but if I'm not funding it we
// still need fallbacks that have the letters going out with new info each
// day." Today, if Anthropic is unfunded, Gemini is the ONLY generation
// engine — and Gemini's own free-tier quota is already observed exhausting
// under real production load (it's tried FIRST for every topic, not just as
// an outage fallback), making it a single point of failure. Groq closes that
// gap: a real ongoing free tier (no card, not a trial), on a fully
// independent account/quota from both Google and Anthropic, so a
// Gemini-exhausted day still has a real shot at fresh content instead of
// falling straight to the stale-resend backup layer.
//
// Model: openai/gpt-oss-120b specifically (NOT the Llama models Groq's docs
// list alongside it) — llama-3.1-8b-instant and llama-3.3-70b-versatile are
// both scheduled for decommission 2026-08-16 per
// console.groq.com/docs/deprecations, verified live during research. Using
// either would silently break in about two weeks.

import { encode, decode } from "gpt-tokenizer";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// gpt-oss-120b's free-tier ceiling (console.groq.com/docs/rate-limits,
// verified live during research): 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD.
// TPM is the tight one for alpha's use — see truncateForGroq below.
const MODEL = "openai/gpt-oss-120b";

// Starting-point safety margin under the 8,000 TPM ceiling — a first GUESS,
// not a guarantee (see the halving retry in groqGenerateText below, which is
// the backstop for whatever this guess still gets wrong). gpt-tokenizer
// implements OpenAI's cl100k/o200k encoding, NOT gpt-oss-120b's own
// tokenizer, so every local count here is an estimate.
//
// TWO separate ratios were measured live 2026-07-29 via Groq's own
// usage.prompt_tokens accounting, and BOTH matter — an earlier version of
// this file only adjusted the user-content side and treated the system
// prompt's local count as if it were already the real cost ("accurate for
// plain prose, no adjustment"). That was wrong and was the actual root cause
// of every earlier "the retry still doesn't converge" failure: sending
// topic-blurb.ts's real SYSTEM_PROMPT (3,774 local tokens) alone measured
// 5,385 REAL tokens — a 1.43x ratio, not 1.02x. Treating it as 1.02x quietly
// invented ~1,600 tokens of budget that didn't exist, so every request
// landed right at the 8,000 ceiling no matter how hard the user content was
// trimmed. URL/source-heavy SIGNAL content (real search results — "SOURCE:
// https://...", headline+link blocks) measured separately in the ~2.1x-2.7x
// range depending on how URL-dense the specific content is.
const TPM_BUDGET = 7_200;
const SYSTEM_PROMPT_SAFETY_FACTOR = 1.5; // measured ~1.43x, +margin
const URL_HEAVY_SAFETY_FACTOR = 2.5;

export function groqConfigured(): boolean {
  return !!process.env.GROQ_API_KEY;
}

// Mirrors braveRateLimitedCount/youRateLimitedCount's monotonic-counter
// reasoning (never reset per-invocation, survives overlapping cron runs on a
// warm lambda) — see lib/brave.ts's comment for the full rationale.
let rateLimitedCount = 0;
export function groqRateLimitedCount(): number {
  return rateLimitedCount;
}

export class GroqTruncatedError extends Error {}

// Trims an already-assembled userPrompt (built for Gemini/Claude's much
// larger effective context) down to whatever's left of TPM_BUDGET after the
// REAL measured cost of systemPrompt, shrunk further by
// URL_HEAVY_SAFETY_FACTOR to account for the measured tokenizer discrepancy
// on URL-heavy content (see TPM_BUDGET's comment — a first version of this
// cap trusted gpt-tokenizer's raw count for the user content too and still
// hit a real 413 on real topic-blurb content). Cuts on a token boundary at
// the tail, which can land mid-word — acceptable for a last-resort tier
// trading a little polish for guaranteed delivery.
export function truncateForGroq(systemPrompt: string, userPrompt: string): string {
  const systemTokensLocal = encode(systemPrompt).length;
  const systemTokensRealEstimate = Math.ceil(systemTokensLocal * SYSTEM_PROMPT_SAFETY_FACTOR);
  const rawBudget = TPM_BUDGET - systemTokensRealEstimate; // real Groq-token units left for user content
  const localBudget = Math.floor(rawBudget / URL_HEAVY_SAFETY_FACTOR); // shrunk to gpt-tokenizer units
  if (localBudget <= 0) {
    // The system prompt alone already exceeds the budget — nothing of the
    // user content can safely fit. Extremely unlikely (today's system
    // prompt measures ~3,774 local / ~5,385 real tokens, well under
    // TPM_BUDGET) but a real, checkable condition rather than silently
    // sending an empty/negative slice.
    throw new GroqTruncatedError(
      `system prompt alone (~${systemTokensRealEstimate} estimated real tokens) exceeds Groq's safety budget (${TPM_BUDGET})`
    );
  }
  const userTokens = encode(userPrompt);
  if (userTokens.length <= localBudget) return userPrompt;
  const cut = decode(userTokens.slice(0, localBudget));
  return `${cut}\n\n[...additional sources omitted to fit this provider's context limit...]`;
}

interface GroqChoice {
  message?: { content?: string };
  finish_reason?: string;
}
interface GroqResponse {
  choices?: GroqChoice[];
}

async function postChatCompletion(
  key: string,
  systemPrompt: string,
  userContent: string,
  maxOutputTokens: number
): Promise<Response> {
  return fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: maxOutputTokens,
      // gpt-oss-120b is a reasoning model — by default it spends part of
      // max_tokens on an internal chain-of-thought before the actual answer
      // (measured live: ~55 reasoning tokens on a trivial 2-sentence
      // question). At editor-note.ts's maxOutputTokens=1000 that reasoning
      // overhead was enough to trip GroqTruncatedError with EMPTY real
      // content. "low" cut it to ~5 tokens with no visible quality loss on
      // the same test prompt — this is a writing task with real signal
      // already resolved, not a reasoning task, so there's nothing for
      // deeper reasoning to add.
      reasoning_effort: "low",
    }),
    signal: AbortSignal.timeout(20_000),
  });
}

async function parseGroqSuccess(res: Response, maxOutputTokens: number): Promise<string> {
  const data = (await res.json()) as GroqResponse;
  const choice = data.choices?.[0];
  // "length" is OpenAI-schema's truncation signal (mirrors Claude's
  // stop_reason==="max_tokens" and Gemini's finishReason==="MAX_TOKENS") —
  // never trust a cut-off response as if it finished cleanly.
  if (choice?.finish_reason === "length") {
    throw new GroqTruncatedError(`Groq hit its ${maxOutputTokens}-token output ceiling`);
  }
  const text = choice?.message?.content ?? "";
  if (!text.trim()) throw new Error("Groq returned no text");
  return text;
}

async function failGroq(res: Response): Promise<never> {
  if (res.status === 429) rateLimitedCount += 1;
  const text = await res.text().catch(() => "");
  const err = new Error(`Groq ${MODEL} ${res.status}: ${text.slice(0, 300)}`);
  // Attach the real numeric status so callers can check e.status === 429
  // directly (topic-blurb.ts's isRateLimited, the same check already used for
  // Haiku/Sonnet's Anthropic errors) instead of pattern-matching the message
  // string, which is one incidental response-body substring away from a false
  // positive/negative.
  (err as Error & { status?: number }).status = res.status;
  throw err;
}

// Plain text generation (topic-blurb / editor-note WRITING, same role as
// geminiGenerateText) — no search/tool use, the caller already has real
// signal and just needs prose. Bounded fetch, no unconditional retry: this
// is itself a fallback tier, so a slow Groq call should fail fast into
// whatever comes next rather than stacking wait time on top (same reasoning
// as gemini-client.ts's callGemini) — the retries this makes are narrowly
// for the 413-correction case below, not a generic "try again" retry.
export async function groqGenerateText(
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number
): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY missing from environment");

  let content = truncateForGroq(systemPrompt, userPrompt);

  // Up to 4 total attempts: the first is the static best-guess trim; each
  // retry after that HALVES the current content's local token count. A
  // precise ratio-based correction ("shrink by exactly requested/limit")
  // was tried first and DIDN'T converge reliably — measured live, content
  // density isn't uniform (cutting from the tail doesn't reduce real Groq
  // tokens proportionally to local tokens, since the trailing portion cut
  // can be more or less URL-dense than the whole), so a precise-looking
  // correction still undershot three times in a row (8952 -> 8681 -> 8514,
  // never getting under 8000). Halving is deliberately crude but converges
  // fast regardless of density variance: even a badly-off real/local ratio
  // is very unlikely to survive two 50% cuts. Bounded (not unbounded) since
  // this is itself a fallback tier — a topic that still can't fit after
  // real attempts should escalate to the next tier rather than loop.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await postChatCompletion(key, systemPrompt, content, maxOutputTokens);
    if (res.ok) return parseGroqSuccess(res, maxOutputTokens);

    if (res.status === 413 && attempt < 4) {
      const currentLocalTokens = encode(content).length;
      const targetLocalTokens = Math.floor(currentLocalTokens / 2);
      // Below this, there's nothing meaningful left to trim — stop
      // correcting and let this same iteration's failGroq(res) below report
      // the failure, rather than sending a pointless near-empty request.
      if (targetLocalTokens >= 50) {
        const corrected = decode(encode(content).slice(0, targetLocalTokens));
        content = `${corrected}\n\n[...additional sources omitted to fit this provider's context limit...]`;
        console.warn(`[groq-client] 413, attempt ${attempt} — halving content and retrying`);
        continue;
      }
    }

    return failGroq(res);
  }
  // Unreachable (every loop iteration returns) — keeps TS happy about the
  // function's return type.
  throw new Error("Groq: exhausted retries while trying to fit under the token limit");
}
