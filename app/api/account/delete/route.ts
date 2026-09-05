import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { isUserNotFoundError } from "@/lib/gotrue-errors";
import {
  isAccountDeletionBlockedBySuppressionRecovery,
  removeAccountAuthAndCompleteSaga,
  settleAccountDeletionBilling,
  settleAccountDeletionPrivacy,
} from "@/lib/account-deletion";
import { normalizeAccountEmails } from "@/lib/account-privacy";

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
// Stripe and Auth cannot share a transaction. A service-only deletion saga
// first scrubs staged checkout PII, freezes new fulfillment, expires every
// exact open Alpha Checkout Session, and cancels only exact Alpha
// subscriptions. Auth is removed only after Stripe and the database both
// confirm that billing is terminal. The pseudonymous tombstone makes a failed
// request safe to retry without retaining the subscriber's profile text.
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

  // Fetching the row separately keeps the user-facing missing-row error clear
  // and preserves the confirmed Auth email for support/Resend cleanup. The
  // saga itself re-reads and locks the exact billing ids transactionally.
  const { data: row, error: rowErr } = await svc
    .from("users")
    .select("email")
    .eq("id", user.id)
    .maybeSingle();
  if (rowErr) {
    console.error(`[account/delete] pre-fetch of the user email failed for ${user.id}; account left intact:`, rowErr.message);
    return NextResponse.json(
      { error: "Couldn't verify your billing status. Nothing was deleted. Try again." },
      { status: 503 }
    );
  }
  // An authenticated auth user with no public.users row is data drift, not
  // proof that no Stripe customer exists. Deleting auth here would erase the
  // only remaining account identity while leaving us unable to establish
  // whether a recurring subscription still needs cancellation.
  if (!row) {
    console.error(`[account/delete] public user row missing for ${user.id}; account left intact because billing status is unknown`);
    return NextResponse.json(
      { error: "Couldn't verify your billing status. Nothing was deleted. Contact support if this keeps happening." },
      { status: 503 }
    );
  }

  let deletionState:
    | "prepared"
    | "billing_clean"
    | "auth_delete_started"
    | "complete";
  try {
    deletionState = await settleAccountDeletionBilling(svc, user.id);
  } catch (billingError) {
    if (isAccountDeletionBlockedBySuppressionRecovery(billingError)) {
      console.warn(
        `[account/delete] reviewed delivery recovery blocks deletion for ${user.id}; account left intact`
      );
      return NextResponse.json(
        {
          error:
            "Account deletion is blocked until the reviewed delivery recovery is settled. Your account is still intact.",
        },
        { status: 409 }
      );
    }
    console.error(
      `[account/delete] exact Alpha billing cleanup was not confirmed for ${user.id}; Auth left intact:`,
      billingError instanceof Error ? billingError.message : billingError
    );
    return NextResponse.json(
      {
        error:
          "Couldn't safely finish billing cleanup. Your account is still intact. Try again or contact support.",
      },
      { status: 503 }
    );
  }

  // Auth is authoritative after a confirmed email change. The public mirror
  // can lag until ThemeApplier or the reconciliation route catches up, so
  // clean both addresses before the saga records privacy completion.
  const cleanupEmails = normalizeAccountEmails(user.email, row.email);
  if (
    cleanupEmails.length === 0 &&
    deletionState !== "auth_delete_started" &&
    deletionState !== "complete"
  ) {
    console.error(
      `[account/delete] no confirmed email remained for required privacy cleanup for ${user.id}`
    );
    return NextResponse.json(
      { error: "Couldn't verify your account email. Nothing was deleted." },
      { status: 503 }
    );
  }
  if (
    cleanupEmails.length > 0 &&
    deletionState !== "auth_delete_started" &&
    deletionState !== "complete"
  ) {
    try {
      await settleAccountDeletionPrivacy(
        svc,
        user.id,
        cleanupEmails
      );
    } catch (privacyError) {
      console.error(
        `[account/delete] required privacy cleanup was not confirmed for ${user.id}; Auth left intact:`,
        privacyError instanceof Error ? privacyError.message : privacyError
      );
      return NextResponse.json(
        {
          error:
            "Couldn't finish deleting your stored support data. Your account is still intact. Try again.",
        },
        { status: 503 }
      );
    }
  }

  try {
    const deleteAuthUser = async () => {
      const { error } = await svc.auth.admin.deleteUser(user.id);
      if (!error) return;
      // A retry can arrive after a prior request removed Auth but failed to
      // write the final saga marker. Not-found is the idempotent success path.
      if (isUserNotFoundError(error)) {
        console.warn(`[account/delete] deleteUser reported not-found for ${user.id} — already deleted, treating as success`);
        return;
      }
      throw error;
    };
    if (deletionState === "complete") {
      await deleteAuthUser();
    } else {
      await removeAccountAuthAndCompleteSaga(svc, user.id, deleteAuthUser);
    }
  } catch (authError) {
    console.error(
      `[account/delete] Auth removal or durable saga completion failed for ${user.id}:`,
      authError instanceof Error ? authError.message : authError
    );
    return NextResponse.json(
      { error: "Account deletion is still in progress. Try again or contact support." },
      { status: 503 }
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
