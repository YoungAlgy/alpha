import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Stripe from "stripe";
import { STRIPE_PRICE_ID, getStripeClient, describeStripeError } from "@/lib/stripe";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { rateLimit, clientKeyFromRequest } from "@/lib/rate-limit";
import { isProfileComplete } from "@/lib/checkout-guards";
import { parseBirthday } from "@/lib/demographics";
import { coerceThemeId } from "@/lib/themes";
import { BLURB_CAPS } from "@/lib/types";
import { isLiveForManagement, MAX_QTY, MIN_QTY } from "@/lib/update-quantity-guards";
import { scrubExpiredCheckoutProfiles } from "@/lib/checkout-profile-retention";
import { checkoutEmailBinding } from "@/lib/checkout-binding";
import {
  CHECKOUT_SESSION_PARAMS_VERSION,
  alphaCheckoutSessionCreateParams,
  alphaCheckoutSessionIdempotencyKey,
  checkoutSessionMatchesPersistedRequest,
} from "@/lib/checkout-session-params";
import {
  decryptCheckoutSessionEmail,
  encryptCheckoutSessionEmail,
} from "@/lib/checkout-session-email";
import { checkoutMode } from "@/lib/checkout-maintenance";
import { isInviteOnly } from "@/lib/access-mode";
import { withDeadline } from "@/lib/with-deadline";
import { isAuthSessionMissingError } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Same caps app/api/account/profile/route.ts's LIMITS already enforce for
// firstName/city -- this route is the OTHER write path into the same
// public.users columns (via the staged checkout profile -> webhook), and used
// to be the one place that didn't bound them. The schema rejects oversized
// input before isProfileComplete applies the stricter five-topic base-plan rule.
const CheckoutPayloadSchema = z.object({
  // 254, not 320 -- lib/validate-email.ts documents and enforces the real
  // RFC 5321 total-length bound (320 is the common local-part(64)+domain(255)
  // misconception). isProfileComplete() below already calls isValidEmail(),
  // which rejects anything over 254 -- a 255-320 char input used to pass
  // this schema cleanly and then fail there with a generic "finish your
  // profile" 400 instead of a specific length error, since the two caps
  // disagreed with each other one file apart.
  email: z.string().max(254).optional(),
  firstName: z.string().max(60).optional(),
  city: z.string().max(120).optional(),
  jobBlurb: z.string().max(BLURB_CAPS.jobBlurb).optional(),
  projectBlurb: z.string().max(BLURB_CAPS.projectBlurb).optional(),
  funBlurb: z.string().max(BLURB_CAPS.funBlurb).optional(),
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => parseBirthday(value) !== null, "invalid birthday")
    .optional(),
  gender: z.enum(["male", "female"]).optional(),
  topics: z.array(z.string()).max(25).optional(),
  theme: z.string().max(30).optional(),
});
type CheckoutPayload = z.infer<typeof CheckoutPayloadSchema>;

function newCheckoutBrowserNonce(): string {
  return randomBytes(32).toString("base64url");
}

function checkoutBrowserCookieName(profileId: string): string {
  return `alpha_checkout_${profileId}`;
}

function nonceMatchesHash(nonce: string | undefined, expectedHex: string): boolean {
  if (!nonce || !/^[a-f0-9]{64}$/i.test(expectedHex)) return false;
  const actual = createHash("sha256").update(nonce).digest();
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isCurrentAlphaSubscription(subscription: Stripe.Subscription): boolean {
  if (
    !subscription.items ||
    subscription.items.has_more ||
    !Array.isArray(subscription.items.data)
  ) {
    return false;
  }
  const items = subscription.items?.data ?? [];
  if (items.length !== 1) return false;
  const item = items[0];
  const priceId = typeof item.price === "string" ? item.price : item.price.id;
  const quantity = item.quantity ?? 1;
  return (
    priceId === STRIPE_PRICE_ID &&
    Number.isInteger(quantity) &&
    quantity >= MIN_QTY &&
    quantity <= MAX_QTY
  );
}

function alphaPricePresence(
  subscription: Stripe.Subscription
): "present" | "absent" | "unknown" {
  if (
    !subscription.items ||
    subscription.items.has_more ||
    !Array.isArray(subscription.items.data)
  ) {
    return "unknown";
  }
  return subscription.items.data.some((item) => {
    const priceId = typeof item.price === "string" ? item.price : item.price.id;
    return priceId === STRIPE_PRICE_ID;
  })
    ? "present"
    : "absent";
}

function blocksNewAlphaCheckout(status: Stripe.Subscription.Status): boolean {
  // Only these two states are final and cannot become chargeable again. Every
  // other state keeps the one-subscription lock, including incomplete, paused,
  // past_due, and unpaid. Stripe can reopen/pay an unpaid subscription, so a
  // new recurring Session must not coexist with it.
  return status !== "canceled" && status !== "incomplete_expired";
}

function stripeResourceIsMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "resource_missing"
  );
}

