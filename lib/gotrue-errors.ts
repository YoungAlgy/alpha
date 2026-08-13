// A GoTrue admin "user not found" error, in whatever shape the SDK happens to
// surface it (status 404, or a code/message naming the condition) -- checked
// defensively rather than pinned to one exact shape since this isn't
// documented as a stable contract.
//
// Pulled out of app/api/account/delete/route.ts (round 17 finding #2,
// 2026-08-07) so app/api/admin/users/route.ts's identical deleteUser call
// site could reuse the same not-found-is-success treatment instead of
// carrying an independent copy that could silently drift, or -- what
// actually happened until this fix -- never getting it at all.
export function isUserNotFoundError(e: { status?: unknown; code?: unknown; message?: unknown }): boolean {
  if (e.status === 404) return true;
  const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return code.includes("not_found") || message.includes("not found") || message.includes("not_found");
}
