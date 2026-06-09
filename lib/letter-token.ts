import crypto from "crypto";

// Signed "view my letter" tokens for the weekly email CTA — the standard
// newsletter view-in-browser pattern. The email's "Read the full letter" link
// used to point at /inbox, which needs a Supabase session; on any device where
// the reader wasn't signed in it dead-ended at "No letter yet" (a real
// subscriber hit this). A letter token lets the email link open the letter
// directly: no session, multi-click safe, works when forwarded to yourself on
// another device.
//
// Format: `${userId}.${expEpochSecs}.${sig}` where
//   sig = base64url(HMAC-SHA256(secret, `letter:${userId}.${expEpochSecs}`))
// The "letter:" prefix domain-separates these from unsubscribe tokens (which
// HMAC the bare userId with the same secret) so neither can be replayed as
// the other. Scope is read-only letter viewing — no settings, no billing, no
// session. Reuses UNSUBSCRIBE_SECRET so no new env var is needed (it's
// already required by every letter send for the unsubscribe header).

const HMAC_BYTES = 16;
const DEFAULT_TTL_DAYS = 90;

function secret(): string {
  const s = process.env.UNSUBSCRIBE_SECRET?.trim();
  if (!s) {
    throw new Error("UNSUBSCRIBE_SECRET is not set. Required for signing letter links.");
  }
  return s;
}

function sigFor(userId: string, exp: number): string {
  return crypto
    .createHmac("sha256", secret())
    .update(`letter:${userId}.${exp}`)
    .digest("base64url")
    .slice(0, HMAC_BYTES);
}

export function makeLetterToken(userId: string, ttlDays: number = DEFAULT_TTL_DAYS): string {
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  return `${userId}.${exp}.${sigFor(userId, exp)}`;
}

/** Returns the userId if the token is authentic and unexpired, else null. */
export function verifyLetterToken(token: string): string | null {
  if (!token || typeof token !== "string" || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!userId || !Number.isInteger(exp) || !sig) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null; // expired
  let expected: string;
  try {
    expected = sigFor(userId, exp);
  } catch {
    // Secret not configured — fail closed to the friendly sign-in state
    // rather than a 500.
    return null;
  }
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return userId;
}

export function letterUrl(userId: string, origin: string): string {
  const token = makeLetterToken(userId);
  return `${origin.replace(/\/$/, "")}/alpha/letter?t=${encodeURIComponent(token)}`;
}
