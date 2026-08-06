// Pulled out of app/api/webhooks/resend/route.ts as pure functions so a
// deterministic verify script (scripts/verify-resend-webhook-guards.mts) can
// exercise the one decision this webhook exists to get right: hard bounce
// vs. everything else. An inverted `!==`/`===` here either (a) suppresses on
// every transient blip -- greylisting, a full mailbox, a temporary receiving
// -server hiccup -- silently dropping real subscribers over something that
// would've resolved on its own, or (b) never suppresses a genuine dead
// address, letting it keep dragging down everyday.report's sender
// reputation forever, which is the whole reason this webhook exists.

/** True only for a HARD (Permanent) bounce -- Resend's bounce.type field.
 *  Transient (mailbox full, greylisting, a temporary hiccup) and
 *  Undetermined must NOT suppress; they're expected to self-resolve. */
export function isHardBounce(bounceType: string | undefined): boolean {
  return bounceType === "Permanent";
}

/** Normalizes a webhook event's `data.to` array into a clean, lowercased,
 *  deduped list of recipient addresses to suppress. Defensive against a
 *  malformed payload (non-array, non-string entries, blank strings) --
 *  Resend's own shape is trusted but this is the boundary where an
 *  unexpected payload would otherwise throw or write garbage. */
export function normalizeRecipients(to: unknown): string[] {
  if (!Array.isArray(to)) return [];
  const cleaned = to
    .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
    .map((e) => e.toLowerCase().trim());
  return Array.from(new Set(cleaned));
}
