// Verify round 21 finding (alpha-drift-r21-08, 2026-08-14): three of the four
// access-check gated pages' error/empty states rendered zero heading
// elements. Each state returns a full <main> that completely replaces the
// page -- the large "headline" text was a plain <p> styled to look like a
// heading (alpha-display text-2xl/3xl font-bold) but carrying no heading
// semantics, so a screen-reader user navigating by heading (NVDA/JAWS "H"
// key) found nothing on these screens at all. app/archive/page.tsx was
// already fine (its <h1>"Archive" sits unconditionally above every state);
// this fixes the other three: app/inbox/page.tsx (accessEnded + "no letter
// on this device"), app/inbox/[issueId]/page.tsx (accessEnded + missing),
// and app/letter/page.tsx's LinkProblem (all 3 reasons share 2 render
// branches). These are client/server components without a DOM test harness
// in this repo, so -- matching the established pattern for pure-markup a11y
// fixes -- this is a source-level regression guard.
// Run: npx tsx scripts/verify-access-error-headings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// Requires the space before an attribute (the real JSX opening tag shape,
// <h1 className="...">) so this doesn't also match the fix's own
// explanatory comments, which quote "<h1>" in prose without a trailing space.
function h1Count(src: string): number {
  return (src.match(/<h1 /g) ?? []).length;
}

console.log("(1) app/inbox/page.tsx: both error/empty states now render a real <h1>");
{
  const src = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  check("(1) exactly 2 <h1> tags (accessEnded + no-letter-on-device states)", h1Count(src) === 2);
  check("(1) the accessEnded headline is an <h1>, not a styled <p>", /<h1[^>]*>\s*Your subscription has ended\.\s*<\/h1>/.test(src));
  check("(1) the no-letter-on-device headline is an <h1>, not a styled <p>", /<h1[^>]*>\s*No letter on this device yet\.\s*<\/h1>/.test(src));
  check("(1) no dangling styled-<p> pretending to be these headlines anymore", !/<p className="alpha-display text-2xl md:text-3xl font-bold tracking-tight">\s*(Your subscription has ended|No letter on this device yet)/.test(src));
}

console.log("(2) app/inbox/[issueId]/page.tsx: both error/empty states now render a real <h1>");
{
  const src = readFileSync(new URL("../app/inbox/[issueId]/page.tsx", import.meta.url), "utf8");
  check("(2) exactly 2 <h1> tags (accessEnded + missing states)", h1Count(src) === 2);
  check("(2) the accessEnded headline is an <h1>, not a styled <p>", /<h1[^>]*>\s*Your subscription has ended\.\s*<\/h1>/.test(src));
  check("(2) the missing-letter headline is an <h1>, not a styled <p>", /<h1[^>]*>\s*Can&apos;t find that letter\.\s*<\/h1>/.test(src));
}

console.log("(3) app/letter/page.tsx: LinkProblem's two render branches (access-ended, and the shared expired/no-letter branch) now render a real <h1>");
{
  const src = readFileSync(new URL("../app/letter/page.tsx", import.meta.url), "utf8");
  check("(3) exactly 2 <h1> tags in LinkProblem (access-ended branch + the shared expired/no-letter branch)", h1Count(src) === 2);
  check("(3) the access-ended headline is an <h1>, not a styled <p>", /<h1[^>]*>\s*This letter isn&apos;t available anymore\.\s*<\/h1>/.test(src));
  check(
    "(3) the shared expired/no-letter headline is an <h1> wrapping the conditional text, not a styled <p>",
    /<h1[^>]*>\s*\{reason === "expired"/.test(src)
  );
}

console.log("(4) sanity: app/archive/page.tsx was already fine (h1 unconditional above every state) -- confirms this fix targeted the right 3 files, not a 4th that never had the bug");
{
  const src = readFileSync(new URL("../app/archive/page.tsx", import.meta.url), "utf8");
  check("(4) Archive's own <h1> still exists, unconditionally rendered", /<h1[^>]*>\s*Archive\s*<\/h1>/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("ACCESS-ERROR-HEADINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ACCESS-ERROR-HEADINGS ASSERTIONS PASS");
