// Verify round 69 findings. This round's Workflow run hit a real session
// usage-limit mid-verify (3 of 5 dimensions' verify agents failed outright,
// "You've hit your session limit"), so only 2 of 4 raised findings got a
// full 3-vote panel -- the other 2 were personally re-adjudicated by hand
// rather than trusted at face value, since the automated survived-formula
// (refutedCount < 2) has a known artifact when only 1-2 votes land: a
// single REFUTE with no other votes reads as "survived" even though it's
// really just one skeptic with nothing to outvote it.
// - app/settings/accounts/page.tsx (form-validation-consistency-audit-r15,
//   filed MEDIUM, shipped as a real fix regardless of the severity
//   disagreement): 2/2 votes agreed the admin search box's type="email"
//   let the browser's own HTML5 format-constraint validation silently
//   block submitting anything not shaped like "x@y" -- but the server does
//   a plain ILIKE substring match with zero format requirement, so the one
//   realistic way an admin actually searches (a name fragment, a bare
//   domain) never reached runSearch() at all. Both votes only disputed the
//   severity label (LOW vs MEDIUM), not whether to fix it -- swapped to
//   type="text" + inputMode="email" (keeps the mobile "@" keyboard hint
//   without triggering format validation).
// - app/api/support/route.ts (form-validation-consistency-audit-r15, LOW):
//   full 3-vote panel, 2 CONFIRM + 1 REFUTE, genuinely survived. message
//   had no lower bound while its sibling email field did -- a direct POST
//   (the route is deliberately unauthenticated/CSRF-unguarded) could store
//   and owner-notify an empty-body ticket. Fixed with a .refine (not a
//   bare .min(1), which the finding's own evidence shows a whitespace-only
//   value would still pass; not a .trim() transform, which would silently
//   mutate the stored text and the dedup key).
// PERSONALLY RE-ADJUDICATED, NOT SHIPPED THIS ROUND (only 1-2 of 3 votes
// landed before the session limit hit; treated as inconclusive/refuted
// rather than trusting the automated "survived" flag):
// - app/api/cron/weekly-send/route.ts's chunked-prefetch silent-catch
//   claim: 1 CONFIRM / 1 REFUTE, and the REFUTE vote directly rebuts the
//   CONFIRM vote's strongest point (traced a real downstream Resend-409 /
//   per-user-catch / ops-alert trace for the exact "pendingIssues has zero
//   trace anywhere" claim CONFIRM leaned on). Too close and too
//   consequential (the cron send pipeline) to ship on a coin-flip with no
//   tiebreaker -- left for a future round's fresh verification.
// - app/archive/page.tsx's local truncate() UTF-16-unsafe-slice claim: only
//   1 vote landed (REFUTE) after 2 more errored on the session limit. The
//   "survived" flag read true only because the formula needs 2+ refutes to
//   kill a finding and never got a 2nd or 3rd vote -- not a real
//   confirmation. The lone vote's reasoning (display-only harm, no write/
//   encode path, near-zero reachability at this app's real astral-char
//   frequency, and the proposed fix has its own bugs) was read in full and
//   is not acted on.
// alpha-drift-r69-01, r69-02, both 2026-08-21.
// Run: npx tsx scripts/verify-r69-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/settings/accounts/page.tsx: the search input no longer triggers native email-format constraint validation");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(1a) type is now text, not email", /type="text"\s*\n\s*\/\/ alpha-drift-r69-01/.test(src));
  check("(1b) inputMode=\"email\" preserves the mobile keyboard hint", /inputMode="email"/.test(src));
  check("(1c) no type=\"email\" attribute remains on this input (the comment's own prose mentions the string, so match the JSX shape, not a bare substring)", !/\n\s+type="email"\n/.test(src));
  check("(1d) the aria-label/disabled adjacency verify-r47-findings.mts check (4c) depends on is untouched", /aria-label="Search by email"\s*\n\s*disabled=\{busyRows\.size > 0\}/.test(src));
}

console.log("(2) app/api/support/route.ts: message now rejects empty and whitespace-only values, matching email's presence requirement");
{
  const src = readFileSync(new URL("../app/api/support/route.ts", import.meta.url), "utf8");
  check("(2a) message uses a refine, not a bare min(1) or a mutating trim() transform", /message: z\.string\(\)\.max\(5000\)\.refine\(\(s\) => s\.trim\(\)\.length > 0, "Message can't be empty\."\),/.test(src));
  check("(2b) email's own presence check is untouched", /email: z\.string\(\)\.min\(1\)\.max\(200\)\.refine\(isValidEmail, "Not a valid email address"\),/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R69 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R69 FINDINGS ASSERTIONS PASS");