async function hasBlockingAlphaSubscriptionForCheckout(
  stripe: Stripe,
  email: string,
  knownCustomerId: string | null,
  knownSubscriptionId: string | null
): Promise<boolean> {
  const customerIds = new Set<string>();
  const inspectedSubscriptionIds = new Set<string>();
  let blockingAlphaSubscriptions = 0;
  if (knownCustomerId) customerIds.add(knownCustomerId);

  const inspectSubscription = (subscription: Stripe.Subscription) => {
    if (inspectedSubscriptionIds.has(subscription.id)) return;
    inspectedSubscriptionIds.add(subscription.id);
    if (!blocksNewAlphaCheckout(subscription.status)) return;
    if (!isCurrentAlphaSubscription(subscription)) {
      if (alphaPricePresence(subscription) !== "absent") {
        throw new Error(
          `live Alpha-priced subscription ${subscription.id} has an invalid item shape`
        );
      }
      return;
    }
    blockingAlphaSubscriptions += 1;
  };

  // The durable exact subscription id is stronger evidence than customer or
  // email lookup. Retrieve it first so stale Customer email cannot hide a
  // still-live recurring Alpha charge.
  if (knownSubscriptionId) {
    try {
      const knownSubscription = await stripe.subscriptions.retrieve(
        knownSubscriptionId
      );
      const actualCustomerId =
        typeof knownSubscription.customer === "string"
          ? knownSubscription.customer
          : knownSubscription.customer.id;
      const knownSubscriptionStillBillsAlpha =
        blocksNewAlphaCheckout(knownSubscription.status) &&
        alphaPricePresence(knownSubscription) !== "absent";
      if (
        knownSubscriptionStillBillsAlpha &&
        knownCustomerId &&
        actualCustomerId !== knownCustomerId
      ) {
        throw new Error(
          `stored Alpha subscription ${knownSubscriptionId} belongs to a different Stripe customer`
        );
      }
      customerIds.add(actualCustomerId);
      inspectSubscription(knownSubscription);
    } catch (error) {
      if (!stripeResourceIsMissing(error)) throw error;
    }
  }

  const customers = await stripe.customers.list({ email, limit: 100 });
  if (customers.has_more) {
    throw new Error(`Stripe customer lookup exceeded one page for ${email}`);
  }
  for (const customer of customers.data) customerIds.add(customer.id);

  for (const customerId of customerIds) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      price: STRIPE_PRICE_ID,
      status: "all",
      limit: 100,
    });
    if (subscriptions.has_more) {
      throw new Error(
        `Alpha subscription lookup exceeded one page for customer ${customerId}`
      );
    }
    for (const subscription of subscriptions.data) {
      // The Stripe price filter says this subscription contains Alpha. The
      // shared inspector still verifies the complete one-item shape.
      inspectSubscription(subscription);
    }
  }
  if (blockingAlphaSubscriptions > 1) {
    throw new Error(
      `multiple current Alpha subscriptions found across Stripe customers for ${email}`
    );
  }
  return blockingAlphaSubscriptions === 1;
}

type BoundCheckoutState =
  | { kind: "open"; session: Stripe.Checkout.Session }
  | {
      kind: "paid";
      session: Stripe.Checkout.Session;
      customerId: string;
      subscriptionId: string;
    }
  | {
      kind: "blocked";
      session: Stripe.Checkout.Session;
      customerId: string;
      subscriptionId: string;
      subscriptionStatus: Stripe.Subscription.Status;
    }
  | {
      kind: "released";
      reason: "expired";
    }
  | {
      kind: "released";
      reason: "ended";
      customerId: string;
      subscriptionId: string;
    };

