// Verify round 45 findings: 4 confirmed, 7 refuted (out of 11 raw findings
// across 5 dimensions -- self-audit-r44 found nothing at all, a reassuring
// signal that round 44's fixes shipped clean).
// - components/EmailChanger.tsx: the Cancel button had no busy guard,
//   unlike the Send confirmation button right next to it -- a reader
//   canceling while updateUser() was still in flight could get the
//   confirmation panel silently reopened (and focus stolen) by the earlier
//   call's late success, well after they believed they'd backed out.
// - app/api/admin/users/route.ts: grant_free discarded
//   removeResendSuppression()'s return value entirely, unlike its sibling
//   clear_suppression a few dozen lines below -- worse here specifically,
//   since grant_free's own DB write already zeroes bounced_at/complained_at
//   unconditionally, so a Resend-side failure would leave the admin UI's
//   own SUPPRESSED badge permanently dark with no path left to notice or
//   repair it.
// - app/topics/page.tsx: a failed save's error message was never cleared
//   by any of the mutating actions a reader would naturally take to try to
//   fix it (toggle/removeAt/move/addCustom), so the sticky status bar kept
//   showing a stale failure instead of live pick-count progress.
// - app/settings/accounts/page.tsx: a page-level load error (e.g. "Sign in
//   first.") was never cleared by a subsequent successful load, so a
//   transient auth-cookie-hydration 401 on mount could leave a permanently
//   stuck error banner sitting above a fully correct, freshly-loaded user
//   list.
// 7 refuted, all genuinely adjudicated: a failed-account-deletion local-
// state-clearing claim, an admin sr-only-success/blocking-alert()
// inconsistency claim, two "document the deliberate no-rate-limit
// decision" proposals for the Stripe/Resend webhooks, a ProfileEditor
// required-field-indicator gap, and two "clear the error on edit" gaps
// (signin page, support form) were all refuted 3/3 (or 2/3 for the
// deletion claim).
// alpha-drift-r45-01 through r45-04, all 2026-08-19.
// Run: npx tsx scripts/verify-r45-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) components/EmailChanger.tsx: Cancel is now disabled during the in-flight submit(), matching Send confirmation");
{
  const src = readFileSync(new URL("../components/EmailChanger.tsx", import.meta.url), "utf8");
  check("(1a) the Cancel button now has disabled={busy}", /disabled=\{busy\}\s*\n\s*onClick=\{\(\) => \{\s*\n\s*setEditing\(false\);/.test(src));
  check("(1b) it also dims to match the Send confirmation button's busy styling", /style=\{\{ color: "var\(--ink-soft\)", opacity: busy \? 0\.5 : 1 \}\}/.test(src));
}

console.log("(2) app/api/admin/users/route.ts: grant_free now reports a Resend suppression-removal failure instead of silently discarding it");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  check("(2a) removeResendSuppression's return value is now captured", /const cleared = await removeResendSuppression\(existing\.email\);/.test(src));
  check("(2b) a false result returns a 502 with a real error message, not {ok:true}", /if \(!cleared\) \{\s*\n\s*console\.error\(`\[admin\/users\] grant_free: removeResendSuppression failed/.test(src) && /status: 502/.test(src));
  check("(2c) the old unconditional await-and-discard is gone", !/await removeResendSuppression\(existing\.email\);\s*\n\s*\}\s*\n\s*return NextResponse\.json\(\{ ok: true \}\);/.test(src));

  // Sanity: the sibling clear_suppression pattern this fix mirrors is
  // unchanged.
  check("(2d) sanity: clear_suppression's own established error-reporting pattern is untouched", /Couldn't clear the Resend suppression\. Left the DB flags untouched/.test(src));
}

console.log("(3) app/topics/page.tsx: a failed save's error is now cleared by every action a reader would take to fix it");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
  // alpha-drift-r54-02 (2026-08-20) prepended `userEditedRef.current = true;`
  // as the literal first statement in toggle()/removeAt()/move() -- these
  // regexes loosened to allow that new line before the saveError clear,
  // same relative order otherwise.
  check("(3a) toggle() clears saveError", /function toggle\(id: TopicId\) \{\s*\n(?:\s*userEditedRef\.current = true;\s*\n)?\s*if \(saveError\) setSaveError\(null\);/.test(src));
  check("(3b) removeAt() clears saveError", /function removeAt\(id: TopicId\) \{\s*\n(?:\s*userEditedRef\.current = true;\s*\n)?\s*if \(saveError\) setSaveError\(null\);/.test(src));
  check("(3c) move() clears saveError", /if \(to < 0 \|\| to >= picked\.length\) return;\s*\n(?:\s*userEditedRef\.current = true;\s*\n)?\s*if \(saveError\) setSaveError\(null\);/.test(src));
  check("(3d) addCustom()'s success path clears saveError", /setCustomText\(""\);\s*\n\s*setCustomErr\(null\);\s*\n\s*if \(saveError\) setSaveError\(null\);/.test(src));
}

console.log("(4) app/settings/accounts/page.tsx: a page-level load error is now cleared at the start of every new load() attempt");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(4a) load() now clears err before starting a new fetch", /async function load\(opts\?: \{ search\?: string; before\?: string; append\?: boolean \}\) \{[\s\S]{0,700}if \(err\) setErr\(null\);/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R45 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R45 FINDINGS ASSERTIONS PASS");
