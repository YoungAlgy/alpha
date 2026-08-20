// Verify round 47 findings: 6 confirmed (2 of which were independent reports
// of the SAME bug, so 5 distinct fixes), 6 refuted (out of 12 raw findings
// across 5 dimensions -- 0 UNVERIFIED, automated verify stage worked cleanly).
// - app/checkout/page.tsx: self-audit-r46 AND stale-closure-sweep-round-2
//   independently found the exact same bug -- round 46's own cancelledRef
//   fix (added in the SAME commit set that fixed the identically-shaped
//   mountedRef bug in app/settings/accounts/page.tsx) was itself written as
//   a cleanup-only effect, never resetting to false on mount. Under React
//   Strict Mode dev this permanently broke the checkout funnel's primary
//   CTA -- a genuine self-inflicted regression, caught the same round it
//   shipped. Now resets in the effect body on mount, matching the pattern
//   it was supposed to follow the first time.
// - app/signin/page.tsx: sendCode()/verifyCode() had zero cancellation
//   guard, the one page in the funnel with async-then-navigate flows and no
//   guard at all. A late resend/verify success could snap a reader back to
//   the code step or redirect them to /inbox after they'd already navigated
//   away via the Wordmark or "Start fresh" links.
// - app/topics/page.tsx: submit()'s signed-in save had no cancellation
//   guard, and StepShell's Back button wasn't disabled during it (unlike
//   checkout, fixed round 46) -- same race class, on the one other
//   onboarding-funnel page that does a real network write before
//   navigating.
// - app/settings/accounts/page.tsx: the search input, Search button, and
//   Clear button had no busy guard against act()'s own always-runs
//   finally-block reload (round 46's alpha-drift-r46-01) -- an admin acting
//   on one row while concurrently searching/clearing could end up with
//   whichever HTTP response landed last silently winning, regardless of
//   which was issued more recently.
// - lib/engine/gemini-client.ts: the file's header comment (and two related
//   sub-claims) still said Gemini is "never the primary path" -- the exact
//   stale-primary-vs-fallback claim round 46 already fixed in 3 other
//   places (health check, README Stack table, README directory listing),
//   but missed the actual client those descriptions point at.
// 6 refuted, all genuinely adjudicated: a claimed silent-Stripe-cleanup-skip
// on account/delete's rowErr fallback (the "silent" claim was factually
// wrong -- it's already logged, and the proposed fix would change zero
// observable behavior), a load()-err-clear-missing-mountedRef-guard
// consistency nit (harmless no-op under React 19), a Delete-account-handler
// cancellation-guard proposal on settings/page.tsx (the server-side delete
// already completed regardless of client mount state), a startedRef-never-
// resets claim on app/writing/page.tsx (structurally similar to the real
// checkout bug but adjudicated as not reproducing the same way), and two
// silent-catch-audit findings (archive/page.tsx's unlogged catch, settings/
// page.tsx's bare "// ignore" catch) both refuted on balance-of-severity
// grounds.
// alpha-drift-r47-01 through r47-05, all 2026-08-20.
// Run: npx tsx scripts/verify-r47-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/checkout/page.tsx: cancelledRef now resets to false on mount, closing the Strict Mode regression");
{
  const src = readFileSync(new URL("../app/checkout/page.tsx", import.meta.url), "utf8");
  check("(1a) the effect body now resets cancelledRef to false before returning its cleanup", /useEffect\(\(\) => \{\s*\n\s*cancelledRef\.current = false;\s*\n\s*return \(\) => \{ cancelledRef\.current = true; \};\s*\n\s*\}, \[\]\);/.test(src));
  check("(1b) it's no longer the cleanup-only shape", !/useEffect\(\(\) => \(\) => \{ cancelledRef\.current = true; \}, \[\]\);/.test(src));
}

