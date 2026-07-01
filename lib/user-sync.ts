"use client";

import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { parseBirthday, coerceGender } from "@/lib/demographics";
import { isValidTopicId } from "@/lib/topics";
import type { OnboardingState } from "@/lib/onboarding-state";

// Fire-and-forget sync of an OnboardingState to the authenticated user's row
// in public.users. Runs only when Supabase is configured AND a session exists.
// Errors are warn-logged but never thrown.
export async function syncUserProfile(state: OnboardingState): Promise<void> {
  if (!supabaseConfigured()) return;
  try {
    const sb = supabaseClient();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return; // unauth = no sync, localStorage is the source of truth
    // NOTE: theme is deliberately NOT synced here. It's owned by setTheme()
    // (live changes write the DB directly) and by persist() at checkout. If we
    // wrote it from this in-memory state too, a later update() (e.g. saving
    // topics) would clobber a just-changed theme back to a stale value — the
    // exact "theme doesn't stick" bug.
    //
    // CRITICAL: only write fields the in-memory state actually has a value for.
    // This sync runs whenever a session exists, including a fresh-device or
    // cleared-browser sign-in where localStorage onboarding state is EMPTY. The
    // old code wrote `first_name: state.firstName ?? null` (and `topics ?? []`)
    // unconditionally, so an empty state would null out a real, populated
    // profile in the DB. That silently dropped the user from every send
    // (the cron skips rows with no first_name or no topics). The DB is the
    // source of truth on a fresh device — never overwrite a present value with
    // an empty one. Clearing an optional blurb intentionally is not supported
    // through this path, which is an acceptable trade for not wiping a profile.
    const updates: Record<string, string | string[]> = {};
    const fn = state.firstName?.trim();
    if (fn) updates.first_name = fn;
    const city = state.city?.trim();
    if (city) updates.city = city;
    const jobBlurb = state.jobBlurb?.trim();
    if (jobBlurb) updates.job_blurb = jobBlurb;
    const projectBlurb = state.projectBlurb?.trim();
    if (projectBlurb) updates.project_blurb = projectBlurb;
    const funBlurb = state.funBlurb?.trim();
    if (funBlurb) updates.fun_blurb = funBlurb;
    const birthday = state.birthday?.trim();
    if (birthday && parseBirthday(birthday)) updates.birthday = birthday;
    const gender = coerceGender(state.gender);
    if (gender) updates.gender = gender;
    if (Array.isArray(state.topics) && state.topics.length > 0) {
      // Filter through isValidTopicId: this write goes straight through the
      // browser's own RLS-scoped client (not the validated /api/account/topics
      // route), so a stale/corrupted localStorage state or a modified client
      // could otherwise smuggle a garbage topic id (including Object.prototype
      // names like "constructor") into the same column that route locks down.
      const validTopics = state.topics.filter(isValidTopicId);
      if (validTopics.length > 0) updates.topics = validTopics;
    }
    // Nothing real to sync (uninitialized/empty state) — don't touch the DB.
    if (Object.keys(updates).length === 0) return;
    const { error } = await sb
      .from("users")
      .update(updates)
      .eq("id", session.user.id);
    if (error) {
      console.warn("[user-sync] update failed:", error.message);
    }
  } catch (e) {
    console.warn("[user-sync] exception:", e instanceof Error ? e.message : e);
  }
}

// Delete the authenticated user's account via the server-side endpoint, which
// deletes the auth.users row with the service role — cascading to public.users
// + public.issues (FK on delete cascade). The previous implementation deleted
// via the browser client, but public.users has no DELETE RLS policy, so it
// silently affected zero rows and the data persisted while the UI reported
// success. Routing through the service role fixes that.
export async function deleteUserAccount(): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured()) return { ok: true }; // localStorage-only path
  try {
    const sb = supabaseClient();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { ok: true };
    const res = await fetch("/alpha/api/account/delete", { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    await sb.auth.signOut().catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown" };
  }
}
