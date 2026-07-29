import Anthropic, { APIConnectionError } from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

// Whether Anthropic is even worth attempting — checked BEFORE calling
// Haiku/Sonnet in topic-blurb.ts's escalation chain so that when Algy
// deliberately isn't funding Anthropic (removes the key, the clean way to
// toggle it off), the chain skips straight past two guaranteed-failing tiers
// instead of paying the latency of two wasted attempts (each with its own
// internal retry) before reaching the real answer. Does NOT catch the
// "key present but balance drained to zero" case — that can only be
// discovered by a real call failing (see isAnthropicUnavailable) — but
// removing the key is the expected way to toggle funding off deliberately.
export function anthropicConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

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

// The cheap middle tier in topic-blurb.ts's cost-tiering waterfall (Gemini
// free -> Haiku cheap -> Sonnet last resort). This was alpha's actual
// production blurb model for weeks before the deliberate 2026-07-03 upgrade
// to Sonnet 5 ("blurbs are the actual product") — not a novel or unvalidated
// choice, a known-good one being reintroduced as a cost lever now that live
// testing shows Gemini's free tier alone escalates too often (its own rate
// limit under volume, plus a real gap respecting the banned-AI-tell list) to
// deliver meaningful savings on its own.
export const BLURB_CHEAP_MODEL = pickModel("ALPHA_BLURB_CHEAP_MODEL", "claude-haiku-4-5");

// The editor's note is ONE short call per reader and the most personal,
// voice-critical part of the letter, so it rides Opus 4.8 — the strongest
// writing model — for about $2/mo at daily cadence.
export const EDITOR_NOTE_MODEL = pickModel("ALPHA_EDITOR_MODEL", "claude-opus-4-8");

// The shared classifier topic-blurb.ts and editor-note.ts both use to tell
// "Anthropic itself is unavailable" (fall back to Gemini) apart from a
// request-shaped problem on OUR side (a real bug — surface it, don't mask it).
//
// UNAVAILABLE (fall back to Gemini):
//  - A network failure or a hung-then-timed-out request. The SDK throws
//    APIConnectionError / APIConnectionTimeoutError, which carry NO http status
//    (status === undefined). This is the MOST COMMON real "Anthropic is down"
//    shape, so a status-only check would miss the exact outage the fallback
//    exists for — hence the instanceof branch first.
//  - 401 (bad/expired key), 403 (forbidden), 429 (rate-limited), any 5xx.
//  - 400 "credit balance is too low": Anthropic reports a depleted PREPAID
//    balance as a 400 invalid_request_error, not a 402/429. It is a billing
//    outage (NOT our payload's fault) and the literal "no credits" case this
//    fallback was built for, so match it specifically by message.
//
// NOT unavailable (surface the bug — a Gemini retry would hide it):
//  - Any OTHER 400 / 4xx: a content-policy rejection, a malformed/oversized
//    payload bug. Retrying the identical prompt via Gemini would either hit a
//    similar rejection or ship a degraded result Claude correctly refused,
//    behind a misleading "Anthropic unavailable" log line.
export function isAnthropicUnavailable(e: unknown): e is { status?: number } {
  // No HTTP status at all — a connection/timeout error. THE common outage shape.
  if (isConnectionError(e)) return true;
  if (typeof e !== "object" || e === null || !("status" in e)) return false;
  const status = (e as { status: unknown }).status;
  if (typeof status !== "number") return false;
  if (status === 401 || status === 403 || status === 429 || status >= 500) return true;
  // A 400 counts ONLY when it's the credit-balance/billing case, never a
  // content-policy or malformed-payload 400.
  return status === 400 && isCreditBalanceError(e);
}

// APIConnectionError / APIConnectionTimeoutError (a network failure or a
// hung-then-timed-out request) carry no HTTP status. instanceof is the fast
// path, but it silently breaks when the SDK loads as TWO copies — a CJS/ESM
// dual-package split, which really happens (e.g. a CJS require in one module,
// an ESM import in another) and would reopen the exact "outage not detected"
// gap this guards. So ALSO match the SDK's stable class-name chain, which is
// identical across both builds. Both checks are gated to real Error objects,
// and this only ever runs on an error thrown by the Anthropic client, so a
// same-named foreign class can't reach here.
function isConnectionError(e: unknown): boolean {
  if (e instanceof APIConnectionError) return true;
  if (!(e instanceof Error)) return false;
  for (let p = Object.getPrototypeOf(e); p; p = Object.getPrototypeOf(p)) {
    const name = p.constructor?.name;
    if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") return true;
  }
  return false;
}

// Anthropic's depleted-balance error is a 400 whose response body carries
// "Your credit balance is too low to access the Claude API...". The SDK folds
// that body into the Error's message (APIError.makeMessage JSON-stringifies the
// body when it has no top-level .message), so the phrase reliably appears in
// e.message. Match that distinctive substring — a content 400 never carries it.
function isCreditBalanceError(e: unknown): boolean {
  const msg = (e as { message?: unknown }).message;
  return typeof msg === "string" && /credit balance/i.test(msg);
}
