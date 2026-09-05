// Tiny per-isolate fast limiter for serverless Next.js. It resets on cold
// start and never represents a global ceiling across Cloudflare isolates.
// Cost- or abuse-sensitive public paths pair this first layer with the
// Supabase-backed limiter in lib/distributed-rate-limit.ts. Generate, access
// requests, support, and quantity updates already use that durable layer.
// Other callers use this Map only as a cheap local brake and must not describe
// its result as a globally enforced quota.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// alpha-drift-r18-01 (found+fixed 2026-08-07): neither Map in this file ever
// evicted an expired entry -- a key that's rate-limited once (every distinct
// IP, every distinct authenticated user id) stayed in memory for the entire
// life of the warm isolate, growing without bound. Opportunistic, not a
// timer: Workers isolates are ephemeral and get evicted/respawned on their
// own schedule (this file's own top comment: "resets on cold start"), so a
// setInterval sweep could easily never fire before the isolate recycles
// anyway. Sweeping only once the map has actually grown past a threshold
// keeps the common case (a handful of active keys) at zero added cost, while
// bounding worst-case growth during a busy stretch to roughly this
// threshold plus whatever's genuinely still active.
const BUCKET_SWEEP_THRESHOLD = 1000;
function sweepBuckets(now: number) {
  for (const [key, b] of buckets) {
    if (b.resetAt < now) buckets.delete(key);
  }
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function rateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions
): RateLimitResult {
  if (limit <= 0) {
    return { ok: false, remaining: 0, retryAfterSec: Math.ceil(windowMs / 1000) };
  }
  const now = Date.now();
  if (buckets.size > BUCKET_SWEEP_THRESHOLD) sweepBuckets(now);
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSec: 0 };
  }
  if (b.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.ceil((b.resetAt - now) / 1000),
    };
  }
  b.count++;
  return { ok: true, remaining: limit - b.count, retryAfterSec: 0 };
}

// Separate from rateLimit() above on purpose: that counts VOLUME (how many
// requests in a window), this catches IDENTICAL requests (the same payload
// twice) -- a rapid double-click or a double-submit before a render commits
// disables the button, which volume-only rate limiting doesn't defend
// against at all (both requests are well under any reasonable per-hour cap).
// Same Map-based, per-instance, resets-on-cold-start tradeoffs as buckets
// above -- fine for a casual-double-click deterrent, not a durable guarantee.
const recentSubmissions = new Map<string, number>();

// Each entry stores only a timestamp. The support route passes a bounded hash
// of the normalized submission, so raw email or message text never becomes a
// Map key. Since the selected window is not stored beside the timestamp,
// eviction uses a ceiling that safely outlives the current 60-second duplicate
// window.
const SUBMISSION_SWEEP_THRESHOLD = 1000;
const SUBMISSION_MAX_AGE_MS = 60 * 60 * 1000;
function sweepSubmissions(now: number) {
  for (const [key, seenAt] of recentSubmissions) {
    if (now - seenAt > SUBMISSION_MAX_AGE_MS) recentSubmissions.delete(key);
  }
}

/** True (and records the key) if this exact key was already seen within
 *  windowMs. Callers should treat a true result as "already handled" and
 *  skip the real side effect (DB write, outbound email) rather than erroring. */
export function isDuplicateSubmission(key: string, windowMs: number): boolean {
  const now = Date.now();
  if (recentSubmissions.size > SUBMISSION_SWEEP_THRESHOLD) sweepSubmissions(now);
  const seenAt = recentSubmissions.get(key);
  if (seenAt !== undefined && now - seenAt < windowMs) {
    return true;
  }
  recentSubmissions.set(key, now);
  return false;
}

// Exposed only for scripts/verify-rate-limit.mts. Eviction is deliberately
// behavior-neutral (rateLimit/isDuplicateSubmission treat a present-but-
// expired entry identically to a missing one either way), so there's no
// black-box way to prove a sweep actually freed memory without this --
// asserting on the two Maps' sizes directly is the only way to distinguish
// "evicted" from "silently still leaked."
export function _debugMapSizes() {
  return { buckets: buckets.size, recentSubmissions: recentSubmissions.size };
}

export function clientKeyFromRequest(req: Request): string {
  // cf-connecting-ip is set by Cloudflare's edge itself (the app runs as a
  // Cloudflare Worker) and can't be spoofed by the caller. x-forwarded-for is
  // NOT safe here: Cloudflare APPENDS the real IP to whatever chain the client
  // sent rather than replacing it, so req.headers.get("x-forwarded-for") on
  // this host returns attacker-controlled input if read first -- a caller
  // sending a fresh random value on every request gets a fresh rate-limit
  // bucket every time, defeating every limit(...) call in the app. (This was
  // safe back on Vercel, which overwrites x-forwarded-for; it stopped being
  // safe the week alpha moved to Cloudflare Workers.)
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}
