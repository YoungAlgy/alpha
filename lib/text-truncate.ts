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
