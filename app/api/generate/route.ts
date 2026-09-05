import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import Stripe from "stripe";
import {
  STRIPE_PRICE_ID,
  getStripeClient,
  isStripeResourceMissing,
} from "@/lib/stripe";
import { generateIssue } from "@/lib/engine/assemble";
import { persistIssueIfPossible } from "@/lib/engine/persist";
import { isValidTopicId, MAX_CUSTOM_TOPIC_LEN, CUSTOM_PREFIX } from "@/lib/topics";
import {
  prepareLetterNotification,
  resendConfigured,
  sendOpsAlert,
  sendPreparedSubscriberEmail,
} from "@/lib/email";
import { rateLimit, clientKeyFromRequest } from "@/lib/rate-limit";
import { consumeDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { hasReaderAccess } from "@/lib/access";
import { isInviteOnly } from "@/lib/access-mode";
import { SUBSCRIBER_LETTERS_ENABLED } from "@/lib/subscriber-delivery-policy";
import { letterUrl as buildLetterUrl } from "@/lib/letter-token";
import { withDeadline } from "@/lib/with-deadline";
import { parseBirthday, isValidCalendarDateString } from "@/lib/demographics";
import { coerceThemeId } from "@/lib/themes";
import { BLURB_CAPS, type Issue } from "@/lib/types";
import { deliverLetterOnce, type DeliveryStore } from "@/lib/letter-delivery";
import { sendWithResendDeliveryAttempt } from "@/lib/resend-delivery-attempt";
import { createDailyPaidCallGuard } from "@/lib/paid-call-reservation";
import {
  isLiveForManagement,
  MAX_QTY,
  MIN_QTY,
} from "@/lib/update-quantity-guards";
import {
  checkoutUserMutation,
  subscriptionStatusGrantsAccess,
} from "@/lib/webhook-user-mutation";
import { resolveLegacyCheckoutMetadata } from "@/lib/legacy-checkout";
import { checkoutEmailBinding } from "@/lib/checkout-binding";
import { isAuthSessionMissingError } from "@supabase/supabase-js";
import {
  classifyPriorRecoveryBinding,
  cleanupCurrentCheckoutDuplicate,
  currentCheckoutDuplicateCleanupDependencies,
  resolveCurrentCheckoutCompletionConflict,
} from "@/lib/checkout-recovery";
import {
  legacyDuplicateCancellationIdempotencyKey,
  resolveLegacyBillingWriteConflict,
} from "@/lib/legacy-duplicate-reconciliation";

export const runtime = "nodejs";
export const maxDuration = 120;
// A deterministic deadline comfortably under maxDuration. generateIssue's I/O is
// self-bounded (Anthropic 60s, Brave 5s, deep-read 7s), but those are
// PER-ATTEMPT, and the SDK's one retry plus topic-blurb's parse-retry can stack
// past 120s in a pathological case. Failing fast here returns a clean 500 the
// /writing client absorbs (its retry hits the now-warm per-topic cache), instead
// of waiting for Cloudflare Workers' own hard timeout to kick in. Mirrors the
// cron's per-user deadline.
const GENERATE_DEADLINE_MS = 105_000;

const ProfileSchema = z.object({
  firstName: z.string().min(1).max(60),
  city: z.string().max(120).default(""),
  jobBlurb: z.string().max(BLURB_CAPS.jobBlurb).optional(),
  projectBlurb: z.string().max(BLURB_CAPS.projectBlurb).optional(),
  funBlurb: z.string().max(BLURB_CAPS.funBlurb).optional(),
  // Shape AND validity: a regex-valid but impossible/out-of-range date (e.g.
  // 2020-02-30, 1850-01-01) is rejected here too, so this write path agrees
  // with parseBirthday, which every reader of the field already gates on.
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => parseBirthday(s) !== null, "invalid birthday").optional(),
  gender: z.enum(["male", "female"]).optional(),
  // isValidTopicId, not just shape: this is the same users.topics column the
  // self-serve /api/account/topics route locks down against smuggled/garbage
  // ids (including Object.prototype names like "constructor" that a plain `in`
  // lookup would wrongly accept) -- this onboarding path needs the same gate.
  //
  // alpha-drift-r16-11 (found+fixed 2026-08-07): this refine used to skip
  // the duplicate-id check lib/account-topics-guards.ts's sibling route
  // enforces (`new Set(topics).size !== topics.length`), despite this same
  // file's own comment above claiming it needs "the same gate." A repeated
  // topic id written here isn't a one-time onboarding glitch -- it's
  // written verbatim to users.topics and re-read unmodified by every
  // future cron run, so it regenerates the exact same section twice in
  // every letter, permanently, burning two of the reader's paid slots on
  // one topic until they happen to re-touch that exact topic in the editor.
  topics: z.array(z.string().min(1).max(MAX_CUSTOM_TOPIC_LEN + CUSTOM_PREFIX.length)).min(1).max(25).refine(
    (arr) => arr.every(isValidTopicId),
    "unrecognized topic"
  ).refine(
    (arr) => new Set(arr).size === arr.length,
    "duplicate topic"
  ),
  theme: z.string().max(30).default("forest"),
  email: z.string().email().optional(),
});

const BodySchema = z.object({
  // Current paid checkouts load the immutable staged profile on the server.
  // Keep the browser copy opaque until payment is verified so lost, stale, or
  // malformed localStorage cannot strand a paid subscriber whose server copy
  // is still complete. Authenticated and legacy paths validate it below.
  profile: z.unknown().optional(),
  // This is the onboarding first-letter endpoint -- the client never sends
  // weekOf (it always defaults to today, see defaultWeekOf()). Bounded to a
  // couple days of slop for timezone/clock skew rather than left open: an
  // unbounded weekOf keys the issues upsert below, so it could overwrite any
  // already-delivered issue (past or future) in a reader's archive.
  // alpha-drift-r26-06 (2026-08-14): the old refine only checked
  // Number.isNaN, which JS's Date parser never trips for an impossible
  // day-of-month -- it silently rolls over instead (2026-04-31 becomes
  // May 1), letting the raw, still-invalid string reach persistIssueIfPossible's
  // upsert into public.issues.week_of, a strict Postgres `date` column that
  // rejects it outright. That upsert failure was only console.warned, not
  // surfaced, so the reader got a real letter that silently never saved to
  // their archive. isValidCalendarDateString does the same real round-trip
  // check ProfileSchema.birthday already relies on via parseBirthday, just
  // above in this same schema.
  weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
    if (!isValidCalendarDateString(s)) return false;
    const d = new Date(`${s}T00:00:00Z`).getTime();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return Math.abs(today.getTime() - d) <= 2 * 24 * 60 * 60 * 1000;
  }, "weekOf must be close to today").optional(),
  // Stripe Checkout session id, threaded through from the success_url
  // (/writing?session_id=...). Proves the first letter was paid for.
  sessionId: z.string().max(200).optional(),
});

// Payment gate. Letter generation costs real money (Claude + Brave) and the
// first letter is the paid hook — without this, anyone could complete the free
// onboarding, skip the Stripe button, and POST here directly for a free letter.
// (Matches the "no free trial — exploitation risk" product decision.)
//
// Allow when ANY of:
//   - Stripe isn't configured while running `next dev` locally
//   - the caller is an authenticated, currently-subscribed user
//   - a Stripe Checkout session id is supplied AND Stripe says it's paid
// Fail CLOSED on every unverified path, including a genuine Stripe infra
// blip -- ok:true is only ever returned with a real verifiedEmail attached.
// A Stripe outage means the customer retries in a moment (the checkout
// session itself doesn't expire quickly); it does NOT mean falling back to
// trusting the caller's own profile.email, which is exactly how this
// endpoint had an account-takeover bug (see the POST handler's comment).
// verifiedEmail is the identity this request is ACTUALLY entitled to act as --
// the signed-in user's own email, or the email Stripe collected for the paid
// checkout session. The caller's profile.email must never be trusted for this:
// see the POST handler, which overwrites profile.email with verifiedEmail
// before it reaches persistIssueIfPossible (magic-link minting) or the
// notification send. Without that override, either payment-gate branch below
// would let a caller pass an arbitrary victim email in profile.email, and this
// endpoint would mint THAT victim a sign-in link and overwrite their profile.
type PaidVerification =
  | {
      ok: true;
      kind: "authenticated";
      verifiedEmail: string;
      verifiedUserId: string;
    }
  | {
      ok: true;
      kind: "checkout";
      // Current checkout is auth-first. The confirmed Supabase account owns
      // the canonical profile and delivery identity. Stripe's immutable
      // Session email remains separate so the pseudonymous checkout binding
      // can still be proved after a confirmed account-email change.
      verifiedEmail: string;
      verifiedUserId: string;
      checkoutEmail: string;
      sessionId: string;
      profileId: string;
      customerId: string;
      subscriptionId: string;
      checkoutWeekOf: string;
      checkoutStartedAtIso: string;
    }
  | {
      ok: true;
      kind: "legacy_authenticated";
      verifiedEmail: string;
      verifiedUserId: string;
      sessionId: string;
      customerId: string;
      subscriptionId: string;
      checkoutWeekOf: string;
      checkoutStartedAtIso: string;
      legacyFirstName: string;
      legacyCity: string | null;
    }
  | {
      ok: true;
      kind: "development";
      verifiedEmail: null;
    }
  | {
      ok: false;
      error: string;
      status: 402 | 409 | 503;
      code?: string;
    };

function isAccessRevokedSubscriptionStatus(status: Stripe.Subscription.Status): boolean {
  return status === "canceled" || status === "incomplete_expired" || status === "unpaid";
}

function isFinalSubscriptionStatus(status: Stripe.Subscription.Status): boolean {
  return status === "canceled" || status === "incomplete_expired";
}

function subscriptionCustomerId(subscription: Stripe.Subscription): string {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
}

function exactAlphaSubscription(subscription: Stripe.Subscription): boolean {
  if (
    !subscription.items ||
    subscription.items.has_more ||
    !Array.isArray(subscription.items.data) ||
    subscription.items.data.length !== 1
  ) {
    return false;
  }
  const item = subscription.items.data[0];
  const priceId = typeof item.price === "string" ? item.price : item.price.id;
  const quantity = item.quantity ?? 1;
  return (
    priceId === STRIPE_PRICE_ID &&
    Number.isInteger(quantity) &&
    quantity >= MIN_QTY &&
    quantity <= MAX_QTY
  );
}

