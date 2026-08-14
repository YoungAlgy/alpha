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

  // The delete path (lib/stripe-cancel.ts's deleteSupportTicketsBeforeDelete)
  // treats a subscriber's support tickets as their data to remove -- this
  // export must agree on what "the user's data" means, matching the same
  // privacy-page promise. Only tickets submitted while signed in ever carry
  // a real user_id (app/api/support/route.ts, fixed 2026-08-06); the
  // orphaned-by-email query below (alpha-drift-r28-08) closes the gap this
  // comment used to just flag -- a signed-out submission under this same
  // email is caught too now, not silently missing from the export.
  // alpha-drift-r18-01 (found+fixed 2026-08-07): the sibling issues query
  // above already guards against PostgREST's silent 1,000-row select cap
  // with an explicit .limit() well past any realistic count -- this query
  // had no such guard at all, so a subscriber who somehow filed more than
  // 1,000 support tickets would silently get a truncated export with no
  // indication anything was cut off. Vanishingly unlikely in practice
  // (support tickets aren't a daily-cadence table like issues), but the
  // fix costs nothing and keeps both queries in this file honest about the
  // same failure mode.
  const { data: supportTickets, error: supportErr } = await svc
    .from("support_tickets")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(5000);
  if (supportErr) {
    console.error("[account/export] support_tickets fetch failed:", supportErr.message);
    return NextResponse.json({ error: "Couldn't build your export. Try again." }, { status: 500 });
  }

  // alpha-drift-r28-08 (2026-08-15): the comment two blocks up already named
  // this exact gap ("anonymous submissions... won't appear here") without
  // closing it -- a ticket filed signed-out with this same email has
  // user_id permanently NULL (app/api/support/route.ts only links it when
  // the submitter happens to be signed in at that moment), so the query
  // above misses it even though it's genuinely this reader's own data.
  // Scoped to user_id IS NULL specifically so this can never surface
  // another real account's own already-linked ticket. Case-insensitive via
  // ilike on a wildcard-escaped value, same as the matching delete-side fix
  // in lib/stripe-cancel.ts's deleteSupportTicketsBeforeDelete.
  let orphanedSupportTickets: typeof supportTickets = [];
  if (user.email) {
    const escapedEmail = user.email.replace(/[\\%_]/g, "\\$&");
    const { data: orphaned, error: orphanedErr } = await svc
      .from("support_tickets")
      .select("*")
      .is("user_id", null)
      .ilike("email", escapedEmail)
      .order("created_at", { ascending: true })
      .limit(5000);
    if (orphanedErr) {
      console.error("[account/export] orphaned support_tickets fetch failed:", orphanedErr.message);
      return NextResponse.json({ error: "Couldn't build your export. Try again." }, { status: 500 });
    }
    orphanedSupportTickets = orphaned;
  }

  return NextResponse.json({
    exported_at: new Date().toISOString(),
    // alpha-drift-r18-01 (found+fixed 2026-08-07): app/privacy/page.tsx
    // promises "everything we have about you," but this export never read
    // Supabase Auth's OWN record at all -- separate from the public.users
    // profile row above, and the actual source of truth for sign-in history.
    // Already have it for free: `user` (fetched above to authenticate this
    // request in the first place) IS that record, just never included in
    // the response. Low practical impact today (this app never sets any
    // custom user_metadata), but the built-in fields (when the account was
    // created, when it last signed in, whether the email is confirmed) are
    // still real data about the reader that belongs in an "everything"
    // export regardless.
    auth: {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      last_sign_in_at: user.last_sign_in_at,
      email_confirmed_at: user.email_confirmed_at,
      user_metadata: user.user_metadata,
    },
    profile,
    issues,
    // Merged: tickets linked by id, plus any signed-out submission under
    // this same email that was never linked (see the comment above).
    // user_id IS NULL on the second set and this account's own id on the
    // first, so the two queries can never overlap -- no dedup needed.
    support_tickets: [...supportTickets, ...orphanedSupportTickets],
  });
}
