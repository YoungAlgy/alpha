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

// Default letter-generation model. Haiku keeps per-letter cost well under
// subscriber revenue at this scale: topic blurbs cache per (topic, week_of) and
// are SHARED across subscribers, so cost grows slower than subs.
const DEFAULT_MODEL = "claude-haiku-4-5";

// Env override so an operator can A/B models (e.g. flip blurbs to
// "claude-sonnet-4-6") without a code change. Unset in normal runs.
function pickModel(envVar: string, fallback: string): string {
  return process.env[envVar]?.trim() || fallback;
}

// Split the two calls so the model can differ — the cost/quality split that lets
// the voice land where it matters most while keeping the bill under revenue.
//
// Topic blurbs are the COST DRIVER (the bulk of the prose, longer + per topic),
// but they cache + share across subscribers, and on the rebuilt prompt Haiku
// reads genuinely well, so they default to the cheap model (~$5/mo at this scale).
// Flip to Sonnet via ALPHA_BLURB_MODEL for a richer-sourced read (~$14/mo) once
// paid subs grow.
export const BLURB_MODEL = pickModel("ALPHA_BLURB_MODEL", DEFAULT_MODEL);

// The editor's note is ONE short call per reader and the most personal,
// voice-critical part of the letter, so it rides Sonnet for pennies (~$0.30/mo).
export const EDITOR_NOTE_MODEL = pickModel("ALPHA_EDITOR_MODEL", "claude-sonnet-4-6");
