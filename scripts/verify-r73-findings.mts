// Verify round 73 findings: 4 raised, 3 confirmed, 1 refuted.
// - app/topics/page.tsx (self-audit, MEDIUM, 3/3 CONFIRM): the curated-
//   topic-suggestion button ("We have a curated topic for that: <label> →")
//   unmounts itself on click with zero focus restoration -- a fresh,
//   independently-substantiated instance of this app's own unmount-
//   without-focus-restore class, on a control this file's own removeAt()
//   fix already treats as real. Fixed via a SEPARATE counter+effect
//   (suggestedCount), not by folding into or renaming removedCount, since
//   verify-r61-findings.mts pins that block's exact literal shape.
// - app/settings/accounts/page.tsx (accessibility-resweep-newer-code-r21,
//   MEDIUM, 3/3 CONFIRM): the search box's "Clear" button unmounts on
//   click (activeSearch flips falsy, `{activeSearch && ...}` stops
//   rendering) with no focus restoration -- the same class this file has
//   already fixed 3 times for its OTHER controls (row actions, Load More)
//   but never for Clear, and unlike Load More this one needs no 200-row
//   scale precondition at all. Fixed via a separate clearCount counter +
//   effect targeting the existing accountsHeadingRef, mirroring
//   actionCount/loadMoreCount.
// - scripts/audit-topic-signal.mts (duplicate-code-audit-r22, LOW, 3/3
//   CONFIRM): header comment called the script "Brave-only (cheap/fast, no
//   Claude)", stale since resolveTopicSignal grew a Gemini fallback
//   (2026-07-04), a You.com fallback (2026-07-29), and full-article
//   deep-read fetches via Jina Reader (2026-06-19, on by default) -- none
//   of which are Brave-only or cheap. Fixed the comment only (not the
//   pipeline call, which all 3 votes agreed would just re-implement
//   rankAndDedup/extractSignalUrls) -- kept the accurate "no Claude" half.
// - scripts/inspect-user-completeness.mts's stale active-filter mirror
//   (duplicate-code-audit-r22, MEDIUM, 3/3 REFUTE): real drift (omits
//   unsubscribed_at/bounced_at/complained_at, which the real cron filter
//   requires) but empirically zero-impact -- all 3 votes queried the live
//   DB directly and confirmed every suppression column is null on all 6
//   rows today, so the script's "active" set and the cron's real filter
//   are currently identical, and the script has zero consumers anywhere
//   in the repo (no CI, no package.json entry, no verify-rNN reference).
// alpha-drift-r73-01, r73-02, r73-03, all 2026-08-21.
// Run: npx tsx scripts/verify-r73-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
};

console.log("(1) app/topics/page.tsx: the curated-suggestion button now restores focus to the topics heading, via a separate counter from removedCount");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
  check("(1a) removedCount's own pinned block (verify-r61) is untouched", /const \[removedCount, setRemovedCount\] = useState\(0\);\s*\n\s*const topicsHeadingRef = useRef<HTMLHeadingElement>\(null\);\s*\n\s*useEffect\(\(\) => \{\s*\n\s*if \(removedCount > 0\) topicsHeadingRef\.current\?\.focus\(\);\s*\n\s*\}, \[removedCount\]\);/.test(src));
  check("(1b) a separate suggestedCount state + effect exists, also targeting topicsHeadingRef", /const \[suggestedCount, setSuggestedCount\] = useState\(0\);\s*\n\s*useEffect\(\(\) => \{\s*\n\s*if \(suggestedCount > 0\) topicsHeadingRef\.current\?\.focus\(\);\s*\n\s*\}, \[suggestedCount\]\);/.test(src));
  check("(1c) the suggestion button's onClick increments it, after the existing state clears", /setCustomText\(""\);\s*\n\s*setCustomErr\(null\);\s*\n\s*setSuggestedCount\(\(c\) => c \+ 1\);/.test(src));
}

console.log("(2) app/settings/accounts/page.tsx: the Clear button now restores focus to the accounts heading, via a separate clearCount counter");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(2a) a separate clearCount state + effect exists, targeting accountsHeadingRef", /const \[clearCount, setClearCount\] = useState\(0\);\s*\n\s*useEffect\(\(\) => \{\s*\n\s*if \(clearCount > 0\) accountsHeadingRef\.current\?\.focus\(\);\s*\n\s*\}, \[clearCount\]\);/.test(src));
  check("(2b) clearSearch() increments it, keeps the busy guard, and returns to the pending queue", /function clearSearch\(\) \{\s*\n\s*if \(busyRowsRef\.current\.size > 0\) return;\s*\n\s*setQ\(""\);\s*\n\s*setActiveSearch\(""\);\s*\n\s*setPendingOnly\(true\);\s*\n\s*load\(\{ pending: true \}\);\s*\n\s*setClearCount\(\(c\) => c \+ 1\);\s*\n\s*\}/.test(src));
}

console.log("(3) scripts/audit-topic-signal.mts: the header no longer claims Brave-only/cheap-fast, but still correctly says no Claude");
{
  const src = readFileSync(new URL("../scripts/audit-topic-signal.mts", import.meta.url), "utf8");
  check("(3a) the stale \"Brave-only (cheap/fast, no Claude)\" claim is gone", !/Brave-only \(cheap\/fast, no Claude\)/.test(src));
  check("(3b) the accurate \"no Claude\" half is preserved", /Calls the real resolveTopicSignal\s*\n\/\/ pipeline \(no Claude\)/.test(src));
  check("(3c) the comment now names the real fallback tiers/deep-read that make it neither Brave-only nor cheap", /Gemini-grounded-search fallback, a You\.com fallback, and full-article\s*\n\/\/ deep-read fetches via Jina Reader/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R73 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R73 FINDINGS ASSERTIONS PASS");