function exactLiveAlphaSubscription(subscription: Stripe.Subscription): boolean {
  return (
    !isAccessRevokedSubscriptionStatus(subscription.status) &&
    exactAlphaSubscription(subscription)
  );
}

function alphaDefinitelyAbsent(subscription: Stripe.Subscription): boolean {
  return (
    !!subscription.items &&
    !subscription.items.has_more &&
    Array.isArray(subscription.items.data) &&
    subscription.items.data.every((item) => {
      const priceId =
        typeof item.price === "string" ? item.price : item.price.id;
      return priceId !== STRIPE_PRICE_ID;
    })
  );
}

class LegacyDuplicateCheckoutCancelledError extends Error {}

async function verifyPaid(sessionId: string | undefined): Promise<PaidVerification> {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "development") {
      return { ok: true, kind: "development", verifiedEmail: null };
    }
    console.error("[generate] STRIPE_SECRET_KEY is missing, failing payment verification closed");
    return {
      ok: false,
      error: "Payment verification is temporarily unavailable. Please try again in a moment.",
      status: 503,
    };
  }

  // A supplied current Checkout Session must go through the one-time checkout
  // claim. The short-lived legacy bridge requires an already-confirmed account
  // with the same email, then uses the normal authenticated generation limit.
  if (sessionId) {
    let sessionUserId = "";
    let sessionAuthEmail = "";
    try {
      const authClient = await supabaseServerClient();
      const {
        data: { user: sessionUser },
        error: sessionAuthError,
      } = await authClient.auth.getUser();
      if (sessionAuthError && !isAuthSessionMissingError(sessionAuthError)) {
        return {
          ok: false,
          error: "Account verification is temporarily unavailable. Please try again.",
          status: 503,
        };
      }
      sessionAuthEmail = sessionUser?.email?.toLowerCase().trim() ?? "";
      if (!sessionUser || !sessionUser.email_confirmed_at || !sessionAuthEmail) {
        return {
          ok: false,
          code: "checkout_sign_in_required",
          error:
            "Your payment is on file. Sign in to the confirmed account used to start checkout to finish your first letter.",
          status: 409,
        };
      }
      sessionUserId = sessionUser.id;
    } catch (error) {
      console.warn(
        "[generate] checkout Auth verification failed:",
        error instanceof Error ? error.message : error
      );
      return {
        ok: false,
        error: "Account verification is temporarily unavailable. Please try again.",
        status: 503,
      };
    }
    try {
      const stripe = getStripeClient();
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["line_items", "subscription"],
      });
      const paid =
        session.payment_status === "paid" ||
        session.payment_status === "no_payment_required";
      const sessionLineItemsInspectable =
        !!session.line_items &&
        !session.line_items.has_more &&
        Array.isArray(session.line_items.data);
      const lineItems = session.line_items?.data ?? [];
      const expectedPrice =
        sessionLineItemsInspectable &&
        lineItems.length === 1 &&
        lineItems.every((item) => {
          const priceId =
            typeof item.price === "string" ? item.price : item.price?.id;
          return priceId === STRIPE_PRICE_ID && item.quantity === 1;
        });
      const subscription =
        typeof session.subscription === "string"
          ? await stripe.subscriptions.retrieve(session.subscription)
          : session.subscription;
      const sessionCustomerId =
        typeof session.customer === "string"
          ? session.customer
          : session.customer?.id ?? null;
      const subscriptionCustomerId = subscription
        ? typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer.id
        : null;
      const subscriptionItemsInspectable =
        !!subscription?.items &&
        !subscription.items.has_more &&
        Array.isArray(subscription.items.data);
      const subscriptionItems = subscription?.items?.data ?? [];
      const subscriptionContainsAlpha =
        subscriptionItemsInspectable &&
        subscriptionItems.some((item) => {
          const priceId =
            typeof item.price === "string" ? item.price : item.price.id;
          return priceId === STRIPE_PRICE_ID;
        });
      const exactAlphaSubscription =
        subscriptionItemsInspectable &&
        subscriptionItems.length === 1 &&
        subscriptionItems.every((item) => {
          const priceId =
            typeof item.price === "string" ? item.price : item.price.id;
          const quantity = item.quantity ?? 1;
          return (
            priceId === STRIPE_PRICE_ID &&
            Number.isInteger(quantity) &&
            quantity >= MIN_QTY &&
            quantity <= MAX_QTY
          );
        });
      const profileId = session.metadata?.alpha_profile_id?.trim() || "";
      const profileIdValid = z.string().uuid().safeParse(profileId).success;
      const checkoutWeekOf = new Date(session.created * 1000)
        .toISOString()
        .slice(0, 10);
      const checkoutStartedAtIso = new Date(
        session.created * 1000
      ).toISOString();

      const paymentNotComplete =
        session.status !== "complete" ||
        session.mode !== "subscription" ||
        !paid;
      if (paymentNotComplete || (sessionLineItemsInspectable && !expectedPrice)) {
        return {
          ok: false,
          error: "Payment not completed for an active Alpha subscription.",
          status: 402,
        };
      }
      if (
        !sessionLineItemsInspectable ||
        !subscription ||
        !sessionCustomerId ||
        subscriptionCustomerId !== sessionCustomerId ||
        !subscriptionItemsInspectable ||
        !exactAlphaSubscription
      ) {
        return {
          ok: false,
          error:
            "Your Alpha billing setup needs review before a letter can be generated. Please try again shortly.",
          status: 503,
        };
      }
      if (!subscriptionContainsAlpha) {
        return {
          ok: false,
          error:
            "Your Alpha billing setup needs review before a letter can be generated. Please try again shortly.",
          status: 503,
        };
      }
      if (isAccessRevokedSubscriptionStatus(subscription.status)) {
        return {
          ok: false,
          error: "Payment not completed for an active Alpha subscription.",
          status: 402,
        };
      }
      if (!isLiveForManagement(subscription.status)) {
        return {
          ok: false,
          error:
            "Your Alpha subscription is still being resolved. Check its payment status and try again.",
          status: 503,
        };
      }

      // customer_details.email (post-payment, Stripe-collected) over
      // customer_email (the pre-fill we sent at session creation).
      const verifiedEmail = (
        session.customer_details?.email ||
        session.customer_email ||
        ""
      )
        .toLowerCase()
        .trim();
      if (!verifiedEmail) {
        console.error("[generate] paid checkout session has no verified email");
        return {
          ok: false,
          error: "Payment verification is temporarily unavailable. Please try again.",
          status: 503,
        };
      }
      if (!profileIdValid) {
        const legacy = await resolveLegacyCheckoutMetadata(stripe, session);
        if (legacy) {
          if (sessionAuthEmail !== verifiedEmail) {
            return {
              ok: false,
              code: "legacy_checkout_sign_in_required",
              error:
                "Your payment is on file. Sign in with the email used at checkout to finish your first letter.",
              status: 409,
            };
          }
          return {
            ok: true,
            kind: "legacy_authenticated",
            verifiedEmail,
            verifiedUserId: sessionUserId,
            sessionId,
            customerId: sessionCustomerId,
            subscriptionId: subscription.id,
            checkoutWeekOf,
            checkoutStartedAtIso,
            legacyFirstName: legacy.firstName,
            legacyCity: legacy.city,
          };
        }
        return {
          ok: false,
          code: "paid_checkout_needs_support",
          error:
            "Your payment is on file, but this checkout needs support before the first letter can be generated.",
          status: 409,
        };
      }
      return {
        ok: true,
        kind: "checkout",
        verifiedEmail: sessionAuthEmail,
        verifiedUserId: sessionUserId,
        checkoutEmail: verifiedEmail,
        sessionId,
        profileId,
        customerId: sessionCustomerId,
        subscriptionId: subscription.id,
        checkoutWeekOf,
        checkoutStartedAtIso,
      };
    } catch (e) {
      // resource_missing = fabricated / nonexistent session, definitively not paid.
      if (
        e instanceof Stripe.errors.StripeInvalidRequestError &&
        e.code === "resource_missing"
      ) {
        return {
          ok: false,
          error: "Couldn't verify payment. Subscribe to receive your letter.",
          status: 402,
        };
      }
      console.warn(
        "[generate] stripe verify blip, failing closed:",
        e instanceof Error ? e.message : e
      );
      return {
        ok: false,
        error: "Couldn't verify payment right now. Please try again in a moment.",
        status: 503,
      };
    }
  }

  // Without a Checkout Session, only an authenticated account with current
  // access may generate.
  try {
    const sb = await supabaseServerClient();
    const {
      data: { user },
      error: authError,
    } = await sb.auth.getUser();
    if (authError && !isAuthSessionMissingError(authError)) {
      console.warn("[generate] authenticated-user lookup failed:", authError.message);
      return {
        ok: false,
        error: "Account access is temporarily unavailable. Please try again.",
        status: 503,
      };
    }
    if (!user?.email || !user.email_confirmed_at) {
      return {
        ok: false,
        code: "email_confirmation_required",
        error: "Confirm your email before generating a letter.",
        status: 402,
      };
    }
    const svc = await supabaseServiceClient();
    const { data, error: subErr } = await svc
      .from("users")
      .select("subscribed_at, cancelled_at, access_granted_at")
      .eq("id", user.id)
      .maybeSingle();
    if (subErr) {
      console.warn("[generate] subscription lookup failed:", subErr.message);
      return {
        ok: false,
        error: "Account access is temporarily unavailable. Please try again.",
        status: 503,
      };
    }
    if (
      hasReaderAccess(
        data?.subscribed_at,
        data?.cancelled_at,
        data?.access_granted_at
      )
    ) {
      return {
        ok: true,
        kind: "authenticated",
        verifiedEmail: user.email.toLowerCase().trim(),
        verifiedUserId: user.id,
      };
    }
    return {
      ok: false,
      code: isInviteOnly(true) ? "invite_access_required" : "payment_required",
      error: isInviteOnly(true)
        ? "Invite access is required before generating a letter."
        : "Payment required. Subscribe to receive your letter.",
      status: 402,
    };
  } catch (e) {
    console.warn(
      "[generate] authenticated access check threw:",
      e instanceof Error ? e.message : e
    );
    return {
      ok: false,
      error: "Account access is temporarily unavailable. Please try again.",
      status: 503,
    };
  }
}

type LegacyPriorBindingDecision =
  | "same"
  | "replaceable"
  | "duplicate_live_alpha"
  | "blocked";

