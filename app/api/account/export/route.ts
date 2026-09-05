import { NextResponse } from "next/server";
import {
  AccountExportTooLargeError,
  fetchCompleteExportRows,
  normalizeAccountEmails,
} from "@/lib/account-privacy";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

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

  const mirrorEmail =
    profile &&
    typeof profile === "object" &&
    typeof (profile as { email?: unknown }).email === "string"
      ? (profile as { email: string }).email
      : null;
  // Auth is authoritative after a confirmed email change. The public mirror
  // remains included because signed-out support tickets can still carry the
  // older address while the mirror catches up.
  const exportEmails = normalizeAccountEmails(user.email, mirrorEmail);

  let issues: unknown[];
  let deliveryAttempts: unknown[];
  let suppressionEvents: unknown[];
  let supportTickets: unknown[];
  const orphanedSupportTickets: unknown[] = [];
  try {
    issues = await fetchCompleteExportRows(
      "issues",
      async (from, to) => {
        const result = await svc
          .from("issues")
          .select("*", { count: "exact" })
          .eq("user_id", user.id)
          .order("week_of", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to);
        return {
          data: result.data,
          count: result.count,
          error: result.error,
        };
      }
    );

    deliveryAttempts = await fetchCompleteExportRows(
      "delivery attempts",
      async (from, to) => {
        const result = await svc
          .from("resend_delivery_attempts")
          .select("*", { count: "exact" })
          .eq("user_id", user.id)
          .order("started_at", { ascending: true })
          .order("attempt_id", { ascending: true })
          .range(from, to);
        return {
          data: result.data,
          count: result.count,
          error: result.error,
        };
      }
    );

    suppressionEvents = await fetchCompleteExportRows(
      "Resend suppression events",
      async (from, to) => {
        const result = await svc
          .from("resend_webhook_events")
          .select("*", { count: "exact" })
          .eq("owner_user_id", user.id)
          .order("received_at", { ascending: true })
          .order("email_id", { ascending: true })
          .order("type", { ascending: true })
          .range(from, to);
        return {
          data: result.data,
          count: result.count,
          error: result.error,
        };
      }
    );

    supportTickets = await fetchCompleteExportRows(
      "support tickets linked to the account",
      async (from, to) => {
        const result = await svc
          .from("support_tickets")
          .select("*", { count: "exact" })
          .eq("user_id", user.id)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to);
        return {
          data: result.data,
          count: result.count,
          error: result.error,
        };
      }
    );

    // user_id IS NULL is deliberate. A ticket linked to another account is
    // never returned just because its email happens to match this account.
    for (const email of exportEmails) {
      const escapedEmail = escapeIlike(email);
      const ticketsForEmail = await fetchCompleteExportRows(
        "orphaned support tickets",
        async (from, to) => {
          const result = await svc
            .from("support_tickets")
            .select("*", { count: "exact" })
            .is("user_id", null)
            .ilike("email", escapedEmail)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
          return {
            data: result.data,
            count: result.count,
            error: result.error,
          };
        }
      );
      orphanedSupportTickets.push(...ticketsForEmail);
    }
  } catch (error) {
    if (error instanceof AccountExportTooLargeError) {
      console.warn("[account/export] bounded export limit reached:", error.message);
      return NextResponse.json(
        {
          error:
            "Your export is larger than the one-file limit. Contact support for a complete export.",
        },
        { status: 413 }
      );
    }
    console.error(
      "[account/export] paginated data fetch failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json({ error: "Couldn't build your export. Try again." }, { status: 500 });
  }

  return NextResponse.json(
    {
      exported_at: new Date().toISOString(),
      // Auth's record is included alongside the public profile. The built-in
      // fields are real account data and belong in an "everything" export.
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
      resend_delivery_attempts: deliveryAttempts,
      resend_suppression_events: suppressionEvents,
      // Merged: tickets linked by id, plus signed-out submissions under either
      // the current Auth email or the stale public mirror email. The two sets
      // cannot overlap because the second query requires user_id IS NULL.
      support_tickets: [...supportTickets, ...orphanedSupportTickets],
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
