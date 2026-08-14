// Verify round 20 task #136 (alpha-drift-r20-06, 2026-08-13): a continuously-
// subscribed reader who bounces or complains mid-subscription had NO recovery
// path at all.
//
// bounced_at/complained_at (this app's DB flags) and Resend's own account-
// level suppression list were only ever cleared on a re-consent moment: a
// fresh Stripe checkout (lib/webhook-user-mutation.ts) or a first-time
// signup/resubscribe-after-deletion (lib/engine/persist.ts, gated on
// verificationType !== "magiclink" -- see verify-resend-suppression-removal
// for that gate's own coverage). A reader who never re-checks out and never
// gets deleted -- i.e. every genuinely still-subscribed reader -- has no such
// moment ahead of them: every later magic-link exchange resolves to
// "magiclink" for an existing user, so persist.ts's gate never fires again.
// The only other clearer, admin `grant_free`, explicitly REFUSES to act on
// anyone with a real Stripe subscription (isFreeGrantEligible) -- so a PAYING
// subscriber who bounces had no recovery path whatsoever, and was also
// invisible to the admin (bounced_at/complained_at weren't even selected in
// the admin list query).
//
// Fix: (1) select bounced_at/complained_at in GET /api/admin/users so a
// suppressed reader is visible; (2) a new `clear_suppression` admin action,
// deliberately NOT gated by isFreeGrantEligible (unlike grant_free/
// revoke_free) since it must work on a real paying subscriber -- clears both
// DB flags and calls removeResendSuppression; (3) a "Clear suppression"
// button in the admin UI, shown only when a reader is actually suppressed.
//
// Like the sibling grant_free/revoke_free/delete admin actions, this has no
// live-write test (mutating a real production user row for a test isn't
// something this repo's admin-route tests do -- verify-admin-users-guards.mts
// only covers the pure isFreeGrantEligible guard). This is a source-level
// regression guard instead, proving the fix is fully wired end to end:
// the exact class of "looks fixed in one file, silently missing from its
// pair" drift this session's rounds keep catching.
// Run: npx tsx scripts/verify-clear-suppression-action.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const routeSrc = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
const uiSrc = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");

console.log("(1) route: the action exists, is reachable, and is NOT billing-gated");
{
  check("(1) clear_suppression is a valid action in the Zod schema", /z\.enum\(\[[^\]]*"clear_suppression"[^\]]*\]\)/.test(routeSrc));
  check("(1) the route has a real handler branch for it", /body\.action === "clear_suppression"/.test(routeSrc));
  // Extract just the clear_suppression branch to scope the rest of the checks
  // narrowly (avoid false-passing on isFreeGrantEligible calls that belong to
  // the sibling grant_free/revoke_free branches above it in the same file).
  const branchStart = routeSrc.indexOf('body.action === "clear_suppression"');
  const branchEnd = routeSrc.indexOf("\n  return NextResponse.json({ error: \"Unknown action\"", branchStart);
  const branch = branchStart > -1 && branchEnd > -1 ? routeSrc.slice(branchStart, branchEnd) : "";
  check("(1) branch was actually extracted (sanity check on the slice above)", branch.length > 100);
  check(
    "(1) deliberately NOT gated by isFreeGrantEligible -- must work on a real paying subscriber, unlike grant_free/revoke_free",
    // Match a real function CALL, not the identifier appearing anywhere --
    // the branch's own explanatory comment mentions the name in prose.
    !branch.includes("isFreeGrantEligible(")
  );
  check("(1) clears bounced_at", /bounced_at:\s*null/.test(branch));
  check("(1) clears complained_at", /complained_at:\s*null/.test(branch));
  check("(1) calls removeResendSuppression (the Resend-side clear, not just the DB flags)", /removeResendSuppression\(/.test(branch));
  check("(1) handles the missing-row case explicitly (mirrors grant_free/revoke_free's alpha-drift-r17-01 fix)", /User not found/.test(branch));
}

console.log("(2) route: a suppressed reader is now visible in the admin list (was previously invisible)");
{
  check("(2) bounced_at is selected in the GET query", /\.select\([^)]*bounced_at/.test(routeSrc));
  check("(2) complained_at is selected in the GET query", /\.select\([^)]*complained_at/.test(routeSrc));
}

console.log("(3) UI: the button is wired, type-safe, and conditionally shown");
{
  check("(3) AdminUserRow carries bounced_at", /bounced_at:\s*string \| null/.test(uiSrc));
  check("(3) AdminUserRow carries complained_at", /complained_at:\s*string \| null/.test(uiSrc));
  check("(3) act()'s action union includes clear_suppression", /"clear_suppression"/.test(uiSrc));
  check("(3) an isSuppressed derivation exists, driven by bounced_at OR complained_at", /isSuppressed\s*=\s*!!u\.bounced_at\s*\|\|\s*!!u\.complained_at/.test(uiSrc));
  check("(3) the Clear suppression button is gated on isSuppressed, not always shown", /\{isSuppressed && \(\s*<button/.test(uiSrc));
  check("(3) the button actually dispatches the clear_suppression action", /act\(\s*u\.id,\s*"clear_suppression"/.test(uiSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("CLEAR-SUPPRESSION-ACTION VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL CLEAR-SUPPRESSION-ACTION ASSERTIONS PASS");
