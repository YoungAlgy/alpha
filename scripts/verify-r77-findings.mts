// Verify round 77 findings: 2 raised, 1 confirmed, 1 refuted -- plus 1 real
// bug personally investigated and fixed after all 3 verify votes on the
// refuted finding independently flagged it as an aside.
// - app/settings/page.tsx (accessibility-resweep-newer-code-r25, MEDIUM,
//   3/3 CONFIRM): the shared Section() heading component (YOUR DETAILS,
//   BILLING, THEME, etc. -- 9 sites, every signed-in subscriber's most-
//   visited authenticated page) colored its <h2> with --accent-ink, which
//   fails WCAG AA 4.5:1 against --paper in the default theme and most
//   others. The one un-audited holdout of a bug class this app has fixed
//   5+ times on structurally identical alpha-mono category labels
//   elsewhere (LetterTOC, Digest, changelog's month headings -- r57-04 hit
//   this exact Section() shape on the sibling changelog page). Fixed by
//   swapping to --ink-soft, matching every other instance.
// - README.md's directory-layout tree omitting /letter and /sample
//   (duplicate-code-audit-r26, LOW, 3/3 REFUTE): real omission, but all 3
//   votes independently confirmed the tree was never a route inventory to
//   begin with -- it already omits ~50% of real app/, lib/, and
//   components/ files, including files the README's OWN prose names
//   elsewhere (lib/cadence.ts, lib/engine/url-guard.ts in the very first
//   sentence) without adding them to the tree. Correctly left alone.
// - README.md's "(11 screens, no public landing)" claim: NOT the finding
//   that was filed or voted on, but ALL 3 refute votes above independently
//   flagged it as a genuine, code-verifiable false claim while explaining
//   why the /letter+/sample omission wasn't one -- app/page.tsx's own
//   header comment describes itself as "The landing page for cold
//   traffic... Sits in FRONT of the funnel... Static + indexable". Git
//   history confirms this was true when written (v0.49) and became false
//   when app/page.tsx shipped later (v0.68) -- genuine drift, the exact
//   r74-class bug. Personally verified and fixed.
// alpha-drift-r77-01, r77-02 (a supersession fix inside verify-r74-
// findings.mts, not this file), both 2026-08-21.
// Run: npx tsx scripts/verify-r77-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
};

console.log("(1) app/settings/page.tsx: Section()'s heading now uses --ink-soft, matching every other alpha-mono category label in the app");
{
  const src = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(1a) the h2 now uses --ink-soft, not --accent-ink", /className="alpha-mono mb-4"\s*\n\s*style=\{\{ color: "var\(--ink-soft\)" \}\}\s*\n\s*>\s*\n\s*\{title\.toUpperCase\(\)\}/.test(src));
  check("(1b) no bare Section() h2 still uses --accent-ink", !/function Section\(\{ title, children \}[\s\S]{0,300}var\(--accent-ink\)/.test(src));
}

console.log("(2) README.md: the onboarding-funnel bullet no longer falsely claims there's no public landing page");
{
  const src = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  check("(2a) the false \"no public landing\" claim is gone", !/no public landing/.test(src));
  check("(2b) the bullet now correctly notes the real public landing page in front of the funnel", /reached via a minimal public landing page \(`\/`\) for cold\/SEO traffic/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R77 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R77 FINDINGS ASSERTIONS PASS");
