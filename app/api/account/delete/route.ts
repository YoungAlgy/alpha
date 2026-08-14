import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { cleanUpStripeCustomerBeforeDelete, deleteSupportTicketsBeforeDelete } from "@/lib/stripe-cancel";
import { rateLimit } from "@/lib/rate-limit";
import { isUserNotFoundError } from "@/lib/gotrue-errors";
import { removeResendSuppression } from "@/lib/email";

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

  // Every sibling account/* route (profile, topics, export, email/reconcile)
  // rate-limits per user id; this route was the one gap (found in review
  // 2026-08-06). Delete has no per-second-click cost the way generation does,
  // but the goal here is the same as everywhere else it's applied: a speed
  // bump against a scripted/hijacked-session caller hammering the route, not
  // a normal-usage constraint (an account only gets deleted once).
  const limited = rateLimit(`account-delete:${user.id}`, { limit: 10, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  const svc = await supabaseServiceClient();

  // Cancel any Stripe subscription and delete the Customer object FIRST —
  // deleting the auth user cascades away public.users (incl.
  // stripe_customer_id), and the deleted account can't reach the billing
  // portal, so a still-active subscription would bill forever with no way to
  // stop it. Best-effort: a Stripe hiccup must never block the user's right
  // to delete their account.
  await cleanUpStripeCustomerBeforeDelete(svc, user.id, "[account/delete]");

  // Delete the user's support tickets outright rather than letting the FK
  // cascade just null out user_id — see deleteSupportTicketsBeforeDelete's
  // own comment for why. Best-effort, like the Stripe step above: a failure
  // here must not block the user's right to delete their account.
  await deleteSupportTicketsBeforeDelete(svc, user.id, "[account/delete]");

  // alpha-drift-r20-01 (found+fixed 2026-08-13): if this reader ever hard-
  // bounced or complained, Resend keeps that as its own account-level
  // suppression-list record, keyed by email, entirely separate from (and
  // outliving) every Supabase trace this route already clears -- a real
  // third-party record surviving the "all associated data (irreversible)"
  // promise below. Reusing removeResendSuppression() here isn't about
  // re-enabling delivery (they're gone, we won't email them again) -- the
  // underlying call is DELETE /suppressions/{email}, so the effect wanted
  // either way is identical: the record stops existing at Resend. Best-
  // effort, same as the two calls above.
  if (user.email) {
    await removeResendSuppression(user.email);
  }

  const { error } = await svc.auth.admin.deleteUser(user.id);
  if (error) {
    // A concurrent second click/tab racing this same delete: whichever
    // request completes second hits an auth.users row the first one already
    // removed. The END STATE both requests wanted (no auth user) is already
    // true, so this isn't really a failure -- treating it as one showed a
    // real signed-in user a scary "couldn't delete" alert on an account that
    // was, in fact, already gone (found in review 2026-08-06; no client-side
    // guard existed to prevent the double-click that triggers this).
    if (isUserNotFoundError(error)) {
      console.warn(`[account/delete] deleteUser reported not-found for ${user.id} — already deleted, treating as success`);
    } else {
      console.error("[account/delete] failed:", error.message);
      return NextResponse.json(
        { error: "Couldn't delete your account. Try again or contact support." },
        { status: 500 },
      );
    }
  }

  // Best-effort sign-out so the now-orphaned session cookie is cleared.
  try {
    await sb.auth.signOut();
  } catch {
    // cookie clears client-side regardless
  }

  return NextResponse.json({ ok: true });
}
