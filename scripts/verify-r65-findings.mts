// Verify round 65 findings: 9 raised, 6 confirmed, 3 refuted (a proposed
// aria-hidden addition to app/writing/page.tsx's step glyph, and two
// proposed loadSeqRef additions to app/inbox/page.tsx + app/archive/page.tsx
// -- all three respected). First round to break the zero-split-vote streak
// (2 of 6 confirmed findings split 2-1 on genuinely close judgment calls,
// both resolved by reading the dissenting reasoning, not just the count).
// - components/ScrollFadeIn.tsx + app/globals.css (self-audit-r64, HIGH):
//   round 64's own reduced-motion fix read prefers-reduced-motion at
//   useState-init time -- SSR always emits shown=false (window is
//   undefined in Node), but a reduced-motion visitor's first CLIENT render
//   said true, and React never patches a hydration mismatch in
//   production. On app/letter/page.tsx and app/sample/page.tsx (genuine
//   Server Components rendering <Digest> synchronously, unlike inbox/
//   archive/[issueId]'s client-gated loading state), every topic section
//   stayed PERMANENTLY INVISIBLE for reduced-motion readers -- a cosmetic
//   fade became content-blanking on the actual "Read the full letter"
//   email link and the public /sample trust page. Fixed with useState(false)
//   for SSR/client parity plus a CSS-only @media override that snaps the
//   post-mount flip instant instead of animated, since media queries
//   evaluate identically for SSR-emitted markup and client paint.
// - app/globals.css (self-audit-r64, MEDIUM): round 64's own --ink
//   focus-ring fix fused into arcade theme's pre-existing hard-edged ink
//   box-shadow on .alpha-button (same color, same 3px offset) -- a real
//   WCAG fix everywhere else seeded a fresh visual defect in one theme the
//   same round. Fixed with an arcade-scoped outline-offset bump (NOT
//   arcade's --accent, which itself fails the same 3:1 floor).
// - app/settings/accounts/page.tsx (accessibility-resweep-newer-code-r13,
//   LOW, 2-1 split): act()'s focus-restoration only fired on a clean
//   success -- a failure that still landed its DB write (grant_free's own
//   documented 502-after-write case) triggers the identical reload/
//   unmount as success but never restored focus. Moved the counter
//   increment into the finally block so it fires whenever the reload
//   actually ran.
// - app/letter/page.tsx (duplicate-code-audit-r15, MEDIUM): the issues-
//   query error was discarded on the app's highest-traffic email CTA,
//   unlike the 3 sibling pages this exact Promise.all pattern was copied
//   to (all of which check it). Log-only fix, plus the already-destructured
//   but never-logged userError on the same line.
// - lib/stripe-cancel.ts (silent-catch-audit-r11, HIGH): the subscription-
//   cancel step and the customer-delete step shared one try/catch, so a
//   throw out of subscriptions.list() skipped customers.del() entirely --
//   and per Stripe's own documented behavior, deleting the Customer is
//   what actually cancels a still-live subscription. Split into separate
//   try/catches (matching the pattern app/api/stripe/webhook/route.ts
//   already uses for this same function), plus an ops alert if BOTH steps
//   fail. Extended scripts/verify-stripe-cancel-on-delete.mts with 2 new
//   tests (listThrows, both-fail) -- neither failure mode had test
//   coverage before.
// - app/api/account/email/reconcile/route.ts + components/EmailChanger.tsx
//   (form-validation-consistency-audit-r10, LOW): both files' comments
//   misattributed the reconcile trigger to "the settings page fires this
//   on load" -- wrong since the feature shipped (git blame: same commit
//   introduced both the comment and the real ThemeApplier.tsx trigger).
//   Corrected in 3 spots (both route.ts comments + EmailChanger.tsx) to
//   match ThemeApplier's own already-correct r56-05 comment.
// alpha-drift-r65-01 through r65-06, all 2026-08-21.
// Run: npx tsx scripts/verify-r65-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) components/ScrollFadeIn.tsx + app/globals.css: SSR/hydration mismatch fixed with a CSS-only reduced-motion override");
{
  const src = readFileSync(new URL("../components/ScrollFadeIn.tsx", import.meta.url), "utf8");
  check("(1a) shown initializes to a bare false (SSR/client parity)", /const \[shown, setShown\] = useState\(false\);/.test(src));
  check("(1b) the matchMedia check now lives inside the effect, after the window guard", /if \(typeof window === "undefined"\) return;\s*\n\s*const el = ref\.current;\s*\n\s*if \(!el\) return;\s*\n\s*\n\s*if \(window\.matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)\.matches\) \{\s*\n\s*setShown\(true\);\s*\n\s*return;\s*\n\s*\}/.test(src));
  check("(1c) the wrapper carries a stable class a stylesheet rule can target", /className=\{`alpha-scroll-fade\$\{className \? ` \$\{className\}` : ""\}`\}/.test(src));

  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  check("(1d) a reduced-motion override snaps the post-mount flip instead of animating it", /\.alpha-scroll-fade \{ transition: none !important; \}/.test(css));
}

