import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import {
  decryptCheckoutSessionEmail,
} from "@/lib/checkout-session-email";
import {
  alphaCheckoutSessionCreateParams,
  alphaCheckoutSessionIdempotencyKey,
  checkoutSessionMatchesPersistedRequest,
} from "@/lib/checkout-session-params";
import { isInviteOnly } from "@/lib/access-mode";
import { getStripeClient, STRIPE_PRICE_ID } from "@/lib/stripe";
import type { supabaseServiceClient } from "@/lib/supabase/server";

type ServiceClient = Awaited<ReturnType<typeof supabaseServiceClient>>;

type CreationReplayClaim = {
  decision: string;
  owner_user_id: string | null;
  prior_billing_state: "creating" | "deleting" | string | null;
  session_started_at: string | null;
  session_expires_at: string | null;
  session_business_expires_at: string | null;
  session_origin: string | null;
  session_price_id: string | null;
  session_params_version: number | null;
  session_customer_email_ciphertext: string | null;
};

export interface CheckoutCreationRecoveryResult {
  inspected: number;
  claimed: number;
  inProgress: number;
  reviewRequired: number;
  bound: number;
  expired: number;
  deletionPending: number;
  replayWindowMissed: number;
  errors: string[];
}

export function definitiveExpiredCreateRejection(
  error: unknown
): { requestId: string } | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    type?: unknown;
    statusCode?: unknown;
    param?: unknown;
    requestId?: unknown;
  };
  if (
    candidate.type !== "StripeInvalidRequestError" ||
    candidate.statusCode !== 400 ||
    candidate.param !== "expires_at" ||
    typeof candidate.requestId !== "string" ||
    !/^req_[A-Za-z0-9_]+$/.test(candidate.requestId)
  ) {
    return null;
  }
  return { requestId: candidate.requestId };
}

async function releaseReplay(
  sb: ServiceClient,
  profileId: string,
  leaseToken: string
): Promise<void> {
  const { data, error } = await sb.rpc(
    "release_checkout_session_creation_replay",
    {
      p_profile_id: profileId,
      p_lease_token: leaseToken,
    }
  );
  if (
    error ||
    (data !== "released" &&
      data !== "lease_lost" &&
      data !== "profile_missing")
  ) {
    throw new Error(
      `creation replay release failed: ${error?.message ?? String(data)}`
    );
  }
}

function parsePersistedClaim(profileId: string, row: CreationReplayClaim) {
  const startedMs = Date.parse(row.session_started_at ?? "");
  const expiresMs = Date.parse(row.session_expires_at ?? "");
  const businessExpiresMs = Date.parse(
    row.session_business_expires_at ?? ""
  );
  const expiresAtEpochSeconds = expiresMs / 1000;
  if (
    !Number.isFinite(startedMs) ||
    !Number.isInteger(expiresAtEpochSeconds) ||
    !Number.isFinite(businessExpiresMs) ||
    expiresMs - startedMs !== 23 * 60 * 60 * 1000 ||
    businessExpiresMs - startedMs !== 31 * 60 * 1000 ||
    !row.session_origin ||
    !row.session_price_id ||
    row.session_params_version !== 1 ||
    !row.session_customer_email_ciphertext
  ) {
    throw new Error("persisted creation replay parameters are incomplete");
  }
  return {
    customerEmail: decryptCheckoutSessionEmail(
      row.session_customer_email_ciphertext,
      profileId
    ),
    startedMs,
    expiresAtEpochSeconds,
    businessExpiresMs,
    origin: row.session_origin,
    priceId: row.session_price_id,
    paramsVersion: row.session_params_version,
  };
}

type CreationReviewProfile = {
  billing_state: string;
  stripe_session_id: string | null;
  session_creation_started_at: string | null;
  stripe_session_expires_at: string | null;
  stripe_session_business_expires_at: string | null;
  stripe_session_origin: string | null;
  stripe_session_price_id: string | null;
  stripe_session_params_version: number | null;
  stripe_session_customer_email_ciphertext: string | null;
};

