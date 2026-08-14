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

// alpha-drift-r29-05 (2026-08-14): every Stripe call site in the app (7 of
// them across checkout/portal/update-quantity/webhook/stripe-cancel) caught
// errors identically -- `e instanceof Error ? e.message : e` -- and never
// read the Stripe SDK's own structured error info (StripeError's
// type/code/statusCode/requestId), unlike every OTHER provider client here:
// lib/engine/client.ts's isAnthropicUnavailable classifies retryable vs not,
// lib/engine/openai-compat.ts's throwCompatError and lib/brave.ts both log
// the real HTTP status + response body. A rate limit, a rotated/revoked key,
// a malformed request, and a genuine Stripe outage all looked identical in
// every log line this app has ever written for a Stripe failure. These two
// helpers mirror isAnthropicUnavailable's shape/purpose for Stripe.
export function describeStripeError(e: unknown): string {
  if (e instanceof Stripe.errors.StripeError) {
    const parts = [e.type];
    if (e.code) parts.push(`code=${e.code}`);
    if (typeof e.statusCode === "number") parts.push(`status=${e.statusCode}`);
    if (e.requestId) parts.push(`request=${e.requestId}`);
    return `${parts.join(" ")}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

// True only for a failure a retry could plausibly fix: a network/connection
// problem, a Stripe-side outage (5xx / StripeAPIError), or a rate limit.
// False for anything else, INCLUDING a raw non-StripeError (e.g. a thrown
// string, a plain object) -- an unrecognized shape shouldn't be assumed
// transient just because it isn't provably permanent. Used specifically by
// app/api/stripe/webhook/route.ts's charge.dispute.created handler, whose
// charge-retrieve failure used to rethrow unconditionally (retrying for
// Stripe's full ~3-day webhook window even on a permanent "No such charge"/
// permission error that a retry can never fix) -- every other Stripe call
// site here still fails a request outright rather than relying on Stripe's
// own webhook redelivery, so this is the one place the distinction matters.
export function isTransientStripeError(e: unknown): boolean {
  if (e instanceof Stripe.errors.StripeConnectionError) return true;
  if (e instanceof Stripe.errors.StripeAPIError) return true;
  if (e instanceof Stripe.errors.StripeRateLimitError) return true;
  if (e instanceof Stripe.errors.StripeError && typeof e.statusCode === "number") {
    return e.statusCode >= 500;
  }
  return false;
}
