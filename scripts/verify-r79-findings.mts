// Verify round 79 findings: 4 raised, 2 confirmed, 2 refuted -- plus 1 real
// content-loss bug personally investigated and fixed after all 3 verify
// votes on one confirmed finding independently converged on it as an aside.
// - app/api/unsubscribe/route.ts (self-audit, LOW, 3/3 CONFIRM): appOrigin()'s
//   comment still claimed the old youngalgy.com hub "PROXIES here forever" --
//   next.config.ts's own 2026-08-05 correction verified that false (the
//   Vercel project is gone; the live hub now 301-redirects instead), and
//   that correction was already applied to 3 sibling files in round 49.
//   This file was the one holdout, contradicted by its own repo. Reworded,
//   comment-only, zero behavior change.
// - lib/engine/topic-blurb.ts's trySonnet() BlurbTruncatedError branch
//   (silent-catch-audit, filed MEDIUM, shipped at LOW/MEDIUM per 2 votes'
//   correction, 2 CONFIRM/1 REFUTE): rethrew with zero logging, the only
//   truncation branch in the 5-tier waterfall that didn't (every sibling
//   tier, and the 429 branch one line below in the same function, logs
//   before escalating). Fixed with additive console.warn, no control-flow
//   change.
// - lib/engine/topic-blurb.ts's Sonnet tells-retry (line ~731, NOT the
//   finding that was filed -- an aside all 3 votes on the above finding
//   independently surfaced, with matching line numbers and reasoning):
//   the retry call was unguarded, so if it rejected (429, truncation, or a
//   failed parse retry), the exception propagated up and dropped the whole
//   topic from the letter -- discarding an already-usable draft the code's
//   own comment says isn't worth losing over one banned-word slip, and
//   bypassing keepRetryOrOriginal()'s whole purpose by never reaching it.
//   Personally verified and fixed with a try/catch that falls back to the
//   original draft on any retry failure.
// - app/checkout/page.tsx's Subscribe-failure focus-restoration claim
//   (accessibility-resweep-newer-code-r27, MEDIUM, 3/3 REFUTE): the exact
//   same finding was already raised and refuted in round 54. The button
//   never unmounts on this path (re-enables in place), so the unmount-
//   without-focus-restore precedent doesn't apply, and the proposed fix
//   would have focused a role="alert" region (a double-announcement
//   anti-pattern) while also colliding with an existing `style` prop
//   (duplicate-JSX-attribute compile error).
// - app/city/page.tsx + app/role/page.tsx's no-skip-option claim (form-
//   validation-consistency-audit-r25, MEDIUM, 3/3 REFUTE): real code shape,
//   but deliberate original product design since the funnel's very first
//   commit (focus/fun say "Optional" in their own copy; city/role never
//   have), not drift -- a live signup-funnel data-collection decision for
//   Algy, not an audit-shippable fix.
// alpha-drift-r79-01, r79-02, r79-03, all 2026-08-21.
// Run: npx tsx scripts/verify-r79-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/api/unsubscribe/route.ts: appOrigin()'s comment no longer claims the old hub proxies forever");
{
  const src = readFileSync(new URL("../app/api/unsubscribe/route.ts", import.meta.url), "utf8");
  check("(1a) the false \"PROXIES here forever\" claim is no longer asserted as fact (the fix's own drift-note mentions the string in prose, so match the original assertion shape, not a bare substring)", !/hub PROXIES here forever/.test(src));
  check("(1b) the comment now correctly describes the 301-redirect and cross-references next.config.ts", /now 301-redirects here\s*\n\/\/ rather than proxying \(see next\.config\.ts's fuller correction\)/.test(src));
}

console.log("(2) lib/engine/topic-blurb.ts: trySonnet()'s truncation branch now logs before rethrowing, matching every sibling tier");
{
  const src = readFileSync(new URL("../lib/engine/topic-blurb.ts", import.meta.url), "utf8");
  check("(2a) the truncation branch now warns before rethrowing", /if \(e instanceof BlurbTruncatedError\) \{\s*\n[\s\S]{0,700}console\.warn\(`\[topic-blurb\] \$\{topicId\} \$\{weekOf\}: Sonnet draft truncated, no tier left to escalate to`\);\s*\n\s*throw e;\s*\n\s*\}/.test(src));
  check("(2b) the 429 branch right below is untouched", /console\.warn\(`\[topic-blurb\] \$\{topicId\} \$\{weekOf\}: Sonnet rate-limited \(429\), skipping the retry`\);\s*\n\s*throw e;/.test(src));
}

console.log("(3) lib/engine/topic-blurb.ts: the Sonnet tells-retry no longer drops the whole topic when the retry itself fails");
{
  const src = readFileSync(new URL("../lib/engine/topic-blurb.ts", import.meta.url), "utf8");
  check("(3a) the retry call is now wrapped in a try/catch", /console\.warn\(`\[topic-blurb\] \$\{topicId\} \$\{weekOf\}: Sonnet draft slipped a banned word[\s\S]{0,50}retrying once`\);\s*\n[\s\S]{0,1200}try \{\s*\n\s*const retryParsed = await trySonnet\(\);/.test(src));
  check("(3b) a failed retry falls back to the original draft rather than propagating", /catch \(e\) \{\s*\n\s*console\.warn\(`\[topic-blurb\] \$\{topicId\} \$\{weekOf\}: Sonnet tells-retry failed, shipping the original draft with its slip: \$\{e instanceof Error \? e\.message : e\}`\);\s*\n\s*\}/.test(src));
  check("(3c) a successful retry still goes through keepRetryOrOriginal unchanged", /finalized = keepRetryOrOriginal\(finalized, retryFinalized\);/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R79 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R79 FINDINGS ASSERTIONS PASS");