function exactPersistedSessionLine(
  session: Stripe.Checkout.Session,
  priceId: string
): boolean {
  const items = session.line_items;
  if (!items || items.has_more || items.data.length !== 1) return false;
  const item = items.data[0];
  const actualPrice =
    typeof item.price === "string" ? item.price : item.price?.id;
  return actualPrice === priceId && item.quantity === 1;
}

async function expireDeletionPendingSession(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  validate: (candidate: Stripe.Checkout.Session) => boolean
): Promise<Stripe.Checkout.Session> {
  if (session.status !== "open") return session;
  const expired = await stripe.checkout.sessions.expire(session.id);
  if (expired.id !== session.id || expired.status !== "expired") {
    throw new Error("deletion-pending Checkout Session did not expire");
  }
  const verified = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["line_items", "subscription"],
  });
  if (
    verified.id !== session.id ||
    verified.status !== "expired" ||
    !validate(verified)
  ) {
    throw new Error("deletion-pending Checkout Session expiry was not verified");
  }
  return verified;
}

/**
 * Controlled missed-window resolution for an operator-proven Session id.
 * The injected client keeps focused tests local. Production callers must use
 * the Alpha Stripe client for the same account and mode as normal checkout.
 */
export async function resolveCheckoutCreationReviewWithSession(
  sb: ServiceClient,
  profileId: string,
  sessionId: string,
  options: { stripeClient?: Stripe } = {}
): Promise<"bound" | "expired" | "deletion_pending"> {
  if (!profileId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    throw new Error("checkout creation review identifiers are invalid");
  }
  const { data: review, error: reviewError } = await sb
    .from("checkout_creation_reviews")
    .select("status, resolved_session_id")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (reviewError || !review) {
    throw new Error(
      `checkout creation review lookup failed: ${
        reviewError?.message ?? "review missing"
      }`
    );
  }
  if (
    review.status === "resolved_session" &&
    review.resolved_session_id === sessionId
  ) {
    return "bound";
  }
  if (review.status !== "pending") {
    throw new Error("checkout creation review has a conflicting resolution");
  }

  const { data, error } = await sb
    .from("checkout_profiles")
    .select(
      "billing_state, stripe_session_id, session_creation_started_at, stripe_session_expires_at, stripe_session_business_expires_at, stripe_session_origin, stripe_session_price_id, stripe_session_params_version, stripe_session_customer_email_ciphertext"
    )
    .eq("id", profileId)
    .maybeSingle();
  if (error || !data) {
    throw new Error(
      `checkout creation profile lookup failed: ${
        error?.message ?? "profile missing"
      }`
    );
  }
  const profile = data as CreationReviewProfile;

  // A prior controlled attempt may have validated and bound the exact Session
  // before its final review marker crashed. The durable bind is sufficient to
  // finish that idempotent marker without needing the now-cleared ciphertext.
  if (profile.stripe_session_id !== null) {
    if (profile.stripe_session_id !== sessionId) {
      throw new Error("checkout creation review is bound to another Session");
    }
    const { data: marker, error: markerError } = await sb.rpc(
      "complete_checkout_creation_review_with_session",
      { p_profile_id: profileId, p_session_id: sessionId }
    );
    if (markerError || marker !== "resolved") {
      throw new Error(
        `checkout creation review marker failed: ${
          markerError?.message ?? String(marker)
        }`
      );
    }
    return profile.billing_state === "expired" ? "expired" : "bound";
  }

  const persisted = parsePersistedClaim(profileId, {
    decision: "review",
    owner_user_id: null,
    prior_billing_state: profile.billing_state,
    session_started_at: profile.session_creation_started_at,
    session_expires_at: profile.stripe_session_expires_at,
    session_business_expires_at:
      profile.stripe_session_business_expires_at,
    session_origin: profile.stripe_session_origin,
    session_price_id: profile.stripe_session_price_id,
    session_params_version: profile.stripe_session_params_version,
    session_customer_email_ciphertext:
      profile.stripe_session_customer_email_ciphertext,
  });
  if (
    !["creating", "deleting"].includes(profile.billing_state) ||
    persisted.priceId !== STRIPE_PRICE_ID
  ) {
    throw new Error("checkout creation review profile is not bindable");
  }

  const stripe = options.stripeClient ?? getStripeClient();
  let session: Stripe.Checkout.Session =
    await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["line_items", "subscription"],
    });
  if (
    session.id !== sessionId ||
    !checkoutSessionMatchesPersistedRequest(session, {
      profileId,
      customerEmail: persisted.customerEmail,
      expiresAtEpochSeconds: persisted.expiresAtEpochSeconds,
    })
  ) {
    throw new Error("operator-provided Session does not match persisted request");
  }
  if (
    session.status !== "expired" &&
    !exactPersistedSessionLine(session, persisted.priceId)
  ) {
    throw new Error("operator-provided Session is not the exact Alpha item");
  }
  if (
    session.status !== "open" &&
    session.status !== "complete" &&
    session.status !== "expired"
  ) {
    throw new Error(
      `operator-provided Session has unsupported status ${session.status}`
    );
  }

  const { data: bind, error: bindError } = await sb.rpc(
    "bind_checkout_session",
    { p_profile_id: profileId, p_session_id: sessionId }
  );
  if (
    bindError ||
    (bind !== "bound" && bind !== "deletion_pending")
  ) {
    throw new Error(
      `checkout creation review binding failed: ${
        bindError?.message ?? String(bind)
      }`
    );
  }
  if (bind === "deletion_pending") {
    session = await expireDeletionPendingSession(stripe, session, (candidate) =>
      checkoutSessionMatchesPersistedRequest(candidate, {
        profileId,
        customerEmail: persisted.customerEmail,
        expiresAtEpochSeconds: persisted.expiresAtEpochSeconds,
      })
    );
  }
  if (session.status === "expired" && bind !== "deletion_pending") {
    const { data: settled, error: settleError } = await sb.rpc(
      "settle_checkout_session_expiration",
      { p_profile_id: profileId, p_session_id: sessionId }
    );
    if (settleError || settled !== "settled") {
      throw new Error(
        `checkout creation review expiration failed: ${
          settleError?.message ?? String(settled)
        }`
      );
    }
  }
  const { data: marker, error: markerError } = await sb.rpc(
    "complete_checkout_creation_review_with_session",
    { p_profile_id: profileId, p_session_id: sessionId }
  );
  if (markerError || marker !== "resolved") {
    throw new Error(
      `checkout creation review marker failed: ${
        markerError?.message ?? String(marker)
      }`
    );
  }
  if (bind === "deletion_pending") return "deletion_pending";
  if (session.status === "expired") return "expired";
  return bind === "deletion_pending" ? "deletion_pending" : "bound";
}

