"use client";

import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { getSignupAccountState, type SignupAccountState } from "@/lib/signup-progress";

export async function readOnboardingAccountState(): Promise<SignupAccountState | "signed-out"> {
  if (!supabaseConfigured()) return "signed-out";
  const sb = supabaseClient();
  const { data: { session }, error: authError } = await sb.auth.getSession();
  if (authError) throw new Error("Couldn't check your sign-in. Try again.");
  if (!session) return "signed-out";
  const { data: row, error } = await sb.from("users")
    .select("subscribed_at, cancelled_at, access_requested_at, access_granted_at")
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
  return getSignupAccountState(row);
}
