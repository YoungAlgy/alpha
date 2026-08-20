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

// alpha-drift-r35-02 (2026-08-14): a wrong/expired 6-digit sign-in code is
// GoTrue's OWN raw wording ("Token has expired or is invalid.") reaching a
// subscriber verbatim -- app/signin/page.tsx's `e instanceof Error ?
// e.message : "friendly fallback"` never actually falls back, since every
// real Supabase auth error IS an Error instance. Checked defensively (code
// substring OR the token+expired/invalid message shape) rather than pinned
// to GoTrue's exact current code string, matching isUserNotFoundError's own
// reasoning above -- this isn't a documented stable contract either.
export function isInvalidOrExpiredOtpError(e: { status?: unknown; code?: unknown; message?: unknown }): boolean {
  const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return code.includes("otp") || (message.includes("token") && (message.includes("expired") || message.includes("invalid")));
}

// alpha-drift-r35-02: same problem, for a rate-limited OTP resend ("For
// security purposes, you can only request this after N seconds.").
export function isAuthRateLimitError(e: { status?: unknown; code?: unknown; message?: unknown }): boolean {
  if (e.status === 429) return true;
  const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return code.includes("rate_limit") || message.includes("security purposes");
}

// alpha-drift-r43-01 (2026-08-19, self-audit): app/auth/callback/page.tsx's
// round-42 fix reused isInvalidOrExpiredOtpError above to classify a failed
// exchangeCodeForSession() (the PKCE magic-link callback), but that
// classifier's shape was built for verifyOtp's 6-digit-code error, not
// PKCE. Verified against @supabase/auth-js's own source
// (node_modules/@supabase/auth-js/src/lib/errors.ts,
// lib/error-codes.ts): a code-verifier missing from storage (opening the
// link in a different browser/device than it was requested in) throws
// client-side with code "pkce_code_verifier_not_found" and a message that
// never contains "token"; an expired/already-used link comes back from the
// server as one of GoTrue's own PKCE-specific codes
// ("flow_state_not_found", "flow_state_expired", "bad_code_verifier") --
// none of which contain "otp" either. isInvalidOrExpiredOtpError returns
// false for all four real shapes, so the friendly copy it was meant to
// gate never actually fired -- every PKCE callback failure fell through to
// the generic fallback instead. Checked defensively by code substring
// only, same reasoning as the other classifiers in this file (not pinned
// to GoTrue's exact current code strings, since this isn't a documented
// stable contract).
export function isInvalidOrExpiredPkceError(e: { status?: unknown; code?: unknown; message?: unknown }): boolean {
  const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
  return (
    code.includes("pkce_code_verifier_not_found") ||
    code.includes("flow_state_not_found") ||
    code.includes("flow_state_expired") ||
    code.includes("bad_code_verifier")
  );
}
