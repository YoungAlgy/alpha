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

// Default letter-generation model. Sonnet 5 (upgraded from Haiku 4.5 on
// 2026-07-03, alongside the daily cadence): the blurbs are the actual product —
// the prose subscribers read — and topic blurbs cache per (topic, week_of) and
// are SHARED across subscribers, so cost grows with distinct topics, not subs
// (~$20-27/mo at daily cadence with today's 4 subscribers; Algy approved).
const DEFAULT_MODEL = "claude-sonnet-5";

// Env override so an operator can A/B models without a code change. Unset in
// normal runs (verified: no ALPHA_* vars in the production env).
function pickModel(envVar: string, fallback: string): string {
  return process.env[envVar]?.trim() || fallback;
}

// Split the two calls so the model can differ — blurbs are the cost driver
// (bulk of the prose, per topic, cached/shared), the editor's note is one
// short call per reader.
export const BLURB_MODEL = pickModel("ALPHA_BLURB_MODEL", DEFAULT_MODEL);

// The editor's note is ONE short call per reader and the most personal,
// voice-critical part of the letter, so it rides Opus 4.8 — the strongest
// writing model — for about $2/mo at daily cadence.
export const EDITOR_NOTE_MODEL = pickModel("ALPHA_EDITOR_MODEL", "claude-opus-4-8");

// The shared signal topic-blurb.ts and editor-note.ts both use to tell
// "Anthropic itself is unavailable" (no credits, rate-limited, an outage —
// fall back to Gemini) apart from a request-shaped problem on OUR side.
// Deliberately NARROW to infra-shaped statuses only (401 bad key, 403
// forbidden, 429 rate-limited, 5xx server-side) — NOT 400 or other 4xx. A 400
// (e.g. a content-policy rejection, or a malformed/oversized payload bug)
// means WE sent something wrong, not that the vendor is down; retrying the
// IDENTICAL prompt via Gemini would either hit a similar rejection or produce
// a degraded result for a request Claude correctly refused, silently masking
// a real bug behind a misleading "Anthropic unavailable" log line.
export function isAnthropicUnavailable(e: unknown): e is { status: number } {
  if (typeof e !== "object" || e === null || !("status" in e)) return false;
  const status = (e as { status: unknown }).status;
  return typeof status === "number" && (status === 401 || status === 403 || status === 429 || status >= 500);
}
