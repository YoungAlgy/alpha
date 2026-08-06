import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";

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
