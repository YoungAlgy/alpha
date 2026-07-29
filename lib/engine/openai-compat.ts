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
export function extractCompatText(
  data: CompatResponse,
  providerLabel: string,
  maxOutputTokens: number,
  TruncatedErrorCtor: new (message: string) => Error
): string {
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new TruncatedErrorCtor(`${providerLabel} hit its ${maxOutputTokens}-token output ceiling`);
  }
  const text = choice?.message?.content ?? "";
  if (!text.trim()) throw new Error(`${providerLabel} returned no text`);
  return text;
}
