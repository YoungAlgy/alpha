// Stripe live price ID on the dedicated Alpha account (acct_1TWfDlAhrDpDN9sH,
// separate from Ava Health), so Checkout chrome shows Alpha branding.

import Stripe from "stripe";

export const STRIPE_PRICE_ID = "price_1TWfeHAhrDpDN9sHC2Ay0w7h";

let _stripe: Stripe | null = null;

// Shared Stripe client singleton. Every route used to build its own `new
// Stripe(secret, { apiVersion, httpClient })` with an identical config, which
// meant an API-version bump had to be hand-edited in 8 places and was easy to
// miss one. Centralized here so it's edited once. Throws if
// STRIPE_SECRET_KEY is missing/empty — callers already guard on the secret
// themselves before reaching this, so the throw is a backstop, not the
// primary error path.
export function getStripeClient(): Stripe {
  if (_stripe) return _stripe;
  // Trim — env var paste from clipboards can include trailing \r or
  // whitespace, which Node's HTTP layer rejects when setting the
  // Authorization header.
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  _stripe = new Stripe(secret, {
    apiVersion: "2026-04-22.dahlia",
    httpClient: Stripe.createNodeHttpClient(),
  });
  return _stripe;
}
