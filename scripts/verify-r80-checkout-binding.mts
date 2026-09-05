// Local cryptographic checks only. Loads no env file and makes no I/O calls.
import { createHmac } from "node:crypto";
import { checkoutEmailBinding } from "../lib/checkout-binding.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed += 1;
  else failed += 1;
}

process.env.CHECKOUT_BINDING_SECRET = "round-80-local-test-secret-only";
const email = "reader@example.com";
const expected = createHmac(
  "sha256",
  "round-80-local-test-secret-only"
)
  .update("alpha-checkout-email-v1\0", "utf8")
  .update(email, "utf8")
  .digest("hex");

console.log("(1) checkout email bindings are keyed and domain-separated");
check("(1a) matches the exact keyed construction", checkoutEmailBinding(email) === expected);
check("(1b) is stable for the same canonical email", checkoutEmailBinding(email) === expected);
check(
  "(1c) does not collide for another email",
  checkoutEmailBinding("other@example.com") !== expected
);
check("(1d) remains a 64-character database binding", /^[0-9a-f]{64}$/.test(expected));

delete process.env.CHECKOUT_BINDING_SECRET;
let missingSecretFailedClosed = false;
try {
  checkoutEmailBinding(email);
} catch {
  missingSecretFailedClosed = true;
}
check("(1e) a missing binding secret fails closed", missingSecretFailedClosed);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("R80 CHECKOUT BINDING ASSERTIONS PASS");
