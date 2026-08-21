// Verify round 68 findings: 7 raised, 1 confirmed, 6 refuted. Smallest
// confirmed-count round of the marathon so far, but not a dry round -- and
// the 6 refutations were unusually decisive: 3 independently killed on the
// admin/accounts Load More reachability rule established round 67 (a
// re-entrancy-race variant on archive's sibling loadMore(), and TWO more
// reachability-premised admin/accounts findings, one of which also showed
// the proposed fix would have permanently wedged the button by gating
// setLoadingMore(false) on a staleness check); the alpha-glyph aria-hidden
// class and 2 more accessibility/silent-catch/demographics findings were
// each killed on evidence the finder missed (an unconditional sticky-bar
// live region already announcing every topics removal; RLS already
// preventing the claimed access fail-open; a DB CHECK constraint that would
// need fixing in lockstep with the code, ~16 months before it's even
// reachable).
// - components/ProfileEditor.tsx + app/settings/page.tsx (form-validation-
//   consistency-audit-r14, LOW): ProfileEditor's hasZodiac flag (drives the
//   "add your birthday or Zodiac gets skipped" hint) was fetched once at
//   mount with no resync path. app/settings/page.tsx's confirmTier("down")
//   success branch can truncate users.topics server-side (the same
//   established r58-06/r59-02 truncation class) and silently drop zodiac
//   from the pool with zero signal to this separate component tree, so the
//   hint could keep showing a state the server had just changed until the
//   reader reloaded. Two of three votes confirmed reachability is already
//   established precedent in this exact pair of files (any downgrade with
//   at least one backup topic truncates, not "two tiers" as the raw finding
//   overstated) and that the sound fix is a CustomEvent broadcast (option
//   B), not lifting hasZodiac into the parent page's own `topics` state
//   (option A, which the panel identified as a real regression -- that
//   state falls back to non-authoritative localStorage when the DB row's
//   topics array is empty, per app/settings/page.tsx:441).
// alpha-drift-r68-01, 2026-08-21.
// Run: npx tsx scripts/verify-r68-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/settings/page.tsx: confirmTier()'s downgrade truncation broadcasts the actual truncated array, not just updating local state");
{
  const src = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(1a) the truncated array is computed once from the current topics state", /const truncated = topics \? topics\.slice\(0, poolCap\(data\.topicQuota\)\) : null;/.test(src));
  check("(1b) setTopics uses the same computed value, not a separate re-derivation", /if \(truncated\) \{\s*\n\s*setTopics\(truncated\);/.test(src));
  check("(1c) the truncated array is broadcast via a CustomEvent", /window\.dispatchEvent\(new CustomEvent\("alpha-topics-truncated", \{ detail: \{ topics: truncated \} \}\)\);/.test(src));
  check("(1d) the broadcast is still scoped to the 'down' branch only (an 'up' truncation would be nonsensical)", /if \(direction === "down"\) \{\s*\n\s*const truncated = topics/.test(src));
}

console.log("(2) components/ProfileEditor.tsx: hasZodiac now resyncs from the broadcast instead of staying fixed at its mount-time value");
{
  const src = readFileSync(new URL("../components/ProfileEditor.tsx", import.meta.url), "utf8");
  check("(2a) a listener effect for alpha-topics-truncated exists, separate from the mount-hydrate effect", /function onTopicsTruncated\(e: Event\) \{/.test(src));
  check("(2b) it recomputes hasZodiac from the event's topics array", /if \(Array\.isArray\(detail\?\.topics\)\) setHasZodiac\(detail\.topics\.includes\("zodiac"\)\);/.test(src));
  check("(2c) the listener is registered and cleaned up on the window", /window\.addEventListener\("alpha-topics-truncated", onTopicsTruncated\);\s*\n\s*return \(\) => window\.removeEventListener\("alpha-topics-truncated", onTopicsTruncated\);/.test(src));
  check("(2d) the original mount-time hasZodiac read is untouched", /setHasZodiac\(Array\.isArray\(row\?\.topics\) && row\.topics\.includes\("zodiac"\)\);/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R68 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R68 FINDINGS ASSERTIONS PASS");
