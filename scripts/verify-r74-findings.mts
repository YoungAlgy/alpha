// Verify round 74 findings: 8 raised, 3 confirmed, 5 refuted.
// - app/signin/page.tsx (self-audit, MEDIUM, 3/3 CONFIRM): the "Use
//   different email" button (OTP-code step) unmounts on click -- the code
//   branch has one extra trailing child (the Resend/Use-different-email
//   div) the email branch lacks, so React's positional reconciliation
//   deletes it on step change, taking the just-focused button with it. The
//   file's own codeInputRef auto-focus effect was one-directional (code
//   step only); the reused <form><input> also means autoFocus never refires
//   on the reverse transition. Fixed by adding emailInputRef and making the
//   [step] effect symmetric.
// - README.md (duplicate-code-audit-r23, LOW, 3/3 CONFIRM): the onboarding
//   funnel bullet and directory-layout tree both said "10 screens" and
//   omitted /you (birthday + gender, unconditionally in the funnel between
//   /fun and /email) -- lib/onboarding-state.ts's ONBOARDING_STEPS and
//   every page's own StepShell stepIndex have always said 11. Fixed both
//   sites.
// - app/inbox/[issueId]/page.tsx (duplicate-code-audit-r23, LOW, 3/3
//   CONFIRM): header comment claimed "No localStorage fallback here; that
//   only lives on the main /inbox" -- false since v0.4, since
//   app/archive/page.tsx reads the identical alpha-first-issue key as its
//   own fallback (and has since before this corrective comment was even
//   written). Reworded to name both siblings precisely instead of the
//   false "only".
// The 5 refuted findings, all well-argued:
// - components/InstallPrompt.tsx's Add/Dismiss buttons (accessibility-
//   resweep-newer-code-r22, MEDIUM, 3/3 REFUTE): real unmount-on-click
//   shape, but the control is the LAST focusable node on the page (nothing
//   to disrupt), Add opens the browser's own native install dialog (not
//   app-controlled), Dismiss fires at most once per browser profile ever,
//   and the finding's own proposed fix (capture activeElement on the
//   banner's arrival, restore on departure) is provably a no-op in the
//   dominant case -- the banner appears ~2.4s after page load before a
//   keyboard user has focused anything, so it "restores" focus to <body>,
//   the exact bug it claims to fix.
// - app/inbox/page.tsx's userError silent-catch (silent-catch-audit,
//   MEDIUM, 3/3 REFUTE): real gap in isolation, but the live issues-RLS
//   policy re-derives the identical entitlement check server-side on the
//   sibling issues query in the same Promise.all, so a fail-open here
//   cannot leak access; and the proposed fix is client-side console.error
//   with no telemetry sink, so it delivers zero of the operator-visibility
//   benefit it claims (unlike round 65's analogous fix on app/letter/
//   page.tsx, a server component whose logs actually reach Cloudflare).
// - components/onboarding/QuestionStep.tsx + app/signin/page.tsx +
//   app/support/SupportForm.tsx's type="email" constraint (form-
//   validation-consistency-audit-r20, MEDIUM, 3/3 REFUTE): this exact
//   finding on these exact 3 files was already raised and refuted 3/3 in
//   round 71 (recorded in scripts/verify-r71-findings.mts) -- the finder
//   should have grepped prior rounds first. Separately, the proposed fix
//   (noValidate on all 3 forms) would have been a net regression: 2 of the
//   3 forms rely on native required-field validation for their empty-
//   submit feedback, which noValidate would silently disable.
// - app/inbox/page.tsx + app/inbox/[issueId]/page.tsx's loadError "Try
//   again" button focus restore (duplicate-code-audit-r23, both MEDIUM,
//   both 3/3 REFUTE): this exact finding, framed the same way ("archive
//   got the r44 fix, these siblings didn't"), was already raised and
//   refuted in round 44 (2/3 each) and round 50 (3/3) -- a deliberate,
//   recorded differentiation from archive's fix, not an oversight. Also,
//   archive's fix pattern (a single always-mounted <h1>) cannot transfer:
//   both inbox pages are structured as multiple disjoint early-return
//   <main> blocks with no shared element across states, and the render
//   immediately following a retry is a purely decorative loading skeleton
//   with nothing focusable at all.
// alpha-drift-r74-01, 2026-08-21.
// Run: npx tsx scripts/verify-r74-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/signin/page.tsx: focus is now restored symmetrically on both step transitions");
{
  const src = readFileSync(new URL("../app/signin/page.tsx", import.meta.url), "utf8");
  check("(1a) an emailInputRef exists alongside the pre-existing codeInputRef", /const codeInputRef = useRef<HTMLInputElement>\(null\);\s*\n\s*const emailInputRef = useRef<HTMLInputElement>\(null\);/.test(src));
  check("(1b) the [step] effect is now symmetric", /if \(step === "code"\) codeInputRef\.current\?\.focus\(\);\s*\n\s*if \(step === "email"\) emailInputRef\.current\?\.focus\(\);\s*\n\s*\}, \[step\]\);/.test(src));
  check("(1c) the email input carries the new ref, autoFocus untouched", /ref=\{emailInputRef\}\s*\n\s*autoFocus\s*\n\s*type="email"/.test(src));
}

console.log("(2) README.md: the onboarding funnel now includes the real 11th screen (/you) in both the prose bullet and the directory tree");
{
  const src = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  check("(2a) the funnel bullet says 11 screens and includes you between fun and email", /\(11 screens, no public landing\) — `welcome → theme → name → city → role → focus → topics → fun → you → email → checkout`/.test(src));
  check("(2b) the directory-layout tree row also includes you", /welcome \/ theme \/ name \/ city \/ role \/ focus \/ topics \/ fun \/ you \/ email \/ checkout   onboarding funnel/.test(src));
}

console.log("(3) app/inbox/[issueId]/page.tsx: the header comment no longer falsely claims the localStorage fallback is unique to /inbox");
{
  const src = readFileSync(new URL("../app/inbox/[issueId]/page.tsx", import.meta.url), "utf8");
  check("(3a) the false \"only lives on the main /inbox\" claim is gone", !/that only lives on the main \/inbox/.test(src));
  check("(3b) the reworded comment correctly names both /inbox and /archive", /\/inbox renders the cached first\s*\n\/\/ issue for signed-out visitors, and \/archive reads the same\s*\n\/\/ alpha-first-issue key to list it/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R74 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R74 FINDINGS ASSERTIONS PASS");
