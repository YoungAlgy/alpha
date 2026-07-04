import crypto from "crypto";

// Signed "view my letter" tokens for the weekly email CTA — the standard
// newsletter view-in-browser pattern. The email's "Read the full letter" link
// used to point at /inbox, which needs a Supabase session; on any device where
// the reader wasn't signed in it dead-ended at "No letter yet" (a real
// subscriber hit this). A letter token lets the email link open the letter
// directly: no session, multi-click safe, works when forwarded to yourself on
// another device.
//
// Format (v2): `${userId}.${weekOf}.${expEpochSecs}.${sig}` where
//   sig = base64url(HMAC-SHA256(secret, `letter:${userId}.${weekOf}.${expEpochSecs}`))
// weekOf pins the token to ONE issue. THE BUG THIS FIXES (real subscriber
// report, 2026-07-03): v1 tokens carried only the userId and the /letter page
// loaded the reader's LATEST issue — so every "Read the full letter" link in
// every email she'd ever received opened the same (newest) letter, and her
// letters looked "exactly the same" no matter which email she clicked.
//
// v1 tokens (`${userId}.${exp}.${sig}`, no weekOf) remain VALID — they're
// baked into already-sent emails with a 90-day TTL. They verify against the
// v1 signing string and resolve weekOf=null (the page falls back to latest,
// which is the old behavior and the best available for a legacy link).
//
// The "letter:" prefix domain-separates these from unsubscribe tokens (which
// HMAC the bare userId with the same secret) so neither can be replayed as
// the other. Scope is read-only letter viewing — no settings, no billing, no
// session. Reuses UNSUBSCRIBE_SECRET so no new env var is needed.

const HMAC_BYTES = 16;
const DEFAULT_TTL_DAYS = 90;
const WEEK_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

function secret(): string {
  const s = process.env.UNSUBSCRIBE_SECRET?.trim();
  if (!s) {
    throw new Error("UNSUBSCRIBE_SECRET is not set. Required for signing letter links.");
  }
  return s;
}

function sigV1(userId: string, exp: number): string {
  return crypto
    .createHmac("sha256", secret())
    .update(`letter:${userId}.${exp}`)
    .digest("base64url")
    .slice(0, HMAC_BYTES);
}

function sigV2(userId: string, weekOf: string, exp: number): string {
  return crypto
    .createHmac("sha256", secret())
    .update(`letter:${userId}.${weekOf}.${exp}`)
    .digest("base64url")
    .slice(0, HMAC_BYTES);
}

export function makeLetterToken(
  userId: string,
  weekOf: string,
  ttlDays: number = DEFAULT_TTL_DAYS
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  return `${userId}.${weekOf}.${exp}.${sigV2(userId, weekOf, exp)}`;
}

export interface LetterTokenPayload {
  userId: string;
  /** The issue this link is for; null on a legacy v1 token (page shows latest). */
  weekOf: string | null;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** Returns the payload if the token is authentic and unexpired, else null. */
export function verifyLetterToken(token: string): LetterTokenPayload | null {
  if (!token || typeof token !== "string" || token.length > 220) return null;
  const parts = token.split(".");
  try {
    if (parts.length === 4) {
      // v2: userId.weekOf.exp.sig
      const [userId, weekOf, expStr, sig] = parts;
      const exp = Number(expStr);
      if (!userId || !WEEK_OF_RE.test(weekOf) || !Number.isInteger(exp) || !sig) return null;
      if (exp < Math.floor(Date.now() / 1000)) return null; // expired
      if (!safeEqual(sig, sigV2(userId, weekOf, exp))) return null;
      return { userId, weekOf };
    }
    if (parts.length === 3) {
      // v1 (legacy, already in sent emails): userId.exp.sig
      const [userId, expStr, sig] = parts;
      const exp = Number(expStr);
      if (!userId || !Number.isInteger(exp) || !sig) return null;
      if (exp < Math.floor(Date.now() / 1000)) return null; // expired
      if (!safeEqual(sig, sigV1(userId, exp))) return null;
      return { userId, weekOf: null };
    }
    return null;
  } catch {
    // Secret not configured — fail closed to the friendly sign-in state
    // rather than a 500.
    return null;
  }
}

export function letterUrl(userId: string, origin: string, weekOf: string): string {
  const token = makeLetterToken(userId, weekOf);
  return `${origin.replace(/\/$/, "")}/letter?t=${encodeURIComponent(token)}`;
}
