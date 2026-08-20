// Verify round 43 findings: 2 confirmed, 4 refuted (out of 6 raw findings
// across 5 dimensions -- webhook-signature-completeness found nothing at
// all, a strong signal that surface is solid).
// - app/auth/callback/page.tsx + lib/gotrue-errors.ts: round 42's fix
//   routed the callback's caught error through isInvalidOrExpiredOtpError,
//   built for verifyOtp's error shape -- but this page only ever calls
//   exchangeCodeForSession (PKCE), whose real error shapes never matched,
//   so the friendly copy silently never fired. Traced against
//   @supabase/auth-js's own source and added a PKCE-aware classifier.
// - app/inbox/page.tsx: the main /inbox page had the SAME query-failure-
//   vs-not-found conflation round 42 fixed on its sibling
//   /inbox/[issueId]/page.tsx, on the app's most-visited page. Required a
//   real refactor (extracted load() as a retryable callback, added a
//   sessionEstablished local flag so the catch block only surfaces
//   loadError once a real session was confirmed, not for a genuinely
//   signed-out visitor whose getSession() call itself failed) -- and while
//   implementing, caught and corrected a self-introduced regression before
//   shipping: an early draft treated `!data` (a legitimate "no issue
//   generated yet" empty state) as an error too, which would have broken
//   the normal experience for a brand-new signed-in subscriber.
// 4 refuted, all genuinely adjudicated: a checkout-page signed-in-redirect
// guard (a real UX inconsistency but no double-charge risk, since the
// server-side 409 guard already catches it), /inbox/[issueId]'s dynamic
// (not static) rendering, and two CSP/security-header staleness claims
// (hardcoded PostHog host, a possibly-stale cloudflareinsights.com
// allowance) were all refuted 3/3.
// alpha-drift-r43-01, r43-02, both 2026-08-19.
// Run: npx tsx scripts/verify-r43-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) lib/gotrue-errors.ts + app/auth/callback/page.tsx: PKCE callback failures now get the friendly copy, not just OTP failures");
{
  const gotrueSrc = readFileSync(new URL("../lib/gotrue-errors.ts", import.meta.url), "utf8");
  check("(1a) isInvalidOrExpiredPkceError is exported", /export function isInvalidOrExpiredPkceError\(/.test(gotrueSrc));
  check("(1b) it checks all 4 real GoTrue PKCE error codes", /pkce_code_verifier_not_found/.test(gotrueSrc) && /flow_state_not_found/.test(gotrueSrc) && /flow_state_expired/.test(gotrueSrc) && /bad_code_verifier/.test(gotrueSrc));

  const callbackSrc = readFileSync(new URL("../app/auth/callback/page.tsx", import.meta.url), "utf8");
  check("(1c) callback page imports the new classifier alongside the old OTP one", /import \{ isInvalidOrExpiredOtpError, isInvalidOrExpiredPkceError \} from "@\/lib\/gotrue-errors";/.test(callbackSrc));
  check("(1d) both classifiers are OR'd together in the friendly-copy condition", /isInvalidOrExpiredOtpError\(shape\) \|\| isInvalidOrExpiredPkceError\(shape\)/.test(callbackSrc));

  // Behavioral proof against the REAL exported classifier and the REAL
  // @supabase/auth-js error class -- not a reimplementation or a
  // hand-typed fixture. This is exactly what round 42's own verify script
  // was missing (it only checked the classifier was CALLED, never that it
  // returns true for any real error) -- the gap this round's finding
  // exists to close.
  const { isInvalidOrExpiredOtpError, isInvalidOrExpiredPkceError } = await import("../lib/gotrue-errors.ts");
  const { AuthPKCECodeVerifierMissingError } = await import("@supabase/auth-js");
  const codeVerifierMissing = new AuthPKCECodeVerifierMissingError();
  check("(1e) behavioral: the REAL AuthPKCECodeVerifierMissingError (different-browser case) now classifies as PKCE-invalid", isInvalidOrExpiredPkceError(codeVerifierMissing));
  check("(1f) behavioral: that same real error does NOT match the OTP classifier (confirms the r42 gap was real)", !isInvalidOrExpiredOtpError(codeVerifierMissing));

  const serverShapes = [
    { code: "flow_state_not_found", message: "Invalid flow state, no valid flow state found." },
    { code: "flow_state_expired", message: "Flow state expired." },
    { code: "bad_code_verifier", message: "code challenge does not match previously saved code verifier" },
  ];
  check("(1g) behavioral: all 3 server-returned PKCE error codes classify correctly", serverShapes.every((s) => isInvalidOrExpiredPkceError(s)));
  check("(1h) behavioral: no regression on the original OTP shape (verifyOtp's error) still classifying correctly", isInvalidOrExpiredOtpError({ message: "Token has expired or is invalid." }));
}

console.log("(2) app/inbox/page.tsx: a genuine query failure is now distinguished from a real not-found, matching the sibling fix");
{
  const src = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  check("(2a) a new loadError state exists", /const \[loadError, setLoadError\] = useState\(false\);/.test(src));
  check("(2b) the issues-query error branch sets loadError, separate from the zero-row case", /if \(error\) \{\s*\n\s*setLoadError\(true\);\s*\n\s*return;\s*\n\s*\}/.test(src));
  check("(2c) a genuine zero-row result (no error, no data) is explicitly left to fall through, NOT treated as an error", /if \(data\) \{/.test(src) && !/if \(error \|\| !data\)/.test(src));
  check("(2d) the catch block distinguishes a signed-in failure from a genuinely-signed-out one via a local flag", /let sessionEstablished = false;/.test(src) && /if \(sessionEstablished\) \{/.test(src));
  check("(2e) a distinct loadError UI block exists with a Try again button", /Couldn&apos;t load your letters\./.test(src) && /onClick=\{\(\) => load\(\)\}/.test(src));
  check("(2f) the original signed-in-but-no-letter-yet copy is untouched (still correct for the genuine empty state)", /You&apos;re signed in\. Your letters show up here once they&apos;re/.test(src));
  check("(2g) the finally block still unconditionally marks checked, even after an early return from any branch", /if \(mountedRef\.current\) setChecked\(true\);\s*\n\s*\}\s*\n\s*\}, \[state\.theme\]\);/.test(src));
  check("(2h) the retry-triggering effect depends on the stable load callback, not a raw theme dependency (no unintended re-fetch loop)", /}, \[loaded, load\]\);/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R43 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R43 FINDINGS ASSERTIONS PASS");
