// alpha-drift-r19-01 (found+fixed 2026-08-07): every length cap on
// user-supplied text in this app (app/api/account/profile/route.ts's
// cleanRequired/cleanOptional, lib/engine/editor-note.ts's clamp) used plain
// String.prototype.slice, which cuts by UTF-16 CODE UNIT, not Unicode code
// point. A cut point landing in the middle of a surrogate pair (any emoji
// outside the BMP -- most modern emoji -- or other astral-plane characters,
// exactly the kind of thing people put in a bio/blurb/name) leaves a lone,
// unpaired surrogate: invalid UTF-16 with no valid UTF-8 encoding at all, so
// encodeURIComponent() throws on it and Postgres/PostgREST either corrupts
// the character or fails the write outright -- for a save that looked well
// under the visible character limit to the user. Array.from (and the spread
// operator) iterate a string by code point via the String iterator
// protocol, so slicing through it can't split a pair.
export function codePointSafeSlice(str: string, maxCodePoints: number): string {
  return Array.from(str).slice(0, maxCodePoints).join("");
}

// alpha-drift-r20-08 (found+fixed 2026-08-13): a caller that needs to know
// WHETHER a string was actually cut (to decide whether to append an
// ellipsis) can't safely derive that from `str.length > max` even when the
// slice itself is code-point-safe — .length still counts UTF-16 CODE UNITS,
// so a string with astral-plane characters (surrogate pairs, most modern
// emoji) can have .length > max while its real code-point count is <= max,
// producing a spurious ellipsis on text that was never truncated at all
// (exactly the bug alpha-drift-r19-01 already fixed once, for a plain
// .slice() call — this is the same failure mode one layer up, in the
// truncated-or-not CHECK rather than the cut itself). Deriving both the
// truncated flag and the cut text from the SAME Array.from() pass makes
// them internally consistent by construction — there's no way for one to
// disagree with the other.
export function codePointSafeTruncate(str: string, maxCodePoints: number): { text: string; truncated: boolean } {
  const codePoints = Array.from(str);
  const truncated = codePoints.length > maxCodePoints;
  return { text: truncated ? codePoints.slice(0, maxCodePoints).join("") : str, truncated };
}
