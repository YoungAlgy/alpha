// REAL end-to-end check of cancelCustomerSubscriptions (the account-deletion
// path) against TEST Stripe: creates a throwaway product/price/customer/
// subscription, cancels it via the actual helper, asserts it's canceled +
// idempotent, then cleans up. HARD-REFUSES anything but a test key, so it can
// never touch the live account / the real subscriber.
//
// Run AFTER putting your sk_test_ key in .env.local:
//   npx tsx scripts/verify-stripe-cancel-testmode.mts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const key = process.env.STRIPE_SECRET_KEY?.trim() || "";
if (!key.startsWith("sk_test")) {
  console.error(
    `REFUSING TO RUN: STRIPE_SECRET_KEY starts with "${key.slice(0, 7)}", not "sk_test". This harness only runs in Stripe TEST mode.`
  );
  process.exit(1);
}

const Stripe = (await import("stripe")).default;
const { cancelCustomerSubscriptions } = await import("../lib/stripe-cancel.ts");
const stripe = new Stripe(key, { apiVersion: "2026-04-22.dahlia" } as never);

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

let productId: string | undefined;
let customerId: string | undefined;
try {
  const product = await stripe.products.create({ name: "Alpha delete-flow verify (TEST)" });
  productId = product.id;
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: 500,
    currency: "usd",
    recurring: { interval: "month" },
  });
  const customer = await stripe.customers.create({
    email: "alpha-delete-verify@example.com",
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
  });
  customerId = customer.id;
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
  });
  console.log(`setup: customer ${customer.id}, subscription ${sub.id} (status=${sub.status})`);

  const r1 = await cancelCustomerSubscriptions(stripe, customer.id);
  console.log(`(1) cancelCustomerSubscriptions → ${JSON.stringify(r1)}`);
  check("cancelled the subscription", r1.cancelled.includes(sub.id));
  check("no errors", r1.errors === 0);

  const after = await stripe.subscriptions.retrieve(sub.id);
  check(`subscription status is 'canceled' (got '${after.status}')`, after.status === "canceled");

  const r2 = await cancelCustomerSubscriptions(stripe, customer.id);
  console.log(`(2) idempotent second pass → ${JSON.stringify(r2)}`);
  check("second pass cancels nothing", r2.cancelled.length === 0);
  check("second pass skips the canceled sub", r2.skipped >= 1);
} catch (e) {
  console.error(`harness error: ${e instanceof Error ? e.message : e}`);
  fail++;
} finally {
  try {
    if (customerId) await stripe.customers.del(customerId);
  } catch {}
  try {
    if (productId) await stripe.products.update(productId, { active: false });
  } catch {}
  console.log("cleanup: test customer deleted, product archived");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("TEST-MODE CANCEL VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL TEST-MODE CANCEL-ON-DELETE ASSERTIONS PASS");