async function classifyLegacyPriorBinding(
  stripe: Stripe,
  existing: {
    stripe_customer_id?: string | null;
    stripe_subscription_id?: string | null;
  } | null,
  paid: Extract<PaidVerification, { ok: true; kind: "legacy_authenticated" }>
): Promise<LegacyPriorBindingDecision> {
  const priorCustomerId = existing?.stripe_customer_id ?? null;
  const priorSubscriptionId = existing?.stripe_subscription_id ?? null;
  if (!priorCustomerId && !priorSubscriptionId) return "same";
  if (!priorCustomerId || !priorSubscriptionId) return "blocked";
  if (
    priorCustomerId === paid.customerId &&
    priorSubscriptionId === paid.subscriptionId
  ) {
    return "same";
  }

  let prior: Stripe.Subscription;
  try {
    prior = await stripe.subscriptions.retrieve(priorSubscriptionId);
  } catch (error) {
    if (!isStripeResourceMissing(error)) throw error;

    // resource_missing alone can mean the wrong Stripe account or mode. The
    // known Customer must still be readable and a complete Alpha-price scan
    // must show no live renewal before its local binding can be replaced.
    const customer = await stripe.customers.retrieve(priorCustomerId);
    if ("deleted" in customer || customer.id !== priorCustomerId) {
      return "blocked";
    }
    const subscriptions = await stripe.subscriptions.list({
      customer: priorCustomerId,
      price: STRIPE_PRICE_ID,
      status: "all",
      limit: 100,
    });
    if (
      subscriptions.has_more ||
      !Array.isArray(subscriptions.data) ||
      subscriptions.data.some(
        (subscription) =>
          subscriptionCustomerId(subscription) !== priorCustomerId ||
          !isFinalSubscriptionStatus(subscription.status)
      )
    ) {
      return "blocked";
    }
    return "replaceable";
  }

  if (
    prior.id !== priorSubscriptionId ||
    subscriptionCustomerId(prior) !== priorCustomerId
  ) {
    return "blocked";
  }
  if (isFinalSubscriptionStatus(prior.status)) {
    return "replaceable";
  }
  if (alphaDefinitelyAbsent(prior)) return "replaceable";
  if (exactLiveAlphaSubscription(prior)) return "duplicate_live_alpha";
  return "blocked";
}

async function abortLegacyCheckoutFulfillment(
  sb: Awaited<ReturnType<typeof supabaseServiceClient>>,
  paid: Extract<PaidVerification, { ok: true; kind: "legacy_authenticated" }>,
  claim: LegacyCheckoutClaim,
  winner: { customerId: string; subscriptionId: string }
): Promise<void> {
  const { data, error } = await sb.rpc("abort_legacy_checkout_fulfillment", {
    p_session_id: paid.sessionId,
    p_lease_token: claim.leaseToken,
    p_stripe_customer_id: paid.customerId,
    p_stripe_subscription_id: paid.subscriptionId,
    p_winner_customer_id: winner.customerId,
    p_winner_subscription_id: winner.subscriptionId,
  });
  if (error || data !== true) {
    throw new Error(
      `legacy checkout terminal abort failed: ${error?.message ?? String(data)}`
    );
  }
}

async function cancelDuplicateLegacyCheckout(
  sb: Awaited<ReturnType<typeof supabaseServiceClient>>,
  stripe: Stripe,
  paid: Extract<PaidVerification, { ok: true; kind: "legacy_authenticated" }>,
  claim: LegacyCheckoutClaim,
  winner: { customerId: string; subscriptionId: string },
  reviewAlreadyRecorded = false
): Promise<never> {
  // The first captured charge needs a human decision even when stopping its
  // duplicate renewal is safe. Persist that obligation before provider state
  // changes or the request can acknowledge failure.
  if (!reviewAlreadyRecorded) {
    const { data: reviewRecorded, error: reviewError } = await sb.rpc(
      "record_legacy_duplicate_refund_review",
      {
        p_session_id: paid.sessionId,
        p_lease_token: claim.leaseToken,
        p_user_id: paid.verifiedUserId,
        p_winner_customer_id: winner.customerId,
        p_winner_subscription_id: winner.subscriptionId,
      }
    );
    if (reviewError || reviewRecorded !== true) {
      throw new Error(
        `duplicate legacy checkout review was not authorized: ${
          reviewError?.message ?? String(reviewRecorded)
        }`
      );
    }
  }
  const current = await stripe.subscriptions.retrieve(paid.subscriptionId);
  if (
    current.id !== paid.subscriptionId ||
    subscriptionCustomerId(current) !== paid.customerId
  ) {
    throw new Error("new legacy checkout billing pair changed before cancellation");
  }
  if (!isFinalSubscriptionStatus(current.status)) {
    if (!exactLiveAlphaSubscription(current)) {
      throw new Error(
        "new legacy checkout is no longer an exact Alpha subscription"
      );
    }
    const cancelled = await stripe.subscriptions.cancel(
      paid.subscriptionId,
      {},
      {
        idempotencyKey: legacyDuplicateCancellationIdempotencyKey(
          paid.sessionId,
          paid.subscriptionId
        ),
      }
    );
    if (
      cancelled.id !== paid.subscriptionId ||
      subscriptionCustomerId(cancelled) !== paid.customerId ||
      !isFinalSubscriptionStatus(cancelled.status)
    ) {
      throw new Error("duplicate legacy checkout cancellation was not terminal");
    }
  }
  await abortLegacyCheckoutFulfillment(sb, paid, claim, winner);
  throw new LegacyDuplicateCheckoutCancelledError(
    "The newer duplicate Alpha subscription was stopped and queued for charge review."
  );
}

async function handleLegacySubscriberWriteConflict(
  sb: Awaited<ReturnType<typeof supabaseServiceClient>>,
  stripe: Stripe,
  paid: Extract<PaidVerification, { ok: true; kind: "legacy_authenticated" }>,
  claim: LegacyCheckoutClaim,
  message: string
): Promise<never> {
  const { data: currentConflictData, error: currentConflictError } = await sb.rpc(
    "find_legacy_current_checkout_conflict",
    {
      p_session_id: paid.sessionId,
      p_lease_token: claim.leaseToken,
      p_user_id: paid.verifiedUserId,
    }
  );
  if (currentConflictError) {
    throw new Error(
      `current checkout conflict authorization failed: ${currentConflictError.message}`
    );
  }
  const currentConflict = (Array.isArray(currentConflictData)
    ? currentConflictData[0]
    : currentConflictData) as
    | {
        decision?: string;
        winner_customer_id?: string | null;
        winner_subscription_id?: string | null;
      }
    | null;
  if (currentConflict?.decision === "candidate") {
    const customerId = currentConflict.winner_customer_id ?? null;
    const subscriptionId = currentConflict.winner_subscription_id ?? null;
    if (!customerId || !subscriptionId) {
      throw new Error("current checkout conflict returned no exact winner");
    }
    const winnerDecision = await classifyLegacyPriorBinding(
      stripe,
      {
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
      },
      paid
    );
    if (winnerDecision !== "duplicate_live_alpha") {
      throw new Error("current checkout conflict winner is not live exact Alpha");
    }
    const { data: reviewRecorded, error: reviewError } = await sb.rpc(
      "record_legacy_current_checkout_conflict_refund_review",
      {
        p_session_id: paid.sessionId,
        p_lease_token: claim.leaseToken,
        p_user_id: paid.verifiedUserId,
        p_winner_customer_id: customerId,
        p_winner_subscription_id: subscriptionId,
      }
    );
    if (reviewError || reviewRecorded !== true) {
      throw new Error(
        `current checkout conflict review was not authorized: ${
          reviewError?.message ?? String(reviewRecorded)
        }`
      );
    }
    return cancelDuplicateLegacyCheckout(
      sb,
      stripe,
      paid,
      claim,
      { customerId, subscriptionId },
      true
    );
  }
  if (currentConflict?.decision !== "no_conflict") {
    throw new Error(
      `current checkout conflict remained ${String(currentConflict?.decision)}`
    );
  }
  // Two different paid legacy Sessions can race after both saw the same bare
  // Auth mirror. The canonical billing CAS chooses one winner. Re-read that
  // winner before returning so the losing live subscription cannot remain a
  // renewable, untracked duplicate.
  return resolveLegacyBillingWriteConflict({
    loadWinner: async () => {
      const { data, error } = await sb
        .from("users")
        .select("stripe_customer_id, stripe_subscription_id")
        .eq("id", paid.verifiedUserId)
        .maybeSingle();
      if (error) {
        throw new Error(`${message}: conflict lookup failed: ${error.message}`);
      }
      return data;
    },
    classifyWinner: (winner) =>
      classifyLegacyPriorBinding(stripe, winner, paid),
    cancelLosing: (winner) => {
      const customerId = winner?.stripe_customer_id ?? null;
      const subscriptionId = winner?.stripe_subscription_id ?? null;
      if (!customerId || !subscriptionId) {
        throw new Error("legacy billing race winner is incomplete");
      }
      return cancelDuplicateLegacyCheckout(sb, stripe, paid, claim, {
        customerId,
        subscriptionId,
      });
    },
    errorMessage: message,
  });
}

