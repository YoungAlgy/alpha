import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// Real "download my data" export. The settings page used to just
// JSON.stringify the client's in-memory onboarding state (localStorage) —
// that's a subset of what's actually stored (no saved letters, no usage
// signals) and isn't even a server round-trip, so a cleared browser or a
// different device produced an empty or stale export while the real
// public.users/public.issues rows were untouched. privacy/page.tsx promises
// "everything we have about you," so this endpoint reads that directly from
// the DB with the service role, scoped to the session's own user id.
export async function GET() {
  const sb = await supabaseServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  // Rate limit per user, not IP — same reasoning as account/profile: this is
  // an authed single-user read, so the abuse case is a scripted client, and
  // a generous cap is well above any real settings-page usage.
  const limited = rateLimit(`account-export:${user.id}`, { limit: 10, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  const svc = await supabaseServiceClient();

  const { data: profile, error: profileErr } = await svc
    .from("users")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (profileErr) {
    console.error("[account/export] profile fetch failed:", profileErr.message);
    return NextResponse.json({ error: "Couldn't build your export. Try again." }, { status: 500 });
  }

  // .limit() well above any realistic lifetime issue count (daily cadence,
  // ~365/year) so PostgREST's silent 1,000-row select cap fails loudly via a
  // future increase rather than silently truncating a long-tenured
  // subscriber's data export.
  const { data: issues, error: issuesErr } = await svc
    .from("issues")
    .select("*")
    .eq("user_id", user.id)
    .order("week_of", { ascending: true })
    .limit(5000);
  if (issuesErr) {
    console.error("[account/export] issues fetch failed:", issuesErr.message);
    return NextResponse.json({ error: "Couldn't build your export. Try again." }, { status: 500 });
  }

  return NextResponse.json({
    exported_at: new Date().toISOString(),
    profile,
    issues,
  });
}
