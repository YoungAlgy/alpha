import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { STRIPE_PRICE_ID, getStripeClient, describeStripeError } from "@/lib/stripe";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { hasActiveAccess } from "@/lib/access";
import { clampQuota, TOPICS_PER_BUNDLE, PRICE_PER_BUNDLE_CENTS, type TopicId } from "@/lib/types";
import { rateLimit } from "@/lib/rate-limit";
import { nextQuantity, isLiveForManagement } from "@/lib/update-quantity-guards";
import { poolCap } from "@/lib/engine/select-sections";
import { consumeDistributedRateLimit } from "@/lib/distributed-rate-limit";
import {
  claimQuantityUpdateLease,
  releaseQuantityUpdateLease,
} from "@/lib/quantity-update-lease";
import { isInviteOnly } from "@/lib/access-mode";

export const runtime = "nodejs";

// Bump or shrink the user's Alpha subscription by a single $5/5-topic unit.
// Base $5 = 5 topics. Each add-on +$5 = +5 topics. Max 5 add-ons (25 topics,
// $25/mo). Catalog has 38 topics (alpha-drift-r50-02, 2026-08-20: was stale
// at 27, README.md already had the correct current count); a subscriber
// picks up to 25 of them.
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
  expectedQuantity?: number;
}

function stripeCustomerId(customer: Stripe.Subscription["customer"]): string | null {
  if (typeof customer === "string") return customer;
  return customer?.id ?? null;
}

function isExactAlphaSubscription(
  sub: Stripe.Subscription,
  customerId: string
): boolean {
  if (stripeCustomerId(sub.customer) !== customerId) return false;
  if (!sub.items || sub.items.has_more || !Array.isArray(sub.items.data)) return false;
  if (sub.items.data.length !== 1) return false;

  const item = sub.items.data[0];
  const priceId = typeof item.price === "string" ? item.price : item.price?.id;
  const quantity = item.quantity;
  return (
    priceId === STRIPE_PRICE_ID &&
    Number.isInteger(quantity) &&
    (quantity as number) >= 1 &&
    (quantity as number) <= 5
  );
}

