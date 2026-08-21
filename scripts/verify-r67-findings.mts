// Verify round 67 findings: 7 raised, 4 confirmed, 3 refuted (an aria-hidden
// proposal for the decorative alpha-glyph on 8 error/empty states -- refuted
// as under-scoped and colliding with a round-65 refute of the same class on
// a sibling site; a claim that any admin row action collapses an expanded
// Load More list -- refuted as unreachable at this app's real ~4-user scale
// and the proposed fixes both regress something load-bearing; and a cursor-
// pagination tie-breaker gap on app/api/admin/users/route.ts -- refuted as
// structurally unreachable, since every users-table write is single-row and
// created_at is column-locked post-insert).
// - app/settings/accounts/page.tsx + app/archive/page.tsx Load More focus
//   restoration (accessibility-resweep-newer-code-r15, MEDIUM x2): both
//   Load More buttons unmount on their EXHAUSTION response (hasMore flips
//   false, or -- archive only -- access is revoked mid-session), dropping a
//   keyboard/screen-reader admin/subscriber's focus to <body> with no
//   restoration, unlike every other unmount-without-focus-restore class this
//   app already fixed (act()'s own row actions, EmailChanger.tsx, settings/
//   page.tsx x3, checkout/page.tsx). Went with aria-disabled (not disabled)
//   on both buttons rather than the naive counter-plus-ref-branch fix a
//   couple of votes proposed -- a real `disabled` attribute blurs a focused
//   button back to <body> on click even on the common "more pages remain"
//   path, which multiple votes flagged as risking pre-empting round 66's own
//   queued polite Load-More announcement on the SAME interaction. With
//   aria-disabled, focus never leaves the button on that path at all, so the
//   monotonic-counter effect only has to handle the actual unmount case.
// - app/settings/accounts/page.tsx Load More announcement completeness gap
//   (form-validation-consistency-audit-r13, MEDIUM): round 66's own
//   announcement fix had no zero-row branch (a 0-row response, the boundary
//   landing exactly on a multiple of 200, rendered "Loaded 0 more accounts")
//   and no exhaustion suffix, unlike its sibling in app/archive/page.tsx.
//   Also reuses act()'s own setActionMsg(null)-then-set convention (see
//   verify-r32-findings.mts check 8d) so two "No more accounts to load."
//   announcements landing far apart in time don't hit React's Object.is
//   bailout and silently fail to re-announce the second time.
// - app/archive/page.tsx:42 stale line-number comment (LOW): pointed at
//   app/settings/accounts/page.tsx:444, which round 66's OWN commit had
//   already shifted to :459 by the time the commit landed (15 lines added
//   earlier in the same diff, above the target). Dropped the line number
//   entirely per the unanimous vote recommendation -- a bare line number
//   silently re-drifts on the next unrelated edit to that file, the same
//   fragility class this marathon's own verify scripts have repeatedly hit.
// alpha-drift-r67-01 through r67-04, all 2026-08-21.
// Run: npx tsx scripts/verify-r67-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/settings/accounts/page.tsx: Load More restores focus to the heading once the button actually unmounts, via aria-disabled (not disabled) so focus never leaves it on the still-mounted path");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(1a) a loadMoreBtnRef + loadMoreCount pair exists", /const loadMoreBtnRef = useRef<HTMLButtonElement>\(null\);\s*\n\s*const \[loadMoreCount, setLoadMoreCount\] = useState\(0\);/.test(src));
  check("(1b) the effect focuses the heading only once the button ref is empty and a load-more actually ran", /if \(loadMoreCount > 0 && !loadMoreBtnRef\.current\) accountsHeadingRef\.current\?\.focus\(\);/.test(src));
  check("(1c) loadMore() increments the counter in its finally block", /finally \{\s*\n\s*setLoadingMore\(false\);\s*\n\s*setLoadMoreCount\(\(c\) => c \+ 1\);\s*\n\s*\}/.test(src));
  check("(1d) loadMore() re-entrancy is now a synchronous guard, not the disabled attribute", /async function loadMore\(\) \{\s*\n\s*if \(loadingMore \|\| !users \|\| users\.length === 0\) return;/.test(src));
  check("(1e) the button carries the ref and aria-disabled, not disabled", /ref=\{loadMoreBtnRef\}[\s\S]{0,700}aria-disabled=\{loadingMore\}/.test(src));
  check("(1f) no bare disabled={loadingMore} remains on this button", !/(?<!aria-)disabled=\{loadingMore\}/.test(src));
}

