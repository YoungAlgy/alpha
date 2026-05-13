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
  const email = profile.email;
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

    // Sync the profile fields onto public.users (service role bypasses RLS)
    await sb.from("users").upsert(
      {
        id: userId,
        email,
        first_name: profile.firstName,
        city: profile.city || null,
        job_blurb: profile.jobBlurb || null,
        project_blurb: profile.projectBlurb || null,
        fun_blurb: profile.funBlurb || null,
        theme: profile.theme || "forest",
        topics: profile.topics,
      },
      { onConflict: "id" }
    );

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
