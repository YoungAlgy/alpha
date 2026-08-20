import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// Self-serve "resume my letters" — the counterpart to one-click unsubscribe.
// Clears unsubscribed_at for the SIGNED-IN user so the weekly cron starts
// sending again. A reader who hit unsubscribe (often the inbox-provider's
// one-click button) while still paying could otherwise only get letters back by
// emailing support — a paying customer stuck receiving nothing. Auth'd to the
// session so a caller can only ever resume THEIR OWN account; the actual write
// goes through the service role.
//
// alpha-drift-r51-02 (2026-08-20, rls-migration-drift-audit): this used to
// say "public.users has no self-UPDATE RLS policy" -- wrong. The "users self
// update" policy (auth.uid() = id) has existed since the initial schema and
// is actively relied on elsewhere every day (lib/theme.ts's setTheme(),
// lib/user-sync.ts's syncUserProfile(), both writing through the browser-
// scoped client). The real reason this route needs the service role is the
// separate protect_user_privileged_columns BEFORE UPDATE trigger
// (20260524000000_security_user_column_lock.sql), which pins
// unsubscribed_at (along with subscribed_at/cancelled_at/topic_quota/
// stripe_customer_id/email/id/created_at) back to its old value for any
// non-service_role caller -- not an absent policy. Flagging this explicitly
// so a future "which users-table policies have real callers" pass doesn't
// read this comment as evidence the self-update policy is unused and drop
// it, repeating the 2026-08-06 topics_all_valid same-day-hotfix incident.
// Idempotent: clearing an already-null unsubscribed_at is a harmless no-op,
// and clearing it for a non-subscribed user does nothing (the cron still
// gates on active access).
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
  // not an anonymous IP. 30/hr is well above any real resume-click usage.
  const limited = rateLimit(`resume:${user.id}`, { limit: 30, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  const svc = await supabaseServiceClient();
  const { error } = await svc
    .from("users")
    .update({ unsubscribed_at: null })
    .eq("id", user.id);
  if (error) {
    console.error("[resume] update failed:", error.message);
    return NextResponse.json({ error: "Couldn't resume. Try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
