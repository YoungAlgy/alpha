/**
 * Runtime policy for providers that can create a bill.
 *
 * Alpha's free mode must fail closed. A missing variable, a typo, or a stale
 * deployment therefore disables Anthropic and DeepSeek rather than silently
 * spending against either account. Set ALPHA_ALLOW_PAID_AI to `1` only in an
 * explicitly reviewed runtime that is allowed to incur those calls.
 */
export function paidAiEnabled(): boolean {
  const raw = process.env.ALPHA_ALLOW_PAID_AI?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Strict no-model mode for a zero-cost delivery run.
 *
 * When enabled, the issue pipeline skips all writer-model calls, including
 * per-reader editor notes. It also skips Gemini grounded search and deep
 * reads. Brave, You.com, and an enabled public-feed tier can still resolve
 * current sources before safe source material is formatted locally.
 */
export function noModelModeEnabled(): boolean {
  const raw = process.env.ALPHA_NO_MODEL_MODE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
