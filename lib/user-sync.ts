"use client";

import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { parseBirthday, coerceGender } from "@/lib/demographics";
import { isValidTopicId } from "@/lib/topics";
import type { OnboardingState } from "@/lib/onboarding-state";

// Fire-and-forget sync of an OnboardingState to the authenticated user's row
// in public.users. Runs only when Supabase is configured AND a session exists.
// Errors are warn-logged but never thrown.
//
// alpha-drift-r60-10 (2026-08-20, form-validation-consistency-audit-r5):
// `patch` is the ORIGINAL, unmerged object this specific update() call was
// given -- distinct from `state`, which is that patch already merged onto
// the freshest localStorage snapshot (lib/onboarding-state.ts's update()).
// Needed specifically to gate the topics write below: this function used to
// write `state.topics` unconditionally whenever present, with zero poolCap
// enforcement, unlike the other two write paths into this same column
// (app/api/account/topics/route.ts, and app/api/stripe/update-quantity+
// webhook, both fixed in rounds 58-59 for exactly this class of bug). Since
// `state` can carry a STALE, larger localStorage-cached pool from before a
// downgrade, ANY unrelated onboarding-state save (e.g. saving a profile
// field in Settings) would silently re-write that stale pool straight
// through the browser's own RLS-scoped client, clobbering a correctly-
// server-truncated pool back above the reader's current plan cap. Every
// legitimate topics-syncing caller already passes `{topics: picked}`
// explicitly right after a server-validated save (app/topics/page.tsx), so
// gating on "did THIS call's patch actually intend to touch topics" loses
// no real functionality while closing the stale-pool-resurrection gap.
export async function syncUserProfile(state: OnboardingState, patch: Partial<OnboardingState>): Promise<void> {
  if (!supabaseConfigured()) return;
  try {
    const sb = supabaseClient();
    // getUser() (not getSession()): this write goes straight to Postgres
    // via RLS, so the local-only cached session isn't enough. getUser()
    // round-trips to GoTrue and rejects a revoked session, the same
    // signOut()-then-still-usable-token gap every server route already
    // closes by calling getUser() instead of trusting a cached session.
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return; // unauth = no sync, localStorage is the source of truth
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
    // alpha-drift-r62-10 (2026-08-20, form-validation-consistency-audit-r7):
    // the 7 fields below used to read straight off `state` with no `patch`
    // gate -- the exact bug class r60-10 above fixed for `topics` alone.
    // `state` is the full merged-onto-localStorage snapshot, which can hold
    // values from a stale device: e.g. a reader edits city/birthday/gender
    // via Settings on one browser, then later opens Settings > Topics on a
    // SECOND device whose localStorage still has the pre-edit values --
    // that device's topics-only patch used to silently push its whole stale
    // snapshot back over the just-edited fields, with no error and no UI
    // signal. Gating each field on "did THIS call's patch actually intend
    // to touch it" (same two-part condition as topics: `"field" in patch`
    // AND the value is real) closes that without changing any real caller:
    // components/ProfileEditor.tsx's save() always sends all 7 keys, and
    // the pre-signup onboarding call sites never reach this branch at all
    // (no session yet).
    const updates: Record<string, string | string[]> = {};
    if ("firstName" in patch) {
      const fn = state.firstName?.trim();
      if (fn) updates.first_name = fn;
    }
    if ("city" in patch) {
      const city = state.city?.trim();
      if (city) updates.city = city;
    }
    if ("jobBlurb" in patch) {
      const jobBlurb = state.jobBlurb?.trim();
      if (jobBlurb) updates.job_blurb = jobBlurb;
    }
    if ("projectBlurb" in patch) {
      const projectBlurb = state.projectBlurb?.trim();
      if (projectBlurb) updates.project_blurb = projectBlurb;
    }
    if ("funBlurb" in patch) {
      const funBlurb = state.funBlurb?.trim();
      if (funBlurb) updates.fun_blurb = funBlurb;
    }
    if ("birthday" in patch) {
      const birthday = state.birthday?.trim();
      if (birthday && parseBirthday(birthday)) updates.birthday = birthday;
    }
    if ("gender" in patch) {
      const gender = coerceGender(state.gender);
      if (gender) updates.gender = gender;
    }
    if ("topics" in patch && Array.isArray(state.topics) && state.topics.length > 0) {
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
      .eq("id", user.id);
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
    // alpha-drift-r63-04 (2026-08-21, silent-catch-audit-r9, flagged as a
    // higher-impact sibling of the theme/page.tsx getSession fix): used to
    // discard `error` and return `{ ok: true }` on ANY falsy session,
    // including a genuine getSession() failure -- unlike a real "signed
    // out" result, which is harmless here, a failed CHECK used to report a
    // successful account deletion to the reader when nothing was deleted
    // (the /api/account/delete fetch below never even ran). Now only the
    // genuine no-error "signed out" case short-circuits as ok:true; a real
    // error is reported so the caller's `if (!result.ok) alert(...)` fires
    // instead of silently clearing local state and redirecting to
    // /welcome as if the (still billing, still-existing) account was gone.
    const { data: { session }, error: sessionErr } = await sb.auth.getSession();
    if (sessionErr) {
      return { ok: false, error: `Couldn't verify your session: ${sessionErr.message}` };
    }
    if (!session) return { ok: true };
    const res = await fetch("/api/account/delete", { method: "POST" });
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
