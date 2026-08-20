import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripeClient, describeStripeError } from "@/lib/stripe";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { hasActiveAccess } from "@/lib/access";
import { clampQuota, TOPICS_PER_BUNDLE, PRICE_PER_BUNDLE_CENTS, type TopicId } from "@/lib/types";
import { rateLimit } from "@/lib/rate-limit";
import { nextQuantity, isLiveForManagement } from "@/lib/update-quantity-guards";
import { poolCap } from "@/lib/engine/select-sections";

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
}

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
  const svc = await supabaseServiceClient();
  const { data: row, error: rowErr } = await svc
    .from("users")
    .select("stripe_customer_id, topic_quota, subscribed_at, cancelled_at, topics")
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

  // Find this customer's live subscription. See lib/update-quantity-guards.ts's
  // isLiveForManagement for why status:"active" alone isn't enough (trialing
  // comp checkouts, past_due Smart Retry window) and why this matches
  // lib/stripe-cancel.ts's own status:"all" + explicit-status-set pattern.
  //
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
      ? subs.data.find((s) => isLiveForManagement(s.status))
      : undefined;
  } catch (e) {
    // alpha-drift-r29-05 (2026-08-14): describeStripeError, see lib/stripe.ts.
    console.error("[update-quantity] subscriptions.list failed:", describeStripeError(e));
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

  // alpha-drift-r17-04 (found+fixed 2026-08-07): there's no lock serializing
  // overlapping requests for the same user -- two tabs clicking OPPOSITE
  // directions within the same 30s window compute different nextQty values
  // (different idempotency keys, so Stripe applies BOTH updates instead of
  // deduping them), and whichever HTTP call happens to reach Stripe last
  // wins the item's real quantity, decided by network timing, not
  // application logic. Trusting the LOCALLY COMPUTED nextQty for the DB
  // write-through below (the old code) made this worse: whichever of the
  // two concurrent DB writes landed last stuck, independently of which
  // Stripe update actually won -- so the DB could represent a value NEITHER
  // Stripe call nor the other request intended. Re-fetching the subscription
  // fresh right after this request's own update call and writing/returning
  // THAT converges the DB (and this response) to whatever Stripe's real
  // final state is, regardless of request ordering -- the exact same
  // self-healing principle the customer.subscription.updated webhook
  // already uses (re-reads live quantity rather than trusting a snapshot).
  // Doesn't eliminate the race entirely (a per-user mutex would, at much
  // higher complexity for a narrow two-tabs-clicking-fast scenario) but
  // means the DB can never end up holding a value Stripe never actually
  // confirmed.
  let confirmedQty = nextQty;
  try {
    const fresh = await stripe.subscriptions.retrieve(sub.id);
    const freshItem = fresh.items.data[0];
    if (typeof freshItem?.quantity === "number") {
      confirmedQty = freshItem.quantity;
    }
  } catch (e) {
    // Best-effort: the update above already succeeded, so fall back to the
    // locally-computed nextQty rather than failing a request whose Stripe-
    // side mutation is already real. The webhook still reconciles later.
    // alpha-drift-r29-05 (2026-08-14): describeStripeError, see lib/stripe.ts.
    console.warn("[update-quantity] post-update retrieve failed, using locally-computed quantity:", describeStripeError(e));
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
  const cappedTopics = Array.isArray(row.topics)
    ? (row.topics as TopicId[]).slice(0, poolCap(newQuota))
    : undefined;
  const { error: quotaErr } = await svc
    .from("users")
    .update({ topic_quota: newQuota, ...(cappedTopics ? { topics: cappedTopics } : {}) })
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
  const monthlyCents = unitAmount * confirmedQty;

  return NextResponse.json({
    quantity: confirmedQty,
    topicQuota: newQuota,
    monthlyCents,
  });
}
