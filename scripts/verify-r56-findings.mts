// Verify round 56 findings: 5 raised, all 5 auto-confirmed by the panel (a
// clean, uncontested round -- no personal overturns needed this time).
// - components/ThemeApplier.tsx (self-audit-r55): round 55's live-edit-
//   wins-over-hydrate fix only covered a same-tab pick (setTheme() arming
//   the shared module flag before its own writes). Its cross-tab
//   `storage`-event handler applied a theme change from another tab
//   without arming that same flag, so a tab whose own signed-in hydrate
//   SELECT was still in flight could have the cross-tab-applied theme
//   silently reverted once that SELECT resolved -- and since the hydrate
//   effect only runs once ([] deps), the revert stuck until a hard reload.
// - components/EmailChanger.tsx + app/settings/page.tsx (accessibility-
//   resweep-newer-code-r4): two single-purpose, action-failure-only text
//   nodes (EmailChanger's err, settings' resumeErr) used role="status"
//   instead of the app's established role="alert" convention for this
//   exact shape (7-8 other sites already use role="alert") -- both twins
//   of round 24's own --accent-ink sweep, which fixed their color but
//   never touched their (also-wrong) role.
// - app/signin/page.tsx (duplicate-code-audit-r6): the page's own mount-
//   time getSession()-then-router.replace("/inbox") effect had no
//   cancellation guard, unlike its 3 siblings (QuestionStep round 48,
//   you/welcome round 55) which all got one for the identical shape. The
//   file already declares cancelledRef for sendCode/verifyCode -- just
//   never wired into this 3rd effect.
// - components/ThemeApplier.tsx (silent-catch-audit-r2): the email-mirror
//   self-heal fetch (the app's SOLE trigger for reconciling a confirmed
//   auth email change back into public.users.email, the address
//   weekly-send actually mails to) had a fully silent catch -- no comment,
//   no log -- unlike every sibling catch in this same file.
// alpha-drift-r56-01 through r56-05, all 2026-08-20.
// Run: npx tsx scripts/verify-r56-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) components/ThemeApplier.tsx: a cross-tab theme change now arms the same flag as an in-tab pick");
{
  const src = readFileSync(new URL("../components/ThemeApplier.tsx", import.meta.url), "utf8");
  check("(1a) markThemeEditedThisLoad is imported alongside themeEditedThisLoad", /import \{ themeEditedThisLoad, markThemeEditedThisLoad \} from "@\/lib\/theme-edit-tracker";/.test(src));
  check("(1b) onStorage calls markThemeEditedThisLoad() before reading/applying the cross-tab theme", /function onStorage\(e: StorageEvent\) \{\s*\n\s*if \(e\.key === ONBOARDING_KEY \|\| e\.key === FALLBACK_KEY\) \{\s*\n\s*markThemeEditedThisLoad\(\);\s*\n\s*const next = readLocalTheme\(\);/.test(src));
}

console.log("(2) components/ThemeApplier.tsx: the email-reconcile fetch's catch is no longer silent");
{
  const src = readFileSync(new URL("../components/ThemeApplier.tsx", import.meta.url), "utf8");
  check("(2a) the reconcile fetch's catch no longer discards the error silently", !/fetch\("\/api\/account\/email\/reconcile", \{ method: "POST" \}\)\.catch\(\(\) => \{\}\);/.test(src));
  check("(2b) it now logs via console.warn", /fetch\("\/api\/account\/email\/reconcile", \{ method: "POST" \}\)\.catch\(\(e\) =>\s*\n\s*console\.warn\("\[ThemeApplier\] email reconcile failed:", e instanceof Error \? e\.message : e\)\s*\n\s*\);/.test(src));
}

console.log("(3) components/EmailChanger.tsx: err is now role=\"alert\", matching the app's action-failure convention");
{
  const src = readFileSync(new URL("../components/EmailChanger.tsx", import.meta.url), "utf8");
  check("(3a) err's <p> is now role=\"alert\"", /\{err && \(\s*\n\s*<p\s*\n(?:[^\n]*\n){0,10}?\s*role="alert"/.test(src));
  check("(3b) the redundant aria-live=\"polite\" is gone from that block", !/role="status"\s*\n\s*aria-live="polite"\s*\n\s*className="alpha-ui text-sm mt-3"\s*\n\s*\/\/ alpha-drift-r24-01/.test(src));
}

console.log("(4) app/settings/page.tsx: resumeErr is now role=\"alert\", matching EmailChanger's twin fix; sibling role=\"status\" sites are untouched");
{
  const src = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(4a) resumeErr's <p> is now role=\"alert\"", /\{resumeErr && \(\s*\n\s*<p\s*\n(?:[^\n]*\n){0,15}?\s*role="alert"/.test(src));
  check("(4b) the resumed-confirmation heading and billingMsg bar are untouched (still role=\"status\")", (src.match(/role="status"/g) || []).length >= 2);
}

console.log("(5) app/signin/page.tsx: the mount-time getSession() effect now reuses cancelledRef");
{
  const src = readFileSync(new URL("../app/signin/page.tsx", import.meta.url), "utf8");
  check("(5a) the effect checks cancelledRef.current right after getSession() resolves, before the session branch", /const \{ data: \{ session \} \} = await sb\.auth\.getSession\(\);\s*\n\s*if \(cancelledRef\.current\) return;\s*\n\s*if \(session\) \{/.test(src));
  check("(5b) sendCode/verifyCode's existing cancelledRef usage is untouched (still 2+ other call sites)", (src.match(/cancelledRef\.current/g) || []).length >= 4);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R56 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R56 FINDINGS ASSERTIONS PASS");
