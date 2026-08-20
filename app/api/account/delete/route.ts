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
// It also cancels the user's Stripe subscription(s) — otherwise a paying user
// would keep being billed after their account (and portal access) is gone.
// That step is best-effort and never blocks the deletion.
//
// alpha-drift-r46-06 (2026-08-19): the Stripe/ticket/suppression cleanup used
// to run BEFORE deleteUser() below. If deleteUser() then failed for a real
// (non-not-found) reason, this returned a 500 saying "couldn't delete, try
// again" while the subscription was already cancelled and the Stripe
// customer already gone — the user reads that as a no-op and silently loses
// paid access with no self-serve way to restore it. deleteUser() now runs
// FIRST (right after a pre-fetch of stripe_customer_id, since the row is
// about to cascade away), gating everything else: only on its success (or an
// already-not-found race) do we run the Stripe/ticket/suppression cleanup.
// That way a real deleteUser() failure means NOTHING else has happened yet,
// so "couldn't delete, try again" is accurate again.
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

  // Pre-fetch stripe_customer_id while the row still exists — deleteUser()
  // below cascades public.users away, and this is the only chance to learn
  // it. `rowErr` (not just a falsy `row`) distinguishes "we confirmed there's
  // no Stripe customer" from "the query itself failed and we don't actually
  // know" — collapsing those would risk silently skipping real Stripe
  // cleanup on a transient query error, the same class of gap already fixed
  // elsewhere in this codebase (see admin/users/route.ts's alpha-drift-r26-01).
  const { data: row, error: rowErr } = await svc
    .from("users")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle();
  if (rowErr) {
    console.error(`[account/delete] pre-fetch of stripe_customer_id failed for ${user.id}, proceeding with delete anyway:`, rowErr.message);
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

  // Cancel any Stripe subscription and delete the Customer object — the auth
  // user (and cascaded public.users, incl. stripe_customer_id) is already
  // gone at this point, so pass the pre-fetched id through rather than
  // letting this re-query a row that no longer exists (it would find
  // nothing and silently skip cleanup). Best-effort: a Stripe hiccup must
  // never block the user's right to delete their account — and by this
  // point the account is already deleted regardless.
  await cleanUpStripeCustomerBeforeDelete(svc, user.id, "[account/delete]", undefined, rowErr ? undefined : (row?.stripe_customer_id ?? null));

  // Delete the user's support tickets outright rather than letting the FK
  // cascade just null out user_id — see deleteSupportTicketsBeforeDelete's
  // own comment for why. Best-effort, like the Stripe step above.
  // alpha-drift-r28-08 (2026-08-15): pass the confirmed auth email too, so
  // a support ticket filed signed-out with this same address (user_id
  // permanently NULL) is caught, not just tickets already linked by id.
  await deleteSupportTicketsBeforeDelete(svc, user.id, "[account/delete]", user.email);

  // alpha-drift-r20-01 (found+fixed 2026-08-13): if this reader ever hard-
  // bounced or complained, Resend keeps that as its own account-level
  // suppression-list record, keyed by email, entirely separate from (and
  // outliving) every Supabase trace this route already clears -- a real
  // third-party record surviving the "all associated data (irreversible)"
  // promise below. Reusing removeResendSuppression() here isn't about
  // re-enabling delivery (they're gone, we won't email them again) -- the
  // underlying call is DELETE /suppressions/{email}, so the effect wanted
  // either way is identical: the record stops existing at Resend. Best-
  // effort, same as the Stripe/ticket steps above.
  if (user.email) {
    await removeResendSuppression(user.email);
  }

  // Best-effort sign-out so the now-orphaned session cookie is cleared.
  try {
    await sb.auth.signOut();
  } catch {
    // cookie clears client-side regardless
  }

  return NextResponse.json({ ok: true });
}
