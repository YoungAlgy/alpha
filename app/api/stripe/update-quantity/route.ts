import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { hasActiveAccess } from "@/lib/access";
import {
  clampQuota,
  TOPICS_PER_BUNDLE,
  MAX_TOPIC_QUOTA,
  MIN_TOPIC_QUOTA,
  PRICE_PER_BUNDLE_CENTS,
} from "@/lib/types";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// Bump or shrink the user's Alpha subscription by a single $5/5-topic unit.
// Base $5 = 5 topics. Each add-on +$5 = +5 topics. Max 5 add-ons (25 topics,
// $25/mo). Catalog has 27 topics; a subscriber picks up to 25 of them.
//
// Body: { direction: "up" | "down" }
//   up   → quantity++   (capped at 5, i.e. 25 topics, $25/mo)
//   down → quantity--   (floored at 1, i.e. 5 topics, $5/mo)
//
// Returns: { quantity, topicQuota, monthlyCents }
//
// Stripe handles proration automatically (prorate this month, charge full
// next cycle). The matching webhook handler mirrors quantity → topic_quota,
// but we also write it here so the UI reflects immediately.

interface Body {
  direction?: "up" | "down";
}

const MAX_QTY = MAX_TOPIC_QUOTA / TOPICS_PER_BUNDLE; // 5 bundles = 25 topics
const MIN_QTY = MIN_TOPIC_QUOTA / TOPICS_PER_BUNDLE; // 1 bundle = 5 topics

