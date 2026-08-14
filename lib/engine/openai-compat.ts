// Shared plumbing for the two OpenAI-compatible-wire-protocol content-
// generation clients (groq-client.ts, deepseek-client.ts) — NOT for
// gemini-client.ts, which uses a genuinely different response shape
// (candidates/parts, no finish_reason/choices). Both Groq and DeepSeek's
// /chat/completions responses share the identical
// {choices: [{message: {content}, finish_reason}]} shape, so the
// response-parsing and error-construction logic doesn't need to be
// duplicated per-vendor the way each vendor's OWN config (model name,
// endpoint, rate limits, truncation-error class) genuinely does.

export interface CompatChoice {
  message?: { content?: string };
  finish_reason?: string;
}
export interface CompatResponse {
  choices?: CompatChoice[];
}

// Builds and throws the error for a non-ok response, with the real numeric
// status attached (so callers can check e.status === 429 directly — see
// topic-blurb.ts's isRateLimited, shared across all five generation tiers)
// instead of pattern-matching the message string. onRateLimited is an
// optional callback so each vendor keeps bumping its OWN separate
// rateLimitedCount (they're wired to their own distinct ops-alert lines in
// route.ts, so must stay genuinely separate counters, not a shared one).
export async function throwCompatError(
  providerLabel: string,
  model: string,
  res: Response,
  onRateLimited?: () => void
): Promise<never> {
  if (res.status === 429) onRateLimited?.();
  const text = await res.text().catch(() => "");
  const err = new Error(`${providerLabel} ${model} ${res.status}: ${text.slice(0, 300)}`);
  (err as Error & { status?: number }).status = res.status;
  throw err;
}

// Parses a successful response, throwing TruncatedErrorCtor if the model hit
// its output ceiling ("length" is OpenAI-schema's truncation signal, mirrors
// Claude's stop_reason==="max_tokens" and Gemini's finishReason==="MAX_TOKENS")
// — never trust a cut-off response as if it finished cleanly.
//
// alpha-drift-r28-10 (2026-08-15): this used to only special-case
// finish_reason==="length" -- the OpenAI-compatible schema this function
// deliberately mirrors also defines "content_filter" (a moderation-
// triggered early stop) as a real non-"stop" value, which fell straight
// through and got trusted as a complete response. Fixed to whitelist
// "stop" (and an absent finish_reason, same tolerance the sibling
// gemini-client.ts fix applies for a response shape that can legitimately
// omit it) rather than blacklisting one specific bad value, matching
// gemini-client.ts's geminiGenerateText/geminiGroundedSearch. Reusing
// TruncatedErrorCtor (not a new error class) for a content_filter stop is
// deliberate: topic-blurb.ts's tryGroq()/tryDeepSeek() catch
// GroqTruncatedError/DeepSeekTruncatedError specifically to skip the
// retry-once and escalate immediately, on the reasoning that the failure
// is deterministic for the same input -- true for a token ceiling AND for
// a moderation trip, both of which a same-input retry would reproduce.
export function extractCompatText(
  data: CompatResponse,
  providerLabel: string,
  maxOutputTokens: number,
  TruncatedErrorCtor: new (message: string) => Error
): string {
  const choice = data.choices?.[0];
  const finish = choice?.finish_reason;
  if (finish && finish !== "stop") {
    throw new TruncatedErrorCtor(
      `${providerLabel} finished with reason "${finish}" (not "stop") at a ${maxOutputTokens}-token output ceiling`
    );
  }
  const text = choice?.message?.content ?? "";
  if (!text.trim()) throw new Error(`${providerLabel} returned no text`);
  return text;
}