console.log("(2) app/signin/page.tsx: sendCode()/verifyCode() now have a cancellation guard");
{
  const src = readFileSync(new URL("../app/signin/page.tsx", import.meta.url), "utf8");
  check("(2a) cancelledRef is declared and reset on mount", /const cancelledRef = useRef\(false\);\s*\n\s*useEffect\(\(\) => \{\s*\n\s*cancelledRef\.current = false;\s*\n\s*return \(\) => \{ cancelledRef\.current = true; \};\s*\n\s*\}, \[\]\);/.test(src));
  check("(2b) sendCode checks it right after signInWithOtp resolves, before the setStep/setCooldown block", /sb\.auth\.signInWithOtp\([\s\S]{0,600}?if \(cancelledRef\.current\) return;\s*\n\s*if \(error\) throw error;/.test(src));
  check("(2c) verifyCode checks it right after verifyOtp resolves, before router.push", /sb\.auth\.verifyOtp\([\s\S]{0,600}?if \(cancelledRef\.current\) return;\s*\n\s*if \(error\) throw error;\s*\n\s*audioConfirm\(\);\s*\n\s*router\.push\("\/inbox" as never\);/.test(src));
}

console.log("(3) app/topics/page.tsx: submit()'s signed-in save now has a cancellation guard, and StepShell's Back disables during it");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
  check("(3a) cancelledRef is declared and reset on mount", /const cancelledRef = useRef\(false\);\s*\n\s*useEffect\(\(\) => \{\s*\n\s*cancelledRef\.current = false;\s*\n\s*return \(\) => \{ cancelledRef\.current = true; \};\s*\n\s*\}, \[\]\);/.test(src));
  check("(3b) it's checked before confirm()/update()/router.push on the save-success path", /if \(cancelledRef\.current\) return;\s*\n\s*confirm\(\);\s*\n\s*update\(\{ topics: picked \}\);\s*\n\s*router\.push\("\/settings" as never\);/.test(src));
  check("(3c) StepShell now receives backDisabled tied to saving", /<StepShell stepIndex=\{7\} prevPath=\{signedIn \? "settings" : "focus"\} backDisabled=\{saving\}>/.test(src));
}

console.log("(4) app/settings/accounts/page.tsx: search/clear controls now disable during any in-flight admin action");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(4a) runSearch bails early while busy", /function runSearch\(e: React\.FormEvent\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*if \(busy !== null\) return;/.test(src));
  check("(4b) clearSearch bails early while busy", /function clearSearch\(\) \{\s*\n\s*if \(busy !== null\) return;/.test(src));
  check("(4c) the search input is disabled while busy", /aria-label="Search by email"\s*\n\s*disabled=\{busy !== null\}/.test(src));
  check("(4d) the Search submit button is disabled while busy", /type="submit"\s*\n\s*disabled=\{busy !== null\}/.test(src));
  check("(4e) the Clear button is disabled while busy", /type="button"\s*\n\s*disabled=\{busy !== null\}\s*\n\s*onClick=\{clearSearch\}/.test(src));
}

console.log("(5) lib/engine/gemini-client.ts: header comment and related sub-claims no longer describe Gemini as fallback-only");
{
  const src = readFileSync(new URL("../lib/engine/gemini-client.ts", import.meta.url), "utf8");
  check("(5a) the header no longer claims Gemini is used ONLY as a fallback / never primary", !/used ONLY as a fallback in two narrow roles/.test(src) && !/never\s*\n\/\/ the primary path/.test(src));
  check("(5b) it now states the PRIMARY generation tier role for topic blurbs", /PRIMARY generation tier for topic blurbs/.test(src));
  check("(5c) callGemini's comment no longer blankly says callers are a fallback off a primary provider", !/callers are themselves a fallback\s*\n\/\/ path off a primary provider, so a slow Gemini call/.test(src));
  check("(5d) geminiGenerateText's comment no longer says Anthropic itself unavailable is the trigger for every caller", !/used for the topic-blurb \/ editor-note WRITING\s*\n\/\/ fallback — Anthropic itself unavailable/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R47 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R47 FINDINGS ASSERTIONS PASS");
