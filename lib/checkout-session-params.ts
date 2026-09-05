import type Stripe from "stripe";

export const CHECKOUT_SESSION_PARAMS_VERSION = 1 as const;

export function alphaCheckoutSessionIdempotencyKey(profileId: string): string {
  if (!profileId) throw new Error("checkout profile id is required");
  return `alpha-checkout-${profileId}`;
}

export function alphaCheckoutSessionCreateParams(input: {
  profileId: string;
  customerEmail: string;
  origin: string;
  priceId: string;
  expiresAtEpochSeconds: number;
  paramsVersion: number;
}): Stripe.Checkout.SessionCreateParams {
  if (input.paramsVersion !== CHECKOUT_SESSION_PARAMS_VERSION) {
    throw new Error(
      `unsupported checkout Session params version ${input.paramsVersion}`
    );
  }
  if (!input.profileId || !input.customerEmail || !input.priceId) {
    throw new Error("checkout Session parameters are incomplete");
  }
  if (!Number.isInteger(input.expiresAtEpochSeconds)) {
    throw new Error("checkout Session expiry must be an integer epoch second");
  }
  const parsedOrigin = new URL(input.origin);
  if (
    (parsedOrigin.protocol !== "https:" && parsedOrigin.protocol !== "http:") ||
    parsedOrigin.username ||
    parsedOrigin.password ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search ||
    parsedOrigin.hash
  ) {
    throw new Error("checkout Session origin is invalid");
  }

  return {
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: input.priceId, quantity: 1 }],
    customer_email: input.customerEmail,
    adaptive_pricing: { enabled: false },
    payment_method_collection: "if_required",
    metadata: {
      alpha_profile_id: input.profileId,
    },
    expires_at: input.expiresAtEpochSeconds,
    success_url: `${parsedOrigin.origin}/writing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${parsedOrigin.origin}/checkout`,
    allow_promotion_codes: true,
  };
}

export function checkoutSessionMatchesPersistedRequest(
  session: Stripe.Checkout.Session,
  input: {
    profileId: string;
    customerEmail: string;
    expiresAtEpochSeconds: number;
  }
): boolean {
  return (
    !!session.id &&
    session.mode === "subscription" &&
    session.metadata?.alpha_profile_id === input.profileId &&
    session.expires_at === input.expiresAtEpochSeconds &&
    session.customer_email?.toLowerCase().trim() === input.customerEmail
  );
}
