import { NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { cancelCustomerSubscriptions } from "@/lib/stripe-cancel";

export const runtime = "nodejs";

const ADMIN_EMAIL = "youngalgy@gmail.com";

interface Stats {
  totalUsers: number;
  paying: number;
  freeGranted: number;
  cancelled: number;
  unsubscribed: number;
  notSubscribed: number;
  latestIssueWeekOf: string | null;
  latestIssueCount: number;
}

async function gatherStats(): Promise<Stats> {
  const sb = await supabaseServiceClient();

  // One query, in-memory aggregation — small population, fine for V1
  const { data: rows } = await sb
    .from("users")
    .select("subscribed_at, cancelled_at, unsubscribed_at, stripe_customer_id");

  const stats = {
    totalUsers: rows?.length ?? 0,
    paying: 0,
    freeGranted: 0,
    cancelled: 0,
    unsubscribed: 0,
    notSubscribed: 0,
  };
  // Mutually exclusive buckets so the counts sum to totalUsers (the old
  // version double-counted a user who was both unsubscribed and paying).
  // Priority mirrors what the owner cares about most: opted out > cancelled >
  // paying > free > never-subscribed.
  for (const r of rows ?? []) {
    if (r.unsubscribed_at) stats.unsubscribed++;
    else if (r.cancelled_at) stats.cancelled++;
    else if (r.subscribed_at && r.stripe_customer_id) stats.paying++;
    else if (r.subscribed_at && !r.stripe_customer_id) stats.freeGranted++;
    else stats.notSubscribed++;
  }

  // Latest issue snapshot — surfaces whether the weekly cron is running
  const { data: latestIssues } = await sb
    .from("issues")
    .select("week_of")
    .order("week_of", { ascending: false })
    .limit(1);
  const latestWeekOf = latestIssues?.[0]?.week_of ?? null;

  let latestIssueCount = 0;
  if (latestWeekOf) {
    const { count } = await sb
      .from("issues")
      .select("*", { count: "exact", head: true })
      .eq("week_of", latestWeekOf);
    latestIssueCount = count ?? 0;
  }

  return {
    ...stats,
    latestIssueWeekOf: latestWeekOf,
    latestIssueCount,
  };
}

async function requireAdmin(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  const sb = await supabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  }
  if (user.email !== ADMIN_EMAIL) {
    return { ok: false, res: NextResponse.json({ error: "Not authorized" }, { status: 403 }) };
  }
  return { ok: true };
}

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.res;

  const sb = await supabaseServiceClient();
  const [{ data: users, error }, stats] = await Promise.all([
    sb
      .from("users")
      .select("id, email, first_name, city, theme, topics, stripe_customer_id, subscribed_at, cancelled_at, unsubscribed_at, created_at")
      .order("created_at", { ascending: false })
      .limit(200),
    gatherStats(),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ users, stats });
}

interface ActionBody {
  action: "delete" | "grant_free" | "revoke_free";
  userId: string;
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.res;

  let body: ActionBody;
  try {
    body = (await req.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const sb = await supabaseServiceClient();

  if (body.action === "delete") {
    // Cancel any Stripe subscription FIRST (mirrors self-serve account/delete):
    // deleting the auth user cascades public.users away incl. stripe_customer_id,
    // so a still-active sub would bill forever with no way to stop it. Best-effort
    // — a Stripe hiccup must never block the admin delete.
    const stripeSecret = process.env.STRIPE_SECRET_KEY?.trim();
    if (stripeSecret) {
      try {
        const { data: row } = await sb
          .from("users")
          .select("stripe_customer_id")
          .eq("id", body.userId)
          .maybeSingle();
        const customerId = row?.stripe_customer_id;
        if (customerId) {
          const stripe = new Stripe(stripeSecret, {
            apiVersion: "2026-04-22.dahlia",
            httpClient: Stripe.createNodeHttpClient(),
          });
          const { cancelled, skipped, errors } = await cancelCustomerSubscriptions(
            stripe,
            customerId
          );
          console.log(
            `[admin/delete] stripe ${customerId}: cancelled ${cancelled.length}, skipped ${skipped}, errors ${errors}`
          );
        }
      } catch (e) {
        console.warn(
          "[admin/delete] subscription cancel failed (proceeding with delete):",
          e instanceof Error ? e.message : e
        );
      }
    }
    // Delete the auth user — cascade removes their public.users + issues rows.
    const { error } = await sb.auth.admin.deleteUser(body.userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "grant_free") {
    // Don't let a comp grant clobber a REAL Stripe subscriber's cancellation
    // state (the cancelled_at: null below would un-cancel them in our mirror).
    // Mirror revoke_free's guard: refuse if they have a real Stripe customer —
    // a paying sub is managed in Stripe, never comped over.
    const { data: existing } = await sb
      .from("users")
      .select("stripe_customer_id")
      .eq("id", body.userId)
      .maybeSingle();
    if (existing?.stripe_customer_id) {
      return NextResponse.json(
        { error: "User has a real Stripe subscription. Manage in Stripe, don't comp." },
        { status: 400 }
      );
    }
    // Mark as subscribed without a Stripe customer. App checks subscribed_at.
    // Clear unsubscribed_at too: a comp grant is an explicit admin decision to
    // send letters, so it must re-consent a previously-opted-out user (mirrors
    // the paid checkout path) — otherwise re-comping an unsubscribed reader
    // would silently leave them dropped from every send.
    const { error } = await sb
      .from("users")
      .update({
        subscribed_at: new Date().toISOString(),
        cancelled_at: null,
        unsubscribed_at: null,
      })
      .eq("id", body.userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "revoke_free") {
    // Only revokes the free-grant flag — does NOT touch real Stripe subs.
    // Guard: only revoke if there's no stripe_customer_id (i.e., they were free-granted).
    const { data: row } = await sb
      .from("users")
      .select("stripe_customer_id")
      .eq("id", body.userId)
      .maybeSingle();
    if (row?.stripe_customer_id) {
      return NextResponse.json(
        { error: "User has a real Stripe subscription. Manage in Stripe." },
        { status: 400 }
      );
    }
    const { error } = await sb
      .from("users")
      .update({ subscribed_at: null })
      .eq("id", body.userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
