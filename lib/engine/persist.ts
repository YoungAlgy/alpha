import { supabaseServiceClient } from "@/lib/supabase/server";
import type { Issue, UserProfile } from "@/lib/types";

interface PersistResult {
  userId: string;
  magicLink: string | null;
}

function supabaseConfigured(): boolean {
  return (
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    (!!process.env.SUPABASE_SECRET_KEY || !!process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

// The set of profile fields that the incoming request actually HAS a value for.
// Used to UPDATE an existing public.users row WITHOUT clobbering: a field the
// caller left empty is omitted, so it can never null out a real subscriber's
// saved blurbs/city/theme/topics. Mirrors the non-clobbering pattern in
// lib/user-sync.ts. (The first-letter INSERT path still writes the full profile
// — see persistIssueIfPossible — because onboarding always carries every field.)
function nonEmptyProfileFields(profile: UserProfile): Record<string, string | string[]> {
  const f: Record<string, string | string[]> = {};
  if (profile.firstName?.trim()) f.first_name = profile.firstName.trim();
  if (profile.city?.trim()) f.city = profile.city.trim();
  if (profile.jobBlurb?.trim()) f.job_blurb = profile.jobBlurb.trim();
  if (profile.projectBlurb?.trim()) f.project_blurb = profile.projectBlurb.trim();
  if (profile.funBlurb?.trim()) f.fun_blurb = profile.funBlurb.trim();
  if (profile.birthday?.trim()) f.birthday = profile.birthday.trim();
  if (profile.gender === "male" || profile.gender === "female") f.gender = profile.gender;
  if (profile.theme?.trim()) f.theme = profile.theme.trim();
  if (Array.isArray(profile.topics) && profile.topics.length > 0) f.topics = profile.topics;
  return f;
}

/**
 * Best-effort persistence of a freshly-generated issue. Idempotent over the
 * (user_id, week_of) unique constraint — re-runs will upsert.
 *
 * Pattern: use service-role admin.generateLink to find-or-create the auth user
 * by email AND get a magic link in one round trip. The link can be emailed
 * later so the user can sign back in next time.
 *
 * Returns null if Supabase isn't configured or no email is available — letter
 * still renders fine, just isn't archived.
 */
export async function persistIssueIfPossible(
  profile: UserProfile,
  issue: Issue,
  weekOf: string
): Promise<PersistResult | null> {
  if (!supabaseConfigured()) return null;
  // We can't write to public.users / public.issues without a user_id (RLS).
  // Email is the bootstrap identifier.
  // Lowercase so the auth user + public.users row key on the same canonical
  // email the checkout/webhook paths use (emails are case-insensitive in
  // practice; Supabase auth lowercases anyway).
  const email = profile.email?.toLowerCase().trim();
  if (!email) return null;

  try {
    const sb = await supabaseServiceClient();

    // Find-or-create auth user + grab a sign-in link in one call
    const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: {
        redirectTo: process.env.NEXT_PUBLIC_APP_URL
          ? `${process.env.NEXT_PUBLIC_APP_URL}/alpha/auth/callback?next=/inbox`
          : undefined,
      },
    });
    if (linkErr || !linkData?.user) {
      console.warn("[persist] generateLink failed:", linkErr?.message);
      return null;
    }
    const userId = linkData.user.id;
    const magicLink = linkData.properties?.action_link ?? null;

    // Sync the profile fields onto public.users (service role bypasses RLS).
    // Surface failures: this row is what the weekly cron reads — a silently
    // failed sync means next Sunday's letter generates from stale/missing
    // profile data with no trace of why.
    //
    // NON-CLOBBERING insert/update split (was a full-row upsert). A full-row
    // upsert on conflict overwrites EVERY column with the incoming payload, so
    // the day a re-generate path posts a sparse body (ProfileSchema makes the
    // blurbs optional) it would null an existing paid subscriber's
    // job/project/fun blurbs and stomp city/theme/topics with partial client
    // data — the same silent data-loss class as the user-sync.ts bug. So:
    //   • brand-new row  → write the FULL profile (onboarding always carries
    //     every field, and the cron needs first_name + topics present).
    //   • existing row   → write only the fields the caller actually has a
    //     value for; never overwrite a real value with empty/partial input.
    const { data: existingUser } = await sb
      .from("users")
      .select("id")
      .eq("id", userId)
      .maybeSingle();

    if (!existingUser) {
      const { error: insErr } = await sb.from("users").insert({
        id: userId,
        email,
        first_name: profile.firstName,
        city: profile.city || null,
        job_blurb: profile.jobBlurb || null,
        project_blurb: profile.projectBlurb || null,
        fun_blurb: profile.funBlurb || null,
        birthday: profile.birthday || null,
        gender: profile.gender || null,
        theme: profile.theme || "forest",
        topics: profile.topics,
      });
      if (insErr) {
        // Lost a race with a concurrent insert (e.g. the Stripe checkout
        // webhook creating the row mid-generation) — the row now exists, so
        // fall back to a non-clobbering update instead of dropping the topics.
        const updates = nonEmptyProfileFields(profile);
        if (Object.keys(updates).length > 0) {
          const { error: raceErr } = await sb
            .from("users")
            .update(updates)
            .eq("id", userId);
          if (raceErr) {
            console.error(
              "[persist] users profile insert raced AND update fallback failed:",
              insErr.message,
              raceErr.message
            );
          }
        }
      }
    } else {
      const updates = nonEmptyProfileFields(profile);
      if (Object.keys(updates).length > 0) {
        const { error: updErr } = await sb
          .from("users")
          .update(updates)
          .eq("id", userId);
        if (updErr) {
          console.error("[persist] users profile update failed:", updErr.message);
        }
      }
    }

    // Persist the issue
    const { error: issueErr } = await sb.from("issues").upsert(
      {
        user_id: userId,
        week_of: weekOf,
        volume: issue.volume,
        number: issue.number,
        editor_intro: issue.editorIntro,
        sections: issue.sections,
      },
      { onConflict: "user_id,week_of" }
    );
    if (issueErr) {
      console.warn("[persist] issue upsert failed:", issueErr.message);
    }

    return { userId, magicLink };
  } catch (e) {
    console.warn("[persist] exception:", e instanceof Error ? e.message : e);
    return null;
  }
}
