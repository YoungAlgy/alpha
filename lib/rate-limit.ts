// Tiny in-memory rate limiter for serverless Next.js. Resets on cold start
// (per-instance), which is fine as a casual-abuse deterrent. V1 will swap
// this for a Supabase-backed counter so caps survive deploys.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

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

/** True (and records the key) if this exact key was already seen within
 *  windowMs. Callers should treat a true result as "already handled" and
 *  skip the real side effect (DB write, outbound email) rather than erroring. */
export function isDuplicateSubmission(key: string, windowMs: number): boolean {
  const now = Date.now();
  const seenAt = recentSubmissions.get(key);
  if (seenAt !== undefined && now - seenAt < windowMs) {
    return true;
  }
  recentSubmissions.set(key, now);
  return false;
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
