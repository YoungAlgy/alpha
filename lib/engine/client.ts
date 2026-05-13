import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function anthropicClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing from environment");
  _client = new Anthropic({ apiKey });
  return _client;
}

export const MODEL = "claude-sonnet-4-6";
