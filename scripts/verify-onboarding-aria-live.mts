// Verify round 23 findings (alpha-drift-r23-07/08, 2026-08-14, MEDIUM):
//   - app/you/page.tsx: the r22-04 birthday-invalid validation message had
//     no aria wiring at all -- a screen-reader user got zero announcement
//     that Continue silently disabled after typing an out-of-range date.
//   - app/writing/page.tsx: the whole ~45s automated progress wait had no
//     ARIA live region and the bar carried no role=progressbar, unlike
//     ProgressDots.tsx (used one step earlier in the same funnel), which
//     already gets this right.
//
// Both are pure DOM/ARIA-attribute wiring with no server dependency, so
// this checks the actual source for the specific attribute combinations a
// screen reader needs, rather than asserting on rendered/computed
// accessibility-tree output (no browser harness in this script context).
// Run: npx tsx scripts/verify-onboarding-aria-live.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/you/page.tsx: the birthday input and its hint text are properly associated and live");
{
  const src = readFileSync(new URL("../app/you/page.tsx", import.meta.url), "utf8");
  check("(1a) the input carries aria-describedby pointing at the hint paragraph's id", /aria-describedby="alpha-birthday-hint"/.test(src));
  check("(1b) the input's aria-invalid reflects the SAME format-validity check canContinue gates on (birthday.length > 0 && !birthdayValid), not just emptiness", /aria-invalid=\{birthday\.length > 0 && !birthdayValid\}/.test(src));
  check("(1c) the hint paragraph actually has the id the input references", /id="alpha-birthday-hint"/.test(src));
  check("(1d) the hint paragraph is a live region (role=status, aria-live=polite) so its 3 possible states are all announced on change", /id="alpha-birthday-hint"[\s\S]{0,20}role="status"[\s\S]{0,20}aria-live="polite"/.test(src));
}

console.log("(2) app/writing/page.tsx: the progress bar and status heading are properly exposed to assistive tech");
{
  const src = readFileSync(new URL("../app/writing/page.tsx", import.meta.url), "utf8");
  check("(2a) the progress bar container has role=progressbar", /role="progressbar"/.test(src));
  check("(2b) it has real aria-valuenow/valuemin/valuemax, not just a visual width", /aria-valuenow=\{pct\}/.test(src) && /aria-valuemin=\{0\}/.test(src) && /aria-valuemax=\{100\}/.test(src));
  check("(2c) aria-valuetext gives a human-readable summary, not just raw numbers", /aria-valuetext=\{done \? "Your letter is ready\." : `Writing your letter, \$\{pct\}% done`\}/.test(src));
  check("(2d) the status heading (done vs writing) is a live region -- the one transition that actually matters gets announced", /role="status"\s*\n\s*aria-live="polite"\s*\n\s*className="alpha-display text-2xl md:text-3xl font-bold tracking-tight mb-2"/.test(src));
  // Deliberately NOT live: the per-step checklist. Confirm this wasn't
  // accidentally made chatty (announcing all 7-8 steps over 45s would be
  // noise, not a real improvement) -- the <ul> itself should carry no
  // aria-live of its own.
  const ulMatch = src.match(/<ul className="text-left space-y-3">/);
  check("(2e) sanity: the step-list <ul> itself is unchanged (no new aria-live added there -- that would be chatty, not helpful)", !!ulMatch);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("ONBOARDING-ARIA-LIVE VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ONBOARDING-ARIA-LIVE ASSERTIONS PASS");
