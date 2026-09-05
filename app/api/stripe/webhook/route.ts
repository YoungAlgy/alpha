import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { STRIPE_PRICE_ID, getStripeClient, describeStripeError, isTransientStripeError, isStripeResourceMissing } from "@/lib/stripe";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { checkoutUserMutation, deriveCancelledAt, isTerminalSubscriptionStatus } from "@/lib/webhook-user-mutation";
import { sendOpsAlert } from "@/lib/email";
import { clampQuota, TOPICS_PER_BUNDLE, type TopicId } from "@/lib/types";
import { poolCap } from "@/lib/engine/select-sections";
import { isLiveForManagement } from "@/lib/update-quantity-guards";
import { resolveLegacyCheckoutMetadata } from "@/lib/legacy-checkout";
import { checkoutEmailBinding } from "@/lib/checkout-binding";
import {
  cancelWebhookDuplicateSubscription,
  recordRefundReview,
} from "@/lib/refund-review";
import { hasReaderAccess } from "@/lib/access";

export const runtime = "nodejs";

function subscriptionCustomerId(sub: Stripe.Subscription): string {
  return typeof sub.customer === "string" ? sub.customer : sub.customer.id;
}

function isAlphaSubscription(sub: Stripe.Subscription): boolean {
  if (!sub.items || sub.items.has_more || !Array.isArray(sub.items.data)) {
    return false;
  }
  const items = sub.items?.data ?? [];
  if (items.length !== 1) return false;
  const item = items[0];
  const priceId = typeof item.price === "string" ? item.price : item.price.id;
  const quantity = item.quantity ?? 1;
  return (
    priceId === STRIPE_PRICE_ID &&
    Number.isInteger(quantity) &&
    quantity >= 1 &&
    quantity <= 5
  );
}

function alphaPricePresence(
  sub: Stripe.Subscription
): "present" | "absent" | "unknown" {
  if (!sub.items || sub.items.has_more || !Array.isArray(sub.items.data)) {
    return "unknown";
  }
  return sub.items.data.some((item) => {
    const priceId = typeof item.price === "string" ? item.price : item.price.id;
    return priceId === STRIPE_PRICE_ID;
  })
    ? "present"
    : "absent";
}

