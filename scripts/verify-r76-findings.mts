// Verify round 76 findings: 3 raised, 1 confirmed, 2 refuted. Round 75 was
// this marathon's first fully-dry round; round 76 broke the streak, so the
// standing two-consecutive-dry-rounds stopping criterion was NOT met.
// - components/onboarding/ProgressDots.tsx (accessibility-resweep-newer-
//   code-r24, filed MEDIUM, shipped at LOW per unanimous severity
//   correction, 3/3 CONFIRM): role="progressbar" had no accessible name --
//   only aria-valuenow/valuemin/valuemax/valuetext, no aria-label/
//   aria-labelledby, and no ancestor (StepShell's bare <nav>) supplied one.
//   Mounted on all 11 onboarding steps, so every signup hits it. Fixed with
//   a static aria-label, kept separate from aria-valuetext's own per-step
//   "Step X of Y" text.
// - app/writing/page.tsx's near-identical progressbar (accessibility-
//   resweep-newer-code-r24, MEDIUM, 1 CONFIRM/2 REFUTE): real same-shape
//   gap, but 2 of 3 votes found the cases aren't actually identical --
//   this progressbar's aria-valuetext ("Writing your letter, 45% done") is
//   already fully self-describing (unlike ProgressDots' context-free "Step
//   3 of 6"), and the same information is redundantly available a third
//   time via an adjacent role=status live region. The filed fix
//   (aria-label="Writing your letter") would also produce a stutter while
//   writing and a stale/contradictory announcement once done ("Writing
//   your letter... Your letter is ready."). Left alone per the panel's
//   differentiated verdict.
// - docs/SECRETS.md's "No AI/search keys at all" claim about
//   letter-watchdog.yml (duplicate-code-audit-r25, LOW, 3/3 REFUTE): the
//   workflow's check-resilience-secrets job does read 6 AI/search + 1 ops-
//   webhook secret, but all 3 votes confirmed via git blame that the doc
//   was written the day AFTER that job was added, by the same author, with
//   the job already in the tree -- the sentence is a deliberate WATCHDOG_*
//   -prefix-scoped claim ("no dedicated WATCHDOG_ copy of any AI/search
//   key"), not drift, and is literally true under that reading. Same
//   settled non-exhaustive-inventory principle as rounds 49 and 75.
// alpha-drift-r76-01, 2026-08-21.
// Run: npx tsx scripts/verify-r76-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
};

console.log("(1) components/onboarding/ProgressDots.tsx: the progressbar now has a static accessible name, separate from its live aria-valuetext");
{
  const src = readFileSync(new URL("../components/onboarding/ProgressDots.tsx", import.meta.url), "utf8");
  check("(1a) aria-label is present on the progressbar div", /role="progressbar"[\s\S]{0,600}aria-label="Onboarding progress"/.test(src));
  check("(1b) aria-valuetext's own per-step text is untouched", /aria-valuetext=\{`Step \$\{current\} of \$\{total\}`\}/.test(src));
  check("(1c) aria-label sits before the aria-value* attributes (name, then value)", /aria-label="Onboarding progress"\s*\n\s*aria-valuenow=\{current\}/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R76 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R76 FINDINGS ASSERTIONS PASS");