async function inspectBoundCheckoutSession(
  stripe: Stripe,
  sessionId: string,
  expectedProfileId: string,
  businessExpiresAtIso: string | null
): Promise<BoundCheckoutState> {
  let session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["line_items", "subscription"],
  });
  if (
    session.metadata?.alpha_profile_id !== expectedProfileId ||
    session.mode !== "subscription"
  ) {
    throw new Error("stored Checkout Session binding is invalid");
  }
  // Expired is a definitive Stripe terminal state. Older Session expansions
  // may omit line items, but that cannot make an expired Session chargeable
  // again. Release it before applying the exact-shape checks required for
  // open or completed billing.
  if (session.status === "expired") {
    return { kind: "released", reason: "expired" };
  }
  const businessExpiresAt = Date.parse(businessExpiresAtIso ?? "");
  if (!Number.isFinite(businessExpiresAt)) {
    throw new Error("stored Checkout Session has no valid business deadline");
  }
  if (session.status === "open" && businessExpiresAt <= Date.now()) {
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch {
      // Payment completion can win this race. Re-read the exact Session and
      // decide from its authoritative status instead of assuming expiry.
    }
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "subscription"],
    });
    if (
      session.metadata?.alpha_profile_id !== expectedProfileId ||
      session.mode !== "subscription"
    ) {
      throw new Error("stored Checkout Session binding changed during expiry");
    }
    if (session.status === "expired") {
      return { kind: "released", reason: "expired" };
    }
  }
  const lineItems = session.line_items?.data ?? [];
  const exactAlphaLine =
    !!session.line_items &&
    !session.line_items.has_more &&
    Array.isArray(session.line_items.data) &&
    lineItems.length === 1 &&
    lineItems.every((item) => {
      const priceId =
        typeof item.price === "string" ? item.price : item.price?.id;
      return priceId === STRIPE_PRICE_ID && item.quantity === 1;
    });
  if (!exactAlphaLine) {
    throw new Error("stored Checkout Session is not the exact Alpha base item");
  }
  if (session.status === "open") return { kind: "open", session };
  if (session.status !== "complete") {
    throw new Error(`stored Checkout Session has unsupported status ${session.status}`);
  }

  const paid =
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required";
  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id ?? null;
  const subscription =
    typeof session.subscription === "string"
      ? await stripe.subscriptions.retrieve(session.subscription)
      : session.subscription;
  const subscriptionCustomerId = subscription
    ? typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id
    : null;
  if (!paid || !customerId || !subscription || subscriptionCustomerId !== customerId) {
    throw new Error("completed Checkout Session payment binding is invalid");
  }
  // A terminal subscription cannot create another Alpha charge. Release the
  // lock even if its final item snapshot is stale or malformed. Shape remains
  // fail-closed for every state that can still bill or be revived.
  if (!blocksNewAlphaCheckout(subscription.status)) {
    return {
      kind: "released",
      reason: "ended",
      customerId,
      subscriptionId: subscription.id,
    };
  }
  if (!isCurrentAlphaSubscription(subscription)) {
    if (alphaPricePresence(subscription) !== "absent") {
      throw new Error("stored Alpha subscription has an invalid item shape");
    }
    return {
      kind: "released",
      reason: "ended",
      customerId,
      subscriptionId: subscription.id,
    };
  }
  if (!isLiveForManagement(subscription.status)) {
    return {
      kind: "blocked",
      session,
      customerId,
      subscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
    };
  }
  return {
    kind: "paid",
    session,
    customerId,
    subscriptionId: subscription.id,
  };
}

