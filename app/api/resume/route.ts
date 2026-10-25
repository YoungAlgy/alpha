import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { BREVO_DELIVERY_SCHEMA_ENABLED } from "@/lib/brevo-delivery-policy";
import { SUBSCRIBER_LETTERS_ENABLED } from "@/lib/subscriber-delivery-policy";
import { getResumeLetterStatus } from "@/lib/resume-letter-status";

export const runtime = "nodejs";

// Self-serve "resume my letters" — the counterpart to one-click unsubscribe.
// Clears only unsubscribed_at for the signed-in user. Access, owner-controlled
// enrollment and provider blocks remain separate. The returned current row
// determines the confirmation; clearing this preference alone cannot promise
// delivery. The sender still rechecks eligibility before each attempt.
//
// alpha-drift-r51-02 (2026-08-20, rls-migration-drift-audit): this used to
// say "public.users has no self-UPDATE RLS policy" -- wrong. The "users self
// update" policy (auth.uid() = id) has existed since the initial schema and
// is actively relied on elsewhere every day (lib/theme.ts's setTheme(),
// lib/user-sync.ts's syncUserProfile(), both writing through the browser-
// scoped client). The real reason this route needs the service role is the
// separate protect_user_privileged_columns BEFORE UPDATE trigger, which
// pins unsubscribed_at back to its old value for any non-service_role
// caller -- not an absent policy. Flagging this explicitly so a future
// "which users-table policies have real callers" pass doesn't read this
// comment as evidence the self-update policy is unused and drop it,
// repeating the 2026-08-06 topics_all_valid same-day-hotfix incident.
//
// alpha-drift-r52-02 (2026-08-20, self-audit-r51): the trigger's locked-
// column list above used to name only 8 columns, citing
// 20260524000000_security_user_column_lock.sql's original function body --
// that migration was superseded by 20260806030000_resend_webhook_
// deliverability.sql's `create or replace function`, which added
// bounced_at/complained_at to the same locked set (the identical gap
// scripts/verify-rls-privileged-columns.mts's own r40-08 comment already
// documented for that file). At that migration the trigger locked these 10:
// subscribed_at/cancelled_at/unsubscribed_at/topic_quota/bounced_at/
// complained_at/stripe_customer_id/email/id/created_at.
// Later migrations also protect invite, enrollment and suppression state.
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
  const columns = "id, email, subscribed_at, cancelled_at, access_granted_at, delivery_enrolled, unsubscribed_at, bounced_at, complained_at, suppression_cleanup_pending_at" +
    (BREVO_DELIVERY_SCHEMA_ENABLED ? ", brevo_unsubscribed_at" : "");
  let update = svc.from("users")
    .update({ unsubscribed_at: null })
    .eq("id", user.id);
  if (BREVO_DELIVERY_SCHEMA_ENABLED) {
    // Only Alpha's own pause can be cleared here. A provider opt-out needs
    // reviewed provider-side recovery before this screen can promise mail.
    update = update.is("brevo_unsubscribed_at", null);
  }
  const { data: resumed, error: resumeError } = await update.select(columns);
  if (resumeError) {
    return NextResponse.json({ error: "Couldn't verify your letter settings. Try again." }, { status: 503 });
  }
  if (!Array.isArray(resumed) || resumed.length !== 1) {
    if (BREVO_DELIVERY_SCHEMA_ENABLED) {
      // A zero-row update could also mean a missing account. Name a provider
      // block only after an exact current-row read confirms it.
      const { data: current, error: currentError } = await svc.from("users")
        .select("id, brevo_unsubscribed_at")
        .eq("id", user.id)
        .maybeSingle();
      const profile: unknown = current;
      if (!currentError && profile && typeof profile === "object" &&
          "id" in profile && profile.id === user.id &&
          "brevo_unsubscribed_at" in profile &&
          typeof profile.brevo_unsubscribed_at === "string" &&
          Number.isFinite(Date.parse(profile.brevo_unsubscribed_at))) {
        return NextResponse.json({
          error: "Your email provider has an unsubscribe block. Contact support to review it before resuming letters.",
        }, { status: 409 });
      }
    }
    return NextResponse.json({ error: "Couldn't verify your letter settings. Try again." }, { status: 503 });
  }
  const resumedProfile: unknown = resumed[0];
  const status = resumedProfile && typeof resumedProfile === "object" &&
    "id" in resumedProfile && resumedProfile.id === user.id ? getResumeLetterStatus(resumedProfile, {
    brevoSchemaEnabled: BREVO_DELIVERY_SCHEMA_ENABLED,
    lettersEnabled: SUBSCRIBER_LETTERS_ENABLED,
  }) : "unverified";
  if (status === "unverified") {
    return NextResponse.json({ error: "Your pause preference may have been cleared, but delivery status could not be verified. Refresh your settings before trying again." }, { status: 503 });
  }
  return NextResponse.json({ ok: true, status });
}
