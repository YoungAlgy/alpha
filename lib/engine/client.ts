import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function anthropicClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing from environment");
  // Bound each ATTEMPT at 60s (vs the SDK's 600s default) with one retry, so a
  // slow/overloaded API becomes a fast per-call failure the select-sections
  // backfill + editor-note fallback absorb. NOTE: this is per-attempt, so in a
  // pathological case (the retry, plus topic-blurb's own parse-retry, plus the
  // sequential editor note) total time can still stack past a route's
  // maxDuration. The DETERMINISTIC budget guarantee is the route-level
  // withDeadline (weekly-send per-user, generate onboarding), not this timeout —
  // this just shrinks the typical and common-failure cases dramatically.
  _client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  return _client;
}

// Haiku keeps per-letter cost well under subscriber revenue at this scale: topic
// blurbs cache per (topic, week_of) and are SHARED across subscribers, so cost
// grows slower than subs (each new reader mostly adds just their editor note).
// Flip back to "claude-sonnet-4-6" — or use Sonnet only for the editor note — as
// a quality bump once the margin allows.
export const MODEL = "claude-haiku-4-5";