async function repairLegacyCheckoutSubscriber(
  paid: Extract<PaidVerification, { ok: true; kind: "legacy_authenticated" }>,
  profile: z.infer<typeof ProfileSchema>,
  claim: LegacyCheckoutClaim
): Promise<void> {
  const sb = await supabaseServiceClient();
  const { data: existing, error: existingError } = await sb
    .from("users")
    .select(
      "subscribed_at, cancelled_at, unsubscribed_at, first_name, city, job_blurb, project_blurb, fun_blurb, birthday, gender, topics, theme, stripe_customer_id, stripe_subscription_id, bounced_at, complained_at, delivery_suppression_cleared_at, suppression_cleanup_pending_at"
    )
    .eq("id", paid.verifiedUserId)
    .maybeSingle();
  if (existingError) {
    throw new Error(`legacy subscriber lookup failed: ${existingError.message}`);
  }
  const stripe = getStripeClient();
  const priorBinding = await classifyLegacyPriorBinding(stripe, existing, paid);
  if (priorBinding === "blocked") {
    throw new Error(
      "legacy checkout conflicts with an unresolved exact billing binding"
    );
  }
  if (priorBinding === "duplicate_live_alpha") {
    const winnerCustomerId = existing?.stripe_customer_id ?? null;
    const winnerSubscriptionId = existing?.stripe_subscription_id ?? null;
    if (!winnerCustomerId || !winnerSubscriptionId) {
      throw new Error("legacy duplicate winner binding is incomplete");
    }
    return cancelDuplicateLegacyCheckout(sb, stripe, paid, claim, {
      customerId: winnerCustomerId,
      subscriptionId: winnerSubscriptionId,
    });
  }

  const nowIso = new Date().toISOString();
  // Legacy fulfillment can establish access and billing. It never treats a
  // checkout as permission to remove provider suppression. A clean or new
  // account gets no synthetic delivery-review marker. Existing bounce,
  // complaint, pending-review, and causal-watermark state remains for
  // explicit review. An older direct unsubscribe retains paid re-consent
  // semantics, while an unsubscribe after this checkout still wins.
  const mutation = checkoutUserMutation(existing ?? null, {
    userId: paid.verifiedUserId,
    email: paid.verifiedEmail,
    firstName: paid.legacyFirstName,
    city: paid.legacyCity,
    customerId: paid.customerId,
    subscriptionId: paid.subscriptionId,
    priorBindingReplaceable: priorBinding === "replaceable",
    nowIso,
    checkoutStartedAtIso: paid.checkoutStartedAtIso,
    subscriptionLive: true,
    suppressionCleared: false,
    preserveSuppressionState: true,
    stagedProfile: {
      firstName: paid.legacyFirstName,
      city: paid.legacyCity,
      jobBlurb: profile.jobBlurb ?? null,
      projectBlurb: profile.projectBlurb ?? null,
      funBlurb: profile.funBlurb ?? null,
      birthday: profile.birthday ?? null,
      gender: profile.gender ?? null,
      topics: profile.topics,
      theme: profile.theme,
    },
  });
  if (mutation.kind === "skip") {
    throw new Error(`legacy checkout user mutation blocked: ${mutation.reason}`);
  }
  if (mutation.kind === "insert") {
    const { error } = await sb.from("users").insert(mutation.row);
    if (error) {
      return handleLegacySubscriberWriteConflict(
        sb,
        stripe,
        paid,
        claim,
        `legacy subscriber insert failed: ${error.message}`
      );
    }
  } else {
    let update = sb.from("users").update(mutation.patch).eq("id", paid.verifiedUserId);
    update = existing?.stripe_subscription_id
      ? update.eq("stripe_subscription_id", existing.stripe_subscription_id)
      : update.is("stripe_subscription_id", null);
    update = existing?.stripe_customer_id
      ? update.eq("stripe_customer_id", existing.stripe_customer_id)
      : update.is("stripe_customer_id", null);
    update = existing?.unsubscribed_at
      ? update.eq("unsubscribed_at", existing.unsubscribed_at)
      : update.is("unsubscribed_at", null);
    update = existing?.bounced_at
      ? update.eq("bounced_at", existing.bounced_at)
      : update.is("bounced_at", null);
    update = existing?.complained_at
      ? update.eq("complained_at", existing.complained_at)
      : update.is("complained_at", null);
    update = existing?.suppression_cleanup_pending_at
      ? update.eq(
          "suppression_cleanup_pending_at",
          existing.suppression_cleanup_pending_at
        )
      : update.is("suppression_cleanup_pending_at", null);
    update = existing?.delivery_suppression_cleared_at
      ? update.eq(
          "delivery_suppression_cleared_at",
          existing.delivery_suppression_cleared_at
        )
      : update.is("delivery_suppression_cleared_at", null);
    const { data: updated, error } = await update.select("id").maybeSingle();
    if (error || !updated) {
      return handleLegacySubscriberWriteConflict(
        sb,
        stripe,
        paid,
        claim,
        `legacy subscriber update failed: ${
          error?.message ?? "billing binding changed"
        }`
      );
    }
  }

}

type CheckoutClaimDecision =
  | "claimed"
  | "in_progress"
  | "completed"
  | "aborted"
  | "cleanup_pending"
  | "manual_review"
  | "profile_mismatch";

type LegacyCheckoutClaimDecision = Exclude<
  CheckoutClaimDecision,
  "cleanup_pending"
>;

interface CheckoutClaim {
  decision: CheckoutClaimDecision;
  leaseToken: string;
  sessionId: string;
  profileId: string;
  userId: string | null;
  weekOf: string;
  customerId: string;
  subscriptionId: string;
  checkoutStartedAtIso: string;
  priorCustomerId: string | null;
  priorSubscriptionId: string | null;
  priorBindingReplaceable: boolean;
}

interface LegacyCheckoutClaim {
  decision: LegacyCheckoutClaimDecision;
  leaseToken: string;
  sessionId: string;
  userId: string | null;
  weekOf: string;
}

