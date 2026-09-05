import { NextResponse } from "next/server";
import { hasSubscriberAccess } from "@/lib/access";
import { rateLimit } from "@/lib/rate-limit";
import {
  RenewalCancellationError,
  scheduleExactAlphaRenewalCancellation,
} from "@/lib/renewal-cancellation";
import {
  describeStripeError,
  getStripeClient,
} from "@/lib/stripe";
import {
  supabaseServerClient,
  supabaseServiceClient,
} from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Turns off renewal for the signed-in reader's one exact stored Alpha
 * subscription. Cards and invoices remain in the Stripe Billing Portal.
 * This route never searches by email or Customer. A nonterminal Stripe state
 * that has already revoked local access is ended immediately by exact ID.
 */
export async function POST() {
  if (!process.env.STRIPE_SECRET_KEY?.trim()) {
    return NextResponse.json(
      { error: "Stripe is not configured." },
      { status: 503 }
    );
  }

  const sessionClient = await supabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await sessionClient.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  if (!user.email || !user.email_confirmed_at) {
    return NextResponse.json(
      { error: "Confirm your sign-in email first." },
      { status: 403 }
    );
  }

  const limited = rateLimit(`cancel-renewal:${user.id}`, {
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!limited.ok) {
    return NextResponse.json(
      {
        error: `Too many cancellation checks. Try again in ${Math.ceil(
          limited.retryAfterSec / 60
        )} minutes.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(limited.retryAfterSec) },
      }
    );
  }

  const serviceClient = await supabaseServiceClient();
  const { data: row, error: rowError } = await serviceClient
    .from("users")
    .select(
      "stripe_customer_id, stripe_subscription_id, subscribed_at, cancelled_at"
    )
    .eq("id", user.id)
    .maybeSingle();
  if (rowError) {
    console.error(
      "[stripe/cancel-renewal] exact billing lookup failed:",
      rowError.message
    );
    return NextResponse.json(
      { error: "Couldn't load your Alpha subscription. Try again." },
      { status: 500 }
    );
  }

  const customerId = row?.stripe_customer_id?.trim() || null;
  const subscriptionId = row?.stripe_subscription_id?.trim() || null;
  if (!customerId || !subscriptionId) {
    return NextResponse.json(
      {
        error:
          "Couldn't verify one exact Alpha subscription. Use Stripe billing or contact support.",
      },
      { status: 409 }
    );
  }

  try {
    const requestNow = new Date();
    const localAccess = hasSubscriberAccess(
      row?.subscribed_at,
      row?.cancelled_at,
      requestNow
    );
    const scheduled = await scheduleExactAlphaRenewalCancellation(
      serviceClient,
      {
        userId: user.id,
        customerId,
        subscriptionId,
        stripeClient: getStripeClient(),
        now: requestNow,
      }
    );
    const ended = scheduled.ended || !localAccess;
    const localEnd =
      row?.cancelled_at &&
      !Number.isNaN(Date.parse(row.cancelled_at)) &&
      Date.parse(row.cancelled_at) <= requestNow.getTime()
        ? row.cancelled_at
        : requestNow.toISOString();
    return NextResponse.json({
      ok: true,
      cancelAt: ended && !scheduled.ended ? localEnd : scheduled.cancelAt,
      alreadyScheduled: scheduled.alreadyScheduled,
      ended,
    });
  } catch (error) {
    if (error instanceof RenewalCancellationError) {
      console.warn(
        `[stripe/cancel-renewal] ${error.code}: ${error.message}`
      );
      const pending =
        error.code === "settlement_failed" ||
        error.code === "provider_state_unsafe" ||
        error.code === "in_progress" ||
        error.code === "pending_binding_changed";
      return NextResponse.json(
        { error: error.message, pending },
        { status: error.status }
      );
    }
    console.error(
      "[stripe/cancel-renewal] Stripe request failed:",
      describeStripeError(error)
    );
    return NextResponse.json(
      {
        error:
          "Couldn't confirm the cancellation with Stripe. Alpha will keep checking the exact saved subscription. Try again.",
        pending: true,
      },
      { status: 502 }
    );
  }
}