console.log("(2) app/globals.css: arcade's focus ring clears its own pre-existing box-shadow instead of fusing into it");
{
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  check("(2a) an arcade-scoped focus-visible override exists", /\[data-theme="arcade"\] \.alpha-button:focus-visible \{\s*\n\s*outline-offset: 6px;\s*\n\s*\}/.test(css));
  check("(2b) it does NOT reuse arcade's --accent (fails the same 3:1 floor)", !/\[data-theme="arcade"\] \.alpha-button:focus-visible \{\s*\n\s*outline(?:-color)?: [^\n]*var\(--accent\)/.test(css));
}

console.log("(3) app/settings/accounts/page.tsx: focus restoration now fires on a failed action too, not just a clean success");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(3a) setActionCount is no longer inside the try block's success branch", !/setActionMsg\(`\$\{verb\} \$\{email\}\.`\);\s*\n\s*\/\/ alpha-drift-r61-03[\s\S]{0,80}setActionCount/.test(src));
  check("(3b) setActionCount now runs in the finally block, after load() resolves", /await load\(activeSearch \? \{ search: activeSearch \} : undefined\);\s*\n[\s\S]{0,700}setActionCount\(\(c\) => c \+ 1\);/.test(src));
}

console.log("(4) app/letter/page.tsx: both Promise.all query errors are now logged");
{
  const src = readFileSync(new URL("../app/letter/page.tsx", import.meta.url), "utf8");
  check("(4a) the issues-query error is now destructured", /const \[\{ data: userRow, error: userError \}, \{ data: issueRow, error: issueError \}\] = await Promise\.all\(/.test(src));
  check("(4b) userError is now logged", /if \(userError\) console\.error\("\[letter\] users query error:", userError\.message\);/.test(src));
  check("(4c) issueError is now logged with a distinguishable message from the outer catch", /if \(issueError\) console\.error\("\[letter\] issues query error:", issueError\.message\);/.test(src));
}

console.log("(5) lib/stripe-cancel.ts: the subscription-cancel and customer-delete steps are now independent, with an ops alert if both fail");
{
  const src = readFileSync(new URL("../lib/stripe-cancel.ts", import.meta.url), "utf8");
  check("(5a) cancelCustomerSubscriptions() now has its own try/catch, separate from customers.del()", /let cancelFailed = false;\s*\n\s*try \{\s*\n\s*const \{ cancelled, skipped, errors \} = await cancelCustomerSubscriptions/.test(src));
  check("(5b) a cancel-step failure does not prevent the customer-delete attempt", /\} catch \(cancelErr\) \{\s*\n\s*cancelFailed = true;/.test(src) && /try \{\s*\n\s*await stripe\.customers\.del\(customerId\);/.test(src));
  check("(5c) an ops alert fires only when BOTH steps failed", /if \(cancelFailed\) \{\s*\n[\s\S]{0,500}sendOpsAlert\(/.test(src));

  const verify = readFileSync(new URL("../scripts/verify-stripe-cancel-on-delete.mts", import.meta.url), "utf8");
  check("(5d) the verify script's stub supports simulating subscriptions.list() throwing", /function stub\(subs: Sub\[\], throwOn: string\[\] = \[\], customerDelThrows = false, listThrows = false\)/.test(verify));
  check("(5e) a new test asserts customers.del() still runs when list() throws", /\(13b\) customers\.del\(\) was still attempted/.test(verify));
}

console.log("(6) app/api/account/email/reconcile/route.ts + components/EmailChanger.tsx: comments now correctly attribute the trigger to ThemeApplier");
{
  const route = readFileSync(new URL("../app/api/account/email/reconcile/route.ts", import.meta.url), "utf8");
  check("(6a) route.ts no longer claims the settings page fires this on load", !/The settings page fires this on load/.test(route));
  check("(6b) route.ts now attributes it to ThemeApplier", /ThemeApplier\.tsx is the app's SOLE\s*\n\s*\/\/ trigger/.test(route));
  check("(6c) the rate-limit rationale no longer cites the wrong fire pattern", !/fires once per \/settings/.test(route));

  const changer = readFileSync(new URL("../components/EmailChanger.tsx", import.meta.url), "utf8");
  check("(6d) EmailChanger.tsx no longer claims the settings page's reconcile syncs the mirror", !/where the page's reconcile syncs/.test(changer));
  check("(6e) EmailChanger.tsx now attributes it to ThemeApplier's hydrate effect", /components\/ThemeApplier\.tsx's hydrate effect/.test(changer));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R65 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R65 FINDINGS ASSERTIONS PASS");
