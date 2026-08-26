// Verify round 70 findings: re-verified 2 findings round 69 left inconclusive
// (both got a full fresh 3-vote panel this time), plus 5 dimension finders
// raised 5 more, all refuted (incl. a thorough self-audit REFUTE of round
// 69's own support-route fix -- no regression, just Unicode trivia with zero
// demonstrated harm and a proposed "fix" that itself has gaps).
// - app/api/cron/weekly-send/route.ts (silent-catch-audit-reverify, filed
//   MEDIUM, shipped at LOW per unanimous severity correction): the chunked
//   prefetch queries (alreadyDelivered stamps + retry-safety pendingIssues)
//   discarded each chunk's Supabase error. Round 69 got a 1-1 split; round
//   70's fresh 3-vote panel unanimously CONFIRMED (2-1, refutedCount=1<2)
//   after re-tracing both counter-claims from the split: the stamps-miss
//   path DOES eventually log (a "skipped, claimed by a concurrent run"
//   line at the atomic-claim step) but MISATTRIBUTES the cause and fires
//   only after the spend already happened; the pendingIssues-miss path
//   mostly DOES surface via a Resend idempotency 409 -- except for a
//   persisted-but-never-yet-sent row (several early-return paths sit
//   between the ensure-exists insert and any Resend call), where it stays
//   genuinely silent. Fixed with pure additive logging inside each
//   .then(), no control-flow change.
// - components/Digest.tsx (accessibility-resweep-newer-code-r18, filed
//   MEDIUM, shipped at LOW per unanimous severity correction, 3/3 CONFIRM):
//   the supplementaryRefs ("ALSO") link's decorative arrow glyph was baked
//   into the same text node as the visible label, unlike the primaryRef
//   link 32 lines above (which already splits it into its own aria-hidden
//   span) -- a screen reader announced "label north east arrow" instead of
//   just the label. Nested (not sibling) span, per all 3 votes' preferred
//   shape, to keep it one flex item and avoid a double-space / wrapping
//   regression the literal original suggestion would have introduced.
// - app/archive/page.tsx's truncate() UTF-16 claim: re-verified fresh, now
//   a genuine 3/3 REFUTE (display-only harm, no write/encode path, near-
//   zero reachability). Settled -- do not re-raise again.
// - app/api/support/route.ts's round-69 message .refine (self-audit, 3/3
//   REFUTE): a real Unicode-trivia gap (Cf-category invisible characters
//   survive .trim()) but zero demonstrated harm (a single visible
//   character like "." achieves the identical worthless-ticket outcome,
//   and the route's own comment names the rate limit as the sole abuse
//   control) -- and the proposed Cf-stripping fix itself has gaps (Hangul
//   filler, Braille blank survive it too). No change to round 69's fix.
// - lib/engine/persist.ts's existingUser-lookup silent-catch claim (3/3
//   REFUTE): the claimed "nothing is logged" path is provably unreachable
//   (nonEmptyProfileFields always returns >=2 keys given the caller's own
//   Zod schema), and the proposed fail-closed fix would have been a real
//   regression on new-signup onboarding (breaks the self-healing insert-
//   race fallback).
// - 5 standalone dev scripts' duplicated weekOfNow() helper + scripts/
//   preview-email.mts item (duplicate-code-audit-r19, both 3/3 REFUTE):
//   real duplication, zero reachable harm (weekOf never reaches the actual
//   search-recency window), and applying the suggested fix to
//   verify-resilient-assemble.mts specifically would have made dev runs
//   write into the LIVE topic_blurbs cache the same day's real cron reads.
// alpha-drift-r70-01, r70-02, both 2026-08-21.
// Run: npx tsx scripts/verify-r70-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/api/cron/weekly-send/route.ts: both chunked prefetch queries now warn on a per-chunk failure instead of silently discarding it");
{
  const src = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
  check("(1a) a shared warnOnChunkErrors helper exists", /const warnOnChunkErrors = \(results: Array<\{ error: \{ message: string \} \| null \}>, label: string\) => \{/.test(src));
  check("(1b) it warns with a chunk-failure count and the joined messages", /console\.warn\(\s*\n\s*`\[cron\/weekly-send\] \$\{label\} prefetch: \$\{failed\.length\}\/\$\{results\.length\} chunk\(s\) failed/.test(src));
  check("(1c) stampsPromise's .then() calls it with label \"alreadyDelivered\" before flatMapping", /warnOnChunkErrors\(results, "alreadyDelivered"\);\s*\n\s*return results\.flatMap/.test(src));
  check("(1d) pendingPromise's .then() calls it with label \"pendingIssues\" before flatMapping", /warnOnChunkErrors\(results, "pendingIssues"\);\s*\n\s*return results\.flatMap/.test(src));
}

console.log("(2) components/Digest.tsx: the supplementaryRefs arrow is now aria-hidden, matching the primaryRef link above it");
{
  const src = readFileSync(new URL("../components/Digest.tsx", import.meta.url), "utf8");
  check("(2a) the arrow is nested in its own aria-hidden span within the same flex item", /<span>\{ref\.label\}<span aria-hidden>\{" ↗"\}<\/span><\/span>/.test(src));
  check("(2b) the primaryRef link's own aria-hidden arrow (the reference implementation) is untouched", /<span>\{kindLabel \|\| "Open"\}: \{item\.primaryRef\.label\}<\/span>\s*\n\s*<span aria-hidden>↗<\/span>/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R70 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R70 FINDINGS ASSERTIONS PASS");
