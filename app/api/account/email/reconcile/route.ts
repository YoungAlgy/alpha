import { NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { sendOpsAlert } from "@/lib/email";

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

  const authEmail = user.email?.trim().toLowerCase();
  if (!authEmail) {
    // No email on the auth identity (shouldn't happen for an email/OTP user).
    return NextResponse.json({ ok: true, changed: false });
  }

  const svc = await supabaseServiceClient();
  const { data: row } = await svc
    .from("users")
    .select("email, stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle();

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
      const stripe = new Stripe(secret, {
        apiVersion: "2026-04-22.dahlia",
        httpClient: Stripe.createNodeHttpClient(),
      });
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
