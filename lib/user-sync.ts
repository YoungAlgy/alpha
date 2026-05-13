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

// Delete the authenticated user's row in public.users (cascades to public.issues
// via on-delete-cascade) and sign them out. Auth row in auth.users persists
// for V0 — owner can manually purge via service-role admin if needed.
export async function deleteUserAccount(): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured()) return { ok: true }; // localStorage-only path
  try {
    const sb = supabaseClient();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { ok: true };
    const { error } = await sb.from("users").delete().eq("id", session.user.id);
    if (error) return { ok: false, error: error.message };
    await sb.auth.signOut();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown" };
  }
}
