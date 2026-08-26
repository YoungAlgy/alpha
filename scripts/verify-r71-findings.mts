// Verify round 71 findings: 8 raised, 1 confirmed, 7 refuted.
// - scripts/smoke-test-deploy.mjs (duplicate-code-audit-r20, filed MEDIUM,
//   shipped at LOW per unanimous severity correction, 3/3 CONFIRM): its
//   SOFT resilience-tier list was missing "brave", unlike app/api/health/
//   route.ts's own checks object, scripts/verify-send-preflight.mjs's
//   SOFT_RESILIENCE_TIER, and .github/workflows/letter-watchdog.yml, all of
//   which include it -- a broken/missing BRAVE_SEARCH_API_KEY produced
//   zero warning on this app's own post-deploy CI gate. This script is the
//   literal last step of every real `npm run cf:deploy`, so it's not dead
//   code; fixed by adding "brave" to the list (warn-only, no control-flow
//   change, can't fail a deploy).
// The 7 refuted findings, all well-argued:
// - app/inbox/page.tsx x2 (accessibility-resweep-newer-code-r19 + silent-
//   catch-audit): both refuted 3/3 on evidence/reachability grounds.
// - app/topics/page.tsx (accessibility-resweep-newer-code-r19, LOW, 1
//   CONFIRM/2 REFUTE): a decorative checkmark baked into a subtopic chip's
//   accessible name, framed as the same class round 70 fixed on Digest.tsx
//   -- but 2 of 3 votes found the OPPOSITE in-file pattern applies here:
//   components/ThemeSwitcher.tsx has the identical unhidden-checkmark
//   construct (never flagged across 70 rounds), app/theme/page.tsx
//   deliberately duplicates picked-state INTO its aria-label as a documented
//   design choice, and the finding's own proposed fix would leave the
//   chip's adjacent unhidden emoji untouched -- an under-scoped half-fix on
//   a false "sole outlier" premise, the same shape round 67 already
//   refuted once. Correctly left alone.
// - app/api/health/route.ts (silent-catch-audit, LOW): refuted.
// - app/signin/page.tsx, components/onboarding/QuestionStep.tsx, app/
//   support/SupportForm.tsx (form-validation-consistency-audit-r17, all
//   MEDIUM): all 3 refuted 3/3.
// alpha-drift-r71-01, 2026-08-21.
// Run: npx tsx scripts/verify-r71-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) scripts/smoke-test-deploy.mjs: the SOFT resilience-tier list now includes brave, matching every sibling list");
{
  const src = readFileSync(new URL("../scripts/smoke-test-deploy.mjs", import.meta.url), "utf8");
  check("(1a) SOFT now includes brave alongside the original 4 fields", /const SOFT = \["gemini", "you", "groq", "deepseek", "brave"\];/.test(src));
  check("(1b) it's still warn-only, not a hard failure (no new hardFailures/exit-code coupling)", /if \(softBad\.length > 0\) \{\s*\n\s*console\.warn\(`  \(soft warning, not failing\)/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R71 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R71 FINDINGS ASSERTIONS PASS");
