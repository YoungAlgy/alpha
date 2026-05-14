import crypto from "crypto";

// One-click unsubscribe tokens. Each token encodes the user id + an HMAC over
// it using UNSUBSCRIBE_SECRET, so the URL can be safely embedded in every
// letter email without exposing the user id to forgery.
//
// Format: `${userId}.${hmac}` where hmac = base64url(HMAC-SHA256(secret, userId)).
// Truncated to 16 base64-url bytes (128-bit) — plenty for a never-rotated
// click target on a paid product.

const HMAC_BYTES = 16;

function secret(): string {
  const s = process.env.UNSUBSCRIBE_SECRET?.trim();
  if (!s) {
    throw new Error(
      "UNSUBSCRIBE_SECRET is not set. Required for signing unsubscribe links."
    );
  }
  return s;
}

function hmacFor(userId: string): string {
  return crypto
    .createHmac("sha256", secret())
    .update(userId)
    .digest("base64url")
    .slice(0, HMAC_BYTES);
}

export function makeUnsubscribeToken(userId: string): string {
  return `${userId}.${hmacFor(userId)}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
  if (!token || typeof token !== "string") return null;
  const lastDot = token.lastIndexOf(".");
  if (lastDot < 1) return null;
  const userId = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expected = hmacFor(userId);
  if (sig.length !== expected.length) return null;
  // constant-time compare to avoid timing attacks
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return userId;
}

export function unsubscribeUrl(userId: string, origin: string): string {
  const token = makeUnsubscribeToken(userId);
  return `${origin.replace(/\/$/, "")}/alpha/api/unsubscribe?token=${encodeURIComponent(token)}`;
}
