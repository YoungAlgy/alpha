import { createHmac } from "node:crypto";

function bindingSecret(): string {
  // Keep this independent from link-signing and provider credentials. Rotating
  // either of those must not invalidate an in-flight checkout reservation or
  // make an existing active-email lock invisible.
  const value = process.env.CHECKOUT_BINDING_SECRET?.trim();
  if (!value) throw new Error("CHECKOUT_BINDING_SECRET is not configured");
  return value;
}

/**
 * Stable, keyed, one-way binding for a canonical checkout email address.
 * Database-only disclosure cannot be tested against an email dictionary
 * without the server secret. Callers must normalize the address first.
 */
export function checkoutEmailBinding(normalizedEmail: string): string {
  return createHmac("sha256", bindingSecret())
    .update("alpha-checkout-email-v1\0", "utf8")
    .update(normalizedEmail, "utf8")
    .digest("hex");
}
