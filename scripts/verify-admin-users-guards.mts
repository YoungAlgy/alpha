// Verify lib/admin-users-guards.ts — pure, no network.
// grant_free and revoke_free both guard against the same mistake: touching
// a row that has a REAL Stripe customer on file. An inverted condition here
// would let an admin click un-cancel a real paying subscriber (grant_free)
// or silently blow away a real paid subscription (revoke_free) -- both had
// zero coverage until this script (found in review 2026-08-06).
// Run: npx tsx scripts/verify-admin-users-guards.mts
const { isFreeGrantEligible } = await import("../lib/admin-users-guards.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) no Stripe customer on file -> eligible for grant_free/revoke_free");
check("(1) null -> eligible", isFreeGrantEligible(null) === true);
check("(1) undefined -> eligible", isFreeGrantEligible(undefined) === true);
check("(1) empty string -> eligible", isFreeGrantEligible("") === true);

console.log("(2) a REAL Stripe customer id on file -> NOT eligible, must be refused");
check("(2) a real cus_ id blocks the action", isFreeGrantEligible("cus_abc123") === false);
check(
  "(2) still blocks even for a customer id that looks malformed -- presence alone is the whole check, not format",
  isFreeGrantEligible("not-a-real-cus-id-but-present") === false
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("ADMIN-USERS GUARDS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ADMIN-USERS GUARDS ASSERTIONS PASS");
