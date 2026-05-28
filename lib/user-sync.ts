"use client";

import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
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
    const updates = {
      first_name: state.firstName ?? null,
      city: state.city ?? null,
      job_blurb: state.jobBlurb ?? null,
      project_blurb: state.projectBlurb ?? null,
      fun_blurb: state.funBlurb ?? null,
      theme: state.theme ?? "forest",
      topics: state.topics ?? [],
    };
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
