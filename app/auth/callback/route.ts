import { NextResponse } from "next/server";
import { supabaseServerClient } from "@/lib/supabase/server";

// Handles the magic-link callback. The link Supabase emails the user redirects
// here with a `code` query param. We exchange it for a session cookie, then
// continue to /inbox (or wherever `next` says).
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/inbox";

  if (!code) {
    return NextResponse.redirect(`${origin}/alpha/signin?error=missing_code`);
  }

  try {
    const supabase = await supabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(
        `${origin}/alpha/signin?error=${encodeURIComponent(error.message)}`
      );
    }
    return NextResponse.redirect(`${origin}/alpha${next.startsWith("/") ? next : "/" + next}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "auth failed";
    return NextResponse.redirect(`${origin}/alpha/signin?error=${encodeURIComponent(msg)}`);
  }
}
