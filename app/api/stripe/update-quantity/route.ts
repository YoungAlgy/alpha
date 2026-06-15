import { NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { hasActiveAccess } from "@/lib/access";

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

const MAX_QTY = 5;
const MIN_QTY = 1;

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
    return NextResponse.json({ error: rowErr.message }, { status: 500 });
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

  const stripe = new Stripe(secret, {
    apiVersion: "2026-04-22.dahlia",
    httpClient: Stripe.createNodeHttpClient(),
  });

  // Find the active subscription for this customer
  const subs = await stripe.subscriptions.list({
    customer: row.stripe_customer_id,
    status: "active",
    limit: 1,
  });
  const sub = subs.data[0];
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
  await stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, quantity: nextQty }],
  });

  // Write through to public.users immediately so the UI reflects without
  // waiting on the webhook round-trip. Surface a failed write instead of
  // returning 200 with a stale DB — Stripe is already updated (source of
  // truth; the subscription.updated webhook re-mirrors and throws on failure),
  // so tell the client the truth and let the webhook reconcile.
  const newQuota = Math.max(5, Math.min(25, nextQty * 5));
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

  // unit_amount * quantity = total monthly cents (price has unit_amount 500)
  const unitAmount =
    typeof item.price?.unit_amount === "number" ? item.price.unit_amount : 500;
  const monthlyCents = unitAmount * nextQty;

  return NextResponse.json({
    quantity: nextQty,
    topicQuota: newQuota,
    monthlyCents,
  });
}