function withCheckoutCookie(
  response: NextResponse,
  profileId: string,
  nonce: string
): NextResponse {
  response.cookies.set(checkoutBrowserCookieName(profileId), nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    // The checkout route also needs the binding to recover the one durable
    // pending Session. HttpOnly and SameSite keep it unavailable to scripts
    // and cross-site POSTs while /api/generate can still validate it.
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return response;
}

export async function POST(req: Request) {
  if (isInviteOnly(true)) {
    return NextResponse.json(
      {
        error: "invite_only",
        message: "Alpha is invite-only right now. Request access from the sign-up flow.",
      },
      { status: 410, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (checkoutMode(process.env.ALPHA_CHECKOUT_MODE) === "paused") {
    return NextResponse.json(
      {
        error: "checkout_temporarily_paused",
        message: "Checkout is briefly unavailable. Try again in a few minutes.",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store, must-revalidate",
          "Retry-After": "300",
        },
      }
    );
  }

  // Rate limit (same in-memory limiter the sibling generate/support routes use).
  // Caps casual abuse AND bulk probing of the already-subscribed guard below —
  // that guard returns a distinguishable 409 for active subscribers vs a 200 for
  // everyone else, a subscriber-enumeration oracle if left unthrottled. 10/hr/IP
  // leaves ample room for a real user's checkout retries while making any
  // list-sweep of "who is a paying subscriber" useless.
  const ip = clientKeyFromRequest(req);
  const limited = rateLimit(`checkout:${ip}`, { limit: 10, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  // Trim — env var paste from clipboards can include trailing \r or whitespace,
  // which Node's HTTP layer rejects when setting the Authorization header.
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "development") {
      return NextResponse.json(
        {
          error: "stripe_not_configured",
          message: "Stripe is not configured for local development.",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "Checkout is temporarily unavailable. Try again in a moment." },
      { status: 503 }
    );
  }

  let body: CheckoutPayload = {};
  try {
    // A slow or abandoned request body must never hold this billing handler
    // open indefinitely. A late body parse cannot reach database or Stripe
    // work after this bounded race has returned the validation response.
    const raw = await withDeadline(req.json(), 5_000, "checkout request body");
    body = CheckoutPayloadSchema.parse(raw);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: `Invalid input: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` },
        { status: 400 }
      );
    }
    // Empty/malformed JSON body -- fine, treated as no profile data.
  }
  // Canonicalize the email to lowercase so the double-charge guard's lookup, the
  // Stripe customer_email, and the row the webhook later writes all key on one
  // form (emails are case-insensitive in practice; Supabase auth lowercases too).
  if (body.email) body.email = body.email.toLowerCase().trim();

  // Profile-completeness gate — see lib/checkout-guards.ts's isProfileComplete
  // for why this exists and what it checks.
  if (!isProfileComplete(body)) {
    return NextResponse.json(
      { error: "Please finish setting up your profile before subscribing." },
      { status: 400 }
    );
  }
  let checkoutEmailHash: string;
  try {
    checkoutEmailHash = checkoutEmailBinding(body.email!);
  } catch (bindingError) {
    console.error(
      "[stripe/checkout] checkout email binding is unavailable:",
      bindingError instanceof Error ? bindingError.message : bindingError
    );
    return NextResponse.json(
      { error: "Checkout is temporarily unavailable. Try again in a moment." },
      { status: 503 }
    );
  }

  const stripe = getStripeClient();

  // A subscription lookup is part of the billing decision. If it is
  // unavailable, do not guess that no subscription exists and create a second
  // recurring charge for the same address.
  let sb: Awaited<ReturnType<typeof supabaseServiceClient>>;
  let checkoutOwnerUserId: string | null = null;
  let knownStripeCustomerId: string | null = null;
  let knownStripeSubscriptionId: string | null = null;
  try {
    sb = await supabaseServiceClient();
    const authClient = await supabaseServerClient();
    const {
      data: { user: signedInUser },
      error: authError,
    } = await authClient.auth.getUser();
    if (authError && !isAuthSessionMissingError(authError)) {
      throw new Error(`signed-in checkout lookup failed: ${authError.message}`);
    }

    if (!signedInUser) {
      // Require the same email-code proof for every new and returning buyer.
      // Looking up an arbitrary submitted email and returning a different
      // checkout result disclosed whether that address had an Alpha account or
      // active billing. It also left paid checkout without a stable Auth owner.
      return NextResponse.json(
        {
          error: "identity_verification_required",
          message: "Confirm your email before starting payment.",
        },
        { status: 409 }
      );
    }
    if (!signedInUser.email_confirmed_at) {
      return NextResponse.json(
        {
          error: "identity_verification_required",
          message: "Confirm your email before starting payment.",
        },
        { status: 409 }
      );
    }

    {
      const authEmail = signedInUser.email?.toLowerCase().trim();
      if (!authEmail || authEmail !== body.email) {
        return NextResponse.json(
          {
            error: "account_email_changed",
            message:
              "Your account email changed. Reload this page before starting checkout.",
          },
          { status: 409 }
        );
      }
      // Resolve subscription state by stable user id. During the supported
      // email-change flow, Auth can already hold the new email while the public
      // mirror still has the old one. An email-only lookup would miss the
      // existing paid account and create a second recurring charge.
      const { data: ownerRow, error: ownerError } = await sb
        .from("users")
        .select(
          "id, email, subscribed_at, cancelled_at, stripe_customer_id, stripe_subscription_id"
        )
        .eq("id", signedInUser.id)
        .maybeSingle();
      if (ownerError || !ownerRow) {
        throw new Error(
          `signed-in subscriber lookup failed: ${ownerError?.message ?? "public user missing"}`
        );
      }
      const { data: deletionSaga, error: deletionSagaError } = await sb
        .from("account_deletion_sagas")
        .select("state")
        .eq("user_id", signedInUser.id)
        .maybeSingle();
      if (deletionSagaError) {
        throw new Error(
          `account-deletion guard lookup failed: ${deletionSagaError.message}`
        );
      }
      if (deletionSaga) {
        return NextResponse.json(
          {
            error: "account_deletion_in_progress",
            message:
              "This account is being deleted. Billing cannot be restarted on it.",
          },
          { status: 409 }
        );
      }
      checkoutOwnerUserId = signedInUser.id;
      knownStripeCustomerId = ownerRow.stripe_customer_id ?? null;
      knownStripeSubscriptionId = ownerRow.stripe_subscription_id ?? null;
    }

    // Database state can lag a Stripe cancellation or miss a failed
    // provisioning event. Verify the exact Alpha price across the known
    // customer and every Stripe customer for this email before allowing a new
    // recurring Session. A Stripe lookup failure blocks checkout.
    const liveAlphaSubscription = await hasBlockingAlphaSubscriptionForCheckout(
      stripe,
      body.email!,
      knownStripeCustomerId,
      knownStripeSubscriptionId
    );
    if (liveAlphaSubscription) {
      return NextResponse.json(
        {
          error: "already_subscribed",
          message:
            "You already have an active subscription. Sign in to read your letters or manage it.",
        },
        { status: 409 }
      );
    }
  } catch (e) {
    console.error(
      "[stripe/checkout] active-subscription pre-check failed, blocking checkout:",
      e instanceof Error ? e.message : e
    );
    return NextResponse.json(
      { error: "Checkout is temporarily unavailable. Try again in a moment." },
      { status: 503 }
    );
  }

  // The pseudonymous reservation has a five-day operational deadline inside
  // the public seven-day outer limit. Cleanup retires only Sessionless rows.
  // Bound Sessions keep their duplicate-charge lock until fresh Stripe proof
  // says they expired or ended.
  const retentionErrors = await scrubExpiredCheckoutProfiles(sb);
  for (const retentionError of retentionErrors) {
    console.warn("[stripe/checkout] checkout retention cleanup failed:", retentionError);
  }

  // alpha-drift-r49-03 (2026-08-20, docs-code-drift-round-5): same stale
  // "internal Vercel host" rationale as app/api/generate/route.ts's
  // alpha-drift-r49-02 -- that proxy/rewrite doesn't exist anymore and this
  // app hasn't run on Vercel since 2026-08-05. Prefer the public app URL
  // (alpha.everyday.report) over the request origin — this route runs on
  // Cloudflare Workers, and req.url can still reflect a Worker-internal or
  // preview hostname, which would send users back to an unrouted URL after
  // Stripe success.
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || new URL(req.url).origin;

  // Atomically store the validated profile on the confirmed canonical user and
  // create a pseudonymous reservation before sending the reader to Stripe.
  // The Checkout Session carries only this opaque id. Partial email and owner
  // indexes serialize active Alpha intents across Worker isolates.
  let stagedProfileId = randomUUID();
  let stagedBrowserNonce = newCheckoutBrowserNonce();
  let stagedProfileReady = false;

  // A proven expired or ended intent is retired with a compare-and-set, then
  // this request gets one bounded attempt to create its replacement. Any
  // ambiguous Stripe or database result preserves the active lock and fails
  // closed instead of risking a second recurring subscription.
  for (let stageAttempt = 0; stageAttempt < 2 && !stagedProfileReady; stageAttempt += 1) {
    const { data: stagedInsert, error: stageError } = await sb.rpc(
      "stage_checkout_profile",
      {
        p_id: stagedProfileId,
        p_email_hash: checkoutEmailHash,
        p_email: body.email!,
        p_first_name: body.firstName!.trim(),
        p_city: body.city?.trim() || null,
        p_job_blurb: body.jobBlurb?.trim() || null,
        p_project_blurb: body.projectBlurb?.trim() || null,
        p_fun_blurb: body.funBlurb?.trim() || null,
        p_birthday: body.birthday || null,
        p_gender: body.gender || null,
        p_topics: body.topics!,
        p_theme: coerceThemeId(body.theme) ?? "forest",
        p_browser_nonce_hash: createHash("sha256")
          .update(stagedBrowserNonce)
          .digest("hex"),
        p_owner_user_id: checkoutOwnerUserId,
      }
    );

    if (!stageError && stagedInsert === "staged") {
      stagedProfileReady = true;
      break;
    }
    if (!stageError && stagedInsert === "deletion_pending") {
      return NextResponse.json(
        {
          error: "account_deletion_in_progress",
          message:
            "This account is being deleted. Billing cannot be restarted on it.",
        },
        { status: 409 }
      );
    }
    if (!stageError) {
      console.error(
        `[stripe/checkout] profile staging returned ${String(stagedInsert)}`
      );
      return NextResponse.json(
        { error: "Checkout is temporarily unavailable. Try again in a moment." },
        { status: 503 }
      );
    }

    const isActiveEmailConflict = (stageError as { code?: string }).code === "23505";
    if (!isActiveEmailConflict) {
      console.error("[stripe/checkout] profile staging failed:", stageError.message);
      return NextResponse.json(
        { error: "Checkout is temporarily unavailable. Try again in a moment." },
        { status: 503 }
      );
    }

    let existingStageQuery = sb
      .from("checkout_profiles")
      .select(
        "id, email_hash, browser_nonce_hash, owner_user_id, stripe_session_id, stripe_session_business_expires_at, stripe_customer_id, stripe_subscription_id, billing_state, created_at"
      )
      .in("billing_state", ["open", "creating", "paid"]);
    existingStageQuery = checkoutOwnerUserId
      ? existingStageQuery.or(
          `email_hash.eq.${checkoutEmailHash},owner_user_id.eq.${checkoutOwnerUserId}`
        )
      : existingStageQuery.eq("email_hash", checkoutEmailHash);
    const { data: existingStage, error: existingStageError } =
      await existingStageQuery.maybeSingle();
    if (existingStageError || !existingStage) {
      console.error(
        "[stripe/checkout] active checkout recovery lookup failed:",
        existingStageError?.message ?? "row missing after active-email conflict"
      );
      return NextResponse.json(
        { error: "Checkout is temporarily unavailable. Try again in a moment." },
        { status: 503 }
      );
    }

    stagedProfileId = existingStage.id;
    const cookieStore = await cookies();
    const existingNonce = cookieStore.get(checkoutBrowserCookieName(stagedProfileId))?.value;
    const sameBrowser = nonceMatchesHash(existingNonce, existingStage.browser_nonce_hash);
    const sameOwner = (existingStage.owner_user_id ?? null) === checkoutOwnerUserId;
    const sameEmailBinding = existingStage.email_hash === checkoutEmailHash;

    if (existingStage.stripe_session_id) {
      let boundState: BoundCheckoutState;
      try {
        boundState = await inspectBoundCheckoutSession(
          stripe,
          existingStage.stripe_session_id,
          stagedProfileId,
          existingStage.stripe_session_business_expires_at
        );
      } catch (e) {
        console.error(
          "[stripe/checkout] active Session recovery failed, preserving lock:",
          describeStripeError(e)
        );
        return withCheckoutCookie(
          NextResponse.json(
            { error: "Checkout is temporarily unavailable. Try again in a moment." },
            { status: 503 }
          ),
          stagedProfileId,
          existingNonce || stagedBrowserNonce
        );
      }

      if (boundState.kind === "released") {
        const nextState = boundState.reason === "expired" ? "expired" : "ended";
        const { data: retiredStage, error: retireError } = await sb
          .from("checkout_profiles")
          .update({
            billing_state: nextState,
            updated_at: new Date().toISOString(),
            raw_profile_scrubbed_at: new Date().toISOString(),
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
            ...(boundState.reason === "ended"
              ? {
                  stripe_customer_id: boundState.customerId,
                  stripe_subscription_id: boundState.subscriptionId,
                }
              : {}),
          })
          .eq("id", stagedProfileId)
          .eq("stripe_session_id", existingStage.stripe_session_id)
          .in("billing_state", ["open", "paid"])
          .select("id")
          .maybeSingle();
        if (retireError || !retiredStage || stageAttempt > 0) {
          console.error(
            "[stripe/checkout] proven terminal intent could not be retired:",
            retireError?.message ?? "concurrent state change"
          );
          return NextResponse.json(
            { error: "Checkout is temporarily unavailable. Try again in a moment." },
            { status: 503 }
          );
        }
        stagedProfileId = randomUUID();
        stagedBrowserNonce = newCheckoutBrowserNonce();
        continue;
      }

      if (boundState.kind === "paid") {
        const { data: paidStage, error: paidStageError } = await sb
          .from("checkout_profiles")
          .update({
            billing_state: "paid",
            stripe_customer_id: boundState.customerId,
            stripe_subscription_id: boundState.subscriptionId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", stagedProfileId)
          .eq("stripe_session_id", boundState.session.id)
          .in("billing_state", ["open", "paid"])
          .select("id")
          .maybeSingle();
        if (paidStageError || !paidStage) {
          console.error(
            "[stripe/checkout] paid intent binding could not be confirmed:",
            paidStageError?.message ?? "concurrent state change"
          );
          return NextResponse.json(
            { error: "Checkout is temporarily unavailable. Try again in a moment." },
            { status: 503 }
          );
        }
      }

      if (boundState.kind === "blocked") {
        const { data: blockedStage, error: blockedStageError } = await sb
          .from("checkout_profiles")
          .update({
            stripe_customer_id: boundState.customerId,
            stripe_subscription_id: boundState.subscriptionId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", stagedProfileId)
          .eq("stripe_session_id", boundState.session.id)
          .in("billing_state", ["open", "paid"])
          .select("id")
          .maybeSingle();
        if (blockedStageError || !blockedStage) {
          console.error(
            "[stripe/checkout] pending subscription binding could not be confirmed:",
            blockedStageError?.message ?? "concurrent state change"
          );
          return NextResponse.json(
            { error: "Checkout is temporarily unavailable. Try again in a moment." },
            { status: 503 }
          );
        }
        return NextResponse.json(
          {
            error: "subscription_pending",
            message:
              "Your existing Alpha subscription is still being resolved. Check its payment status before starting another checkout.",
          },
          { status: 409 }
        );
      }

      if (!sameBrowser || !sameOwner) {
        return NextResponse.json(
          {
            error: "checkout_already_started",
            message:
              "A checkout for this email is already open in another tab or browser. Finish it there, or sign in if payment already completed.",
          },
          { status: 409 }
        );
      }

      stagedBrowserNonce = existingNonce!;
      if (boundState.kind === "open") {
        if (!boundState.session.url) {
          console.error("[stripe/checkout] verified open Session has no URL");
          return NextResponse.json(
            { error: "Checkout is temporarily unavailable. Try again in a moment." },
            { status: 503 }
          );
        }
        return withCheckoutCookie(
          NextResponse.json({ url: boundState.session.url, reused: true }),
          stagedProfileId,
          stagedBrowserNonce
        );
      }
      return withCheckoutCookie(
        NextResponse.json({
          url: `${origin}/writing?session_id=${encodeURIComponent(boundState.session.id)}`,
          reused: true,
        }),
        stagedProfileId,
        stagedBrowserNonce
      );
    }

    // A same-browser retry can safely resume a sessionless row through the
    // stable idempotency key below. A different browser may retire only a
    // sessionless orphan old enough that the first request cannot still be in
    // its ordinary create-and-bind window.
    if (sameBrowser && sameOwner && sameEmailBinding) {
      stagedBrowserNonce = existingNonce!;
      stagedProfileReady = true;
      break;
    }
    if (sameOwner && !sameEmailBinding) {
      return NextResponse.json(
        {
          error: "checkout_already_started",
          message:
            "This account already has a checkout under its prior email. Finish or expire that checkout before starting another.",
        },
        { status: 409 }
      );
    }
    const createdAt = Date.parse(existingStage.created_at);
    const staleSessionless =
      Number.isFinite(createdAt) && Date.now() - createdAt >= 5 * 60 * 1000;
    if (staleSessionless) {
      const { data: retiredOrphan, error: retireOrphanError } = await sb
        .from("checkout_profiles")
        .update({
          billing_state: "expired",
          updated_at: new Date().toISOString(),
          raw_profile_scrubbed_at: new Date().toISOString(),
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
        })
        .eq("id", stagedProfileId)
        .eq("billing_state", "open")
        .is("stripe_session_id", null)
        .select("id")
        .maybeSingle();
      if (retireOrphanError || !retiredOrphan || stageAttempt > 0) {
        console.error(
          "[stripe/checkout] sessionless orphan could not be retired:",
          retireOrphanError?.message ?? "concurrent state change"
        );
        return NextResponse.json(
          { error: "Checkout is temporarily unavailable. Try again in a moment." },
          { status: 503 }
        );
      }
      stagedProfileId = randomUUID();
      stagedBrowserNonce = newCheckoutBrowserNonce();
      continue;
    }
    return NextResponse.json(
      {
        error: "checkout_already_started",
        message:
          "A checkout for this email is already being prepared. Try again in a few minutes.",
      },
      { status: 409 }
    );
  }

  if (!stagedProfileReady) {
    return NextResponse.json(
      { error: "Checkout is temporarily unavailable. Try again in a moment." },
      { status: 503 }
    );
  }

  let proposedSessionEmailCiphertext: string;
  try {
    proposedSessionEmailCiphertext = encryptCheckoutSessionEmail(
      body.email!,
      stagedProfileId
    );
  } catch (encryptionError) {
    console.error(
      "[stripe/checkout] exact Session email encryption is unavailable:",
      encryptionError instanceof Error
        ? encryptionError.message
        : encryptionError
    );
    return NextResponse.json(
      { error: "Checkout is temporarily unavailable. Try again in a moment." },
      { status: 503 }
    );
  }
  const { data: creationResult, error: creationDecisionError } = await sb.rpc(
    "begin_checkout_session_creation",
    {
      p_profile_id: stagedProfileId,
      p_origin: origin,
      p_price_id: STRIPE_PRICE_ID,
      p_params_version: CHECKOUT_SESSION_PARAMS_VERSION,
      p_customer_email_ciphertext: proposedSessionEmailCiphertext,
    }
  );
  if (creationDecisionError) {
    console.error(
      "[stripe/checkout] durable Session-creation claim failed:",
      creationDecisionError.message
    );
    return NextResponse.json(
      { error: "Checkout is temporarily unavailable. Try again in a moment." },
      { status: 503 }
    );
  }
  type CreationDecision = {
    decision: string;
    session_started_at: string | null;
    session_expires_at: string | null;
    session_business_expires_at: string | null;
    session_origin: string | null;
    session_price_id: string | null;
    session_params_version: number | null;
    session_customer_email_ciphertext: string | null;
  };
  const creationDecision = Array.isArray(creationResult)
    ? (creationResult[0] as CreationDecision | undefined)
    : undefined;
  if (creationDecision?.decision === "deletion_pending") {
    return NextResponse.json(
      {
        error: "account_deletion_in_progress",
        message:
          "This account is being deleted. Billing cannot be restarted on it.",
      },
      { status: 409 }
    );
  }
  if (creationDecision?.decision !== "ready") {
    console.error(
      `[stripe/checkout] Session creation was not durably claimed: ${String(
        creationDecision?.decision ?? "missing decision"
      )}`
    );
    return NextResponse.json(
      { error: "Checkout is temporarily unavailable. Try again in a moment." },
      { status: 503 }
    );
  }

  const persistedExpiryMs = Date.parse(
    creationDecision.session_expires_at ?? ""
  );
  const persistedExpirySeconds = persistedExpiryMs / 1000;
  const persistedStartedMs = Date.parse(
    creationDecision.session_started_at ?? ""
  );
  const persistedBusinessExpiryMs = Date.parse(
    creationDecision.session_business_expires_at ?? ""
  );
  let persistedCustomerEmail: string;
  try {
    persistedCustomerEmail = decryptCheckoutSessionEmail(
      creationDecision.session_customer_email_ciphertext ?? "",
      stagedProfileId
    );
  } catch (decryptionError) {
    console.error(
      "[stripe/checkout] persisted Session email could not be authenticated:",
      decryptionError instanceof Error
        ? decryptionError.message
        : decryptionError
    );
    return NextResponse.json(
      { error: "Checkout is temporarily unavailable. Try again in a moment." },
      { status: 503 }
    );
  }
  if (
    !Number.isInteger(persistedExpirySeconds) ||
    !Number.isFinite(persistedStartedMs) ||
    !Number.isFinite(persistedBusinessExpiryMs) ||
    persistedExpiryMs - persistedStartedMs !== 23 * 60 * 60 * 1000 ||
    persistedBusinessExpiryMs - persistedStartedMs !== 31 * 60 * 1000 ||
    creationDecision.session_origin !== origin ||
    creationDecision.session_price_id !== STRIPE_PRICE_ID ||
    creationDecision.session_params_version !==
      CHECKOUT_SESSION_PARAMS_VERSION ||
    persistedCustomerEmail !== body.email
  ) {
    console.error(
      "[stripe/checkout] durable Session parameters were missing or did not match this checkout"
    );
    return NextResponse.json(
      { error: "Checkout is temporarily unavailable. Try again in a moment." },
      { status: 503 }
    );
  }

  try {
    // This key is stable for the full life of the database-backed intent. A
    // retry after a network timeout therefore gets the same Stripe Session,
    // while a new intent after expiry receives a new UUID and a new Session.
    const idemKey = alphaCheckoutSessionIdempotencyKey(stagedProfileId);
    const sessionParams = alphaCheckoutSessionCreateParams({
      profileId: stagedProfileId,
      customerEmail: persistedCustomerEmail,
      origin: creationDecision.session_origin,
      priceId: creationDecision.session_price_id,
      expiresAtEpochSeconds: persistedExpirySeconds,
      paramsVersion: creationDecision.session_params_version,
    });
    let session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: idemKey,
    });

    if (!checkoutSessionMatchesPersistedRequest(session, {
      profileId: stagedProfileId,
      customerEmail: persistedCustomerEmail,
      expiresAtEpochSeconds: persistedExpirySeconds,
    })) {
      console.error(
        "[stripe/checkout] created Session does not match its persisted exact request"
      );
      return withCheckoutCookie(
        NextResponse.json(
          { error: "Couldn't start checkout. Try again in a moment." },
          { status: 503 }
        ),
        stagedProfileId,
        stagedBrowserNonce
      );
    }

    if (
      session.status === "open" &&
      persistedBusinessExpiryMs <= Date.now()
    ) {
      try {
        await stripe.checkout.sessions.expire(session.id);
      } catch {
        // Completion can win the expiry race. The authoritative re-read below
        // decides which terminal or usable path actually happened.
      }
      session = await stripe.checkout.sessions.retrieve(session.id);
      if (!checkoutSessionMatchesPersistedRequest(session, {
        profileId: stagedProfileId,
        customerEmail: persistedCustomerEmail,
        expiresAtEpochSeconds: persistedExpirySeconds,
      })) {
        throw new Error(
          "Checkout Session changed its persisted binding during expiry"
        );
      }
    }
    if (session.status === "open" && !session.url) {
      throw new Error("open Checkout Session has no hosted URL");
    }
    if (
      session.status !== "open" &&
      session.status !== "complete" &&
      session.status !== "expired"
    ) {
      throw new Error(
        `created Checkout Session has unsupported status ${session.status}`
      );
    }

    const { data: bindDecision, error: bindError } = await sb.rpc(
      "bind_checkout_session",
      {
        p_profile_id: stagedProfileId,
        p_session_id: session.id,
      }
    );
    if (bindError) {
      console.error("[stripe/checkout] Session binding write failed:", bindError.message);
      return withCheckoutCookie(
        NextResponse.json(
          { error: "Checkout is temporarily unavailable. Try again in a moment." },
          { status: 503 }
        ),
        stagedProfileId,
        stagedBrowserNonce
      );
    }
    if (bindDecision === "deletion_pending") {
      return NextResponse.json(
        {
          error: "account_deletion_in_progress",
          message:
            "This account is being deleted. The pending checkout was locked before it could be used.",
        },
        { status: 409 }
      );
    }
    if (bindDecision !== "bound") {
      console.error(
        `[stripe/checkout] Session binding could not be confirmed: ${String(
          bindDecision
        )}`
      );
      return withCheckoutCookie(
        NextResponse.json(
          { error: "Checkout is temporarily unavailable. Try again in a moment." },
          { status: 503 }
        ),
        stagedProfileId,
        stagedBrowserNonce
      );
    }

    if (session.status === "expired") {
      const { data: expiryDecision, error: expiryError } = await sb.rpc(
        "settle_checkout_session_expiration",
        {
          p_profile_id: stagedProfileId,
          p_session_id: session.id,
        }
      );
      if (expiryError || expiryDecision !== "settled") {
        throw new Error(
          `expired Checkout Session settlement failed: ${
            expiryError?.message ?? String(expiryDecision)
          }`
        );
      }
      return withCheckoutCookie(
        NextResponse.json(
          {
            error: "checkout_expired",
            message: "This checkout expired. Start again to continue.",
          },
          { status: 409 }
        ),
        stagedProfileId,
        stagedBrowserNonce
      );
    }

    if (session.status === "complete") {
      return withCheckoutCookie(
        NextResponse.json({
          url: `${origin}/writing?session_id=${encodeURIComponent(session.id)}`,
          reused: true,
        }),
        stagedProfileId,
        stagedBrowserNonce
      );
    }

    return withCheckoutCookie(
      NextResponse.json({ url: session.url }),
      stagedProfileId,
      stagedBrowserNonce
    );
  } catch (e) {
    // Log the real Stripe error server-side only. This endpoint has no auth
    // (just a rate limit), so the raw SDK message must never reach the
    // caller — it can leak price/product IDs or account config.
    //
    // alpha-drift-r29-05 (2026-08-14): describeStripeError (not a bare
    // e.message) so a rate limit, an auth failure, and a genuine outage are
    // distinguishable in logs -- see lib/stripe.ts's own comment.
    console.error("[stripe/checkout] failed:", describeStripeError(e));
    const response = NextResponse.json(
      { error: "Couldn't start checkout. Try again in a moment." },
      { status: 503 }
    );
    return withCheckoutCookie(response, stagedProfileId, stagedBrowserNonce);
  }
}