export async function resolveCheckoutCreationReviewNoCreate(
  sb: ServiceClient,
  profileId: string,
  proofReference: string
): Promise<void> {
  if (
    !profileId ||
    !/^(req|evt|case|ticket)_[A-Za-z0-9_-]+$/.test(proofReference) ||
    proofReference.length > 255
  ) {
    throw new Error("checkout creation no-create proof reference is invalid");
  }
  const { data, error } = await sb.rpc(
    "resolve_checkout_creation_review_no_create",
    {
      p_profile_id: profileId,
      p_proof_reference: proofReference,
    }
  );
  if (error || data !== "resolved") {
    throw new Error(
      `checkout creation no-create resolution failed: ${
        error?.message ?? String(data)
      }`
    );
  }
}

export async function countPendingCheckoutCreationReviews(
  sb: ServiceClient
): Promise<number> {
  const { data, error } = await sb.rpc(
    "count_pending_checkout_creation_reviews"
  );
  if (error || !Number.isInteger(data) || data < 0) {
    throw new Error(
      `pending checkout creation review count failed: ${
        error?.message ?? String(data)
      }`
    );
  }
  return data;
}

export async function reconcileStaleCheckoutSessionCreations(
  sb: ServiceClient,
  options: {
    nowIso?: string;
    limit?: number;
    stripeClient?: Stripe;
  } = {}
): Promise<CheckoutCreationRecoveryResult> {
  const result: CheckoutCreationRecoveryResult = {
    inspected: 0,
    claimed: 0,
    inProgress: 0,
    reviewRequired: 0,
    bound: 0,
    expired: 0,
    deletionPending: 0,
    replayWindowMissed: 0,
    errors: [],
  };
  const nowIso = options.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const mode = isInviteOnly(true) ? "invite_review" : "paid_replay";
  if (!Number.isFinite(nowMs)) {
    result.errors.push("checkout creation recovery received an invalid clock");
    return result;
  }
  const limit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 5)));
  const { data, error } = await sb.rpc(
    "list_stale_checkout_session_creations",
    { p_now: nowIso, p_limit: limit }
  );
  if (error) {
    result.errors.push(`checkout creation lookup failed: ${error.message}`);
    return result;
  }

  for (const candidate of data ?? []) {
    const profileId = (candidate as { profile_id?: unknown }).profile_id;
    if (typeof profileId !== "string") {
      result.errors.push("checkout creation lookup returned an invalid id");
      continue;
    }
    result.inspected += 1;
    if (mode === "invite_review") {
      const { data: holdData, error: holdError } = await sb.rpc(
        "hold_checkout_session_creation_for_invite_review",
        {
          p_profile_id: profileId,
          p_now: nowIso,
        }
      );
      if (holdError) {
        result.errors.push(
          `checkout creation ${profileId}: invite review hold failed`
        );
        continue;
      }
      if (holdData === "review_required") {
        result.reviewRequired += 1;
        continue;
      }
      if (holdData === "already_bound") {
        result.bound += 1;
        continue;
      }
      if (holdData === "in_progress" || holdData === "not_due") {
        result.inProgress += 1;
        continue;
      }
      result.errors.push(
        `checkout creation ${profileId}: invite review hold was rejected (${String(
          holdData
        )})`
      );
      continue;
    }

    const leaseToken = randomUUID();
    let claimed = false;
    try {
      const { data: claimData, error: claimError } = await sb.rpc(
        "claim_checkout_session_creation_replay",
        {
          p_profile_id: profileId,
          p_lease_token: leaseToken,
          p_lease_seconds: 300,
        }
      );
      if (claimError) {
        throw new Error(`creation replay claim failed: ${claimError.message}`);
      }
      const claim = Array.isArray(claimData)
        ? (claimData[0] as CreationReplayClaim | undefined)
        : undefined;
      if (!claim?.decision) {
        throw new Error("creation replay claim returned no decision");
      }
      if (claim.decision === "in_progress" || claim.decision === "not_due") {
        result.inProgress += 1;
        continue;
      }
      if (claim.decision === "manual_review") {
        result.reviewRequired += 1;
        continue;
      }
      if (claim.decision === "replay_window_missed") {
        result.replayWindowMissed += 1;
        result.errors.push(
          `checkout creation ${profileId} missed its safe idempotency replay window`
        );
        continue;
      }
      if (claim.decision === "already_bound") {
        result.bound += 1;
        continue;
      }
      if (claim.decision !== "claimed") {
        throw new Error(`creation replay was rejected: ${claim.decision}`);
      }
      claimed = true;
      result.claimed += 1;
      const persisted = parsePersistedClaim(profileId, claim);
      const stripe = options.stripeClient ?? getStripeClient();
      const params = alphaCheckoutSessionCreateParams({
        profileId,
        customerEmail: persisted.customerEmail,
        origin: persisted.origin,
        priceId: persisted.priceId,
        expiresAtEpochSeconds: persisted.expiresAtEpochSeconds,
        paramsVersion: persisted.paramsVersion,
      });

      let session: Stripe.Checkout.Session;
      try {
        session = await stripe.checkout.sessions.create(params, {
          idempotencyKey: alphaCheckoutSessionIdempotencyKey(profileId),
        });
      } catch (createError) {
        const terminal = definitiveExpiredCreateRejection(createError);
        if (!terminal) throw createError;
        const { data: settleData, error: settleError } = await sb.rpc(
          "settle_checkout_session_creation_replay",
          {
            p_profile_id: profileId,
            p_lease_token: leaseToken,
            p_expected_session_expires_at: claim.session_expires_at,
            p_terminal_reason: "provider_rejected_expired_params",
            p_provider_request_id: terminal.requestId,
          }
        );
        if (settleError || settleData !== "settled") {
          throw new Error(
            `creation no-create proof was not persisted: ${
              settleError?.message ?? String(settleData)
            }`
          );
        }
        result.expired += 1;
        claimed = false;
        continue;
      }

      if (!checkoutSessionMatchesPersistedRequest(session, {
        profileId,
        customerEmail: persisted.customerEmail,
        expiresAtEpochSeconds: persisted.expiresAtEpochSeconds,
      })) {
        throw new Error("replayed Session does not match persisted request");
      }
      if (session.status === "open" && persisted.businessExpiresMs <= nowMs) {
        try {
          await stripe.checkout.sessions.expire(session.id);
        } catch {
          // A completion race is classified by the exact re-read below.
        }
        session = await stripe.checkout.sessions.retrieve(session.id);
        if (!checkoutSessionMatchesPersistedRequest(session, {
          profileId,
          customerEmail: persisted.customerEmail,
          expiresAtEpochSeconds: persisted.expiresAtEpochSeconds,
        })) {
          throw new Error("replayed Session binding changed during expiry");
        }
      }
      if (
        session.status !== "open" &&
        session.status !== "complete" &&
        session.status !== "expired"
      ) {
        throw new Error(`replayed Session has unsupported status ${session.status}`);
      }

      const { data: bindData, error: bindError } = await sb.rpc(
        "bind_checkout_session",
        {
          p_profile_id: profileId,
          p_session_id: session.id,
        }
      );
      if (
        bindError ||
        (bindData !== "bound" && bindData !== "deletion_pending")
      ) {
        throw new Error(
          `replayed Session binding failed: ${
            bindError?.message ?? String(bindData)
          }`
        );
      }
      claimed = false;
      if (bindData === "deletion_pending") {
        session = await expireDeletionPendingSession(
          stripe,
          session,
          (candidate) =>
            checkoutSessionMatchesPersistedRequest(candidate, {
              profileId,
              customerEmail: persisted.customerEmail,
              expiresAtEpochSeconds: persisted.expiresAtEpochSeconds,
            })
        );
        result.deletionPending += 1;
        continue;
      }
      if (session.status === "expired") {
        const { data: expiryData, error: expiryError } = await sb.rpc(
          "settle_checkout_session_expiration",
          {
            p_profile_id: profileId,
            p_session_id: session.id,
          }
        );
        if (expiryError || expiryData !== "settled") {
          throw new Error(
            `replayed expired Session settlement failed: ${
              expiryError?.message ?? String(expiryData)
            }`
          );
        }
        result.expired += 1;
      } else {
        result.bound += 1;
      }
    } catch (recoveryError) {
      if (claimed) {
        try {
          await releaseReplay(sb, profileId, leaseToken);
        } catch (releaseError) {
          result.errors.push(
            `checkout creation ${profileId}: ${
              releaseError instanceof Error
                ? releaseError.message
                : "replay release failed"
            }`
          );
        }
      }
      result.errors.push(
        `checkout creation ${profileId}: ${
          recoveryError instanceof Error
            ? recoveryError.message
            : "recovery failed"
        }`
      );
    }
  }
  return result;
}
