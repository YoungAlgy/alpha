"use client";

import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { getSignupAccountState, type SignupAccountState } from "@/lib/signup-progress";
import { hasUsableReaderProfile } from "@/lib/reader-profile-state";

export interface OnboardingAccount {
  state: SignupAccountState | "signed-out";
  // The owner approved this account before its profile was saved. The normal
  // signup steps stay open, and /checkout saves the answers to the account.
  approvedIncomplete: boolean;
  email: string | null;
}

export async function readOnboardingAccount(): Promise<OnboardingAccount> {
  if (!supabaseConfigured()) return { state: "signed-out", approvedIncomplete: false, email: null };
  const sb = supabaseClient();
  const { data: { session }, error: authError } = await sb.auth.getSession();
  if (authError) throw new Error("Couldn't check your sign-in. Try again.");
  if (!session) return { state: "signed-out", approvedIncomplete: false, email: null };
  const { data: row, error } = await sb.from("users")
    .select("first_name, topics, birthday, subscribed_at, cancelled_at, access_requested_at, access_granted_at")
    .eq("id", session.user.id)
    .maybeSingle();
  if (error) throw new Error("Couldn't check your signup. Try again.");
  if (!row) {
    // A cached session can outlive a deleted account. Only a current auth
    // identity may resume the auth-only stage before its profile is created.
    const { data: { user }, error: identityError } = await sb.auth.getUser();
    if (identityError || !user || user.id !== session.user.id) {
      throw new Error("Couldn't verify your account. Please sign in again.");
    }
  }
  const state = getSignupAccountState(row);
  const approvedIncomplete = state === "reader" && !!row?.access_granted_at && !hasUsableReaderProfile(row);
  return {
    state: approvedIncomplete ? "incomplete" : state,
    approvedIncomplete,
    email: session.user.email ?? null,
  };
}

export async function readOnboardingAccountState(): Promise<SignupAccountState | "signed-out"> {
  return (await readOnboardingAccount()).state;
}
