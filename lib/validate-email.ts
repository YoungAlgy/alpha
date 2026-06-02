// Pragmatic email validation for the funnel's entry points (onboarding email
// step + sign-in). We deliberately do NOT attempt full RFC 5322 — that regex
// is monstrous and still can't prove deliverability. The goal here is narrower
// and higher-value: catch the *typos that silently cost a paying subscriber
// their letter*.
//
// The browser's native type="email" is far too lax for the money path — it
// treats "john@gmail" and "a@b" as VALID (it requires no TLD). Those sail
// straight through onboarding into Stripe as the customer_email, the $5/mo
// subscription succeeds, and every weekly send bounces forever with no signal
// to the reader. This check requires a local part, "@", a domain, a dot, and
// an alphabetic TLD of >=2 chars — rejecting the common real-world mistakes
// (missing ".com", trailing space, double "@", "name@localhost") while
// accepting everything a normal subscriber would actually type
// (sub.domains, .co.uk, .io, long TLDs, +tags).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

export function isValidEmail(value: string): boolean {
  const v = value.trim();
  // "a@b.co" (6) is the shortest sane address; RFC 5321 caps total length at 254.
  if (v.length < 6 || v.length > 254) return false;
  return EMAIL_RE.test(v);
}

/**
 * Returns a friendly, human error message if the address looks like a typo,
 * or null if it looks deliverable. Shaped as a `validate` callback for
 * QuestionStep so the reader fixes it inline — on the email screen, before
 * they pick topics and reach payment — instead of hitting a cryptic Stripe
 * error several steps later (or worse, paying and never getting a letter).
 */
export function emailError(value: string): string | null {
  const v = value.trim();
  if (!v) return "Enter your email so we know where to send the letter.";
  if (!isValidEmail(v))
    return "That doesn't look quite right — check for a typo (a missing \".com\", an extra space).";
  return null;
}