export async function POST(req: Request) {
  if (isInviteOnly(true)) {
    return NextResponse.json(
      {
        error:
          "Alpha is invite-only now. Paid plan changes are closed. You can still turn off renewal from Settings.",
      },
      { status: 410, headers: { "Cache-Control": "no-store" } }
    );
  }

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
  if (!user.email_confirmed_at) {
    return NextResponse.json(
      { error: "Confirm your email before changing billing." },
      { status: 403 }
    );
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
    const parsed = (await req.json()) as Body | null;
    // alpha-drift-r31-02 (2026-08-14): a literal JSON `null` body parses
    // successfully -- this catch block only ever sees a genuine parse
    // failure -- so without this check `body` was reassigned straight to
    // `null`, and the very next line's `body.direction` read threw an
    // unhandled TypeError instead of the clean "direction must be..." 400
    // a missing/malformed body already gets. Normalizing a null parse to
    // `{}` reuses that exact existing validation path rather than adding a
    // new one -- matches this catch block's own "empty body acceptable,
    // validated below" philosophy for the parse-failure case.
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {
    // empty body acceptable, validated below
  }
  if (body.direction !== "up" && body.direction !== "down") {
    return NextResponse.json({ error: "direction must be 'up' or 'down'" }, { status: 400 });
  }
  if (
    !Number.isInteger(body.expectedQuantity) ||
    (body.expectedQuantity as number) < 1 ||
    (body.expectedQuantity as number) > 5
  ) {
    return NextResponse.json(
      { error: "expectedQuantity must be an integer from 1 through 5" },
      { status: 400 }
    );
  }

  // alpha-drift-r55-05 (2026-08-20, rls-migration-drift-audit-r4): service
  // role, not the session client -- and not because the SELECT itself is
  // unreachable. public.users DOES have a working self-read/self-update
  // policy scoped to auth.uid() (relied on daily by lib/theme.ts's
  // setTheme() and lib/user-sync.ts's syncUserProfile() -- see round 51's
  // rls-migration-drift-audit finding on app/api/resume/route.ts for the
  // same correction). The real reason: this handler later writes
  // topic_quota (line ~237), one of the columns
  // protect_user_privileged_columns_trg (20260524000000_security_user_
  // column_lock.sql) pins back to its old value for any non-service_role
  // caller. Using the service role for both the read and the write keeps
  // one client for the whole round trip.
  let svc: Awaited<ReturnType<typeof supabaseServiceClient>>;
  try {
    svc = await supabaseServiceClient();
  } catch {
    return NextResponse.json(
      { error: "Billing protection is temporarily unavailable. Try again shortly." },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }
  const distributedLimit = await consumeDistributedRateLimit(
    svc,
    "quantity-update-user",
    user.id,
    { limit: 10, windowMs: 60 * 60 * 1000 }
  );
  if (!distributedLimit.available) {
    return NextResponse.json(
      { error: "Billing protection is temporarily unavailable. Try again shortly." },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }
  if (!distributedLimit.ok) {
    return NextResponse.json(
      { error: "Too many billing changes. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(distributedLimit.retryAfterSec) },
      }
    );
  }

  const leaseToken = randomUUID();
  let leaseClaimed = false;
  try {
    leaseClaimed = await claimQuantityUpdateLease(
      svc,
      user.id,
      leaseToken
    );
  } catch {
    return NextResponse.json(
      { error: "Billing protection is temporarily unavailable. Try again shortly." },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }
  if (!leaseClaimed) {
    return NextResponse.json(
      { error: "Another billing change is still running. Try again shortly." },
      { status: 409, headers: { "Retry-After": "15" } }
    );
  }

  try {
  const { data: row, error: rowErr } = await svc
    .from("users")
    // alpha-drift-r59-01: `topics` deliberately dropped from this early
    // SELECT -- it's re-read fresh right before the write further down,
    // see that fetch's own comment for why reusing this snapshot was a bug.
    .select("stripe_customer_id, stripe_subscription_id, topic_quota, subscribed_at, cancelled_at")
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

  // Resolve the exact Alpha subscription bound to this account. New accounts
  // carry stripe_subscription_id. A legacy row without it gets one bounded
  // lookup, which succeeds only when Stripe returns one current subscription
  // with exactly one Alpha line item and a valid quantity.
  //
  // Both Stripe calls below (list, then update) are wrapped so a Stripe-side
  // slowdown or hiccup surfaces as a clean 500 instead of an unhandled 80s+
  // SDK timeout or an uncaught TypeError — matches checkout/route.ts and
  // portal/route.ts, which both guard their Stripe calls the same way.
  let sub: Stripe.Subscription | undefined;
  const storedSubscriptionId =
    typeof row.stripe_subscription_id === "string"
      ? row.stripe_subscription_id.trim()
      : null;

  if (typeof row.stripe_subscription_id === "string" && !storedSubscriptionId) {
    console.error("[update-quantity] stored subscription id is empty");
    return NextResponse.json({ error: "Couldn't verify your Alpha subscription." }, { status: 500 });
  }

  if (storedSubscriptionId) {
    try {
      const candidate = await stripe.subscriptions.retrieve(storedSubscriptionId);
      if (
        candidate.id !== storedSubscriptionId ||
        !isLiveForManagement(candidate.status) ||
        !isExactAlphaSubscription(candidate, row.stripe_customer_id)
      ) {
        console.error("[update-quantity] stored subscription binding did not resolve to one current exact Alpha subscription");
        return NextResponse.json(
          { error: "No active Alpha subscription on file." },
          { status: 400 }
        );
      }
      sub = candidate;
    } catch (e) {
      console.error("[update-quantity] subscriptions.retrieve failed:", describeStripeError(e));
      return NextResponse.json(
        { error: "Couldn't reach Stripe. Try again in a moment." },
        { status: 500 }
      );
    }
  } else {
    let legacyMatches: Stripe.Subscription[] = [];
    try {
      const subs = await stripe.subscriptions.list({
        customer: row.stripe_customer_id,
        price: STRIPE_PRICE_ID,
        status: "all",
        limit: 100,
      });
      if (subs.has_more || !Array.isArray(subs.data)) {
        console.error("[update-quantity] legacy subscription lookup was paginated or malformed");
        return NextResponse.json(
          { error: "Couldn't safely identify your Alpha subscription." },
          { status: 500 }
        );
      }

      for (const candidate of subs.data) {
        if (!isExactAlphaSubscription(candidate, row.stripe_customer_id)) {
          console.error("[update-quantity] legacy lookup found an invalid or mixed Alpha subscription shape");
          return NextResponse.json(
            { error: "Couldn't safely identify your Alpha subscription." },
            { status: 500 }
          );
        }
      }
      legacyMatches = subs.data.filter((candidate) => isLiveForManagement(candidate.status));
    } catch (e) {
      console.error("[update-quantity] subscriptions.list failed:", describeStripeError(e));
      return NextResponse.json(
        { error: "Couldn't reach Stripe. Try again in a moment." },
        { status: 500 }
      );
    }

    if (legacyMatches.length > 1) {
      console.error("[update-quantity] legacy lookup found multiple current Alpha subscriptions");
      return NextResponse.json(
        { error: "Multiple Alpha subscriptions need support review before changing this plan." },
        { status: 409 }
      );
    }
    sub = legacyMatches[0];

    if (sub) {
      const { data: boundRow, error: bindErr } = await svc
        .from("users")
        .update({ stripe_subscription_id: sub.id })
        .eq("id", user.id)
        .is("stripe_subscription_id", null)
        .select("stripe_subscription_id")
        .maybeSingle();
      if (bindErr) {
        console.error("[update-quantity] exact subscription binding write failed:", bindErr.message);
        return NextResponse.json(
          { error: "Couldn't save your verified Alpha subscription." },
          { status: 500 }
        );
      }
      if (!boundRow) {
        const { data: racedRow, error: racedErr } = await svc
          .from("users")
          .select("stripe_subscription_id")
          .eq("id", user.id)
          .maybeSingle();
        if (racedErr || racedRow?.stripe_subscription_id !== sub.id) {
          console.error("[update-quantity] exact subscription binding changed during legacy resolution");
          return NextResponse.json(
            { error: "Your subscription changed while this request was running. Refresh and try again." },
            { status: 409 }
          );
        }
      }
    }
  }

  if (!sub) {
    return NextResponse.json(
      { error: "No active Alpha subscription on file." },
      { status: 400 }
    );
  }

  const item = sub.items.data[0];
  if (!item || !isExactAlphaSubscription(sub, row.stripe_customer_id)) {
    return NextResponse.json(
      { error: "Couldn't verify the Alpha subscription line item." },
      { status: 500 }
    );
  }

  const currentQty = item.quantity ?? 1;
  // The client confirms the exact quantity shown in its billing panel. If a
  // prior request reached Stripe but its response was lost, a retry still
  // carries the old expectation and stops here instead of applying a second
  // paid change under a newly computed idempotency key.
  if (currentQty !== body.expectedQuantity) {
    return NextResponse.json(
      {
        error:
          "Your Alpha plan changed before this request finished. Refresh before changing it again.",
      },
      { status: 409 }
    );
  }
  const nextQty = nextQuantity(body.direction, currentQty);

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
    // alpha-drift-r29-05 (2026-08-14): describeStripeError, see lib/stripe.ts.
    console.error("[update-quantity] subscriptions.update failed:", describeStripeError(e));
    return NextResponse.json(
      { error: "Couldn't reach Stripe. Try again in a moment." },
      { status: 500 }
    );
  }

  // A database-backed per-user lease now serializes app-side quantity
  // changes. Re-fetch anyway because Stripe remains the source of truth and
  // an operator or provider-side change can still occur outside this route.
  // Writing only the confirmed quantity keeps the local mirror honest.
  let confirmedQty: number;
  try {
    const fresh = await stripe.subscriptions.retrieve(sub.id);
    if (
      fresh.id !== sub.id ||
      !isLiveForManagement(fresh.status) ||
      !isExactAlphaSubscription(fresh, row.stripe_customer_id)
    ) {
      console.error("[update-quantity] post-update subscription no longer matched the exact Alpha binding");
      return NextResponse.json(
        { error: "Plan changed with Stripe, but its Alpha subscription shape needs support review." },
        { status: 500 }
      );
    }
    const freshItem = fresh.items.data[0];
    if (typeof freshItem?.quantity !== "number") {
      return NextResponse.json(
        { error: "Plan changed with Stripe, but confirmation was incomplete. Refresh in a minute." },
        { status: 500 }
      );
    }
    confirmedQty = freshItem.quantity;
  } catch (e) {
    // The mutation may already be real, but writing a locally-computed value
    // can diverge from Stripe if another provider-side change landed. Leave
    // the mirror untouched and let the live-reading webhook converge it.
    console.warn("[update-quantity] post-update retrieve failed:", describeStripeError(e));
    return NextResponse.json(
      { error: "Plan changed with Stripe, but confirmation is delayed. Refresh in a minute." },
      { status: 500 }
    );
  }

  // Write through to public.users immediately so the UI reflects without
  // waiting on the webhook round-trip. Surface a failed write instead of
  // returning 200 with a stale DB — Stripe is already updated (source of
  // truth; the subscription.updated webhook re-mirrors and throws on failure),
  // so tell the client the truth and let the webhook reconcile.
  const newQuota = clampQuota(confirmedQty * TOPICS_PER_BUNDLE);
  // alpha-drift-r58-06 (2026-08-20, form-validation-consistency-audit-r3):
  // a downgrade shrinks poolCap (= quota + 5 free backup slots, lib/engine/
  // select-sections.ts) but this write never touched `topics` -- so a
  // reader who'd filled their backups (the UI's own "add a few more and
  // they become backups, free" nudge) got their stored pool stuck above
  // the new, smaller cap. lib/account-topics-guards.ts's
  // validateTopicsAgainstCap hard-rejects an over-cap array with no
  // truncation, so EVERY future self-serve save -- even a pure reorder or
  // single removal -- was silently blocked until the reader manually
  // trimmed enough items on their own, contradicting settings' own
  // downgrade copy ("any extra picks become free backups," no action
  // needed). Truncated here to mirror weekly-send/route.ts's own existing
  // read-time slice(0, poolCap(letterSize)) -- applying the same policy at
  // write-time instead of leaving the DB row silently inconsistent with it.
  //
  // alpha-drift-r59-01 (2026-08-20, self-audit-r58): this used to reuse
  // `row.topics`, fetched at the TOP of the handler before 3 sequential
  // awaited Stripe calls (list/update/retrieve -- easily hundreds of ms to
  // several seconds). Since cappedTopics is truthy on virtually every call
  // (a fresh signup's topics defaults to '{}', never null), this write
  // clobbered `topics` back to that stale pre-request snapshot on EVERY
  // plan change, up or down -- silently reverting a concurrent, independent
  // /api/account/topics save (a plain unconditional update with no version
  // check) made in the window while this request's Stripe round-trips were
  // still in flight. Re-read fresh, immediately before this write, mirroring
  // the webhook's own subscription-mirror branch, which already read this
  // correctly (no intervening network calls there).
  // alpha-drift-r61-07 (2026-08-20, form-validation-consistency-audit-r6):
  // `error` used to be discarded here, unlike every other Supabase call in
  // this handler (rowErr above, quotaErr below) -- a transient read
  // failure silently left cappedTopics undefined, so the write below
  // updated topic_quota WITHOUT touching topics, reproducing the exact
  // alpha-drift-r58-06 bug this fix (r59-01) exists to prevent, with zero
  // trace anywhere. Logged, matching the rest of this handler's pattern.
  const { data: freshRow, error: freshErr } = await svc
    .from("users")
    .select("topics")
    .eq("id", user.id)
    .maybeSingle();
  if (freshErr) {
    console.error("[update-quantity] topics re-read failed:", freshErr.message);
    return NextResponse.json(
      {
        error:
          "Plan updated with Stripe, but the app couldn't safely sync it yet. Refresh in a minute.",
      },
      { status: 500 }
    );
  }
  const cappedTopics = Array.isArray(freshRow?.topics)
    ? (freshRow.topics as TopicId[]).slice(0, poolCap(newQuota))
    : undefined;
  const { data: quotaRow, error: quotaErr } = await svc
    .from("users")
    .update({ topic_quota: newQuota, ...(cappedTopics ? { topics: cappedTopics } : {}) })
    .eq("id", user.id)
    .eq("stripe_customer_id", row.stripe_customer_id)
    .eq("stripe_subscription_id", sub.id)
    .select("id")
    .maybeSingle();
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
  if (!quotaRow) {
    console.error(
      "[update-quantity] billing binding changed before local quota sync"
    );
    return NextResponse.json(
      {
        error:
          "Your subscription changed while this request was running. Refresh before changing it again.",
      },
      { status: 409 }
    );
  }

  // unit_amount * quantity = total monthly cents. Falls back to the shared
  // PRICE_PER_BUNDLE_CENTS constant (not a re-typed literal) only if Stripe's
  // price object is ever missing unit_amount.
  const unitAmount =
    typeof item.price?.unit_amount === "number" ? item.price.unit_amount : PRICE_PER_BUNDLE_CENTS;
  const monthlyCents = unitAmount * confirmedQty;

  return NextResponse.json({
    quantity: confirmedQty,
    topicQuota: newQuota,
    monthlyCents,
  });
  } finally {
    try {
      const released = await releaseQuantityUpdateLease(
        svc,
        user.id,
        leaseToken
      );
      if (!released) {
        console.warn("[update-quantity] quantity lease was already expired or replaced");
      }
    } catch {
      console.warn("[update-quantity] quantity lease release failed; it will expire automatically");
    }
  }
}
