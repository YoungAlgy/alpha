import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Self-serve "resume my letters" — the counterpart to one-click unsubscribe.
// Clears unsubscribed_at for the SIGNED-IN user so the weekly cron starts
// sending again. A reader who hit unsubscribe (often the inbox-provider's
// one-click button) while still paying could otherwise only get letters back by
// emailing support — a paying customer stuck receiving nothing. Auth'd to the
// session so a caller can only ever resume THEIR OWN account; the actual write
// goes through the service role (public.users has no self-UPDATE RLS policy,
// same as the unsubscribe + account-delete paths). Idempotent: clearing an
// already-null unsubscribed_at is a harmless no-op, and clearing it for a
// non-subscribed user does nothing (the cron still gates on active access).
export async function POST() {
  const sb = await supabaseServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
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
