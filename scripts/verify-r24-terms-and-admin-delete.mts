// Verify round 24 findings #171 (terms.tsx overstates the Billing Portal
// button as the normal cancel path when the Stripe account has zero portal
// configurations, so it always fails), #174 (terms.tsx's "we'll resend your
// most recent letter" promise doesn't hold for a brand-new subscriber's very
// first send), and #175 (admin user-delete fetched the same public.users row
// twice -- once for email, once inside cleanUpStripeCustomerBeforeDelete for
// stripe_customer_id). alpha-drift-r24-03/05/06, all 2026-08-14.
// Run: npx tsx scripts/verify-r24-terms-and-admin-delete.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// JSX text wraps across source lines with arbitrary indentation, and apostrophes
// are written as the &apos; HTML entity (6 chars), not a literal ' -- collapsing
// all whitespace runs to a single space and matching &apos; literally avoids the
// false negatives that come from guessing exact line breaks or wildcarding the
// entity as a single "any character".
function normalize(src: string): string {
  return src.replace(/\s+/g, " ");
}

console.log("(1) terms.tsx: cancellation copy leads with email (the only path that actually works today), doesn't overstate the button");
{
  const src = normalize(readFileSync(new URL("../app/terms/page.tsx", import.meta.url), "utf8"));
  check("(1a) no longer says \"if that button doesn't work for you\" (implied it usually does)", !/doesn&apos;t work for you/.test(src));
  check("(1b) leads with email as the direct cancellation path", /You can cancel any time\. Email us and we&apos;ll cancel it the same day/.test(src));
  check("(1c) still mentions the Settings → Billing button, hedged with \"when it's live for your account\"", /Manage subscription button in Settings → Billing[\s\S]*?when it&apos;s live for your account/.test(src));
  check("(1d) still states the billing-cycle-end cancellation timing (unchanged fact, not part of this fix)", /cancellation takes effect at the end of the current billing cycle/.test(src));
}

console.log("(2) terms.tsx: first-letter resend promise now caveats brand-new subscribers");
{
  const src = normalize(readFileSync(new URL("../app/terms/page.tsx", import.meta.url), "utf8"));
  check("(2a) still promises the resend-most-recent-letter fallback for existing subscribers", /we&apos;ll resend your most recent one and say so plainly in the letter itself/.test(src));
  check("(2b) new caveat: fallback needs a prior letter, doesn't cover the very first one", /doesn&apos;t apply to your very first one as a new subscriber/.test(src));
  check("(2c) new caveat: says what actually happens instead (no letter that day, retried next scheduled send)", /you simply won&apos;t get one that day, and we try again on the next scheduled send/.test(src));
}

console.log("(3) lib/stripe-cancel.ts: cleanUpStripeCustomerBeforeDelete accepts an optional pre-fetched customer id");
{
  const src = readFileSync(new URL("../lib/stripe-cancel.ts", import.meta.url), "utf8");
  check("(3a) new 5th parameter exists", /preFetchedCustomerId\?:\s*string\s*\|\s*null/.test(src));
  check("(3b) uses a strict undefined check (not a falsy check) to distinguish omitted from explicit null", /customerId === undefined/.test(src));
  check("(3c) the Supabase lookup is now conditional, not unconditional", /if \(customerId === undefined\) \{[\s\S]{0,200}from\("users"\)/.test(src));
}

console.log("(4) app/api/admin/users/route.ts: delete branch selects stripe_customer_id in the SAME query as email, passes it through");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  check("(4a) single select now asks for both columns", /select\("email, stripe_customer_id"\)/.test(src));
  // Note: app/api/admin/users/route.ts has an unrelated select("email") call
  // elsewhere (a different action, not the delete branch) -- this check is
  // scoped to the delete-branch block specifically, not a bare file-wide grep.
  const deleteBlockMatch = src.match(/if \(body\.action === "delete"\) \{([\s\S]*?)return NextResponse\.json\(\{ ok: true \}\);/);
  check("(4b) the delete branch itself was found", !!deleteBlockMatch);
  const deleteBlock = deleteBlockMatch ? deleteBlockMatch[1] : "";
  check("(4c) delete branch no longer selects email alone", !/select\("email"\)/.test(deleteBlock));
  check("(4d) cleanUpStripeCustomerBeforeDelete is called with the pre-fetched id as the 5th argument", /cleanUpStripeCustomerBeforeDelete\(\s*sb,\s*body\.userId,\s*"\[admin\/delete\]",\s*undefined,\s*targetUser\?\.stripe_customer_id\s*\)/.test(deleteBlock));
}

console.log("(5) sanity: account/delete/route.ts is UNCHANGED -- still omits the new param, still relies on its own internal lookup");
{
  const src = readFileSync(new URL("../app/api/account/delete/route.ts", import.meta.url), "utf8");
  check("(5a) still calls with exactly 3 arguments (no pre-fetch to pass -- it never needed stripe_customer_id for anything else)", /cleanUpStripeCustomerBeforeDelete\(svc, user\.id, "\[account\/delete\]"\);/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R24 TERMS + ADMIN-DELETE VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R24 TERMS + ADMIN-DELETE ASSERTIONS PASS");
