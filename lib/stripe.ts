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
  // Bound each ATTEMPT at 20s (vs the SDK's 80s default) with one retry,
  // mirroring anthropicClient()'s { timeout, maxRetries }. Without this,
  // generate/route.ts's verifyPaid() calls checkout.sessions.retrieve()
  // BEFORE its own 105s withDeadline even starts — an unbounded Stripe leg
  // could alone burn most of the route's 120s maxDuration.
  //
  // createFetchHttpClient(), NOT createNodeHttpClient(): this app runs on
  // Cloudflare Workers (workerd), which only supports outbound networking
  // via the Fetch API -- there are no raw TCP sockets for Node's http/https
  // modules to open, even under OpenNext's Node-compat layer. Found live in
  // production (2026-08-06): createNodeHttpClient() made every
  // checkout.sessions.create() call hang until the 20s timeout, retry once,
  // hang again, and fail -- checkout was completely broken for real
  // subscribers. Reproduced by comparing a local Node call (succeeds in
  // ~700ms) against the identical call through the deployed Worker (hangs
  // ~15-30s then fails) with the exact same verified-good API key --
  // confirmed the failure was httpClient-specific, not a bad key.
  // alpha-drift-r22-01 (found+fixed 2026-08-14): bumped from 2026-04-22 to
  // match the stripe npm package's own pinned type after an in-range `npm
  // update`. Both are monthly releases within the same "dahlia" train --
  // per Stripe's own versioning policy (docs.stripe.com/sdks/versioning),
  // every monthly release within a train is backward-compatible by
  // guarantee; only a new NAMED train (e.g. dahlia -> the next codename)
  // carries breaking changes. Confirmed before bumping, not assumed --
  // this pins live production billing.
  _stripe = new Stripe(secret, {
    apiVersion: "2026-07-29.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
    timeout: 20_000,
    maxNetworkRetries: 1,
  });
  return _stripe;
}
