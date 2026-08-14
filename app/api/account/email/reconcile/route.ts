import { NextResponse } from "next/server";
import { getStripeClient } from "@/lib/stripe";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { sendOpsAlert } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// Reconcile the public.users.email MIRROR (and the Stripe customer email) to the
// authoritative Supabase auth email. The auth email is the one a confirmed
// email-change actually updates; everything else mirrors it. The weekly cron
// sends to public.users.email, so until this runs after a change, letters keep
// going to the OLD address — this is what catches the mirror up.
//
// Security: there is NO user-supplied email here. The new address is read from
// the SESSION (user.email), which Supabase only sets after the reader confirmed
// ownership via the change link. So a caller can only ever set their own mirror
// to their own already-verified auth email — idempotent, and a no-op when they
// already match (every normal sign-in). The settings page fires this on load,
// which is where an email-change confirm lands (emailRedirectTo → /settings).
export async function POST() {
  const sb = await supabaseServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  // Rate limit per user (not IP): this is a single-row Supabase write behind
  // auth, so the abuse case is a scripted authenticated client hammering it,
  // not an anonymous IP. 30/hr is well above the "fires once per /settings
  // load" real usage described above.
  const limited = rateLimit(`account-email-reconcile:${user.id}`, { limit: 30, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  const authEmail = user.email?.trim().toLowerCase();
  if (!authEmail) {
    // No email on the auth identity (shouldn't happen for an email/OTP user).
    return NextResponse.json({ ok: true, changed: false });
  }

  const svc = await supabaseServiceClient();
  // alpha-drift-r26-04 (2026-08-14): this used to discard `error` here,
  // so a genuinely failed read (never throws, resolves as {data:null,
  // error:{...}}) was indistinguishable from "no row" and fell straight
  // into the same 200 {changed:false} "nothing to do" response below --
  // this route's own purpose is keeping the letter-delivery mirror in
  // sync, so a silently-swallowed read failure means it silently stays
  // stale with zero signal, undermining the reason the route exists.
  // Every write later in this function already checks error and alerts
  // on failure; this read was the one gap.
  const { data: row, error: rowError } = await svc
    .from("users")
    .select("email, stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle();
  if (rowError) {
    console.error("[account/email/reconcile] mirror read failed:", rowError.message);
    sendOpsAlert(
      "alpha: email mirror read failed",
      `Reconcile couldn't read public.users for user ${user.id} before comparing it to their confirmed auth email. Their mirror may be stale with nothing recorded here to show it. DB error: ${rowError.message}`
    ).catch(() => {});
    return NextResponse.json({ error: "Couldn't sync. Try again." }, { status: 500 });
  }

  // Already in sync (or no row) — nothing to do.
  if (!row || (row.email ?? "").toLowerCase() === authEmail) {
    return NextResponse.json({ ok: true, changed: false });
  }

  const { error } = await svc
    .from("users")
    .update({ email: authEmail })
    .eq("id", user.id);
  if (error) {
    console.error("[account/email/reconcile] mirror update failed:", error.message);
    // A stuck mirror means a paying subscriber's letters keep going to the OLD
    // address with no signal — the same silent-drop class the cron already
    // alarms on, so surface it. A unique violation (23505) means the target
    // email already sits on another row, which needs a human (not a retry).
    sendOpsAlert(
      "alpha: email mirror sync failed",
      `Reconcile could not set public.users.email for user ${user.id} to their confirmed auth email. Their letters may keep going to the old address. DB error: ${error.message}`
    ).catch(() => {});
    const conflict = (error as { code?: string }).code === "23505";
    return NextResponse.json(
      { error: conflict ? "That email is already on another account." : "Couldn't sync. Try again." },
      { status: conflict ? 409 : 500 }
    );
  }

  // Best-effort: keep the Stripe customer's email in step too (receipts /
  // invoices). Cosmetic — a failure here must NOT fail the reconcile, since the
  // letter-delivery mirror (the part that matters) is already updated.
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (secret && row.stripe_customer_id) {
    try {
      const stripe = getStripeClient();
      await stripe.customers.update(row.stripe_customer_id, { email: authEmail });
    } catch (e) {
      console.warn(
        "[account/email/reconcile] Stripe email sync failed (non-fatal):",
        e instanceof Error ? e.message : e
      );
    }
  }

  return NextResponse.json({ ok: true, changed: true });
}
