// Verify round 46 findings: 10 confirmed, 2 refuted (out of 12 raw findings
// across 5 dimensions -- 0 UNVERIFIED, the automated verify stage worked
// cleanly this round).
// - app/settings/accounts/page.tsx: two separate bugs.
//   (1) act() only reloaded the row list/stats on a clean-success response
//   -- grant_free's own post-commit 502 (round 45's alpha-drift-r45-01)
//   means the DB write can land even though the response reports an error,
//   so the admin's on-screen row stayed stale relative to a write that had
//   actually committed. Moved the reload into a `finally` block.
//   (2) mountedRef was a `useRef(true)` with a cleanup-only effect -- under
//   React Strict Mode dev, the first (discarded) mount's cleanup sets it to
//   false and nothing ever resets it, permanently disabling every
//   `!mountedRef.current` guard for the rest of the component's real
//   lifetime. Matches the already-fixed pattern in archive/page.tsx,
//   inbox/page.tsx, and inbox/[issueId]/page.tsx.
// - app/checkout/page.tsx + components/onboarding/StepShell.tsx:
//   subscribe() had no cancellation guard at all, unlike every other async
//   flow in the funnel that touches navigation -- a reader could hit Back
//   (StepShell's button had no busy-awareness) while the POST was still in
//   flight, and a late resolution could still force window.location.href to
//   Stripe (or router.push to /writing) on top of wherever they'd since
//   navigated. Added a cancelledRef + a new backDisabled prop on StepShell.
// - app/settings/page.tsx: "Delete my account" had zero busy-state UI,
//   unlike every other mutation control on the page -- deleteInFlight (a
//   ref) blocked a second click but gave no visual feedback during the
//   multi-step delete. Added a `deleting` state, disabling the button and
//   swapping its label.
// - app/signin/page.tsx: "Use different email" had no busy guard, unlike
//   the Resend button right next to it -- clicking it while a sendCode/
//   verifyCode request was in flight could let a late resolution snap the
//   reader back to the code step or redirect them to /inbox after they'd
//   already switched away. Same class as EmailChanger's round-45 fix.
// - app/api/account/delete/route.ts: the Stripe-cleanup-before-deleteUser
//   ordering meant a real (non-not-found) deleteUser() failure left an
//   already-cancelled subscription and an already-deleted Stripe customer
//   behind a generic "couldn't delete, try again" -- the user reasonably
//   assumes nothing happened. Reordered so deleteUser() runs first (after a
//   pre-fetch of stripe_customer_id, since the row cascades away on
//   success), gating the Stripe/ticket/suppression cleanup on its outcome.
//   NOTABLE: the identical-shaped finding on app/api/admin/users/route.ts's
//   delete branch (same underlying helpers) was reviewed the SAME round and
//   REFUTED 3/3 -- respected that differentiated verdict (the admin is a
//   trusted operator with direct Stripe-dashboard/log access, unlike a
//   self-serve end user), left that route unchanged.
// - app/api/health/route.ts + README.md (x3): five doc-drift findings, all
//   variations on the same root cause -- the 2026-07-23 flip of
//   topic-blurb.ts's cost-tiering waterfall (Gemini now drafts every blurb
//   by default, Claude only escalates) was never reflected in the health
//   check's own gemini comment, the Stack table's AI row, or the
//   lib/engine/ directory listing's topic-blurb.ts annotation. A separate,
//   unrelated docs-drift finding fixed the cf:deploy chain description,
//   which omitted the real npm run typecheck:worker step.
// alpha-drift-r46-01 through r46-07, all 2026-08-19.
// Run: npx tsx scripts/verify-r46-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/settings/accounts/page.tsx: act() now reloads regardless of outcome, and mountedRef resets on (re)mount");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(1a) the reload call now lives in act()'s finally block", /\} finally \{[\s\S]{0,900}?await load\(activeSearch \? \{ search: activeSearch \} : undefined\);\s*\n\s*setBusy\(null\);/.test(src));
  check("(1b) it's no longer called right after the res.ok check (pre-catch)", !/if \(!res\.ok\) throw new Error\(data\.error \|\| `HTTP \$\{res\.status\}`\);\s*\n\s*await load\(/.test(src));
  check("(1c) mountedRef is now reset to true inside the mount effect body, not just useRef(true)", /useEffect\(\(\) => \{\s*\n\s*mountedRef\.current = true;\s*\n\s*return \(\) => \{ mountedRef\.current = false; \};\s*\n\s*\}, \[\]\);/.test(src));
}