export async function POST(req: Request) {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }

  // Auth gate — only the signed-in user can modify their own subscription.
  const sb = await supabaseServerClient();
  const { data: { user }, error: authErr } = await sb.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  }

  // Rate limit per user: each call is a real Stripe proration charge/credit,
  // not just a dedupe-by-idempotency-key case — the idempotency key only
  // collapses an exact repeat within the same 30s bucket, so a rapid
  // up/down/up/down (a compromised session, a buggy client retry loop) would
  // otherwise land as genuinely distinct billing mutations with nothing to
  // stop it.
  const limited = rateLimit(`qty:${user.id}`, { limit: 10, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // empty body acceptable, validated below
  }
  if (body.direction !== "up" && body.direction !== "down") {
    return NextResponse.json({ error: "direction must be 'up' or 'down'" }, { status: 400 });
  }

  // Look up the user's Stripe customer + topic_quota via service role
  // (RLS-bypassing — public.users isn't reachable directly with the user's
  // JWT on the server because we set policy to self-read only).
  const svc = await supabaseServiceClient();
  const { data: row, error: rowErr } = await svc
    .from("users")
    .select("stripe_customer_id, topic_quota, subscribed_at, cancelled_at")
    .eq("id", user.id)
    .maybeSingle();
  if (rowErr) {
    console.error("[update-quantity] user lookup failed:", rowErr.message);
    return NextResponse.json({ error: "Couldn't load your subscription. Try again." }, { status: 500 });
  }
  if (!row?.stripe_customer_id) {
    return NextResponse.json(
      { error: "No subscription found. Finish checkout first." },
      { status: 400 }
    );
  }
  // Block only when access has actually ENDED. A cancel-at-period-end user
  // (future cancelled_at) is still paid up — blocking their tier change was
  // both inconsistent with the access rule everywhere else and lost revenue
  // when an upgrading user is clearly choosing to stay.
  if (!hasActiveAccess(row.cancelled_at)) {
    return NextResponse.json(
      { error: "Subscription has ended. Reactivate via the billing portal first." },
      { status: 400 }
    );
  }

  const stripe = getStripeClient();

  // Find this customer's live subscription. status:"active" ONLY missed two
  // real, reachable states: a 100%-off comp/trial checkout (checkout/route.ts
  // supports this via payment_method_collection:"if_required") sits in
  // "trialing", and a subscriber whose card just started failing sits in
  // "past_due" for Stripe's multi-week Smart Retry window during which the
  // webhook's invoice.payment_failed handler deliberately keeps their access
  // live (see that handler's own comment) — both are real, hasActiveAccess()
  // -passing users who'd otherwise hit a false "no subscription" error just
  // for trying to change their tier. Matches lib/stripe-cancel.ts's own
  // status:"all" + explicit-status-set pattern rather than a single string.
  const LIVE_FOR_MANAGEMENT: ReadonlySet<Stripe.Subscription.Status> = new Set([
    "active",
    "trialing",
    "past_due",
  ]);
  // Both Stripe calls below (list, then update) are wrapped so a Stripe-side
  // slowdown or hiccup surfaces as a clean 500 instead of an unhandled 80s+
  // SDK timeout or an uncaught TypeError — matches checkout/route.ts and
  // portal/route.ts, which both guard their Stripe calls the same way.
  let sub: Stripe.Subscription | undefined;
  try {
    const subs = await stripe.subscriptions.list({
      customer: row.stripe_customer_id,
      status: "all",
      limit: 10,
    });
    // Array.isArray guard: a malformed 200 (missing/non-array `data`) must
    // fail into the clean "no subscription" branch below, not throw
    // .find-of-undefined out of the route.
    sub = Array.isArray(subs.data)
      ? subs.data.find((s) => LIVE_FOR_MANAGEMENT.has(s.status))
      : undefined;
  } catch (e) {
    console.error(
      "[update-quantity] subscriptions.list failed:",
      e instanceof Error ? e.message : e
    );
    return NextResponse.json(
      { error: "Couldn't reach Stripe. Try again in a moment." },
      { status: 500 }
    );
  }
  if (!sub) {
    return NextResponse.json(
      { error: "No active subscription on file." },
      { status: 400 }
    );
  }

  const item = sub.items.data[0];
  if (!item) {
    return NextResponse.json(
      { error: "Subscription has no line items. Contact support." },
      { status: 500 }
    );
  }

  const currentQty = item.quantity ?? 1;
  const nextQty =
    body.direction === "up"
      ? Math.min(MAX_QTY, currentQty + 1)
      : Math.max(MIN_QTY, currentQty - 1);

  if (nextQty === currentQty) {
    return NextResponse.json(
      {
        error:
          body.direction === "up"
            ? "Already at the maximum (25 topics)."
            : "Already at the minimum (5 topics).",
      },
      { status: 400 }
    );
  }

  // Apply the change. Default proration_behavior is "create_prorations"
  // which charges/credits proportionally on the next invoice — what we want.
  // Idempotency key so a network retry (or a double-submit that slips past the
  // UI guard) doesn't fire a second subscription.update + a second webhook. The
  // 30s time bucket scopes it to rapid retries of THIS action: a deliberate
  // same-transition change later (e.g. up then down then up) lands in a new
  // bucket and still applies, rather than being deduped against Stripe's 24h key cache.
  const idemKey = `alpha-qty-${sub.id}-${currentQty}-${nextQty}-${Math.floor(Date.now() / 30000)}`;
  try {
    await stripe.subscriptions.update(
      sub.id,
      { items: [{ id: item.id, quantity: nextQty }] },
      { idempotencyKey: idemKey }
    );
  } catch (e) {
    console.error(
      "[update-quantity] subscriptions.update failed:",
      e instanceof Error ? e.message : e
    );
    return NextResponse.json(
      { error: "Couldn't reach Stripe. Try again in a moment." },
      { status: 500 }
    );
  }

  // Write through to public.users immediately so the UI reflects without
  // waiting on the webhook round-trip. Surface a failed write instead of
  // returning 200 with a stale DB — Stripe is already updated (source of
  // truth; the subscription.updated webhook re-mirrors and throws on failure),
  // so tell the client the truth and let the webhook reconcile.
  const newQuota = clampQuota(nextQty * TOPICS_PER_BUNDLE);
  const { error: quotaErr } = await svc
    .from("users")
    .update({ topic_quota: newQuota })
    .eq("id", user.id);
  if (quotaErr) {
    console.error("[update-quantity] quota write-through failed:", quotaErr.message);
    return NextResponse.json(
      {
        error:
          "Plan updated with Stripe, but the app didn't sync yet. It will reflect within a minute. Refresh to check.",
      },
      { status: 500 }
    );
  }

  // unit_amount * quantity = total monthly cents. Falls back to the shared
  // PRICE_PER_BUNDLE_CENTS constant (not a re-typed literal) only if Stripe's
  // price object is ever missing unit_amount.
  const unitAmount =
    typeof item.price?.unit_amount === "number" ? item.price.unit_amount : PRICE_PER_BUNDLE_CENTS;
  const monthlyCents = unitAmount * nextQty;

  return NextResponse.json({
    quantity: nextQty,
    topicQuota: newQuota,
    monthlyCents,
  });
}
