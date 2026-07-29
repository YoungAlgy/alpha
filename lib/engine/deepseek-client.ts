// Thin client over the DeepSeek API (OpenAI-compatible REST, no SDK) — the
// 3rd content-GENERATION tier, tried after Groq (2026-07-29, per Algy: "I
// want the Anthropic option to exist but if I'm not funding it we still need
// fallbacks that have the letters going out with new info each day"). Unlike
// Gemini/Groq's free tiers (which this whole session watched genuinely run
// dry under real load), DeepSeek has no daily/per-minute cap — it's a real
// funded balance, trivially cheap ($0.14/1M input tokens on a cache miss,
// $0.28/1M output — see api-docs.deepseek.com/quick_start/pricing). This is
// the tier that actually makes "the letters keep going out no matter what"
// true, not just "usually true."
//
// Model: deepseek-v4-flash, the cheap tier (deepseek-v4-pro exists but costs
// ~3x more per token for a use case — templated prose from already-resolved
// signal — that doesn't need the pro tier's extra capability).
//
// No truncateForGroq-style token-budget dance here: DeepSeek's context is 1M
// tokens with a 384K max output (api-docs.deepseek.com, verified live
// 2026-07-29), vastly larger than anything alpha's topic-blurb/editor-note
// prompts ever approach, so there's no realistic way to hit a real ceiling.

import { throwCompatError, extractCompatText, type CompatResponse } from "./openai-compat";

const ENDPOINT = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-v4-flash";

export function deepseekConfigured(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}

// Mirrors groqRateLimitedCount/braveRateLimitedCount's monotonic-counter
// reasoning — see lib/brave.ts's comment for the full rationale.
let rateLimitedCount = 0;
export function deepseekRateLimitedCount(): number {
  return rateLimitedCount;
}

export class DeepSeekTruncatedError extends Error {}

function failDeepSeek(res: Response): Promise<never> {
  return throwCompatError("DeepSeek", MODEL, res, () => {
    rateLimitedCount += 1;
  });
}

// Plain text generation (topic-blurb / editor-note WRITING, same role as
// geminiGenerateText/groqGenerateText) — no search/tool use, the caller
// already has real signal and just needs prose. Bounded fetch, no
// unconditional retry: this is itself a fallback tier, so a slow DeepSeek
// call should fail fast into whatever comes next rather than stacking wait
// time on top (same reasoning as gemini-client.ts's callGemini).
export async function deepseekGenerateText(
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number
): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY missing from environment");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxOutputTokens,
      // DeepSeek-V4 defaults to thinking mode ON (api-docs.deepseek.com/
      // guides/thinking_mode, verified live 2026-07-29) — it spends part of
      // max_tokens on chain-of-thought (returned separately as
      // reasoning_content) before the real answer. Learned this the hard way
      // on Groq's gpt-oss-120b (same failure shape: a tight output budget
      // silently eaten by reasoning, producing empty content) — disabling it
      // up front here instead of rediscovering the bug. This is a writing
      // task with real signal already resolved, not a reasoning task.
      thinking: { type: "disabled" },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) return failDeepSeek(res);

  const data = (await res.json()) as CompatResponse;
  return extractCompatText(data, "DeepSeek", maxOutputTokens, DeepSeekTruncatedError);
}
