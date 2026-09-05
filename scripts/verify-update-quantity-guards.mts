// Verify lib/update-quantity-guards.ts — pure, no network. update-quantity
// is the only OTHER route besides checkout that changes what a subscriber is
// billed, but unlike checkout (whose guards live in lib/checkout-guards.ts
// specifically so scripts/verify-checkout-guards.mts can test them) this
// route's equivalent logic was inline and untested until this script (found
// in review 2026-08-06). An inverted Math.min/Math.max here silently over-
// or under-bills add-on units; a broken status-set lookup silently 400s a
// real paying subscriber trying to change tier.
// Run: npx tsx scripts/verify-update-quantity-guards.mts
import { readFileSync } from "node:fs";

const { nextQuantity, isLiveForManagement, MAX_QTY, MIN_QTY } = await import(
  "../lib/update-quantity-guards.ts"
);

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
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

// --- exact Alpha subscription binding in the mutation route ---------------
console.log("(5) update route binds and mutates only one exact Alpha subscription");
{
  const route = readFileSync(
    new URL("../app/api/stripe/update-quantity/route.ts", import.meta.url),
    "utf8"
  );
  check(
    "(5a) the user lookup includes the durable subscription id",
    route.includes("stripe_customer_id, stripe_subscription_id, topic_quota")
  );
  check(
    "(5b) a stored id is retrieved directly instead of scanning for the first live product",
    route.includes("stripe.subscriptions.retrieve(storedSubscriptionId)") &&
      !route.includes("subs.data.find((s) => isLiveForManagement(s.status))")
  );
  check(
    "(5c) exact identity includes customer, one item, Alpha price, and quantity 1 through 5",
    route.includes("stripeCustomerId(sub.customer) !== customerId") &&
      route.includes("sub.items.data.length !== 1") &&
      route.includes("priceId === STRIPE_PRICE_ID") &&
      route.includes("(quantity as number) >= 1") &&
      route.includes("(quantity as number) <= 5")
  );
  check(
    "(5d) legacy lookup is restricted to the Alpha price and rejects pagination",
    /stripe\.subscriptions\.list\(\{[\s\S]{0,250}customer: row\.stripe_customer_id,[\s\S]{0,120}price: STRIPE_PRICE_ID,[\s\S]{0,120}limit: 100/.test(route) &&
      route.includes("if (subs.has_more || !Array.isArray(subs.data))")
  );
  check(
    "(5e) legacy lookup rejects invalid shapes and multiple current matches",
    route.includes("if (!isExactAlphaSubscription(candidate, row.stripe_customer_id))") &&
      route.includes("if (legacyMatches.length > 1)")
  );
  check(
    "(5f) a legacy id is persisted with a compare-and-set",
    route.includes(".update({ stripe_subscription_id: sub.id })") &&
      route.includes('.is("stripe_subscription_id", null)') &&
      route.includes("racedRow?.stripe_subscription_id !== sub.id")
  );
  check(
    "(5g) only the verified Alpha item id is sent to Stripe",
    route.includes("!item || !isExactAlphaSubscription(sub, row.stripe_customer_id)") &&
      route.includes("{ items: [{ id: item.id, quantity: nextQty }] }")
  );
  check(
    "(5h) the post-update read is checked against the same exact binding",
    route.includes("fresh.id !== sub.id") &&
      route.includes("!isExactAlphaSubscription(fresh, row.stripe_customer_id)")
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("UPDATE-QUANTITY GUARDS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL UPDATE-QUANTITY GUARDS ASSERTIONS PASS");
