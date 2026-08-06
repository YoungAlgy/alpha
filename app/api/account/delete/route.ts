import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { cancelStripeSubscriptionsBeforeDelete } from "@/lib/stripe-cancel";

export const runtime = "nodejs";

// Real account deletion. The client-side "Delete my account" button used to
// run `delete from users where id = self` via the browser client — but there
// is no DELETE policy on public.users, so RLS silently matched zero rows and
// the data persisted while the UI claimed success. This endpoint deletes the
// auth.users row with the service role, which cascades to public.users and
// public.issues (FK on delete cascade).
//
// support_tickets.user_id is ON DELETE SET NULL, not CASCADE — deleting the
// auth user alone would just orphan the ticket row while its name/email/
// message text lives on forever. The privacy page and delete-confirmation
// copy both promise "all associated data" is gone, so we delete those rows
// ourselves, by user_id, before the auth user goes away and takes that FK
// link with it.
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
  await cancelStripeSubscriptionsBeforeDelete(svc, user.id, "[account/delete]");

  // Delete the user's support tickets outright rather than letting the FK
  // cascade just null out user_id — SET NULL would leave their name, email,
  // and message text sitting in the table with nothing tying it back to an
  // account, which contradicts the "irreversible, all data gone" promise on
  // the privacy and settings pages. Best-effort, like the Stripe step above:
  // a failure here must not block the user's right to delete their account.
  const { error: ticketsErr } = await svc
    .from("support_tickets")
    .delete()
    .eq("user_id", user.id);
  if (ticketsErr) {
    console.error("[account/delete] failed to delete support_tickets:", ticketsErr.message);
  }

  const { error } = await svc.auth.admin.deleteUser(user.id);
  if (error) {
    console.error("[account/delete] failed:", error.message);
    return NextResponse.json(
      { error: "Couldn't delete your account. Try again or contact support." },
      { status: 500 },
    );
  }

  // Best-effort sign-out so the now-orphaned session cookie is cleared.
  try {
    await sb.auth.signOut();
  } catch {
    // cookie clears client-side regardless
  }

  return NextResponse.json({ ok: true });
}