console.log("(2) app/checkout/page.tsx + StepShell.tsx: subscribe() now has a cancellation guard, and Back disables during it");
{
  const checkoutSrc = readFileSync(new URL("../app/checkout/page.tsx", import.meta.url), "utf8");
  // alpha-drift-r47-supersedes-r46 (2026-08-20): this round's own cancelledRef
  // fix was ITSELF the exact Strict-Mode bug this same round fixed for
  // mountedRef elsewhere (cleanup-only, never reset on mount) -- round 47's
  // self-audit and stale-closure-sweep dimensions both caught it independently
  // and it's now fixed to reset in the effect body. Loosened to just confirm
  // the ref still exists and still gets set on cleanup, since the exact
  // cleanup-only shape this assertion originally proved is the very thing that
  // got fixed.
  check("(2a) cancelledRef is declared and gets set true on cleanup", /const cancelledRef = useRef\(false\);/.test(checkoutSrc) && /return \(\) => \{ cancelledRef\.current = true; \};/.test(checkoutSrc));
  check("(2b) subscribe() checks it right after the fetch resolves, before any navigation branch", /const data = await res\.json\(\);\s*\n\s*if \(cancelledRef\.current\) return;/.test(checkoutSrc));
  check("(2c) the catch block also checks it before touching state", /\} catch \(e\) \{\s*\n\s*if \(cancelledRef\.current\) return;\s*\n\s*setSubscribing\(false\);/.test(checkoutSrc));
  check("(2d) StepShell now receives backDisabled tied to subscribing", /<StepShell stepIndex=\{11\} prevPath="email" backDisabled=\{subscribing\}>/.test(checkoutSrc));

  const shellSrc = readFileSync(new URL("../components/onboarding/StepShell.tsx", import.meta.url), "utf8");
  check("(2e) StepShellProps now declares backDisabled", /backDisabled\?: boolean;/.test(shellSrc));
  check("(2f) the Back button is disabled and dims when backDisabled is true", /disabled=\{backDisabled\}\s*\n\s*onClick=\{\(\) => router\.push\(`\/\$\{prevPath\}` as never\)\}\s*\n\s*className="alpha-ui text-sm py-3 -my-3"\s*\n\s*style=\{\{ color: "var\(--ink-soft\)", opacity: backDisabled \? 0\.5 : 1 \}\}/.test(shellSrc));
}

