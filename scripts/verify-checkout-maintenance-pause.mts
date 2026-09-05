// Fully local checks for the checkout maintenance gate. No env files,
// provider clients, network, database, or app data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkoutMode } from "../lib/checkout-maintenance.ts";

assert.equal(checkoutMode(undefined), "paused");
assert.equal(checkoutMode(""), "paused");
assert.equal(checkoutMode("false"), "paused");
assert.equal(checkoutMode("0"), "paused");
assert.equal(checkoutMode("paused"), "paused");
assert.equal(checkoutMode("typo-fails-closed"), "paused");
assert.equal(checkoutMode("open"), "open");
assert.equal(checkoutMode(" OPEN "), "open");

const route = readFileSync(
  new URL("../app/api/stripe/checkout/route.ts", import.meta.url),
  "utf8"
);
const gateIndex = route.indexOf("checkoutMode(process.env.ALPHA_CHECKOUT_MODE)");
const rateLimitIndex = route.indexOf("const ip = clientKeyFromRequest(req)");
const stripeIndex = route.indexOf("process.env.STRIPE_SECRET_KEY");
assert.ok(gateIndex > 0);
assert.ok(gateIndex < rateLimitIndex);
assert.ok(gateIndex < stripeIndex);
assert.match(route, /withDeadline\(req\.json\(\), 5_000, "checkout request body"\)/);
assert.match(route, /error: "checkout_temporarily_paused"/);
assert.match(route, /"Cache-Control": "no-store, must-revalidate"/);
assert.match(route, /"Retry-After": "300"/);

const wrangler = readFileSync(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8"
);
assert.match(wrangler, /"ALPHA_CHECKOUT_MODE": "paused"/);

const runbook = readFileSync(
  new URL("../docs/CHECKOUT_MAINTENANCE.md", import.meta.url),
  "utf8"
);
assert.match(runbook, /NEXT_PUBLIC_ALPHA_RELEASE_SHA=<GUARD_SHA>/);
assert.match(runbook, /Revoke the exact old Stripe key/);
assert.match(runbook, /post-rotation\s+paused guard Worker is the only later rollback target/);
assert.match(runbook, /20-second attempts and at most one retry/);
assert.match(runbook, /Add that exact non-secret value to the full Round 80 `wrangler\.jsonc`/);

console.log("PASS verify-checkout-maintenance-pause (offline, 21 assertions)");