console.log("(2) app/archive/page.tsx: the sibling Load More focus restoration, same aria-disabled shape");
{
  const src = readFileSync(new URL("../app/archive/page.tsx", import.meta.url), "utf8");
  check("(2a) a loadMoreBtnRef + loadMoreCount pair exists", /const loadMoreBtnRef = useRef<HTMLButtonElement>\(null\);\s*\n\s*const \[loadMoreCount, setLoadMoreCount\] = useState\(0\);/.test(src));
  check("(2b) the effect focuses the archive heading only once the button ref is empty and gated on loadMoreCount > 0", /if \(loadMoreCount > 0 && !loadMoreBtnRef\.current\) archiveHeadingRef\.current\?\.focus\(\);/.test(src));
  check("(2c) loadMore()'s finally increments the counter, still guarded by mountedRef", /finally \{\s*\n\s*if \(mountedRef\.current\) \{\s*\n\s*setLoadingMore\(false\);\s*\n\s*setLoadMoreCount\(\(c\) => c \+ 1\);\s*\n\s*\}\s*\n\s*\}/.test(src));
  check("(2d) the button carries the ref and aria-disabled, not disabled", /ref=\{loadMoreBtnRef\}[\s\S]{0,400}aria-disabled=\{loadingMore\}/.test(src));
  check("(2e) no bare disabled={loadingMore} remains on this button", !/(?<!aria-)disabled=\{loadingMore\}/.test(src));
  // The round-66 live region must still be mounted unconditionally, immediately
  // followed by the loading-skeleton block -- verify-r66-findings.mts check (2c)
  // already asserts the exact adjacency; this just confirms our new hooks landed
  // above it, not spliced between the two.
  check("(2f) the live region is still immediately followed by the loading-state block (new hooks didn't land between them)", /<p role="status" aria-live="polite" className="sr-only">\s*\n\s*\{loadMoreMsg\}\s*\n\s*<\/p>\s*\n\s*\n\s*\{state === "loading"/.test(src));
}

console.log("(3) app/settings/accounts/page.tsx: Load More's announcement now handles the zero-row and exhaustion cases, and resets to null first so a repeated identical string still re-announces");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(3a) the append path clears actionMsg to null before the fetch, not just on success", /if \(opts\?\.append\) setActionMsg\(null\);\s*\n\s*const seq = \+\+loadSeqRef\.current;/.test(src));
  check("(3b) a zero-row response announces exhaustion instead of \"Loaded 0 more accounts\"", /data\.users\.length === 0\s*\n\s*\? "No more accounts to load\."/.test(src));
  check("(3c) a non-zero response still carries the running total", /: `Loaded \$\{data\.users\.length\} more account\$\{data\.users\.length === 1 \? "" : "s"\} -- \$\{newTotal\} shown\./.test(src));
  check("(3d) a final partial page appends the exhaustion suffix", /\$\{stillMore \? "" : " That's all of them\."\}/.test(src));
  check("(3e) stillMore is computed from the same 200-row cap the API enforces", /const stillMore = data\.users\.length === 200;/.test(src));
}

console.log("(4) app/archive/page.tsx: the stale accounts/page.tsx:444 line-number reference is gone");
{
  const src = readFileSync(new URL("../app/archive/page.tsx", import.meta.url), "utf8");
  check("(4a) no line-number reference into accounts/page.tsx remains", !/accounts\/page\.tsx:\d+/.test(src));
  check("(4b) the comment still describes which region it mirrors, descriptively", /Mirrors the sr-only role=status\s*\n\s*\/\/ region below app\/settings\/accounts\/page\.tsx's own err block\./.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R67 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R67 FINDINGS ASSERTIONS PASS");
