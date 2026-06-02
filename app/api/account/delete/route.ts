import { NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { cancelCustomerSubscriptions } from "@/lib/stripe-cancel";

export const runtime = "nodejs";

// Real account deletion. The client-side "Delete my account" button used to
// run `delete from users where id = self` via the browser client — but there
// is no DELETE policy on public.users, so RLS silently matched zero rows and
// the data persisted while the UI claimed success. This endpoint deletes the
// auth.users row with the service role, which cascades to public.users and
// public.issues (FK on delete cascade) and sets support_tickets.user_id null.
//
// Before deleting, it cancels the user's Stripe subscription(s) — otherwise a
// paying user would keep being billed after their account (and portal access)
// is gone. That step is best-effort and never blocks the deletion.
//
// Auth: only the signed-in user can delete their own account. We read the
// session server-side and delete that exact id — no user-supplied id is
// trusted.
export async function POST() {
  const sb = await supabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await sb.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const svc = await supabaseServiceClient();

  // Cancel any Stripe subscription FIRST — deleting the auth user cascades away
  // public.users (incl. stripe_customer_id), and the deleted account can't reach
  // the billing portal, so a still-active subscription would bill forever with
  // no way to stop it. Best-effort: a Stripe hiccup must never block the user's
  // right to delete their account.
  const stripeSecret = process.env.STRIPE_SECRET_KEY?.trim();
  if (stripeSecret) {
    try {
      const { data: row } = await svc
        .from("users")
        .select("stripe_customer_id")
        .eq("id", user.id)
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
          `[account/delete] stripe ${customerId}: cancelled ${cancelled.length}, skipped ${skipped}, errors ${errors}`
        );
      }
    } catch (e) {
      console.warn(
        "[account/delete] subscription cancel failed (proceeding with delete):",
        e instanceof Error ? e.message : e
      );
    }
  }

  const { error } = await svc.auth.admin.deleteUser(user.id);
  if (error) {
    console.error("[account/delete] failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Best-effort sign-out so the now-orphaned session cookie is cleared.
  try {
    await sb.auth.signOut();
  } catch {
    // cookie clears client-side regardless
  }

  return NextResponse.json({ ok: true });
}