console.log("(3) app/settings/page.tsx: \"Delete my account\" now shows busy state during its multi-step delete");
{
  const src = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(3a) a deleting state is declared", /const \[deleting, setDeleting\] = useState\(false\);/.test(src));
  check("(3b) the button is disabled while deleting", /disabled=\{deleting\}\s*\n\s*onClick=\{async \(\) => \{/.test(src));
  check("(3c) setDeleting(true) fires before the delete request goes out", /deleteInFlight\.current = true;\s*\n\s*setDeleting\(true\);\s*\n\s*const result = await deleteUserAccount\(\);/.test(src));
  check("(3d) the label swaps to a busy state", /\{deleting \? "Deleting…" : "Delete my account"\}/.test(src));
}

console.log("(4) app/signin/page.tsx: \"Use different email\" is now disabled during busy");
{
  const src = readFileSync(new URL("../app/signin/page.tsx", import.meta.url), "utf8");
  check("(4a) the button now has disabled={busy}", /disabled=\{busy\}\s*\n\s*onClick=\{\(\) => \{\s*\n\s*setStep\("email"\);/.test(src));
  check("(4b) it dims to match the busy styling used on the Resend button", /className="underline underline-offset-4"\s*\n\s*style=\{\{ opacity: busy \? 0\.5 : 1, cursor: busy \? "default" : "pointer" \}\}\s*\n\s*>\s*\n\s*Use different email/.test(src));
}

console.log("(5) app/api/account/delete/route.ts: deleteUser() now runs before the Stripe/ticket/suppression cleanup, not after");
{
  const src = readFileSync(new URL("../app/api/account/delete/route.ts", import.meta.url), "utf8");
  check("(5a) stripe_customer_id is pre-fetched before deleteUser()", /const \{ data: row, error: rowErr \} = await svc\s*\n\s*\.from\("users"\)\s*\n\s*\.select\("stripe_customer_id"\)/.test(src));
  const deleteUserIdx = src.indexOf("await svc.auth.admin.deleteUser(user.id);");
  const cleanupIdx = src.indexOf("await cleanUpStripeCustomerBeforeDelete(");
  check("(5b) deleteUser() is called before the Stripe cleanup, not after", deleteUserIdx > -1 && cleanupIdx > -1 && deleteUserIdx < cleanupIdx);
  check("(5c) the pre-fetched id (not a fresh lookup) is passed through, with the rowErr distinction preserved", /cleanUpStripeCustomerBeforeDelete\(svc, user\.id, "\[account\/delete\]", undefined, rowErr \? undefined : \(row\?\.stripe_customer_id \?\? null\)\)/.test(src));
  check("(5d) a pre-fetch query failure is logged, not silently treated as \"no customer\"", /if \(rowErr\) \{\s*\n\s*console\.error\(`\[account\/delete\] pre-fetch of stripe_customer_id failed/.test(src));
}

console.log("(6) docs/comment drift: Gemini's real primary-tier role for topic blurbs is now documented everywhere it was stale");
{
  const healthSrc = readFileSync(new URL("../app/api/health/route.ts", import.meta.url), "utf8");
  check("(6a) health check's gemini comment no longer calls it a reactive-only fallback", !/Fallback provider, not primary — false just means the Brave-outage/.test(healthSrc));
  check("(6b) it now states the PRIMARY generation tier role", /PRIMARY\s*\n\s*\/\/ generation tier for topic blurbs/.test(healthSrc));

  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  check("(6c) README Stack table's AI row now reflects the cost-tiered waterfall", /Gemini → Groq → DeepSeek → Claude Haiku 4\.5 → Claude Sonnet 5, cost-tiered waterfall \(topic blurbs\)/.test(readme));
  check("(6d) README directory listing's topic-blurb.ts annotation no longer says \"Claude synthesis prompt\"", !/topic-blurb\.ts\s+Claude synthesis prompt for one section/.test(readme));
  check("(6e) it now describes the Gemini-primary waterfall", /topic-blurb\.ts\s+cost-tiered blurb generation for one section \(Gemini-primary, Claude last resort\)/.test(readme));
  check("(6f) README's cf:deploy chain description now includes the typecheck:worker step", /`opennextjs-cloudflare build` → `npm run typecheck:worker` → `opennextjs-cloudflare deploy`/.test(readme));
}

console.log("(7) sanity: the refuted admin-delete finding was deliberately left unchanged (differentiated verdict, not a miss)");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  check("(7a) admin delete still runs Stripe cleanup before deleteUser(), unchanged from before round 46", /await cleanUpStripeCustomerBeforeDelete\(\s*\n\s*sb,\s*\n\s*body\.userId,\s*\n\s*"\[admin\/delete\]",/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R46 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R46 FINDINGS ASSERTIONS PASS");
