import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function anthropicClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing from environment");
  // Bound the call: a slow/overloaded API becomes a fast per-call failure that
  // the select-sections backfill + editor-note fallback already absorb, instead
  // of stacking the SDK default (600s × retries) and blowing the route's 120s
  // (generate) / 800s (cron) budget — which would 504 the request and, on the
  // cron, starve every later subscriber that send.
  _client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  return _client;
}

export const MODEL = "claude-sonnet-4-6";