async function claimLegacyCheckoutFulfillment(
  paid: Extract<PaidVerification, { ok: true; kind: "legacy_authenticated" }>,
  weekOf: string
): Promise<LegacyCheckoutClaim> {
  const sb = await supabaseServiceClient();
  const leaseToken = crypto.randomUUID();
  const { data, error } = await sb.rpc("claim_legacy_checkout_fulfillment", {
    p_session_id: paid.sessionId,
    p_email_hash: checkoutEmailBinding(paid.verifiedEmail),
    p_user_id: paid.verifiedUserId,
    p_stripe_customer_id: paid.customerId,
    p_stripe_subscription_id: paid.subscriptionId,
    p_week_of: weekOf,
    p_lease_token: leaseToken,
    p_lease_seconds: 180,
  });
  if (error) {
    throw new Error(`legacy checkout fulfillment claim failed: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        decision?: LegacyCheckoutClaimDecision;
        claimed_user_id?: string | null;
        claimed_week_of?: string;
      }
    | null;
  if (!row?.decision || !row.claimed_week_of) {
    throw new Error("legacy checkout fulfillment claim returned no decision");
  }
  return {
    decision: row.decision,
    leaseToken,
    sessionId: paid.sessionId,
    userId: row.claimed_user_id ?? null,
    weekOf: row.claimed_week_of,
  };
}

async function releaseLegacyCheckoutFulfillment(
  claim: LegacyCheckoutClaim
): Promise<void> {
  if (claim.decision !== "claimed") return;
  const sb = await supabaseServiceClient();
  const { error } = await sb
    .from("legacy_checkout_fulfillments")
    .update({
      lease_token: null,
      lease_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    })
    .eq("session_id", claim.sessionId)
    .in("status", ["pending", "awaiting_issue"])
    .eq("lease_token", claim.leaseToken);
  if (error) {
    throw new Error(`legacy checkout fulfillment release failed: ${error.message}`);
  }
}

async function completeLegacyCheckoutFulfillment(
  claim: LegacyCheckoutClaim,
  userId: string
): Promise<void> {
  const sb = await supabaseServiceClient();
  const { data, error } = await sb.rpc(
    "complete_legacy_checkout_fulfillment",
    {
      p_session_id: claim.sessionId,
      p_lease_token: claim.leaseToken,
      p_user_id: userId,
    }
  );
  if (error || data !== "completed") {
    throw new Error(
      `legacy checkout fulfillment completion failed: ${
        error?.message ?? String(data)
      }`
    );
  }
}

function checkoutBrowserCookieName(profileId: string): string {
  return `alpha_checkout_${profileId}`;
}

async function claimCheckoutFulfillment(
  paid: Extract<PaidVerification, { ok: true; kind: "checkout" }>,
  weekOf: string
): Promise<CheckoutClaim> {
  const sb = await supabaseServiceClient();
  const leaseToken = crypto.randomUUID();
  const { data, error } = await sb.rpc("claim_checkout_fulfillment", {
    p_session_id: paid.sessionId,
    p_profile_id: paid.profileId,
    p_email_hash: checkoutEmailBinding(paid.checkoutEmail),
    p_user_id: paid.verifiedUserId,
    p_week_of: weekOf,
    p_lease_token: leaseToken,
    // Generation has a 105-second provider deadline, then still has to persist
    // the canonical issue and finish the claim. Leave enough room for those
    // required writes without allowing an abandoned claim to stick forever.
    p_lease_seconds: 180,
  });
  if (error) throw new Error(`checkout fulfillment claim failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        decision?: CheckoutClaimDecision;
        claimed_user_id?: string | null;
        claimed_week_of?: string;
      }
    | null;
  if (!row?.decision || !row.claimed_week_of) {
    throw new Error("checkout fulfillment claim returned no decision");
  }
  return {
    decision: row.decision,
    leaseToken,
    sessionId: paid.sessionId,
    profileId: paid.profileId,
    userId: row.claimed_user_id ?? null,
    weekOf: row.claimed_week_of,
    customerId: paid.customerId,
    subscriptionId: paid.subscriptionId,
    checkoutStartedAtIso: paid.checkoutStartedAtIso,
    priorCustomerId: null,
    priorSubscriptionId: null,
    priorBindingReplaceable: false,
  };
}

async function cancelDuplicateCurrentCheckout(
  sb: Awaited<ReturnType<typeof supabaseServiceClient>>,
  stripe: Stripe,
  paid: Extract<PaidVerification, { ok: true; kind: "checkout" }>,
  claim: CheckoutClaim,
  winner: { customerId: string; subscriptionId: string }
): Promise<never> {
  await cleanupCurrentCheckoutDuplicate(
    {
      sessionId: paid.sessionId,
      profileId: paid.profileId,
      leaseToken: claim.leaseToken,
      userId: paid.verifiedUserId,
      loser: {
        customerId: paid.customerId,
        subscriptionId: paid.subscriptionId,
      },
      initialWinner: winner,
    },
    currentCheckoutDuplicateCleanupDependencies(sb, stripe)
  );
  await clearCheckoutBrowserBinding(paid.profileId);
  throw new LegacyDuplicateCheckoutCancelledError(
    "The duplicate Alpha subscription was stopped and queued for charge review."
  );
}

async function resolveLateCheckoutCompletionConflict(
  paid: Extract<PaidVerification, { ok: true; kind: "checkout" }>,
  claim: CheckoutClaim,
  completionError: unknown
): Promise<never> {
  const sb = await supabaseServiceClient();
  const stripe = getStripeClient();
  return resolveCurrentCheckoutCompletionConflict({
    loadWinner: async () => {
      const { data, error } = await sb
        .from("users")
        .select("stripe_customer_id, stripe_subscription_id")
        .eq("id", paid.verifiedUserId)
        .maybeSingle();
      if (error) {
        throw new Error(
          `late checkout conflict lookup failed: ${error.message}`
        );
      }
      return data;
    },
    classifyWinner: async (winner) => {
      const customerId = winner?.stripe_customer_id ?? null;
      const subscriptionId = winner?.stripe_subscription_id ?? null;
      if (!customerId || !subscriptionId) return "blocked";
      if (
        customerId === paid.customerId &&
        subscriptionId === paid.subscriptionId
      ) {
        return "same";
      }
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      if (
        subscription.id !== subscriptionId ||
        subscriptionCustomerId(subscription) !== customerId
      ) {
        return "blocked";
      }
      if (
        subscriptionStatusGrantsAccess(subscription.status) &&
        exactLiveAlphaSubscription(subscription)
      ) {
        return "duplicate_live_alpha";
      }
      if (
        isFinalSubscriptionStatus(subscription.status) ||
        alphaDefinitelyAbsent(subscription)
      ) {
        return "replaceable";
      }
      return "blocked";
    },
    cancelLosing: (winner) => {
      const customerId = winner?.stripe_customer_id ?? null;
      const subscriptionId = winner?.stripe_subscription_id ?? null;
      if (!customerId || !subscriptionId) {
        throw new Error("late checkout conflict winner is incomplete");
      }
      return cancelDuplicateCurrentCheckout(sb, stripe, paid, claim, {
        customerId,
        subscriptionId,
      });
    },
    completionError,
  });
}

async function authorizeCheckoutCompletionBinding(
  paid: Extract<PaidVerification, { ok: true; kind: "checkout" }>,
  claim: CheckoutClaim
): Promise<CheckoutClaim> {
  const sb = await supabaseServiceClient();
  const { data, error } = await sb
    .from("users")
    .select("stripe_customer_id, stripe_subscription_id")
    .eq("id", paid.verifiedUserId)
    .maybeSingle();
  if (error || !data) {
    throw new Error(
      `checkout prior billing lookup failed: ${
        error?.message ?? "canonical owner missing"
      }`
    );
  }
  const prior = {
    customerId: data.stripe_customer_id ?? null,
    subscriptionId: data.stripe_subscription_id ?? null,
  };
  const stripe = getStripeClient();
  if (
    prior.customerId &&
    prior.subscriptionId &&
    (prior.customerId !== paid.customerId ||
      prior.subscriptionId !== paid.subscriptionId)
  ) {
    const winner = await stripe.subscriptions.retrieve(prior.subscriptionId);
    if (
      winner.id === prior.subscriptionId &&
      subscriptionCustomerId(winner) === prior.customerId &&
      subscriptionStatusGrantsAccess(winner.status) &&
      exactLiveAlphaSubscription(winner)
    ) {
      return cancelDuplicateCurrentCheckout(sb, stripe, paid, claim, {
        customerId: prior.customerId,
        subscriptionId: prior.subscriptionId,
      });
    }
  }
  const decision = await classifyPriorRecoveryBinding(
    stripe,
    prior,
    { customerId: paid.customerId, subscriptionId: paid.subscriptionId }
  );
  return {
    ...claim,
    priorCustomerId: prior.customerId,
    priorSubscriptionId: prior.subscriptionId,
    priorBindingReplaceable: decision === "replaceable",
  };
}

async function releaseCheckoutFulfillment(claim: CheckoutClaim): Promise<void> {
  if (claim.decision !== "claimed") return;
  const sb = await supabaseServiceClient();
  const { error } = await sb
    .from("checkout_fulfillments")
    .update({ lease_token: null, lease_expires_at: new Date(0).toISOString() })
    .eq("session_id", claim.sessionId)
    .eq("status", "pending")
    .eq("lease_token", claim.leaseToken);
  if (error) throw new Error(`checkout fulfillment release failed: ${error.message}`);
}

async function scrubProvisionedCheckoutProfile(
  profileId: string,
  userId: string
): Promise<void> {
  const sb = await supabaseServiceClient();
  const { data, error } = await sb
    .from("checkout_profiles")
    .update({
      provisioned_user_id: userId,
      email: null,
      first_name: null,
      city: null,
      job_blurb: null,
      project_blurb: null,
      fun_blurb: null,
      birthday: null,
      gender: null,
      topics: null,
      theme: null,
      raw_profile_scrubbed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", profileId)
    .eq("billing_state", "paid")
    .or(`provisioned_user_id.is.null,provisioned_user_id.eq.${userId}`)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    throw new Error(
      `checkout profile privacy scrub failed: ${error?.message ?? "binding mismatch"}`
    );
  }
}

async function completeCheckoutFulfillment(
  claim: CheckoutClaim,
  userId: string
): Promise<void> {
  const sb = await supabaseServiceClient();
  const { data, error } = await sb
    .rpc("complete_checkout_fulfillment", {
      p_session_id: claim.sessionId,
      p_profile_id: claim.profileId,
      p_lease_token: claim.leaseToken,
      p_user_id: userId,
      p_customer_id: claim.customerId,
      p_subscription_id: claim.subscriptionId,
      p_checkout_started_at: claim.checkoutStartedAtIso,
      p_prior_customer_id: claim.priorCustomerId,
      p_prior_subscription_id: claim.priorSubscriptionId,
      p_prior_binding_replaceable: claim.priorBindingReplaceable,
    });
  if (error || data !== true) {
    throw new Error(
      `checkout fulfillment completion failed: ${
        error?.message ?? "claim no longer owned"
      }`
    );
  }
}

async function clearCheckoutBrowserBinding(profileId: string): Promise<void> {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(checkoutBrowserCookieName(profileId));
  } catch (error) {
    // Fulfillment is already durable at each call site. A cookie cleanup
    // failure must not release or repeat the one-time claim.
    console.warn(
      "[generate] completed checkout browser binding could not be cleared:",
      error instanceof Error ? error.message : error
    );
  }
}

async function loadStagedCheckoutProfile(
  paid: Extract<PaidVerification, { ok: true; kind: "checkout" }>
): Promise<{
  profile: z.infer<typeof ProfileSchema>;
  ownerUserId: string;
}> {
  const {
    profileId,
    verifiedEmail,
    verifiedUserId,
    checkoutEmail,
    sessionId,
    customerId,
    subscriptionId,
  } = paid;
  const sb = await supabaseServiceClient();
  const { data, error } = await sb
    .from("checkout_profiles")
    .select(
      "email_hash, email, first_name, city, job_blurb, project_blurb, fun_blurb, birthday, gender, topics, theme, browser_nonce_hash, owner_user_id, provisioned_user_id, stripe_session_id, stripe_customer_id, stripe_subscription_id, billing_state, raw_profile_scrubbed_at"
    )
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw new Error(`checkout profile lookup failed: ${error.message}`);
  if (
    !data ||
    data.email_hash !== checkoutEmailBinding(checkoutEmail) ||
    data.owner_user_id !== verifiedUserId ||
    data.stripe_session_id !== sessionId ||
    !["open", "paid"].includes(data.billing_state) ||
    (data.stripe_customer_id && data.stripe_customer_id !== customerId) ||
    (data.stripe_subscription_id && data.stripe_subscription_id !== subscriptionId) ||
    (data.provisioned_user_id &&
      data.provisioned_user_id !== verifiedUserId) ||
    !data.raw_profile_scrubbed_at ||
    data.email !== null ||
    data.first_name !== null ||
    data.city !== null ||
    data.job_blurb !== null ||
    data.project_blurb !== null ||
    data.fun_blurb !== null ||
    data.birthday !== null ||
    data.gender !== null ||
    data.topics !== null ||
    data.theme !== null
  ) {
    throw new Error(
      "checkout profile is missing, ended, or bound to another identity, Session, or subscription"
    );
  }
  const cookieStore = await cookies();
  const browserNonce = cookieStore
    .get(checkoutBrowserCookieName(profileId))
    ?.value;
  const actualHash = createHash("sha256")
    .update(browserNonce || "")
    .digest();
  const expectedHash = /^[a-f0-9]{64}$/i.test(data.browser_nonce_hash)
    ? Buffer.from(data.browser_nonce_hash, "hex")
    : Buffer.alloc(0);
  if (
    !browserNonce ||
    expectedHash.length !== actualHash.length ||
    !timingSafeEqual(expectedHash, actualHash)
  ) {
    throw new Error("checkout browser binding is missing or invalid");
  }

  // Stripe has just proven this exact Session, Customer, and live Alpha
  // subscription. Record the durable paid lock before generation starts. The
  // state predicate prevents a delayed success request from reopening an
  // intent already retired by a terminal subscription event.
  const { data: paidStage, error: paidStageError } = await sb
    .from("checkout_profiles")
    .update({
      billing_state: "paid",
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", profileId)
    .eq("owner_user_id", verifiedUserId)
    .eq("stripe_session_id", sessionId)
    .in("billing_state", ["open", "paid"])
    .select("id")
    .maybeSingle();
  if (paidStageError || !paidStage) {
    throw new Error(
      `checkout paid binding failed: ${paidStageError?.message ?? "intent no longer active"}`
    );
  }

  const { data: canonicalUser, error: canonicalUserError } = await sb
    .from("users")
    .select(
      "first_name, city, job_blurb, project_blurb, fun_blurb, birthday, gender, topics, theme"
    )
    .eq("id", verifiedUserId)
    .maybeSingle();
  if (canonicalUserError || !canonicalUser) {
    throw new Error(
      `canonical checkout profile lookup failed: ${
        canonicalUserError?.message ?? "checkout owner missing"
      }`
    );
  }
  return {
    profile: ProfileSchema.parse({
      email: verifiedEmail,
      firstName: canonicalUser.first_name,
      city: canonicalUser.city ?? "",
      jobBlurb: canonicalUser.job_blurb ?? undefined,
      projectBlurb: canonicalUser.project_blurb ?? undefined,
      funBlurb: canonicalUser.fun_blurb ?? undefined,
      birthday: canonicalUser.birthday ?? undefined,
      gender: canonicalUser.gender ?? undefined,
      topics: canonicalUser.topics,
      theme: canonicalUser.theme,
    }),
    ownerUserId: verifiedUserId,
  };
}

async function loadCompletedCheckoutIssue(
  userId: string | null,
  weekOf: string
): Promise<Issue | null> {
  if (!userId) return null;
  const sessionClient = await supabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await sessionClient.auth.getUser();
  if (authError || user?.id !== userId) return null;

  const sb = await supabaseServiceClient();
  const [userResult, issueResult] = await Promise.all([
    sb
      .from("users")
      .select("first_name, city, subscribed_at, cancelled_at, access_granted_at")
      .eq("id", userId)
      .maybeSingle(),
    sb
      .from("issues")
      .select("id, volume, number, editor_intro, sections")
      .eq("user_id", userId)
      .eq("week_of", weekOf)
      .maybeSingle(),
  ]);
  if (userResult.error || issueResult.error) {
    throw new Error(
      `completed checkout replay lookup failed: ${
        userResult.error?.message ?? issueResult.error?.message
      }`
    );
  }
  const account = userResult.data;
  const row = issueResult.data;
  if (
    !account ||
    !hasReaderAccess(
      account.subscribed_at,
      account.cancelled_at,
      account.access_granted_at
    ) ||
    !row
  ) {
    return null;
  }
  return {
    id: row.id,
    volume: row.volume,
    number: row.number,
    weekOf,
    recipientFirstName: account.first_name || "Reader",
    recipientCity: account.city || "",
    editorIntro: row.editor_intro,
    sections: row.sections as Issue["sections"],
  };
}

export async function POST(req: Request) {
  if (!SUBSCRIBER_LETTERS_ENABLED) {
    return NextResponse.json(
      {
        error: "subscriber_delivery_paused",
        message: "New letters are paused. You can still read your saved letters in your inbox.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Local burst brake: 3 generations per IP per hour in this isolate. The
  // Supabase-backed check below is the cross-isolate ceiling.
  const ip = clientKeyFromRequest(req);
  const limited = rateLimit(`generate:${ip}`, { limit: 3, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await req.json();
    body = BodySchema.parse(raw);
  } catch (e) {
    const message =
      e instanceof z.ZodError
        ? `Invalid input: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        : "Invalid JSON";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // The in-memory bucket above sheds casual bursts inside one isolate. This
  // database bucket is the real cross-isolate ceiling. It runs after input
  // validation so malformed requests cannot spend a database call, and before
  // payment/provider verification so distributed callers cannot multiply
  // Stripe and writer work across Cloudflare isolates.
  let distributedIpLimit;
  try {
    distributedIpLimit = await consumeDistributedRateLimit(
      await supabaseServiceClient(),
      "generate-ip",
      ip,
      { limit: 3, windowMs: 60 * 60 * 1000 }
    );
  } catch {
    distributedIpLimit = {
      ok: false,
      remaining: 0,
      retryAfterSec: 60,
      available: false,
    };
  }
  if (!distributedIpLimit.available) {
    return NextResponse.json(
      { error: "Request protection is temporarily unavailable. Try again shortly." },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }
  if (!distributedIpLimit.ok) {
    return NextResponse.json(
      {
        error: `Too many requests. Try again in ${Math.ceil(
          distributedIpLimit.retryAfterSec / 60
        )} minutes.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(distributedIpLimit.retryAfterSec) },
      }
    );
  }

  // Payment gate. 402 means the caller has not proved payment. 503 means
  // verification itself is temporarily unavailable and should be retried.
  const paid = await verifyPaid(body.sessionId);
  if (!paid.ok) {
    return NextResponse.json(
      {
        error: paid.code ?? paid.error,
        ...(paid.code ? { message: paid.error } : {}),
      },
      { status: paid.status }
    );
  }

  // alpha-drift-r18-01 (found+fixed 2026-08-07): the IP-keyed limit above is
  // the only throttle on this route, but verifyPaid()'s authenticated branch
  // (an "already-subscribed" re-generate call) needs no Stripe sessionId at
  // all -- an attacker with ONE valid paid account and many source IPs (or a
  // shared/rotating proxy) could drive real, metered Anthropic/Gemini/Brave
  // generation spend past the intended 3/hour cap indefinitely, since the IP
  // key resets per address. Every sibling account-mutation route (admin
  // actions, update-quantity) keys its limit on the resolved user id for
  // exactly this reason. Keyed separately from the IP limit (not instead of
  // it) so a legitimate subscriber behind a shared office/NAT IP is never
  // penalized by other unrelated traffic on that same address.
  if (
    paid.kind === "authenticated" ||
    paid.kind === "checkout" ||
    paid.kind === "legacy_authenticated"
  ) {
    const userLimited = rateLimit(`generate-user:${paid.verifiedUserId}`, {
      limit: 3,
      windowMs: 60 * 60 * 1000,
    });
    if (!userLimited.ok) {
      return NextResponse.json(
        { error: `Too many requests. Try again in ${Math.ceil(userLimited.retryAfterSec / 60)} minutes.` },
        { status: 429, headers: { "Retry-After": String(userLimited.retryAfterSec) } }
      );
    }

    let distributedUserLimit;
    try {
      distributedUserLimit = await consumeDistributedRateLimit(
        await supabaseServiceClient(),
        "generate-user",
        paid.verifiedUserId,
        { limit: 3, windowMs: 60 * 60 * 1000 }
      );
    } catch {
      distributedUserLimit = {
        ok: false,
        remaining: 0,
        retryAfterSec: 60,
        available: false,
      };
    }
    if (!distributedUserLimit.available) {
      return NextResponse.json(
        { error: "Request protection is temporarily unavailable. Try again shortly." },
        { status: 503, headers: { "Retry-After": "60" } }
      );
    }
    if (!distributedUserLimit.ok) {
      return NextResponse.json(
        {
          error: `Too many requests. Try again in ${Math.ceil(
            distributedUserLimit.retryAfterSec / 60
          )} minutes.`,
        },
        {
          status: 429,
          headers: { "Retry-After": String(distributedUserLimit.retryAfterSec) },
        }
      );
    }
  }

  let activeCheckoutClaim: CheckoutClaim | null = null;
  let activeLegacyCheckoutClaim: LegacyCheckoutClaim | null = null;
  try {
    // A checkout fulfills the current issue only. An authenticated account can
    // still use the bounded weekOf override for the existing re-generate path.
    const weekOf =
      paid.kind === "checkout" || paid.kind === "legacy_authenticated"
        ? paid.checkoutWeekOf
        : body.weekOf || defaultWeekOf();
    let profile: Parameters<typeof generateIssue>[0] | null = null;
    let checkoutExpectedUserId: string | undefined;

    if (paid.kind === "legacy_authenticated") {
      const rawProfile =
        body.profile && typeof body.profile === "object"
          ? (body.profile as Record<string, unknown>)
          : null;
      if (!rawProfile || !Array.isArray(rawProfile.topics) || rawProfile.topics.length !== 5) {
        return NextResponse.json(
          {
            error: "legacy_profile_required",
            message:
              "Your payment is on file. Choose five topics before finishing your first letter.",
          },
          { status: 409 }
        );
      }
      const parsedLegacyProfile = ProfileSchema.safeParse({
        ...rawProfile,
        firstName: paid.legacyFirstName,
        city: paid.legacyCity ?? "",
        email: paid.verifiedEmail,
      });
      if (!parsedLegacyProfile.success) {
        return NextResponse.json(
          {
            error: `Invalid input: ${parsedLegacyProfile.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}`,
          },
          { status: 400 }
        );
      }
      profile = parsedLegacyProfile.data as Parameters<typeof generateIssue>[0];
      checkoutExpectedUserId = paid.verifiedUserId;
      const claim = await claimLegacyCheckoutFulfillment(paid, weekOf);
      if (claim.decision === "completed") {
        const existingIssue = await loadCompletedCheckoutIssue(
          claim.userId,
          claim.weekOf
        );
        if (existingIssue) {
          return NextResponse.json({
            issue: existingIssue,
            userId: claim.userId,
            signedIn: true,
            emailSent: false,
            reused: true,
          });
        }
        return NextResponse.json(
          {
            error: "checkout_already_used",
            message: "This checkout link has already been used. Sign in to read your letter.",
          },
          { status: 409 }
        );
      }
      if (claim.decision === "in_progress") {
        return NextResponse.json(
          {
            error: "checkout_in_progress",
            message: "Your first letter is already being written. Try again shortly.",
          },
          { status: 409, headers: { "Retry-After": "15" } }
        );
      }
      if (claim.decision === "manual_review") {
        return NextResponse.json(
          {
            error: "checkout_review_required",
            message:
              "This checkout needs a billing review before it can be used again. Contact support for help.",
          },
          { status: 409 }
        );
      }
      if (claim.decision === "aborted") {
        return NextResponse.json(
          {
            error: "account_deletion_in_progress",
            message:
              "This account is being deleted. This checkout can no longer create a letter.",
          },
          { status: 409 }
        );
      }
      if (claim.decision === "profile_mismatch") {
        return NextResponse.json(
          { error: "This checkout link does not match this account." },
          { status: 402 }
        );
      }
      activeLegacyCheckoutClaim = claim;
      // Only the durable lease owner may touch the canonical profile, billing
      // mirror, suppression state, or paid providers. Replays and concurrent
      // losers above are read-only.
      await repairLegacyCheckoutSubscriber(
        paid,
        profile,
        claim
      );
    }

    if (paid.kind === "checkout") {
      // Prove the current confirmed Auth owner, the same browser, and the exact
      // staged Session before taking the expensive-generation lease.
      const stagedCheckout = await loadStagedCheckoutProfile(paid);
      profile = stagedCheckout.profile as Parameters<typeof generateIssue>[0];
      checkoutExpectedUserId = stagedCheckout.ownerUserId;

      // The paid-session bucket belongs after the HttpOnly browser binding is
      // proved. A copied success URL has no nonce and must not be able to burn
      // the real purchaser's five bounded retries from other IPs.
      const sessionLimited = rateLimit(`generate-session:${paid.sessionId}`, {
        limit: 5,
        windowMs: 60 * 60 * 1000,
      });
      if (!sessionLimited.ok) {
        return NextResponse.json(
          {
            error: `Too many requests. Try again in ${Math.ceil(
              sessionLimited.retryAfterSec / 60
            )} minutes.`,
          },
          {
            status: 429,
            headers: { "Retry-After": String(sessionLimited.retryAfterSec) },
          }
        );
      }

      let distributedSessionLimit;
      try {
        distributedSessionLimit = await consumeDistributedRateLimit(
          await supabaseServiceClient(),
          "generate-session",
          paid.sessionId,
          { limit: 5, windowMs: 60 * 60 * 1000 }
        );
      } catch {
        distributedSessionLimit = {
          ok: false,
          remaining: 0,
          retryAfterSec: 60,
          available: false,
        };
      }
      if (!distributedSessionLimit.available) {
        return NextResponse.json(
          { error: "Request protection is temporarily unavailable. Try again shortly." },
          { status: 503, headers: { "Retry-After": "60" } }
        );
      }
      if (!distributedSessionLimit.ok) {
        return NextResponse.json(
          {
            error: `Too many requests. Try again in ${Math.ceil(
              distributedSessionLimit.retryAfterSec / 60
            )} minutes.`,
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(distributedSessionLimit.retryAfterSec),
            },
          }
        );
      }

      const claim = await claimCheckoutFulfillment(paid, weekOf);
      if (claim.decision === "completed") {
        if (claim.userId && claim.userId !== paid.verifiedUserId) {
          return NextResponse.json(
            { error: "This checkout link does not match this account." },
            { status: 402 }
          );
        }
        if (claim.userId) {
          // A prior response may have completed the replay claim just before a
          // transient scrub write failed. Make every safe replay finish that
          // privacy cleanup before returning the canonical issue.
          await scrubProvisionedCheckoutProfile(paid.profileId, claim.userId);
        }
        await clearCheckoutBrowserBinding(paid.profileId);
        const existingIssue = await loadCompletedCheckoutIssue(
          claim.userId,
          claim.weekOf
        );
        if (existingIssue) {
          return NextResponse.json({
            issue: existingIssue,
            userId: claim.userId,
            signedIn: true,
            emailSent: false,
            reused: true,
          });
        }
        return NextResponse.json(
          {
            error: "checkout_already_used",
            message: "This checkout link has already been used. Sign in to read your letter.",
          },
          { status: 409 }
        );
      }
      if (claim.decision === "in_progress") {
        return NextResponse.json(
          {
            error: "checkout_in_progress",
            message: "Your first letter is already being written. Try again shortly.",
          },
          { status: 409, headers: { "Retry-After": "15" } }
        );
      }
      if (claim.decision === "cleanup_pending") {
        return NextResponse.json(
          {
            error: "checkout_cleanup_pending",
            message:
              "Billing cleanup is still in progress for this checkout. Try again later or contact support.",
          },
          { status: 409, headers: { "Retry-After": "300" } }
        );
      }
      if (claim.decision === "manual_review") {
        return NextResponse.json(
          {
            error: "checkout_review_required",
            message:
              "This checkout needs a billing review before it can be used again. Contact support for help.",
          },
          { status: 409 }
        );
      }
      if (claim.decision === "aborted") {
        return NextResponse.json(
          {
            error: "checkout_unavailable",
            message:
              "This checkout can no longer create a letter. Sign in or contact support if you need help.",
          },
          { status: 409 }
        );
      }
      if (claim.decision === "profile_mismatch") {
        return NextResponse.json(
          { error: "This checkout link does not match this signup." },
          { status: 402 }
        );
      }
      // Keep the lease in the release path before the provider-backed prior
      // binding check. A transient Stripe/read failure must not strand the
      // one-time fulfillment claim until its lease expires.
      activeCheckoutClaim = claim;
      activeCheckoutClaim = await authorizeCheckoutCompletionBinding(
        paid,
        claim
      );
    }
    if (!profile) {
      const parsedProfile = ProfileSchema.safeParse(body.profile);
      if (!parsedProfile.success) {
        return NextResponse.json(
          {
            error: `Invalid input: ${parsedProfile.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}`,
          },
          { status: 400 }
        );
      }
      profile = parsedProfile.data as Parameters<typeof generateIssue>[0];
    }
    // ProfileSchema only bounds theme's length, not its catalog membership --
    // unlike topics (isValidTopicId, above) and gender (coerceGender, in
    // persist.ts), theme reached the DB unchecked. coerceThemeId is "the
    // single allow-list check for a theme value coming from an untrusted
    // source" per its own comment, tied to a real past incident (a removed
    // theme id shipping wrong on the emailed letter view).
    profile.theme = coerceThemeId(profile.theme) ?? "forest";
    // Never trust the caller-supplied profile.email for identity. Overwrite it
    // with the email verifyPaid() actually confirmed this request as (the
    // signed-in user's own email, or the email Stripe collected at checkout).
    // See verifyPaid's comment -- this is the fix for a real account-takeover
    // bug where profile.email flowed straight into magic-link generation.
    if (paid.verifiedEmail) {
      profile.email = paid.verifiedEmail;
    }
    // No letterSize passed on purpose: this is the onboarding first letter,
    // where the reader picked exactly their quota of topics (pool == quota), so
    // generating the whole pool == generating their letterSize. If a future
    // re-generate path lets an existing reader with a DEEPER ranked pool hit
    // this endpoint, pass their topic_quota as letterSize here (as the cron
    // does) so it respects favorites/backups instead of generating the pool.
    // User-triggered first letters and signed-in regeneration share the same
    // real-day paid-provider ceiling as the scheduled send. A request cannot
    // sit outside the durable cost brake. Free providers, cached content, and
    // deterministic fallbacks remain available after the brake closes.
    const interactivePaidCallBudget = createDailyPaidCallGuard(
      await supabaseServiceClient(),
      defaultWeekOf(),
      10
    );
    const generatedIssue = await withDeadline(
      generateIssue(
        profile,
        weekOf,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        interactivePaidCallBudget.allow
      ),
      GENERATE_DEADLINE_MS,
      "onboarding generateIssue"
    );

    // The archive row is part of successful fulfillment. Sending an email
    // whose signed letter URL points at a missing issue is not a usable result.
    const persistence = await persistIssueIfPossible(
      profile,
      generatedIssue,
      weekOf,
      paid.kind === "authenticated" ? paid.verifiedUserId : checkoutExpectedUserId
    );
    const durableWriteRequired =
      paid.kind === "checkout" ||
      paid.kind === "legacy_authenticated" ||
      process.env.NODE_ENV !== "development";
    if (
      durableWriteRequired &&
      (!persistence?.userId ||
        !persistence.profilePersisted ||
        !persistence.issuePersisted)
    ) {
      throw new Error("subscriber profile or issue did not persist");
    }
    // The insert uses ignoreDuplicates so a concurrent cron or retry can win
    // the unique (user_id, week_of) row. From this point forward use only the
    // canonical durable payload. That keeps the browser, email, and archive
    // identical even when this request generated a losing candidate.
    const issue = persistence?.persistedIssue ?? generatedIssue;

    if (activeCheckoutClaim && persistence?.userId) {
      const completedProfileId = activeCheckoutClaim.profileId;
      try {
        await completeCheckoutFulfillment(
          activeCheckoutClaim,
          persistence.userId
        );
      } catch (completionError) {
        if (paid.kind === "checkout") {
          await resolveLateCheckoutCompletionConflict(
            paid,
            activeCheckoutClaim,
            completionError
          );
        }
        throw completionError;
      }
      activeCheckoutClaim = null;
      await clearCheckoutBrowserBinding(completedProfileId);
    }
    if (activeLegacyCheckoutClaim && persistence?.userId) {
      await completeLegacyCheckoutFulfillment(
        activeLegacyCheckoutClaim,
        persistence.userId
      );
      activeLegacyCheckoutClaim = null;
    }

    // Never turn a Stripe result or an admin-generated token into a browser
    // session. Current checkout already requires email-code verification before
    // payment, and its existing Supabase session owns durable inbox access.
    // Legacy checkout also reaches this point only after confirmed sign-in.
    const signedIn =
      paid.kind === "authenticated" ||
      paid.kind === "checkout" ||
      paid.kind === "legacy_authenticated";

    // Best-effort email send (doesn't block on failure either — letter still
    // renders on /inbox even if email delivery hiccups)
    //
    // Idempotency: if a delivered_at stamp already exists for this (user,
    // week) we DO NOT re-send. Protects against /writing remounts, double-
    // submits, retries that succeeded the first time but the client never
    // saw the response, etc. The cron uses the same gate via delivered_at.
    // alpha-drift-r49-02 (2026-08-20, docs-code-drift-round-5): this used to
    // blame req.url on "the youngalgy.com rewrite" landing on "the internal
    // Vercel hostname" -- that proxy/rewrite doesn't exist anymore
    // (youngalgy.com now 301-redirects rather than proxying, per
    // next.config.ts's own 2026-08-05 correction) and this app hasn't run on
    // Vercel since the same date. NEVER derive this from req.url: this route
    // runs on Cloudflare Workers behind alpha's own domain, and req.url can
    // still reflect a Worker-internal or preview hostname depending on how
    // the request arrived -- these URLs go into the subscriber's EMAIL, so
    // an unrouted host would land on a domain where their session cookie
    // doesn't exist ("No letter yet" dead end; a real subscriber hit exactly
    // this). Same canonical fallback as the cron.
    const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://alpha.everyday.report";
    const inboxUrl = `${origin}/inbox`;
    let emailSent = false;
    let deliveryRecipientEmail: string | null = null;
    if (resendConfigured() && persistence?.userId) {
      // The signed checkout event owns subscription and suppression state.
      // Generation can finish before that webhook, or while its provider-side
      // suppression cleanup is retrying. Re-read the durable user row and use
      // the same fail-closed delivery predicate as the daily cron before
      // claiming delivered_at. Leaving the issue unclaimed keeps it eligible
      // for a later safe delivery path.
      const sb = await supabaseServiceClient();
      const { data: deliveryUser, error: deliveryUserError } = await sb
        .from("users")
        .select(
          "email, subscribed_at, cancelled_at, access_granted_at, unsubscribed_at, bounced_at, complained_at, suppression_cleanup_pending_at"
        )
        .eq("id", persistence.userId)
        .maybeSingle();
      if (deliveryUserError) {
        console.warn(
          `[generate] first-letter delivery gate failed for user ${persistence.userId}:`,
          deliveryUserError.message
        );
      } else if (
        deliveryUser &&
        hasReaderAccess(
          deliveryUser.subscribed_at,
          deliveryUser.cancelled_at,
          deliveryUser.access_granted_at
        ) &&
        !deliveryUser.unsubscribed_at &&
        !deliveryUser.bounced_at &&
        !deliveryUser.complained_at &&
        !deliveryUser.suppression_cleanup_pending_at
      ) {
        deliveryRecipientEmail = deliveryUser.email?.toLowerCase().trim() || null;
      } else {
        console.warn(
          `[generate] first-letter delivery deferred for user ${persistence.userId}; subscription or suppression state is not ready`
        );
      }
    }
    // alpha-deliverability-03: sendLetterNotification's List-Unsubscribe
    // header + in-body unsubscribe link both require a real userId (the
    // unsubscribe token is HMAC(userId) -- see lib/unsubscribe.ts). Without
    // persistence.userId (a rare generateLink/Supabase hiccup on this exact
    // signup, per persist.ts's own try/catch), sending anyway would ship a
    // commercial email with NO unsubscribe mechanism at all -- a CAN-SPAM
    // violation and a spam-filter risk that outlives this one reader. Skip
    // the send instead: they already saw their letter rendered live on this
    // page regardless, and the alert below makes the gap visible rather
    // than a silent, permanent loss of their first email.
    if (profile.email && resendConfigured() && !persistence?.userId) {
      console.warn(
        `[generate] skipping onboarding email for ${profile.email} -- no persisted userId, would ship with no unsubscribe mechanism`
      );
      await sendOpsAlert(
        "alpha. onboarding email skipped (no unsubscribe mechanism)",
        `${profile.email} generated a first letter but persistIssueIfPossible didn't return a userId, so the onboarding email was skipped rather than sent without List-Unsubscribe. They still saw the letter live on /writing. Check Supabase Auth admin API health.`,
        `alpha-onboarding-email-skipped-${profile.email}-${weekOf}`
      );
    }
    if (deliveryRecipientEmail && persistence?.userId) {
      const toEmail = deliveryRecipientEmail;
      let issueNumber = 1; // this reader's Nth letter (drives "Issue N" subject)
      let store: DeliveryStore | null = null;
      if (persistence?.userId) {
        const sb = await supabaseServiceClient();
        store = deliveryStoreFor(sb);
        try {
          // Issue number = prior DELIVERED letters (weeks before this one) + 1.
          // delivered_at NOT NULL so a generated-but-unsent row doesn't inflate it.
          // alpha-drift-r62-09: `error` used to be discarded here too -- the
          // catch above only fires on a THROWN failure, but supabase-js
          // resolves rather than throws on a query error, so a genuine
          // failure silently left issueNumber at its default of 1 (a wrong
          // "Issue 1" subject line for an existing reader) with the exact
          // console.warn below never actually firing for that failure mode.
          const { count, error: countErr } = await sb
            .from("issues")
            .select("*", { count: "exact", head: true })
            .eq("user_id", persistence.userId)
            .lt("week_of", weekOf)
            .not("delivered_at", "is", null);
          if (countErr) throw countErr;
          issueNumber = (count ?? 0) + 1;
        } catch (e) {
          console.warn(
            "[generate] issue-number lookup failed (will still attempt send):",
            e instanceof Error ? e.message : e
          );
        }
      }
      // Idempotent send via an ATOMIC delivered_at claim, the same compare-and-
      // swap the weekly cron uses (lib/letter-delivery.ts). A signup can land
      // within ~a minute of a daily cron tick and both paths target the
      // same (user, week_of) row, so claiming before the send means exactly one
      // of them wins and the other skips. No persisted row → best-effort send.
      const deliveryClaimedAt = new Date().toISOString();
      const result = await deliverLetterOnce({
        store,
        userId: persistence?.userId ?? null,
        weekOf,
        stamp: deliveryClaimedAt,
        send: async () => {
          const deliverySb = await supabaseServiceClient();
          const preparedEmail = prepareLetterNotification({
            to: toEmail,
            firstName: profile.firstName,
            issue,
            inboxUrl,
            // Tokenized view-in-browser CTA. Opens the letter with no session.
            letterUrl: buildLetterUrl(persistence.userId, origin, weekOf),
            issueNumber,
            userId: persistence.userId,
            deliveryDate: weekOf,
          });
          const delivery = await sendWithResendDeliveryAttempt({
            sb: deliverySb,
            userId: persistence.userId,
            weekOf,
            recipient: preparedEmail.recipient,
            deliveryLane: "live",
            payloadFingerprint: preparedEmail.requestFingerprint,
            expectedClaimedAt: deliveryClaimedAt,
            send: (storedRecipient) => {
              if (storedRecipient !== preparedEmail.recipient) {
                throw new Error("staged recipient changed before provider send");
              }
              return sendPreparedSubscriberEmail(preparedEmail);
            },
          });
          if (delivery.suppressionReviewRequired) {
            console.warn(
              "[generate] provider accepted the letter but its suppression evidence needs review"
            );
          }
          return { id: delivery.messageId };
        },
        onError: (e) =>
          console.warn("[generate] letter email:", e instanceof Error ? e.message : e),
      });
      emailSent = result.sent;
      if (!result.sent && result.reason === "already-delivered") {
        console.log(
          `[generate] skipped letter email for user ${persistence?.userId}, already delivered for ${weekOf}`
        );
      }
    }

    return NextResponse.json({
      issue,
      userId: persistence?.userId ?? null,
      signedIn,
      emailSent,
    });
  } catch (err) {
    if (activeCheckoutClaim) {
      try {
        await releaseCheckoutFulfillment(activeCheckoutClaim);
      } catch (releaseError) {
        console.error(
          "[generate] checkout claim release failed:",
          releaseError instanceof Error ? releaseError.message : releaseError
        );
      }
    }
    if (activeLegacyCheckoutClaim) {
      try {
        await releaseLegacyCheckoutFulfillment(activeLegacyCheckoutClaim);
      } catch (releaseError) {
        console.error(
          "[generate] legacy checkout claim release failed:",
          releaseError instanceof Error ? releaseError.message : releaseError
        );
      }
    }
    if (err instanceof LegacyDuplicateCheckoutCancelledError) {
      return NextResponse.json(
        {
          error: "duplicate_checkout_cancelled",
          message: err.message,
        },
        { status: 409 }
      );
    }
    // Log the real error server-side only. The development and authenticated
    // paths share this handler, and the try block
    // above spans the Anthropic/Brave/Gemini/Groq/DeepSeek SDKs, Supabase,
    // and Resend — any of those throwing must never put a raw internal
    // message in front of an anonymous caller (same class of leak already
    // fixed in app/api/support/route.ts).
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[generate] failed:", message);
    return NextResponse.json(
      { error: "Couldn't generate your letter. Try again in a moment." },
      { status: 500 }
    );
  }
}

// Adapt a Supabase service client to the DeliveryStore atomic-claim contract.
// `claim` is the compare-and-swap: stamp delivered_at only where it is still
// NULL (Postgres row-locks the UPDATE, so one concurrent caller wins). A 0-row
// result is disambiguated with a read — row present means already delivered, no
// row means best-effort persist never wrote one. `release` is guarded on our
// exact stamp so a rollback can't clear another invocation's claim.
//
// NOT shared with app/api/cron/weekly-send/route.ts's own inline claim —
// that one deliberately isn't built on this same DeliveryStore, since it
// bundles content (volume/number/editor_intro/sections) into the SAME atomic
// UPDATE this interface has no way to express (see that file's "Content
// fields ride along in THIS same atomic UPDATE now" comment). Both still
// share the identical `.eq(user_id).eq(week_of).is("delivered_at", null)`
// compare-and-swap predicate below — keep that predicate in sync if either
// changes. The cron's stuck-claim reclaim step is NOT cron-specific despite
// living in that file: it queries by week_of alone with no caller filter, so
// a claim stuck here (a hard crash between claim and release) is swept up
// and retried by the next cron tick for that same period, same as a cron-
// created stuck claim would be.
function deliveryStoreFor(
  sb: Awaited<ReturnType<typeof supabaseServiceClient>>
): DeliveryStore {
  return {
    async claim(userId, weekOf, stamp) {
      const { data: claimRows, error } = await sb
        .from("issues")
        .update({ delivered_at: stamp })
        .eq("user_id", userId)
        .eq("week_of", weekOf)
        .is("delivered_at", null)
        .select("user_id");
      if (error) throw new Error(error.message);
      if ((claimRows?.length ?? 0) > 0) return { won: true, exists: true };
      const { data: check, error: checkError } = await sb
        .from("issues")
        .select("delivered_at")
        .eq("user_id", userId)
        .eq("week_of", weekOf)
        .maybeSingle();
      // alpha-drift-r58-05 (2026-08-20, silent-catch-audit-r4): this read's
      // own `error` used to be discarded entirely, unlike this function's
      // other two Supabase calls (both throw on error). A genuine read
      // failure here is NOT the double-send risk the comment below
      // describes, though -- personally traced deliverLetterOnce
      // (lib/letter-delivery.ts): its "no-row" branch (what a swallowed
      // error here falls into today) and its "claim-error" branch (what
      // throwing here would route into via the outer catch) both call the
      // identical trySend() and fail open by explicit design ("never block
      // [the paid first letter] on an infra hiccup") -- so a thrown error
      // here changes NEITHER path's send behavior, only observability
      // (onError fires, the returned `reason` is the more accurate
      // "claim-error" instead of a misleading "no-row"). Logged, not
      // thrown, to keep that observability gain without claiming a
      // correctness fix this read genuinely doesn't provide.
      if (checkError) console.warn("[generate] claim() disambiguation read failed:", checkError.message);
      // exists keys on ROW PRESENCE, not on delivered_at being set, on purpose.
      // If a concurrent run claimed this row then released it (its send failed)
      // in the sliver between our UPDATE and this read, we treat the present row
      // as already-handled and SKIP. That is deliberate: best-effort sending a
      // present-but-null row holds NO claim, so the cron could claim and send it
      // too — the exact double-send this guards against. A skipped letter is
      // re-delivered by the next cron tick; a duplicate is not recoverable.
      return { won: false, exists: !!check };
    },
    async release(userId, weekOf, stamp) {
      const { error } = await sb
        .from("issues")
        .update({ delivered_at: null })
        .eq("user_id", userId)
        .eq("week_of", weekOf)
        .eq("delivered_at", stamp);
      if (error) throw new Error(error.message);
    },
  };
}

function defaultWeekOf(): string {
  // The first letter's period key = TODAY's UTC date (the send date), matching
  // the cron's currentPeriodIso() under the multi-send cadence. This keeps the
  // (user, week_of) idempotency key and the (topic, week_of) blurb cache aligned
  // between the onboarding first-letter path and the daily cron, so a
  // first letter and a same-day cron send share one period instead of two keys.
  return new Date().toISOString().slice(0, 10);
}