function isUuid(value: string | null): value is string {
  return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function stripeId(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

interface AlphaBillingOrigin {
  customerId: string;
  subscriptionId: string;
  liveSubscription: Stripe.Subscription | null;
}

interface ReaderAccessSnapshotRow {
  subscribed_at: string | null;
  cancelled_at: string | null;
  access_granted_at: string | null;
}

interface ReaderAccessSummary {
  users: number;
  inviteAccessRemains: boolean;
  readerAccessRemains: boolean;
}

function summarizeReaderAccess(
  rows: ReaderAccessSnapshotRow[] | null | undefined
): ReaderAccessSummary {
  const snapshots = rows ?? [];
  return {
    users: snapshots.length,
    inviteAccessRemains: snapshots.some(
      (row) => row.access_granted_at !== null
    ),
    readerAccessRemains: snapshots.some((row) =>
      hasReaderAccess(
        row.subscribed_at,
        row.cancelled_at,
        row.access_granted_at
      )
    ),
  };
}

// Resolve a charge/dispute back through its PaymentIntent and immutable invoice
// lines before treating it as Alpha activity. Shared Stripe accounts must never
// let another product's payment revoke Alpha or trigger Alpha operations mail.
async function resolveAlphaBillingOrigin(
  stripe: Stripe,
  paymentIntentId: string | null,
  expectedCustomerId?: string | null
): Promise<AlphaBillingOrigin | null> {
  if (!paymentIntentId) return null;
  const payments = await stripe.invoicePayments.list({
    payment: { type: "payment_intent", payment_intent: paymentIntentId },
    limit: 2,
  });
  if (payments.data.length !== 1) return null;

  const invoiceId = stripeId(payments.data[0].invoice);
  if (!invoiceId) return null;
  const [invoice, lineItems] = await Promise.all([
    stripe.invoices.retrieve(invoiceId),
    stripe.invoices.listLineItems(invoiceId, { limit: 100 }),
  ]);
  const customerId = stripeId(invoice.customer);
  if (!customerId || (expectedCustomerId && customerId !== expectedCustomerId)) {
    return null;
  }
  if (lineItems.has_more || lineItems.data.length === 0) return null;
  const onlyAlphaPrice = lineItems.data.every((line) => {
    const price = line.pricing?.price_details?.price;
    const priceId = stripeId(price);
    const quantity = line.quantity ?? 1;
    return (
      priceId === STRIPE_PRICE_ID &&
      Number.isInteger(quantity) &&
      quantity >= 1 &&
      quantity <= 5
    );
  });
  if (!onlyAlphaPrice) return null;

  const subscriptionId = stripeId(
    invoice.parent?.subscription_details?.subscription
  );
  if (!subscriptionId) return null;

  let liveSubscription: Stripe.Subscription | null = null;
  try {
    liveSubscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (e) {
    if (isTransientStripeError(e)) throw e;
  }
  if (
    liveSubscription &&
    subscriptionCustomerId(liveSubscription) !== customerId
  ) {
    return null;
  }
  return { customerId, subscriptionId, liveSubscription };
}

// Stripe webhooks need the raw body for signature verification.
// Next.js route handlers expose this via req.text(); do NOT parse JSON first.
export async function POST(req: Request) {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret || !webhookSecret) {
    return NextResponse.json(
      { error: "Stripe webhook not configured (STRIPE_WEBHOOK_SECRET missing)" },
      { status: 503 }
    );
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  const rawBody = await req.text();
  const stripe = getStripeClient();

  let event: Stripe.Event;
  try {
    // Timestamp-tolerance (replay window) is intentionally left at the
    // Stripe SDK's default (300s, Stripe's own recommendation) rather than
    // passed explicitly here -- reinforced by the stripe_webhook_events
    // dedup table below, which structurally prevents a within-window replay
    // from double-processing regardless of the exact tolerance value.
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid signature";
    console.warn("[stripe-webhook] signature verification failed:", msg);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const sb = await supabaseServiceClient();

  // Claim the event with a durable lease. A duplicate may return success only
  // after the first request finished. A duplicate that arrives while the first
  // request is still processing gets a non-2xx response so Stripe will retry
  // if that first request later fails.
  const webhookLeaseToken = crypto.randomUUID();
  const { data: claimDecision, error: claimError } = await sb.rpc(
    "claim_stripe_webhook_event",
    {
      p_event_id: event.id,
      p_event_type: event.type,
      p_lease_token: webhookLeaseToken,
      p_lease_seconds: 300,
    }
  );
  if (claimError) {
    console.error("[stripe-webhook] event claim failed:", claimError.message);
    return NextResponse.json(
      { received: false, error: "webhook claim unavailable" },
      { status: 503 }
    );
  }
  if (claimDecision === "succeeded") {
    console.warn(`[stripe-webhook] completed duplicate event ${event.id} (${event.type}) -- skipping`);
    return NextResponse.json({ received: true });
  }
  if (claimDecision === "in_progress") {
    return NextResponse.json(
      { received: false, error: "event already processing" },
      { status: 409, headers: { "Retry-After": "15" } }
    );
  }
  if (claimDecision !== "claimed") {
    console.error("[stripe-webhook] event claim returned an invalid decision:", claimDecision);
    return NextResponse.json(
      { received: false, error: "webhook claim unavailable" },
      { status: 503 }
    );
  }

  // End paid billing access only through the exact Customer + Subscription
  // pair previously bound to Alpha. The separate permanent invite marker is
  // read back for accurate operations reporting and is never changed here.
  // One Stripe Customer can belong to more than one product in the account.
  const endExactSubscriptionBinding = async (
    customerId: string,
    subscriptionId: string,
    reason: string
  ) => {
    const endedAt = new Date().toISOString();
    const { data: endedUsers, error: endedUsersError } = await sb
      .from("users")
      .update({ cancelled_at: endedAt })
      .eq("stripe_customer_id", customerId)
      .eq("stripe_subscription_id", subscriptionId)
      .select("id, subscribed_at, cancelled_at, access_granted_at");
    if (endedUsersError) {
      throw new Error(
        `${reason} user binding update failed: ${endedUsersError.message}`
      );
    }

    const { data: endedIntents, error: endedIntentsError } = await sb
      .from("checkout_profiles")
      .update({
        billing_state: "ended",
        raw_profile_scrubbed_at: endedAt,
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
        updated_at: endedAt,
      })
      .eq("stripe_customer_id", customerId)
      .eq("stripe_subscription_id", subscriptionId)
      .neq("billing_state", "ended")
      .select("id");
    if (endedIntentsError) {
      throw new Error(
        `${reason} checkout intent update failed: ${endedIntentsError.message}`
      );
    }

    return {
      ...summarizeReaderAccess(endedUsers),
      intents: endedIntents?.length ?? 0,
    };
  };

  const readExactSubscriptionAccess = async (
    customerId: string,
    subscriptionId: string,
    reason: string
  ): Promise<ReaderAccessSummary> => {
    const { data: exactUser, error: exactUserError } = await sb
      .from("users")
      .select("subscribed_at, cancelled_at, access_granted_at")
      .eq("stripe_customer_id", customerId)
      .eq("stripe_subscription_id", subscriptionId)
      .maybeSingle();
    if (exactUserError) {
      throw new Error(
        `${reason} exact access lookup failed: ${exactUserError.message}`
      );
    }
    if (exactUser) return summarizeReaderAccess([exactUser]);

    const { data: legacyUser, error: legacyUserError } = await sb
      .from("users")
      .select("subscribed_at, cancelled_at, access_granted_at")
      .eq("stripe_customer_id", customerId)
      .is("stripe_subscription_id", null)
      .maybeSingle();
    if (legacyUserError) {
      throw new Error(
        `${reason} legacy access lookup failed: ${legacyUserError.message}`
      );
    }
    return summarizeReaderAccess(legacyUser ? [legacyUser] : []);
  };

  // Existing rows created before stripe_subscription_id was introduced have a
  // null exact binding. A signed terminal Alpha event may settle that legacy
  // row only after a fresh Stripe list proves there is at most one other
  // current Alpha subscription for the customer. Lookup errors and duplicates
  // are retriable instead of guessing from customer id alone.
  const settleLegacyAlphaEnd = async (
    customerId: string,
    endedSubscriptionId: string,
    reason: string
  ) => {
    const { data: legacyUser, error: legacyUserError } = await sb
      .from("users")
      .select("id, subscribed_at, cancelled_at, access_granted_at")
      .eq("stripe_customer_id", customerId)
      .is("stripe_subscription_id", null)
      .maybeSingle();
    if (legacyUserError) {
      throw new Error(`${reason} legacy user lookup failed: ${legacyUserError.message}`);
    }
    if (!legacyUser) return summarizeReaderAccess([]);

    const alphaSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      price: STRIPE_PRICE_ID,
      status: "all",
      limit: 100,
    });
    if (alphaSubscriptions.has_more) {
      throw new Error(
        `${reason} Alpha subscription lookup exceeded one page for customer ${customerId}`
      );
    }
    const currentAlphaSubscriptions: Stripe.Subscription[] = [];
    for (const candidate of alphaSubscriptions.data) {
      if (
        candidate.id === endedSubscriptionId ||
        isTerminalSubscriptionStatus(candidate.status)
      ) {
        continue;
      }
      if (!isAlphaSubscription(candidate)) {
        throw new Error(
          `${reason} found a nonterminal Alpha-priced subscription with an invalid item shape`
        );
      }
      currentAlphaSubscriptions.push(candidate);
    }
    if (currentAlphaSubscriptions.length > 1) {
      throw new Error(
        `${reason} found multiple current Alpha subscriptions for customer ${customerId}`
      );
    }

    if (currentAlphaSubscriptions.length === 1) {
      const current = currentAlphaSubscriptions[0];
      const quantity = current.items.data[0]?.quantity ?? 1;
      const { data: rebound, error: reboundError } = await sb
        .from("users")
        .update({
          stripe_subscription_id: current.id,
          cancelled_at: deriveCancelledAt(current.status, current.cancel_at),
          topic_quota: clampQuota(quantity * TOPICS_PER_BUNDLE),
        })
        .eq("id", legacyUser.id)
        .eq("stripe_customer_id", customerId)
        .is("stripe_subscription_id", null)
        .select("id, subscribed_at, cancelled_at, access_granted_at")
        .maybeSingle();
      if (reboundError || !rebound) {
        throw new Error(
          `${reason} legacy binding repair failed: ${
            reboundError?.message ?? "user changed concurrently"
          }`
        );
      }
      return summarizeReaderAccess([rebound]);
    }

    const { data: revoked, error: revokedError } = await sb
      .from("users")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("id", legacyUser.id)
      .eq("stripe_customer_id", customerId)
      .is("stripe_subscription_id", null)
      .select("id, subscribed_at, cancelled_at, access_granted_at")
      .maybeSingle();
    if (revokedError || !revoked) {
      throw new Error(
        `${reason} legacy cancellation mirror failed: ${
          revokedError?.message ?? "user changed concurrently"
        }`
      );
    }
    return summarizeReaderAccess([revoked]);
  };

  const proveMissingPriorSubscriptionIsReplaceable = async (
    customerId: string,
    newlyPaidSubscriptionId: string
  ): Promise<void> => {
    const alphaSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      price: STRIPE_PRICE_ID,
      status: "all",
      limit: 100,
    });
    if (
      alphaSubscriptions.has_more ||
      !Array.isArray(alphaSubscriptions.data)
    ) {
      throw new Error(
        "stored missing subscription has no complete Customer-level proof"
      );
    }
    for (const candidate of alphaSubscriptions.data) {
      if (subscriptionCustomerId(candidate) !== customerId) {
        throw new Error(
          "Customer-filtered prior subscription has a different binding"
        );
      }
      if (
        candidate.id === newlyPaidSubscriptionId ||
        isTerminalSubscriptionStatus(candidate.status)
      ) {
        continue;
      }
      throw new Error(
        `stored Customer still has current Alpha subscription ${candidate.id}`
      );
    }
  };

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const checkoutLines = await stripe.checkout.sessions.listLineItems(
          session.id,
          { limit: 2 }
        );
        const exactAlphaCheckout =
          !checkoutLines.has_more &&
          checkoutLines.data.length === 1 &&
          checkoutLines.data.every((line) => {
            const priceId = stripeId(line.price);
            return priceId === STRIPE_PRICE_ID && line.quantity === 1;
          });
        const paymentComplete =
          session.payment_status === "paid" ||
          session.payment_status === "no_payment_required";
        if (
          session.mode !== "subscription" ||
          session.status !== "complete" ||
          !paymentComplete ||
          !exactAlphaCheckout
        ) {
          console.warn(
            `[stripe-webhook] ignoring non-Alpha checkout shape ${session.id} (mode=${session.mode}, status=${session.status}, payment=${session.payment_status})`
          );
          break;
        }
        const rawEmail = session.customer_details?.email || session.customer_email;
        // Normalize to lowercase so the public.users row, the auth user (Supabase
        // auth lowercases anyway), and the checkout double-charge guard's email
        // lookup all key on ONE canonical form (email addresses are treated
        // case-insensitively in practice).
        const email = rawEmail ? rawEmail.toLowerCase().trim() : null;
        if (!email) {
          throw new Error("checkout session has no email");
        }
        // A subscription-mode Checkout always attaches a Customer, so
        // session.customer is non-null here; the ?? null fallback is only for
        // type-narrowing. If a customer-less checkout path is ever added, the
        // out-of-order subscription-mirror self-heal would break (it keys on
        // stripe_customer_id), so guard that path rather than writing a null id.
        const customerId =
          typeof session.customer === "string"
            ? session.customer
            : session.customer?.id;
        if (email) {
          if (!customerId) {
            throw new Error("checkout session has no Stripe customer id");
          }
          // Verify the subscription before creating an auth user or touching
          // public.users. A delayed checkout event can arrive after terminal
          // subscription events have already been absorbed against no row.
          // Treat a failed lookup as retriable and an ended subscription as a
          // failed handler. Either way, it cannot mint fresh active access.
          const subId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription?.id ?? null;
          if (!subId) {
            throw new Error("checkout session has no subscription id");
          }
          let subscriptionLive = false;
          try {
            const sub = await stripe.subscriptions.retrieve(subId);
            if (subscriptionCustomerId(sub) !== customerId) {
              throw new Error(
                "checkout subscription customer binding has drifted"
              );
            }
            const alphaPresence = alphaPricePresence(sub);
            if (alphaPresence === "absent") {
              await endExactSubscriptionBinding(
                customerId,
                subId,
                "checkout subscription no longer contains Alpha"
              );
              console.warn(
                `[stripe-webhook] ignoring checkout ${session.id}: subscription no longer contains Alpha`
              );
              break;
            }
            if (alphaPresence === "unknown" || !isAlphaSubscription(sub)) {
              throw new Error(
                "checkout subscription Alpha item shape is incomplete or invalid"
              );
            }
            subscriptionLive = isLiveForManagement(sub.status);
            if (!subscriptionLive) {
              if (isTerminalSubscriptionStatus(sub.status)) {
                await endExactSubscriptionBinding(
                  customerId,
                  subId,
                  "checkout subscription is terminal"
                );
                console.warn(
                  `[stripe-webhook] checkout ${session.id} subscription ${subId} is ${sub.status}; exact Alpha access remains ended`
                );
                break;
              }
              throw new Error(`checkout subscription ${subId} is ${sub.status}`);
            }
          } catch (e) {
            throw new Error(
              `could not verify checkout subscription as live: ${describeStripeError(e)}`
            );
          }

          const meta = (session.metadata || {}) as Record<string, string>;
          const rawStagedProfileId = meta.alpha_profile_id?.trim() || null;
          const stagedProfileId = isUuid(rawStagedProfileId)
            ? rawStagedProfileId
            : null;
          const legacyProfile = stagedProfileId
            ? null
            : await resolveLegacyCheckoutMetadata(stripe, session);
          if (!stagedProfileId && !legacyProfile) {
            console.error(
              `[stripe-webhook] Alpha checkout ${session.id} has no redeemable profile binding; cancelling its exact subscription`
            );
            await recordRefundReview(sb, {
              sessionId: session.id,
              subscriptionId: subId,
              customerId,
              reason: "unfulfillable_checkout",
            });
            const cancelledUnfulfillable = await stripe.subscriptions.cancel(subId);
            if (
              cancelledUnfulfillable.id !== subId ||
              subscriptionCustomerId(cancelledUnfulfillable) !== customerId ||
              !isTerminalSubscriptionStatus(cancelledUnfulfillable.status)
            ) {
              throw new Error(
                "unfulfillable Alpha checkout cancellation did not become terminal"
              );
            }
            await sendOpsAlert(
              "[alpha] unfulfillable paid checkout cancelled",
              `Checkout Session ${session.id} paid for Alpha but has no current staged profile or redeemable legacy profile. Exact subscription ${subId} was cancelled. Review the first charge for a refund.`,
              `alpha-checkout-missing-profile-${session.id}`
            );
            break;
          }
          let stagedProfile:
            | {
                firstName: string;
                city: string | null;
                jobBlurb: string | null;
                projectBlurb: string | null;
                funBlurb: string | null;
                birthday: string | null;
                gender: "male" | "female" | null;
                topics: string[];
                theme: string;
                ownerUserId: string | null;
              }
            | undefined;
          let stagedBoundUserId: string | null = null;
          let stagedProvisionedUserId: string | null = null;
          if (stagedProfileId) {
            const { data: staged, error: stagedError } = await sb
              .from("checkout_profiles")
              .select(
                "email_hash, email, first_name, city, job_blurb, project_blurb, fun_blurb, birthday, gender, topics, theme, owner_user_id, provisioned_user_id, stripe_session_id, billing_state, stripe_customer_id, stripe_subscription_id, raw_profile_scrubbed_at"
              )
              .eq("id", stagedProfileId)
              .eq("stripe_session_id", session.id)
              .maybeSingle();
            if (stagedError) {
              throw new Error(`checkout profile lookup failed: ${stagedError.message}`);
            }
            if (!staged) {
              throw new Error("checkout profile is missing during paid webhook processing");
            }
            if (staged) {
              if (staged.billing_state !== "open" && staged.billing_state !== "paid") {
                throw new Error(
                  `checkout profile is ${staged.billing_state}, not fulfillable`
                );
              }
              if (
                staged.email_hash !== checkoutEmailBinding(email)
              ) {
                throw new Error("checkout profile email hash does not match Stripe email");
              }
              const pseudonymousStage =
                !!staged.owner_user_id &&
                !!staged.raw_profile_scrubbed_at &&
                staged.email === null &&
                staged.first_name === null &&
                staged.city === null &&
                staged.job_blurb === null &&
                staged.project_blurb === null &&
                staged.fun_blurb === null &&
                staged.birthday === null &&
                staged.gender === null &&
                staged.topics === null &&
                staged.theme === null;
              if (!pseudonymousStage) {
                throw new Error(
                  "checkout profile did not preserve its pseudonymous staging invariant"
                );
              }
              if (
                (staged.stripe_customer_id &&
                  staged.stripe_customer_id !== customerId) ||
                (staged.stripe_subscription_id &&
                  staged.stripe_subscription_id !== subId)
              ) {
                throw new Error("checkout profile Stripe binding conflict");
              }
              if (
                staged.provisioned_user_id &&
                staged.owner_user_id !== staged.provisioned_user_id
              ) {
                throw new Error("checkout profile owner and provisioned user differ");
              }

              // Make the paid billing identity durable before auth or email
              // provider work. The compare-and-swap prevents a concurrent
              // event from replacing a different exact Stripe binding.
              let paidStageQuery = sb
                .from("checkout_profiles")
                .update({
                  billing_state: "paid",
                  stripe_customer_id: customerId,
                  stripe_subscription_id: subId,
                })
                .eq("id", stagedProfileId)
                .eq("stripe_session_id", session.id)
                .in("billing_state", ["open", "paid"]);
              paidStageQuery = staged.stripe_customer_id
                ? paidStageQuery.eq(
                    "stripe_customer_id",
                    staged.stripe_customer_id
                  )
                : paidStageQuery.is("stripe_customer_id", null);
              paidStageQuery = staged.stripe_subscription_id
                ? paidStageQuery.eq(
                    "stripe_subscription_id",
                    staged.stripe_subscription_id
                  )
                : paidStageQuery.is("stripe_subscription_id", null);
              const { data: paidStage, error: paidStageError } =
                await paidStageQuery.select("id").maybeSingle();
              if (paidStageError || !paidStage) {
                throw new Error(
                  `checkout profile paid binding failed: ${
                    paidStageError?.message ?? "profile changed concurrently"
                  }`
                );
              }
              stagedProvisionedUserId = staged.provisioned_user_id ?? null;
              stagedBoundUserId = staged.owner_user_id;
              const { data: canonicalProfile, error: canonicalProfileError } =
                await sb
                  .from("users")
                  .select(
                    "first_name, city, job_blurb, project_blurb, fun_blurb, birthday, gender, topics, theme"
                  )
                  .eq("id", staged.owner_user_id)
                  .maybeSingle();
              if (canonicalProfileError || !canonicalProfile) {
                throw new Error(
                  `canonical checkout profile lookup failed: ${
                    canonicalProfileError?.message ?? "owner row missing"
                  }`
                );
              }
              if (
                typeof canonicalProfile.first_name !== "string" ||
                !Array.isArray(canonicalProfile.topics) ||
                canonicalProfile.topics.length !== 5 ||
                typeof canonicalProfile.theme !== "string"
              ) {
                throw new Error("canonical checkout profile is incomplete");
              }
              stagedProfile = {
                firstName: canonicalProfile.first_name,
                city: canonicalProfile.city,
                jobBlurb: canonicalProfile.job_blurb,
                projectBlurb: canonicalProfile.project_blurb,
                funBlurb: canonicalProfile.fun_blurb,
                birthday: canonicalProfile.birthday,
                gender:
                  canonicalProfile.gender === "male" ||
                  canonicalProfile.gender === "female"
                    ? canonicalProfile.gender
                    : null,
                topics: canonicalProfile.topics,
                theme: canonicalProfile.theme,
                ownerUserId: staged.owner_user_id,
              };
            }
          }

          // A signed-in owner is bound by stable auth user id. Do not resolve
          // that checkout through its possibly-old Stripe email: a confirmed
          // email change can finish between Session creation and this event,
          // and generateLink(oldEmail) would create or select a different user.
          // Anonymous checkout still uses Stripe's verified email to bootstrap
          // the auth user.
          let userId: string;
          let accountEmail = email;
          if (stagedBoundUserId) {
            const { data: ownerData, error: ownerError } = await sb.auth.admin.getUserById(
              stagedBoundUserId
            );
            const currentOwnerEmail = ownerData?.user?.email?.toLowerCase().trim();
            if (
              ownerError ||
              !ownerData?.user ||
              !ownerData.user.email_confirmed_at ||
              !currentOwnerEmail
            ) {
              throw new Error(
                `checkout owner lookup failed: ${
                  ownerError?.message ??
                  "owner missing, unconfirmed, or has no email"
                }`
              );
            }
            userId = stagedBoundUserId;
            accountEmail = currentOwnerEmail;
          } else {
            // Ensure the anonymous auth user exists (creates if missing) and
            // grab its id. Throw so Stripe retries if Auth is unavailable.
            const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
              type: "magiclink",
              email,
            });
            if (linkErr || !linkData?.user) {
              throw new Error(
                `generateLink failed: ${linkErr?.message ?? "no user returned"}`
              );
            }
            userId = linkData.user.id;
          }
          if (accountEmail !== email) {
            const syncedCustomer = await stripe.customers.update(customerId, {
              email: accountEmail,
            });
            if (
              syncedCustomer.deleted ||
              syncedCustomer.id !== customerId ||
              syncedCustomer.email?.toLowerCase() !== accountEmail
            ) {
              throw new Error(
                "Stripe Customer email did not match the confirmed account email"
              );
            }
          }
          {
            const firstName =
              stagedProfile?.firstName ||
              legacyProfile?.firstName ||
              meta.alpha_first_name ||
              meta.first_name ||
              "friend";
            const city =
              stagedProfile?.city ||
              legacyProfile?.city ||
              meta.alpha_city ||
              meta.city ||
              null;
            // Look up the existing row so we don't clobber subscription-owned
            // state (topic_quota / cancelled_at) on a re-delivered or
            // out-of-order checkout event. See lib/webhook-user-mutation.
            //
            // alpha-drift-r66-04 (2026-08-21, silent-catch-audit-r12): used
            // to discard `error` -- the only Supabase call in this handler
            // that did (every sibling, incl. the topics-cap read 200 lines
            // below, already checks it). A transient read failure on an
            // ALREADY-subscribed user (the common onboarding-funnel case)
            // used to look identical to "no row exists," routing into a
            // doomed INSERT that collides on the users.id PK and throws a
            // misleading "duplicate key" error instead of the real cause.
            // Self-healing either way (Stripe retries, the ops alert still
            // fires), so logged + folded into the insert-failure message
            // below rather than an early throw -- an early throw would also
            // break the "row genuinely absent" direct-checkout case, where
            // this same read failing today still lets the INSERT succeed.
            const { data: existing, error: existingErr } = await sb
              .from("users")
              .select(
                "subscribed_at, cancelled_at, unsubscribed_at, bounced_at, complained_at, delivery_suppression_cleared_at, suppression_cleanup_pending_at, first_name, city, job_blurb, project_blurb, fun_blurb, birthday, gender, topics, theme, stripe_customer_id, stripe_subscription_id"
              )
              .eq("id", userId)
              .maybeSingle();
            if (existingErr) {
              throw new Error(`existing user lookup failed: ${existingErr.message}`);
            }
            if (
              !stagedProfile &&
              !legacyProfile &&
              (!existing || !Array.isArray(existing.topics) || existing.topics.length === 0)
            ) {
              throw new Error(
                "paid checkout has no staged profile and the subscriber has no topics"
              );
            }
            let priorBindingReplaceable = false;
            let priorBindingIsLiveExactAlpha = false;
            let priorLiveExactAlphaBinding: {
              customerId: string;
              subscriptionId: string;
            } | null = null;
            if (
              existing?.stripe_subscription_id &&
              existing.stripe_subscription_id !== subId
            ) {
              let priorSubscription: Stripe.Subscription | null = null;
              try {
                priorSubscription = await stripe.subscriptions.retrieve(
                  existing.stripe_subscription_id
                );
              } catch (e) {
                if (isStripeResourceMissing(e)) {
                  if (!existing.stripe_customer_id) {
                    throw new Error(
                      "stored missing subscription has no exact Customer binding"
                    );
                  }
                  // Missing can also mean this runtime has the wrong Stripe
                  // account or mode. Replace only after the stored Customer
                  // is readable and a complete Alpha scan proves no other
                  // current subscription can still charge.
                  await proveMissingPriorSubscriptionIsReplaceable(
                    existing.stripe_customer_id,
                    subId
                  );
                  priorBindingReplaceable = true;
                  console.warn(
                    "[stripe/webhook] stored prior subscription is missing and its Customer has no other current Alpha subscription"
                  );
                } else {
                  throw new Error(
                    `stored subscription verification failed: ${describeStripeError(e)}`
                  );
                }
              }
              if (priorSubscription) {
                const priorCustomerId = subscriptionCustomerId(priorSubscription);
                const priorAlphaPresence = alphaPricePresence(priorSubscription);
                if (
                  priorAlphaPresence !== "absent" &&
                  !isTerminalSubscriptionStatus(priorSubscription.status) &&
                  (!existing.stripe_customer_id ||
                    priorCustomerId !== existing.stripe_customer_id)
                ) {
                  throw new Error(
                    "stored live Alpha subscription has no exact Customer binding"
                  );
                }
                priorBindingReplaceable =
                  isTerminalSubscriptionStatus(priorSubscription.status) ||
                  priorAlphaPresence === "absent";
                priorBindingIsLiveExactAlpha =
                  isLiveForManagement(priorSubscription.status) &&
                  isAlphaSubscription(priorSubscription);
                if (priorBindingIsLiveExactAlpha) {
                  if (
                    !existing.stripe_customer_id ||
                    !existing.stripe_subscription_id
                  ) {
                    throw new Error(
                      "stored live Alpha subscription billing pair is incomplete"
                    );
                  }
                  priorLiveExactAlphaBinding = {
                    customerId: existing.stripe_customer_id,
                    subscriptionId: existing.stripe_subscription_id,
                  };
                }
                if (!priorBindingReplaceable && !priorBindingIsLiveExactAlpha) {
                  throw new Error(
                    "stored prior subscription Alpha shape is incomplete or invalid"
                  );
                }
              }
            }
            if (priorLiveExactAlphaBinding) {
              // This paid Session created a second live Alpha subscription for
              // an identity that already owns one. Keep the established exact
              // binding, cancel only this Session's newly-created exact sub,
              // and scrub its staged profile. Retrying the webhook is safe.
              const duplicateCleanup =
                await cancelWebhookDuplicateSubscription(
                  sb,
                  {
                    sessionId: session.id,
                    userId,
                    emailHash: checkoutEmailBinding(accountEmail),
                    weekOf: new Date(session.created * 1000)
                      .toISOString()
                      .slice(0, 10),
                    loser: { customerId, subscriptionId: subId },
                    winner: priorLiveExactAlphaBinding,
                  },
                  {
                    retrieveSubscription: (subscriptionId) =>
                      stripe.subscriptions.retrieve(subscriptionId),
                    cancelSubscription: (subscriptionId, idempotencyKey) =>
                      stripe.subscriptions.cancel(
                        subscriptionId,
                        {},
                        { idempotencyKey }
                      ),
                    isExactAlphaSubscription: isAlphaSubscription,
                    isTerminalSubscriptionStatus,
                  }
                );
              await endExactSubscriptionBinding(
                customerId,
                subId,
                "duplicate paid Alpha checkout"
              );
              await sendOpsAlert(
                "[alpha] duplicate paid checkout cancelled",
                `Checkout Session ${session.id} created duplicate Alpha subscription ${subId} while ${priorLiveExactAlphaBinding.subscriptionId} was still live. The new subscription ${duplicateCleanup.cancelled ? "was cancelled" : "was already terminal"}. Review its first charge for a refund.`,
                `alpha-duplicate-checkout-${session.id}`
              );
              break;
            }
            const checkoutStartedAtIso = new Date(
              session.created * 1000
            ).toISOString();
            const checkoutMutationAt = new Date().toISOString();
            const mut = checkoutUserMutation(existing ?? null, {
              userId,
              email: accountEmail,
              firstName,
              city,
              customerId,
              subscriptionId: subId,
              priorBindingReplaceable,
              nowIso: checkoutMutationAt,
              checkoutStartedAtIso,
              subscriptionLive,
              // Paid checkout never removes a provider suppression or clears
              // local bounce/complaint evidence. It may restore paid access,
              // but delivery remains blocked until the explicit admin clear
              // action confirms the provider-side state.
              suppressionCleared: false,
              preserveSuppressionState: true,
              stagedProfile,
            });
            // A failed user write must THROW (-> 5xx -> Stripe retry, #35).
            if (mut.kind === "skip") {
              throw new Error(`checkout user mutation blocked: ${mut.reason}`);
            } else if (mut.kind === "insert") {
              const { error: insErr } = await sb.from("users").insert(mut.row);
              if (insErr) {
                throw new Error(`user insert failed: ${insErr.message}`);
              }
            } else {
              let checkoutUserUpdate = sb
                .from("users")
                .update(mut.patch)
                .eq("id", userId);
              checkoutUserUpdate = existing?.stripe_subscription_id
                ? checkoutUserUpdate.eq(
                    "stripe_subscription_id",
                    existing.stripe_subscription_id
                  )
                : checkoutUserUpdate.is("stripe_subscription_id", null);
              checkoutUserUpdate = existing?.cancelled_at
                ? checkoutUserUpdate.eq("cancelled_at", existing.cancelled_at)
                : checkoutUserUpdate.is("cancelled_at", null);
              checkoutUserUpdate = existing?.unsubscribed_at
                ? checkoutUserUpdate.eq(
                    "unsubscribed_at",
                    existing.unsubscribed_at
                  )
                : checkoutUserUpdate.is("unsubscribed_at", null);
              checkoutUserUpdate = existing?.bounced_at
                ? checkoutUserUpdate.eq("bounced_at", existing.bounced_at)
                : checkoutUserUpdate.is("bounced_at", null);
              checkoutUserUpdate = existing?.complained_at
                ? checkoutUserUpdate.eq(
                    "complained_at",
                    existing.complained_at
                  )
                : checkoutUserUpdate.is("complained_at", null);
              checkoutUserUpdate = existing?.suppression_cleanup_pending_at
                ? checkoutUserUpdate.eq(
                    "suppression_cleanup_pending_at",
                    existing.suppression_cleanup_pending_at
                  )
                : checkoutUserUpdate.is(
                    "suppression_cleanup_pending_at",
                    null
                  );
              const { data: updatedUser, error: updErr } = await checkoutUserUpdate
                .select("id")
                .maybeSingle();
              if (updErr || !updatedUser) {
                throw new Error(
                  `user update failed: ${
                    updErr?.message ?? "billing identity changed concurrently"
                  }`
                );
              }
            }

            // The canonical user row now owns the subscriber profile. Keep only
            // the pseudonymous billing reservation and exact Stripe bindings in
            // checkout_profiles so a seven-day reservation does not duplicate
            // raw subscriber data. This is idempotent on provider retries.
            if (stagedProfileId) {
              let scrubStageQuery = sb
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
              .eq("id", stagedProfileId)
              .eq("stripe_session_id", session.id)
              .eq("stripe_customer_id", customerId)
              .eq("stripe_subscription_id", subId)
              .eq("billing_state", "paid");
              scrubStageQuery = stagedProvisionedUserId
                ? scrubStageQuery.eq("provisioned_user_id", stagedProvisionedUserId)
                : scrubStageQuery.is("provisioned_user_id", null);
              const { data: scrubbedStage, error: scrubStageError } =
                await scrubStageQuery.select("id").maybeSingle();
              if (scrubStageError || !scrubbedStage) {
                throw new Error(
                  `checkout profile scrub failed: ${
                    scrubStageError?.message ?? "profile changed concurrently"
                  }`
                );
              }
            }
            // The old extra paid welcome email is intentionally disabled. It
            // was a second subscriber-facing Resend path with no staged owner,
            // so a fast bounce or complaint could not be tied back to this
            // user. The first letter and in-app checkout completion remain the
            // welcome path. Re-enable only through the same staged ledger used
            // by letter delivery.
          }
        }
        break;
      }
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        const profileId = session.metadata?.alpha_profile_id?.trim() || null;
        if (!isUuid(profileId)) break;
        // The signed event already proves this exact Session is terminal. The
        // profile UUID plus stored Session ID CAS is the mutation authority.
        // Requiring a second line-item read here can only retain an
        // unchargeable lock when Stripe's expansion is unavailable.
        const { error: expiredIntentError } = await sb
          .from("checkout_profiles")
          .update({
            billing_state: "expired",
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
            updated_at: new Date().toISOString(),
          })
          .eq("id", profileId)
          .eq("stripe_session_id", session.id)
          .in("billing_state", ["open", "creating"]);
        if (expiredIntentError) {
          throw new Error(
            `expired checkout intent cleanup failed: ${expiredIntentError.message}`
          );
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        // Stripe delivers webhooks at-least-once and NOT in order. Rapidly
        // clicking "add topic bundle" fires back-to-back subscription.updated
        // events (update-quantity/route.ts's own write-through already set
        // topic_quota from the LATEST click); if an earlier event's delivery
        // is delayed/retried and lands after a later one, trusting ITS
        // embedded snapshot would overwrite topic_quota back down to a stale
        // quantity forever (nothing else self-heals it). Re-reading the LIVE
        // subscription at handler time means every delivery, in whatever
        // order it lands, converges on Stripe's actual current quantity
        // instead of freezing whichever snapshot happened to arrive last.
        // The live read is required. Applying a stale snapshot after the
        // subscription changed products could resurrect Alpha access or copy
        // another product's quantity into Alpha. A read failure is retriable.
        // alpha-drift-r38-03 (2026-08-19): hoisted out of the try block (was
        // previously `const liveSub` declared INSIDE it, so it fell out of
        // scope by the time cancelledAt was derived below) -- see that
        // derivation's own comment for why reading the live subscription
        // matters there too, not just for quantity.
        let liveSub: Stripe.Subscription;
        try {
          liveSub = await stripe.subscriptions.retrieve(sub.id);
        } catch (e) {
          console.warn(
            "[stripe-webhook] live subscription retrieve failed; retrying without applying stale state:",
            describeStripeError(e)
          );
          throw e;
        }
        if (subscriptionCustomerId(liveSub) !== customerId) {
          throw new Error("live subscription customer differs from signed event");
        }
        if (isTerminalSubscriptionStatus(liveSub.status)) {
          const ended = await endExactSubscriptionBinding(
            customerId,
            liveSub.id,
            "terminal Alpha subscription"
          );
          if (ended.users === 0) {
            await settleLegacyAlphaEnd(
              customerId,
              liveSub.id,
              "terminal Alpha subscription"
            );
          }
          break;
        }
        const liveAlphaPresence = alphaPricePresence(liveSub);
        if (liveAlphaPresence === "absent") {
          const ended = await endExactSubscriptionBinding(
            customerId,
            liveSub.id,
            "Alpha price removal"
          );
          if (ended.users === 0) {
            await settleLegacyAlphaEnd(
              customerId,
              liveSub.id,
              "Alpha price removal"
            );
          }
          console.warn(
            `[stripe-webhook] subscription ${liveSub.id} no longer has the Alpha price; ended ${ended.users} exact user binding(s) and ${ended.intents} exact checkout intent(s)`
          );
          break;
        }
        if (liveAlphaPresence === "unknown" || !isAlphaSubscription(liveSub)) {
          throw new Error(
            "live Alpha subscription item shape is incomplete or invalid"
          );
        }

        const { data: exactBoundUser, error: exactBoundUserError } = await sb
          .from("users")
          .select("id, stripe_subscription_id, cancelled_at, topics")
          .eq("stripe_customer_id", customerId)
          .eq("stripe_subscription_id", liveSub.id)
          .maybeSingle();
        if (exactBoundUserError) {
          throw new Error(
            `exact subscription binding lookup failed: ${exactBoundUserError.message}`
          );
        }

        let boundUser = exactBoundUser;
        if (!boundUser) {
          // A Customer-only maybeSingle() deadlocks forever when historical
          // drift has attached the same Stripe Customer to multiple Alpha
          // users. Exact Subscription ownership wins. Only a single legacy
          // null-subscription row may be repaired, and only after Stripe proves
          // this is the Customer's sole current Alpha subscription.
          const { data: customerCandidates, error: customerCandidatesError } =
            await sb
              .from("users")
              .select("id, stripe_subscription_id, cancelled_at, topics")
              .eq("stripe_customer_id", customerId)
              .limit(3);
          if (customerCandidatesError) {
            throw new Error(
              `legacy subscription binding lookup failed: ${customerCandidatesError.message}`
            );
          }
          if ((customerCandidates?.length ?? 0) > 1) {
            throw new Error(
              `customer ${customerId} is attached to multiple Alpha users without an exact subscription owner`
            );
          }
          const legacyCandidate = customerCandidates?.[0] ?? null;
          if (legacyCandidate?.stripe_subscription_id) {
            throw new Error(
              `customer ${customerId} is already bound to a different Alpha subscription`
            );
          }
          boundUser = legacyCandidate;
        }

        if (boundUser && !boundUser.stripe_subscription_id) {
          const alphaSubscriptions = await stripe.subscriptions.list({
            customer: customerId,
            price: STRIPE_PRICE_ID,
            status: "all",
            limit: 100,
          });
          if (alphaSubscriptions.has_more) {
            throw new Error(
              `Alpha subscription lookup exceeded one page for customer ${customerId}`
            );
          }
          const currentAlphaSubscriptions: Stripe.Subscription[] = [];
          for (const candidate of alphaSubscriptions.data) {
            if (isTerminalSubscriptionStatus(candidate.status)) continue;
            if (!isAlphaSubscription(candidate)) {
              throw new Error(
                `cannot bind customer ${customerId}: nonterminal Alpha-priced subscription has an invalid item shape`
              );
            }
            currentAlphaSubscriptions.push(candidate);
          }
          if (
            currentAlphaSubscriptions.length !== 1 ||
            currentAlphaSubscriptions[0].id !== liveSub.id
          ) {
            throw new Error(
              `cannot bind customer ${customerId}: current Alpha subscription is ambiguous`
            );
          }
        }

        const { error: intentPaidError } = await sb
          .from("checkout_profiles")
          .update({ billing_state: "paid" })
          .eq("stripe_customer_id", customerId)
          .eq("stripe_subscription_id", liveSub.id)
          .in("billing_state", ["open", "paid"]);
        if (intentPaidError) {
          throw new Error(
            `subscription checkout intent mirror failed: ${intentPaidError.message}`
          );
        }
        const quantity = liveSub.items.data[0]?.quantity ?? 1;
        const topicQuota = clampQuota(quantity * TOPICS_PER_BUNDLE);
        // Throw on failure -> 5xx -> Stripe retries (#35). Set-to-current, so
        // a retry is idempotent. Silently losing this write desyncs paid quota
        // / cancellation state from Stripe with no recovery.
        // Guard the cancelled_at derivation. The old `sub.cancel_at!` non-null
        // assertion was a double trap: if cancel_at is null/undefined,
        // `new Date(NaN).toISOString()` THROWS (→ outer catch → 5xx →
        // Stripe retries forever, throw-looping the quota mirror too), and
        // `new Date(0).toISOString()` would write a 1970 PAST date that the
        // cron's `cancelled_at.gt.now` filter reads as "access ended" — silently
        // DROPPING a cancel-at-period-end subscriber who is still paid up. Only
        // write a real future end date; otherwise leave null (keep serving the
        // paid-up reader — subscription.deleted will set the real end later).
        //
        // alpha-drift-r15-02 (found+fixed 2026-08-06): this used to also
        // require `sub.cancel_at_period_end` before trusting `sub.cancel_at`.
        // Stripe exposes those as two INDEPENDENT fields (confirmed via the
        // API schema): cancel_at_period_end is true only for the common
        // "cancel at the end of what I already paid for" case, but a
        // subscription can also be scheduled to cancel on an arbitrary
        // future date (e.g. the Dashboard's "cancel on a specific date"
        // action, or the API's own `cancel_at` param used without
        // `cancel_at_period_end:true`) -- Stripe still populates cancel_at
        // in that case, just with cancel_at_period_end left false. Gating on
        // the boolean meant that combination fell through to null: the app
        // recorded NO scheduled cancellation at all, kept generating and
        // sending real paid-API-cost letters right up to the real cancel_at
        // moment, with zero visibility anywhere that a cancellation was
        // already scheduled. cancel_at alone is the correct signal for
        // "when does access end" regardless of which flow set it.
        //
        // TERMINAL STATUS must never resolve to null. A `subscription.deleted`
        // event correctly sets cancelled_at=now() when the sub ends. But Stripe
        // retries a failed `updated`/`created` delivery for ~3 days -- if that
        // retry lands AFTER `deleted` has already processed, this snapshot's
        // cancel_at may be unset (a terminal sub isn't "canceling", it already
        // ended), so an un-guarded derivation would write cancelled_at=null and
        // silently resurrect a churned subscriber's paid access indefinitely.
        // Once a sub is in a terminal status, this handler must agree with
        // subscription.deleted, not undo it. See deriveCancelledAt's own
        // comment for the full reasoning (pulled out for testability).
        //
        // alpha-drift-r38-03 (2026-08-19): this used to derive from `sub`
        // (the webhook event's OWN embedded snapshot) instead of `liveSub`
        // (re-read above for exactly this reason with quantity). Stripe's
        // at-least-once, out-of-order delivery means an EARLIER non-terminal
        // event can be retried and processed AFTER a genuinely later
        // terminal event already set cancelled_at=now() -- that retry still
        // reaches this handler (a different event.id, so the dedup table
        // doesn't skip it), and deriving from its stale embedded status/
        // cancel_at would write cancelled_at back to null, silently
        // resurrecting a churned subscriber's paid access indefinitely.
        // Deriving from liveSub converges on Stripe's actual current state
        // regardless of delivery order, same as quantity two lines above.
        const cancelledAt = deriveCancelledAt(liveSub.status, liveSub.cancel_at);
        // A downgrade shrinks poolCap (quota + 5 free backup slots). Topics
        // come from the same exact Customer + Subscription owner resolved
        // above, so Customer reuse cannot truncate another Alpha account.
        const cappedTopics = Array.isArray(boundUser?.topics)
          ? (boundUser.topics as TopicId[]).slice(0, poolCap(topicQuota))
          : undefined;
        let subscriptionMirrorQuery = sb
          .from("users")
          .update({
            cancelled_at: cancelledAt,
            topic_quota: topicQuota,
            stripe_subscription_id: liveSub.id,
            ...(cappedTopics ? { topics: cappedTopics } : {}),
          })
          .eq("stripe_customer_id", customerId)
          .eq(
            "id",
            boundUser?.id ?? "00000000-0000-0000-0000-000000000000"
          );
        subscriptionMirrorQuery = boundUser?.stripe_subscription_id
          ? subscriptionMirrorQuery.eq(
              "stripe_subscription_id",
              boundUser.stripe_subscription_id
            )
          : subscriptionMirrorQuery.is("stripe_subscription_id", null);
        subscriptionMirrorQuery = boundUser?.cancelled_at
          ? subscriptionMirrorQuery.eq("cancelled_at", boundUser.cancelled_at)
          : subscriptionMirrorQuery.is("cancelled_at", null);
        const { data: subRows, error: subErr } =
          await subscriptionMirrorQuery.select("id");
        if (subErr) throw new Error(`subscription mirror failed: ${subErr.message}`);
        // A Supabase .update() does NOT error on 0 matched rows, so a missed
        // mirror would be SILENTLY lost. 0 rows means one of two things,
        // distinguished by the subscription status:
        //   - active/trialing/etc → out-of-order: the event beat checkout linking
        //     stripe_customer_id. THROW so Stripe retries (#35); by retry time the
        //     row exists and the mirror lands.
        //   - terminal (canceled/expired/unpaid) → the account was already
        //     deleted (delete cancels the sub, cascading the row away, then this
        //     event lands). Nothing to mirror — absorb with 200 like
        //     subscription.deleted, so a normal delete flow doesn't churn ~3d of
        //     futile retries.
        if ((subRows?.length ?? 0) === 0) {
          // alpha-drift-r16-16 (found+fixed 2026-08-07): this used to hand-
          // duplicate isTerminalSubscriptionStatus's exact 3-status list
          // inline -- the same file's own deriveCancelledAt call above
          // already goes through the real function. Reusing it here means
          // this retry-vs-absorb decision can never silently drift from
          // the canonical definition the way a second hand-copy could.
          //
          // alpha-drift-r39-03 (2026-08-19, self-audit): this used to check
          // `sub.status` -- the stale event snapshot -- while cancelledAt
          // just above already reads `liveSub?.status ?? sub.status` for
          // exactly the out-of-order-delivery reason explained there. A
          // genuinely non-terminal event retried AFTER a later terminal
          // event has already deleted the account would see liveSub report
          // the real terminal status, but this check's stale sub.status
          // would still say non-terminal and throw to force a Stripe retry
          // that can never succeed (the row is genuinely gone) -- wasted
          // ~3-day retry storm plus repeated day-bucketed alert noise for an
          // already-resolved deletion. Matched to the same converged source.
          const effectiveStatus = liveSub.status;
          if (isTerminalSubscriptionStatus(effectiveStatus)) {
            console.warn(
              `[stripe-webhook] subscription mirror matched 0 rows for customer ${customerId} (status=${effectiveStatus}, account deleted?) — no-op`
            );
          } else {
            throw new Error(
              `subscription mirror matched 0 rows for customer ${customerId} (status=${effectiveStatus}, out-of-order? will retry)`
            );
          }
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        // A subscription can be switched away from Alpha before it is deleted,
        // so the final snapshot may contain another product's price. The local
        // exact subscription binding is the authority in that case. An
        // unrelated deleted subscription on the same customer matches nothing.
        const ended = await endExactSubscriptionBinding(
          customerId,
          sub.id,
          "subscription.deleted"
        );
        if (ended.users === 0) {
          await settleLegacyAlphaEnd(
            customerId,
            sub.id,
            "subscription.deleted"
          );
        }
        if (ended.users === 0 && ended.intents === 0) {
          console.warn(
            `[stripe-webhook] subscription.deleted ${sub.id} matched no exact Alpha binding for customer ${customerId}`
          );
        }
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const failedInvoiceLines = await stripe.invoices.listLineItems(inv.id, {
          limit: 100,
        });
        const alphaInvoice =
          !failedInvoiceLines.has_more &&
          failedInvoiceLines.data.length > 0 &&
          failedInvoiceLines.data.every((line) => {
            const priceId = stripeId(line.pricing?.price_details?.price);
            return priceId === STRIPE_PRICE_ID;
          });
        if (!alphaInvoice) {
          console.warn(
            `[stripe-webhook] ignoring non-Alpha failed invoice ${inv.id}`
          );
          break;
        }
        console.warn(
          `[stripe-webhook] payment_failed for invoice ${inv.id}, customer ${inv.customer}`
        );
        // A declining card doesn't revoke access on its own -- hasActiveAccess
        // only flips on cancelled_at, which stays null through Stripe's whole
        // Smart Retry window (commonly 2-4 weeks). Without this, the only
        // signal is a log line nobody's watching, so a subscriber can keep
        // reading (and getting sent) paid content for weeks on a dead card
        // with no one noticing. Best-effort: sendOpsAlert never throws.
        await sendOpsAlert(
          "alpha. payment failed",
          `Invoice ${inv.id} failed for customer ${inv.customer}. Stripe will retry automatically over the next couple weeks; check the customer in the Stripe dashboard if it keeps failing.`,
          `alpha-ops-alert-${inv.id}`
        );
        break;
      }
      // alpha-drift-r14-01 (review 2026-08-06): before this, the switch had
      // NO case for any dispute/refund/radar event -- they fell to default
      // and were silently dropped. cancelled_at, which controls paid access,
      // is written exclusively by checkout.session.completed and
      // customer.subscription.updated/deleted, so a disputed charge never
      // touched it: the subscriber kept passing hasActiveAccess() forever,
      // and the daily cron kept generating (real paid Anthropic/Gemini/Groq/
      // DeepSeek/Brave calls) and emailing them a letter indefinitely with
      // zero revenue behind it -- the exact failure mode a webhook handler
      // exists to prevent.
      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
        const charge = await stripe.charges.retrieve(chargeId);
        const disputePaymentIntentId = stripeId(dispute.payment_intent);
        const chargePaymentIntentId = stripeId(charge.payment_intent);
        if (
          disputePaymentIntentId &&
          chargePaymentIntentId &&
          disputePaymentIntentId !== chargePaymentIntentId
        ) {
          throw new Error("dispute and charge PaymentIntent bindings differ");
        }
        const paymentIntentId = disputePaymentIntentId || chargePaymentIntentId;
        const chargeCustomerId = stripeId(charge.customer);
        const origin = await resolveAlphaBillingOrigin(
          stripe,
          paymentIntentId,
          chargeCustomerId
        );
        if (!origin) {
          console.warn(
            `[stripe-webhook] ignoring dispute ${dispute.id}: payment is not provably an Alpha subscription invoice`
          );
          break;
        }
        const customerId = origin.customerId;
        // A dispute means the customer is already contesting the charge
        // through their bank -- keep serving them (real per-day generation
        // spend) while that's unresolved is money paid twice: once disputed
        // away, once spent generating content nobody's paying for anymore.
        // Cancel only the exact subscription that generated the proven Alpha
        // invoice. Never enumerate and cancel another product's subscriptions
        // that happen to share the same Stripe Customer.
        const cancelResult = { cancelled: [] as string[], skipped: 0, errors: 0 };
        const liveOriginSubscription = origin.liveSubscription;
        if (
          liveOriginSubscription &&
          isAlphaSubscription(liveOriginSubscription) &&
          !isTerminalSubscriptionStatus(liveOriginSubscription.status)
        ) {
          try {
            await stripe.subscriptions.cancel(origin.subscriptionId);
            cancelResult.cancelled.push(origin.subscriptionId);
          } catch (e) {
            cancelResult.errors++;
            console.warn(
              `[stripe-webhook] dispute ${dispute.id}: exact Alpha subscription cancel threw:`,
              describeStripeError(e)
            );
            // Do not mark the dispute handled while the recurring charge may
            // still be live. The event lease is released by the outer catch,
            // and Stripe can retry. If the cancellation actually succeeded but
            // the response was lost, the retry re-reads the subscription and
            // sees its terminal state before deciding whether to cancel again.
            throw e;
          }
        } else {
          cancelResult.skipped++;
        }
        // Past charges can outlive both the account and a later replacement
        // Alpha subscription. End only the billing window that produced the
        // disputed invoice. A dispute on an old charge must not end a reader's
        // newer exact subscription on the same Stripe Customer.
        const disputeEnded = await endExactSubscriptionBinding(
          customerId,
          origin.subscriptionId,
          "dispute access revoke"
        );
        let disputeAccess: ReaderAccessSummary = disputeEnded;
        if (disputeEnded.users === 0) {
          disputeAccess = await settleLegacyAlphaEnd(
            customerId,
            origin.subscriptionId,
            "dispute access revoke"
          );
        }
        const accountAlreadyGone = disputeAccess.users === 0;
        if (accountAlreadyGone) {
          console.warn(
            `[stripe-webhook] dispute ${dispute.id}: billing-end matched 0 rows for customer ${customerId} (account already deleted?)`
          );
        }
        const disputeSummary = `Dispute ${dispute.id} on charge ${chargeId} for customer ${customerId} (${dispute.reason}, $${(dispute.amount / 100).toFixed(2)}).`;
        const subscriptionSummary = `Subscription cancel: ${cancelResult.cancelled.length} cancelled, ${cancelResult.skipped} skipped, ${cancelResult.errors} errors. Review in the Stripe dashboard.`;
        let alertTitle: string;
        let accessSummary: string;
        if (accountAlreadyGone) {
          alertTitle = "alpha. dispute opened. billing ended, account not found";
          accessSummary =
            "No matching Alpha account was found. The account may have been deleted before the dispute arrived.";
        } else if (disputeAccess.inviteAccessRemains) {
          alertTitle =
            "alpha. dispute opened. billing ended, invite access remains";
          accessSummary =
            "Billing for the disputed subscription ended. Permanent invite reader access remains unchanged.";
        } else if (disputeAccess.readerAccessRemains) {
          alertTitle =
            "alpha. dispute opened. disputed billing ended, reader access remains";
          accessSummary =
            "Billing for the disputed subscription ended. Reader access remains through another current billing binding.";
        } else {
          alertTitle =
            "alpha. dispute opened. billing ended, reader access revoked";
          accessSummary =
            "Billing for the disputed subscription ended and reader access was revoked.";
        }
        await sendOpsAlert(
          alertTitle,
          `${disputeSummary} ${accessSummary} ${subscriptionSummary}`,
          `alpha-dispute-${dispute.id}`
        );
        break;
      }
      case "charge.dispute.closed": {
        // Read-only visibility. A closed dispute never changes billing or
        // reader access. Read the current protected invite marker so the
        // operational alert does not claim an invite reader was revoked.
        const dispute = event.data.object as Stripe.Dispute;
        const closedChargeId = stripeId(dispute.charge);
        if (!closedChargeId) break;
        const closedCharge = await stripe.charges.retrieve(closedChargeId);
        const closedOrigin = await resolveAlphaBillingOrigin(
          stripe,
          stripeId(dispute.payment_intent) || stripeId(closedCharge.payment_intent),
          stripeId(closedCharge.customer)
        );
        if (!closedOrigin) {
          console.warn(
            `[stripe-webhook] ignoring non-Alpha closed dispute ${dispute.id}`
          );
          break;
        }
        const closedAccess = await readExactSubscriptionAccess(
          closedOrigin.customerId,
          closedOrigin.subscriptionId,
          "closed dispute"
        );
        let closedAccessSummary: string;
        if (closedAccess.inviteAccessRemains) {
          closedAccessSummary =
            "Billing for the disputed subscription ended when the dispute opened. Permanent invite reader access remains unchanged.";
        } else if (closedAccess.readerAccessRemains) {
          closedAccessSummary =
            "Current reader access remains. This closed event did not change billing or access.";
        } else if (closedAccess.users > 0) {
          closedAccessSummary =
            "Billing ended and reader access was revoked when the dispute opened. This closed event does not restore either one automatically.";
        } else {
          closedAccessSummary =
            "No matching Alpha account is currently bound to the disputed subscription. This closed event made no account changes.";
        }
        await sendOpsAlert(
          "alpha. dispute closed",
          `Dispute ${dispute.id} closed with status "${dispute.status}". ${closedAccessSummary}`,
          `alpha-dispute-closed-${dispute.id}`
        );
        break;
      }
      case "charge.refunded": {
        // Visibility only, deliberately -- unlike a dispute, a refund alone
        // is ambiguous: it could be Algy's own "we'll make it right"
        // goodwill gesture (terms page's own promise) while deliberately
        // KEEPING the subscriber, or it could be a real cancellation that
        // should also end access. Auto-cancelling here would break the
        // goodwill-refund case; auto-ignoring it would repeat
        // alpha-drift-r14-01's own mistake for a different event. Alerting
        // (mirrors invoice.payment_failed's own no-throw pattern) puts the
        // decision where it belongs -- a human who knows which case this is.
        const charge = event.data.object as Stripe.Charge;
        const customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id ?? null;
        const refundOrigin = await resolveAlphaBillingOrigin(
          stripe,
          stripeId(charge.payment_intent),
          customerId
        );
        if (!refundOrigin) {
          console.warn(
            `[stripe-webhook] ignoring non-Alpha refund event ${event.id}`
          );
          break;
        }
        const full = charge.amount_refunded >= charge.amount;
        // alpha-drift-r27-05 (2026-08-14): this used to key on charge.id,
        // the one alert in this file scoped to the underlying Charge
        // instead of the Stripe Event -- every sibling alert here uses
        // event.id (the generic failure alert below) or dispute.id (each
        // scoped to one distinct dispute lifecycle event). Stripe supports
        // multiple partial refunds against a single charge, and each fires
        // its own charge.refunded event sharing the SAME charge.id but a
        // different amount_refunded -- keying on charge.id risked a second,
        // materially different refund (e.g. a partial that just became
        // full) getting deduped away against the first alert instead of
        // reaching Algy. event.id uniquely identifies THIS refund event.
        await sendOpsAlert(
          "alpha. charge refunded",
          `Charge ${charge.id} refunded (${full ? "full" : "partial"}: $${(charge.amount_refunded / 100).toFixed(2)} of $${(charge.amount / 100).toFixed(2)})${customerId ? ` for customer ${customerId}` : ""}. Access was NOT automatically revoked -- a refund alone doesn't cancel the subscription. If this should also end their access, cancel their subscription in Stripe or via the admin panel.`,
          `alpha-refund-${event.id}`
        );
        break;
      }
      default:
        // Ignore other event types
        break;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[stripe-webhook] handler error:", msg);
    // The dedup row above was inserted BEFORE the switch ran, marking this
    // event "seen" regardless of whether the handler actually succeeded. If
    // we don't undo that here, the retry Stripe is about to send (via the
    // 5xx below) hits the dedup guard's short-circuit on arrival and never
    // re-enters the switch at all -- silently swallowing every future retry
    // of an event whose handler never actually completed. Best-effort: a
    // failed delete here must not change the response Stripe sees (a real
    // dup-processing risk on a THIS-specific transient failure is far
    // cheaper than a permanently stranded paying customer).
    const { error: cleanupErr } = await sb
      .from("stripe_webhook_events")
      .delete()
      .eq("id", event.id)
      .eq("status", "processing")
      .eq("lease_token", webhookLeaseToken);
    if (cleanupErr) {
      console.warn(
        `[stripe-webhook] failed to release event claim for ${event.id} after handler error:`,
        cleanupErr.message
      );
    }
    // Return 5xx so Stripe RETRIES (webhooks are at-least-once). The handlers are
    // idempotent — checkoutUserMutation does a non-clobbering update on an existing
    // row, and the subscription.* paths set columns to their current value — so a
    // retry safely recovers a transient Supabase/Stripe blip instead of silently
    // losing the user-row state-write (which would strand a paid user with no
    // access). A genuinely-unprocessable event just retries ~3d then Stripe stops
    // (log noise, no harm). (#35 — audit S27)
    //
    // But "retries ~3d then stops" is also the failure mode: if it keeps failing
    // past the retry window (schema drift, an RLS change, a real bug), Stripe's
    // dashboard shows it, but nothing here is watching that dashboard, so a paying
    // customer is left with no users row / no quota and no one
    // finds out. event.id keys the alert so Stripe's own retries of the same event
    // don't re-page repeatedly. Best-effort: sendOpsAlert never throws.
    //
    // alpha-drift-r27-07 (2026-08-14): "don't re-page repeatedly" only held
    // for the first 24 hours -- Resend's own send-idempotency window is 24h,
    // but Stripe retries a failing delivery with backoff for up to 3 days.
    // Every retry re-enters this catch (insertedDedupRow is deliberately
    // deleted above so the dedup guard never short-circuits a retry), and
    // once a retry lands more than 24h after the FIRST attempt, Resend no
    // longer recognizes `alpha-webhook-fail-${event.id}` as a duplicate and
    // sends a fresh alert -- for the exact prolonged-outage scenario this
    // alert exists to catch, Algy got paged again on every subsequent
    // retry, not once, risking alert fatigue burying the one alert meant to
    // surface a real multi-day failure. Adding a UTC day bucket to the key
    // caps it at one alert per calendar day a failure persists -- silence
    // for retries within the same day (matching the original intent),
    // still genuinely re-alerting daily if the failure outlives Resend's
    // window, instead of either re-paging on every retry or going quiet
    // after the first day.
    const dayBucket = new Date().toISOString().slice(0, 10);
    await sendOpsAlert(
      "alpha. webhook processing failed",
      `event ${event.id} (${event.type}): ${msg}`,
      `alpha-webhook-fail-${event.id}-${dayBucket}`
    );
    return NextResponse.json({ received: false, error: "handler error" }, { status: 500 });
  }

  const { data: completedMarker, error: completedMarkerError } = await sb
    .from("stripe_webhook_events")
    .update({
      status: "succeeded",
      lease_token: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", event.id)
    .eq("status", "processing")
    .eq("lease_token", webhookLeaseToken)
    .select("id")
    .maybeSingle();
  if (completedMarkerError || !completedMarker) {
    console.error(
      `[stripe-webhook] handler succeeded but completion marker failed for ${event.id}:`,
      completedMarkerError?.message ?? "claim no longer owned"
    );
    return NextResponse.json(
      { received: false, error: "webhook completion unavailable" },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}
