// Verify lib/update-quantity-guards.ts — pure, no network. update-quantity
// is the only OTHER route besides checkout that changes what a subscriber is
// billed, but unlike checkout (whose guards live in lib/checkout-guards.ts
// specifically so scripts/verify-checkout-guards.mts can test them) this
// route's equivalent logic was inline and untested until this script (found
// in review 2026-08-06). An inverted Math.min/Math.max here silently over-
// or under-bills add-on units; a broken status-set lookup silently 400s a
// real paying subscriber trying to change tier.
// Run: npx tsx scripts/verify-update-quantity-guards.mts
const { nextQuantity, isLiveForManagement, MAX_QTY, MIN_QTY } = await import(
  "../lib/update-quantity-guards.ts"
);

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// --- nextQuantity: boundaries + a full up-then-down round trip -------------
console.log("(1) nextQuantity — up direction");
check(`(1) MAX_QTY is 5 (25 topics / 5 per bundle)`, MAX_QTY === 5);
check(`(1) MIN_QTY is 1 (5 topics / 5 per bundle)`, MIN_QTY === 1);
check("(1) up from 1 -> 2", nextQuantity("up", 1) === 2);
check("(1) up from 4 -> 5 (reaches the max)", nextQuantity("up", 4) === 5);
check("(1) up from 5 -> 5 (already at max, no-op, NOT 6)", nextQuantity("up", 5) === 5);
check("(1) up from an already-out-of-range 7 clamps DOWN to 5, doesn't grow further", nextQuantity("up", 7) === 5);

console.log("(2) nextQuantity — down direction");
check("(2) down from 5 -> 4", nextQuantity("down", 5) === 4);
check("(2) down from 2 -> 1 (reaches the min)", nextQuantity("down", 2) === 1);
check("(2) down from 1 -> 1 (already at min, no-op, NOT 0)", nextQuantity("down", 1) === 1);
check("(2) down from an already-out-of-range 0 clamps UP to 1, doesn't shrink further", nextQuantity("down", 0) === 1);

console.log("(3) full up-then-down round trip returns to the start");
let qty = 1;
for (let i = 0; i < 4; i++) qty = nextQuantity("up", qty);
check("(3) four ups from 1 reaches exactly MAX_QTY (5)", qty === MAX_QTY);
for (let i = 0; i < 4; i++) qty = nextQuantity("down", qty);
check("(3) four downs back down reaches exactly MIN_QTY (1)", qty === MIN_QTY);

// --- isLiveForManagement: every real Stripe subscription status -----------
console.log("(4) isLiveForManagement — the real Stripe status set");
check("(4) active -> manageable", isLiveForManagement("active") === true);
check("(4) trialing -> manageable (100%-off comp checkouts)", isLiveForManagement("trialing") === true);
check("(4) past_due -> manageable (Smart Retry window, access still live)", isLiveForManagement("past_due") === true);
check("(4) canceled -> NOT manageable", isLiveForManagement("canceled") === false);
check("(4) incomplete_expired -> NOT manageable", isLiveForManagement("incomplete_expired") === false);
check("(4) unpaid -> NOT manageable", isLiveForManagement("unpaid") === false);
check("(4) incomplete -> NOT manageable (never completed initial payment)", isLiveForManagement("incomplete") === false);
check("(4) paused -> NOT manageable", isLiveForManagement("paused") === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("UPDATE-QUANTITY GUARDS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL UPDATE-QUANTITY GUARDS ASSERTIONS PASS");
