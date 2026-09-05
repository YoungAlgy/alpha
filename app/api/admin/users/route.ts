import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { hasActiveAccess, ADMIN_EMAIL } from "@/lib/access";
import { rateLimit } from "@/lib/rate-limit";
import { isFreeGrantEligible } from "@/lib/admin-users-guards";
import { isUserNotFoundError } from "@/lib/gotrue-errors";
import { isValidCalendarDate } from "@/lib/demographics";
import {
  isAccountDeletionBlockedBySuppressionRecovery,
  removeAccountAuthAndCompleteSaga,
  settleAccountDeletionBilling,
  settleAccountDeletionPrivacy,
} from "@/lib/account-deletion";
import { normalizeAccountEmails } from "@/lib/account-privacy";
import { MANUAL_PROVIDER_SUPPRESSION_REMOVAL_HOLD_MESSAGE } from "@/lib/suppression-recovery-policy";

export const runtime = "nodejs";

interface Stats {
  totalUsers: number;
  pendingRequests: number;
  paying: number;
  freeGranted: number;
  inviteGranted: number;
  cancelled: number;
  unsubscribed: number;
  notSubscribed: number;
  latestIssueWeekOf: string | null;
  latestIssueCount: number;
}

async function gatherStats(): Promise<Stats> {
  const sb = await supabaseServiceClient();

  // Paginated fetch, in-memory aggregation — small population, fine for V1.
  // Paginated (not a single unbounded select) because PostgREST silently
  // caps an unbounded select at 1,000 rows, which would start silently
  // undercounting every stat below once totalUsers passes that mark — same
  // bug class already fixed for alreadyDelivered/priorIssueCount in the cron.
  const PAGE_SIZE = 1000;
  type StatsRow = {
    subscribed_at: string | null;
    cancelled_at: string | null;
    unsubscribed_at: string | null;
    stripe_customer_id: string | null;
    access_requested_at: string | null;
    access_granted_at: string | null;
  };
  // alpha-drift-r60-08 (2026-08-20, silent-catch-audit-r6): all three reads
  // in this function used to discard `error` entirely. On a failure,
  // Supabase resolves rather than throws, so `page`/`latestIssues`/`count`
  // just came back undefined/null and every downstream stat silently
  // computed as 0 or truncated -- with the route still returning a normal
  // 200, misleading whoever reads this admin dashboard into treating a
  // query blip as real "paying: 0" business data. app/api/cron/weekly-
  // send/route.ts's own comment near its equivalent paginated fetch
  // ("Same fix, same reasoning as gatherStats()...") turned out to be
  // false as of the code that existed before this fix -- corrected below.
  // Throwing here (once logged) lets GET's own try/catch return the same
  // clean 500 JSON shape its sibling usersQuery error path already uses,
  // instead of a misleadingly-successful 200 with wrong numbers.
  const rows: StatsRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error: pageError } = await sb
      .from("users")
      .select("subscribed_at, cancelled_at, unsubscribed_at, stripe_customer_id, access_requested_at, access_granted_at")
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (pageError) {
      console.error("[admin/users] gatherStats users page fetch failed:", pageError.message);
      throw new Error(`gatherStats users page fetch failed: ${pageError.message}`);
    }
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const stats = {
    totalUsers: rows.length,
    pendingRequests: 0,
    paying: 0,
    freeGranted: 0,
    inviteGranted: 0,
    cancelled: 0,
    unsubscribed: 0,
    notSubscribed: 0,
  };
  // Mutually exclusive buckets so the counts sum to totalUsers (the old
  // version double-counted a user who was both unsubscribed and paying).
  // Priority mirrors what the owner cares about most: opted out > cancelled >
  // paying > free > never-subscribed.
  for (const r of rows) {
    if (r.access_requested_at && !r.access_granted_at) stats.pendingRequests++;
    // Invite access is an overlay. A reader can still have a paid period open
    // while their permanent invite is already recorded, so this count is
    // intentionally independent from the mutually exclusive billing buckets.
    if (r.access_granted_at) stats.inviteGranted++;
    if (r.unsubscribed_at) stats.unsubscribed++;
    // "cancelled" = actually churned (cancel date in the PAST). A FUTURE
    // cancelled_at is cancel-at-period-end: still paying, still getting
    // letters, so it falls through to the paying bucket — matches
    // hasActiveAccess, the single source of truth the cron + access gates use.
    else if (r.cancelled_at && !hasActiveAccess(r.cancelled_at)) stats.cancelled++;
    else if (r.subscribed_at && r.stripe_customer_id) stats.paying++;
    else if (r.subscribed_at && !r.stripe_customer_id) stats.freeGranted++;
    else stats.notSubscribed++;
  }

  // Latest issue snapshot — surfaces whether the weekly cron is running
  const { data: latestIssues, error: latestIssuesError } = await sb
    .from("issues")
    .select("week_of")
    .order("week_of", { ascending: false })
    .limit(1);
  if (latestIssuesError) {
    console.error("[admin/users] gatherStats latest-issue lookup failed:", latestIssuesError.message);
    throw new Error(`gatherStats latest-issue lookup failed: ${latestIssuesError.message}`);
  }
  const latestWeekOf = latestIssues?.[0]?.week_of ?? null;

  let latestIssueCount = 0;
  if (latestWeekOf) {
    const { count, error: countError } = await sb
      .from("issues")
      .select("*", { count: "exact", head: true })
      .eq("week_of", latestWeekOf);
    if (countError) {
      console.error("[admin/users] gatherStats issue count failed:", countError.message);
      throw new Error(`gatherStats issue count failed: ${countError.message}`);
    }
    latestIssueCount = count ?? 0;
  }

  return {
    ...stats,
    latestIssueWeekOf: latestWeekOf,
    latestIssueCount,
  };
}

async function requireAdmin(): Promise<
  { ok: true; userId: string } | { ok: false; res: NextResponse }
> {
  const sb = await supabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  }
  if (user.email !== ADMIN_EMAIL) {
    return { ok: false, res: NextResponse.json({ error: "Not authorized" }, { status: 403 }) };
  }
  return { ok: true, userId: user.id };
}

export async function GET(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.res;

  // alpha-drift-r18-01 (found+fixed 2026-08-07): unlike POST (below, 30/hour
  // per admin), this had zero rate limiting despite gatherStats() doing a
  // full paginated table scan on every single call -- requireAdmin() already
  // restricts this to one trusted account, so the risk isn't abuse from an
  // outsider, it's a runaway client (a buggy retry loop, an open admin tab
  // left auto-refreshing) hammering a full-table scan with no backstop at
  // all. A generous cap matching POST's own window.
  const listLimited = rateLimit(`admin-users-list:${gate.userId}`, { limit: 60, windowMs: 60 * 60 * 1000 });
  if (!listLimited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(listLimited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(listLimited.retryAfterSec) } }
    );
  }

  // Without q/before, the row list is capped at the newest 200 signups with no
  // way to reach anyone older — gatherStats() below still counts the whole
  // table correctly, but the actionable list would silently hide everyone else.
  // `q` searches every user by email regardless of the cap; `before` (a
  // created_at cursor) pages backwards through the same newest-first order so
  // the rest of the table stays reachable without one.
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const before = searchParams.get("before");
  const pending = searchParams.get("pending");
  if (pending !== null && pending !== "1") {
    return NextResponse.json({ error: "Invalid pending filter." }, { status: 400 });
  }
  if (pending === "1" && q) {
    return NextResponse.json(
      { error: "Pending requests and email search cannot be combined." },
      { status: 400 }
    );
  }

  // alpha-drift-r26-08 (2026-08-14): `before` used to reach the .lt() filter
  // below completely unvalidated -- a malformed value (?before=not-a-date)
  // reached Postgres as an invalid timestamp literal, which failed the
  // query and surfaced as a bare 500 "Couldn't load users. Try again."
  // instead of a clean 400 naming the actual problem. Low real exposure
  // (requireAdmin() gates this to one fixed trusted account, and the real
  // frontend always round-trips a genuine created_at value it already got
  // back from this same route), but a real gap on an otherwise carefully-
  // validated route -- and a clean error is cheap here regardless.
  //
  // alpha-drift-r27-01 (2026-08-14, self-audit): the NaN check alone was
  // the exact weak pattern this SAME round's own weekOf fix (lib/
  // demographics.ts's isValidCalendarDate) diagnosed and closed elsewhere --
  // JS's Date parser silently ROLLS OVER an impossible calendar date
  // instead of producing NaN, so "2026-04-31T00:00:00.000Z" passed this
  // guard (rolls over to May 1, a valid getTime()) and still reached
  // Postgres as an out-of-range literal, reproducing the exact bare-500
  // this fix was meant to prevent. `before` is a full timestamp, not the
  // bare "YYYY-MM-DD" shape isValidCalendarDateString expects, so this
  // pulls just the date prefix out and validates that against the same
  // isValidCalendarDate the weekOf fix uses, on top of the original NaN
  // check (which still catches shape-invalid input like "not-a-date").
  if (before) {
    const beforeDateMatch = before.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const beforeCalendarValid = !beforeDateMatch || isValidCalendarDate(+beforeDateMatch[1], +beforeDateMatch[2], +beforeDateMatch[3]);
    if (Number.isNaN(new Date(before).getTime()) || !beforeCalendarValid) {
      return NextResponse.json({ error: "Invalid 'before' cursor." }, { status: 400 });
    }
  }

  // alpha-drift-r26-08 (2026-08-14): `q` used to interpolate straight into
  // an ILIKE pattern with no escaping of ILIKE's own wildcard metacharacters
  // (% and _). Not a SQL-injection vector (the Supabase client parameterizes
  // the value) -- but a literal % or _ in the admin's search text was
  // silently treated as a pattern wildcard instead of a literal character,
  // e.g. searching for "a_b" would match "axb" too. Escaping both (and the
  // backslash escape character itself) makes the search match what the
  // admin actually typed.
  const escapedQ = q?.replace(/[\\%_]/g, "\\$&");

  // alpha-drift-r17-09 (found+fixed 2026-08-07): .limit(200) used to be
  // baked into the base query before branching on q/before -- PostgREST
  // combines every query-string param (filter + limit) into ONE SQL query,
  // so `email=ilike...&limit=200` really is "up to 200 of the MATCHING
  // rows," not "the 200 newest overall, then filtered" -- but that still
  // directly contradicted this route's own comment above ("q searches
  // every user by email regardless of the cap") and the frontend's
  // assumption (app/settings/accounts/page.tsx hides "Load more" during a
  // search because it assumes the results are always one complete page).
  // Once past 200 real matches, search silently truncated with no
  // indication or way to page through the rest. Only cap the two BROWSE
  // paths (plain newest-first list, and the `before`-cursor page-back) --
  // the search path relies on PostgREST's own default row cap (~1000) as
  // its backstop instead of an artificial 200, so it actually searches
  // "every user... regardless of the cap" the way the comment always said.
  const sb = await supabaseServiceClient();
  let usersQuery = sb
    .from("users")
    // alpha-drift-r20-06 (found+fixed 2026-08-13): bounced_at/complained_at
    // were never selected here, so a continuously-subscribed reader who
    // bounces or complains mid-subscription (a genuine Resend delivery-
    // suppression event, not a billing change) was invisible in this list --
    // silently excluded from every future send by the cron's own
    // .is("bounced_at", null).is("complained_at", null) filter with no way
    // for an admin to even SEE it happened. The panel keeps the delivery
    // review state visible while provider recovery is held.
    .select("id, email, first_name, city, birthday, gender, theme, topics, stripe_customer_id, subscribed_at, access_requested_at, access_granted_at, cancelled_at, unsubscribed_at, bounced_at, complained_at, suppression_cleanup_pending_at, suppression_recovery_started_at, created_at");
  if (escapedQ) {
    usersQuery = usersQuery
      .ilike("email", `%${escapedQ}%`)
      .order("created_at", { ascending: false });
  } else if (pending === "1") {
    usersQuery = usersQuery
      .not("access_requested_at", "is", null)
      .is("access_granted_at", null)
      .order("access_requested_at", { ascending: false });
    if (before) usersQuery = usersQuery.lt("access_requested_at", before);
    usersQuery = usersQuery.limit(200);
  } else if (before) {
    usersQuery = usersQuery
      .lt("created_at", before)
      .order("created_at", { ascending: false })
      .limit(200);
  } else {
    usersQuery = usersQuery.order("created_at", { ascending: false }).limit(200);
  }

  // alpha-drift-r61-01 (2026-08-20, self-audit-r60): round 60's own
  // gatherStats()-throws fix (alpha-drift-r60-08) combined the two reads in
  // one Promise.all -- Promise.all rejects the WHOLE call the instant
  // EITHER promise rejects, discarding an already-successful (or about-to-
  // succeed) usersQuery result along with the failed stats. Before round
  // 60, gatherStats() never threw, so this always returned 200 with the
  // real user list even when stats came back wrong; round 60 traded that
  // for "the entire admin dashboard, including the Grant/Revoke/Delete/
  // delivery-review state an admin might urgently need during exactly this
  // kind of DB blip, goes fully blank" on any transient stats-
  // side failure. Promise.allSettled decouples them: a stats failure is
  // still logged (round 60's real improvement, kept), but a working user
  // list is never thrown away over it. stats: null signals "unavailable"
  // to the frontend, which already renders that gracefully (app/settings/
  // accounts/page.tsx's `{stats && (...)}` gate) -- the row list and every
  // action button still work normally.
  const [usersSettled, statsSettled] = await Promise.allSettled([usersQuery, gatherStats()]);
  if (usersSettled.status === "rejected") {
    // Supabase-js resolves query errors rather than rejecting -- this
    // shouldn't happen in practice, but handled defensively rather than
    // left to bubble into a raw 500.
    console.error("[admin/users] users query threw unexpectedly:", usersSettled.reason instanceof Error ? usersSettled.reason.message : usersSettled.reason);
    return NextResponse.json({ error: "Couldn't load users. Try again." }, { status: 500 });
  }
  const { data: users, error } = usersSettled.value;
  if (error) {
    console.error("[admin/users] users query failed:", error.message);
    return NextResponse.json({ error: "Couldn't load users. Try again." }, { status: 500 });
  }
  let stats: Stats | null = null;
  if (statsSettled.status === "fulfilled") {
    stats = statsSettled.value;
  } else {
    console.error("[admin/users] gatherStats failed:", statsSettled.reason instanceof Error ? statsSettled.reason.message : statsSettled.reason);
  }
  return NextResponse.json({ users, stats });
}

const ActionBodySchema = z.object({
  action: z.enum([
    "delete",
    "grant_free",
    "revoke_free",
    "grant_invite",
    "revoke_invite",
    "deny_access",
    "clear_suppression",
  ]),
  userId: z.string().uuid(),
});
type ActionBody = z.infer<typeof ActionBodySchema>;

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.res;

  // Speed bump against bulk damage (mass delete/grant/revoke) from a
  // compromised admin session — the account itself is trusted, but a
  // hijacked session shouldn't be able to script through the whole table
  // instantly. Keyed on the admin's user id, not IP, since ADMIN_EMAIL is a
  // single fixed account.
  const limited = rateLimit(`admin-users-action:${gate.userId}`, { limit: 30, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many admin actions. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  let body: ActionBody;
  try {
    const raw = await req.json();
    body = ActionBodySchema.parse(raw);
  } catch (e) {
    const message =
      e instanceof z.ZodError
        ? `Invalid input: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        : "Invalid JSON";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (body.action === "clear_suppression") {
    return NextResponse.json(
      {
        error: MANUAL_PROVIDER_SUPPRESSION_REMOVAL_HOLD_MESSAGE,
        code: "manual_recovery_disabled",
      },
      { status: 409 }
    );
  }

  const sb = await supabaseServiceClient();

  if (body.action === "delete") {
    // Keep confirmed emails only for app-owned support cleanup. Deletion
    // preserves provider-side do-not-email blocks.
    // The deletion saga independently locks the current public.users billing
    // ids and every related staged checkout before it touches Stripe.
    const { data: targetUser, error: targetUserError } = await sb
      .from("users")
      .select("email")
      .eq("id", body.userId)
      .maybeSingle();
    if (targetUserError) {
      console.error("[admin/users] delete: pre-fetch failed:", targetUserError.message);
      return NextResponse.json({ error: "Couldn't verify user before delete. Try again." }, { status: 500 });
    }
    const { data: targetAuth, error: targetAuthError } =
      await sb.auth.admin.getUserById(body.userId);
    if (targetAuthError && !isUserNotFoundError(targetAuthError)) {
      console.error("[admin/users] delete: Auth identity lookup failed:", targetAuthError.message);
      return NextResponse.json(
        { error: "Couldn't verify user before delete. Try again." },
        { status: 503 }
      );
    }
    // Auth is authoritative after a confirmed email change. Keep the public
    // mirror too because an orphaned support ticket may still
    // carry the older address.
    const cleanupEmails = normalizeAccountEmails(
      targetAuth?.user?.email,
      targetUser?.email
    );
    let deletionState:
      | "prepared"
      | "billing_clean"
      | "auth_delete_started"
      | "complete";
    try {
      deletionState = await settleAccountDeletionBilling(sb, body.userId);
    } catch (billingError) {
      if (isAccountDeletionBlockedBySuppressionRecovery(billingError)) {
        console.warn(
          `[admin/users] delete: reviewed delivery recovery blocks deletion for ${body.userId}; account left intact`
        );
        return NextResponse.json(
          {
            error:
              "Account deletion is blocked until the reviewed delivery recovery is settled. The account is still intact.",
          },
          { status: 409 }
        );
      }
      console.error(
        `[admin/users] delete: exact Alpha billing cleanup was not confirmed for ${body.userId}; Auth left intact:`,
        billingError instanceof Error ? billingError.message : billingError
      );
      return NextResponse.json(
        {
          error:
            "Couldn't safely finish this user's billing cleanup. Nothing was deleted. Try again.",
        },
        { status: 503 }
      );
    }

    if (
      cleanupEmails.length === 0 &&
      deletionState !== "auth_delete_started" &&
      deletionState !== "complete"
    ) {
      console.error(
        `[admin/users] delete: no confirmed email remained for required privacy cleanup for ${body.userId}`
      );
      return NextResponse.json(
        { error: "Couldn't verify the user's email. Nothing was deleted." },
        { status: 503 }
      );
    }
    if (
      cleanupEmails.length > 0 &&
      deletionState !== "auth_delete_started" &&
      deletionState !== "complete"
    ) {
      try {
        await settleAccountDeletionPrivacy(
          sb,
          body.userId,
          cleanupEmails
        );
      } catch (privacyError) {
        console.error(
          `[admin/users] delete: required privacy cleanup was not confirmed for ${body.userId}; Auth left intact:`,
          privacyError instanceof Error ? privacyError.message : privacyError
        );
        return NextResponse.json(
          {
          error:
            "Couldn't finish deleting support data. The user account is still intact. Try again.",
          },
          { status: 503 }
        );
      }
    }

    try {
      const deleteAuthUser = async () => {
        const { error } = await sb.auth.admin.deleteUser(body.userId);
        if (!error) return;
        if (isUserNotFoundError(error)) {
          console.warn(`[admin/users] deleteUser reported not-found for ${body.userId} — already deleted, treating as success`);
          return;
        }
        throw error;
      };
      if (deletionState === "complete") {
        await deleteAuthUser();
      } else {
        await removeAccountAuthAndCompleteSaga(sb, body.userId, deleteAuthUser);
      }
    } catch (authError) {
      console.error(
        `[admin/users] delete: Auth removal or durable saga completion failed for ${body.userId}:`,
        authError instanceof Error ? authError.message : authError
      );
      return NextResponse.json(
        { error: "Account deletion is still in progress. Try again." },
        { status: 503 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "deny_access") {
    const { data: existing, error: existingError } = await sb
      .from("users")
      .select("access_requested_at, access_granted_at")
      .eq("id", body.userId)
      .maybeSingle();
    if (existingError) {
      console.error("[admin/users] deny_access pre-fetch failed");
      return NextResponse.json(
        { error: "Couldn't verify the access request. Try again." },
        { status: 500 }
      );
    }
    if (!existing) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    if (existing.access_granted_at) {
      return NextResponse.json(
        { error: "This account already has invite access. Revoke that access separately." },
        { status: 409 }
      );
    }
    if (!existing.access_requested_at) {
      return NextResponse.json({ ok: true, alreadyDenied: true });
    }
    const { data: updated, error } = await sb
      .from("users")
      .update({ access_requested_at: null })
      .eq("id", body.userId)
      .eq("access_requested_at", existing.access_requested_at)
      .is("access_granted_at", null)
      .select("id");
    if (error) {
      console.error("[admin/users] deny_access failed");
      return NextResponse.json(
        { error: "Couldn't deny the access request. Try again." },
        { status: 500 }
      );
    }
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        { error: "The request changed while it was being reviewed. Refresh and try again." },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "grant_invite" || body.action === "revoke_invite") {
    // A Stripe-linked reader can be moved onto permanent invite access without
    // rewriting any billing field. cancelled_at remains the provider mirror,
    // which means renewal cancellation and terminal events keep their exact
    // meaning. The protected access_granted_at marker is the separate invite
    // entitlement consumed by reader and delivery gates.
    const { data: existing, error: existingError } = await sb
      .from("users")
      .select(
        "stripe_customer_id, subscribed_at, access_requested_at, access_granted_at"
      )
      .eq("id", body.userId)
      .maybeSingle();
    if (existingError) {
      console.error("[admin/users] invite access pre-fetch failed");
      return NextResponse.json(
        { error: "Couldn't verify user. Try again." },
        { status: 500 }
      );
    }
    if (!existing) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    if (!existing.stripe_customer_id) {
      return NextResponse.json(
        {
          error:
            body.action === "grant_invite"
              ? "Use Grant free for a reader with no Stripe account."
              : "Use Revoke free for a reader with no Stripe account.",
        },
        { status: 400 }
      );
    }
    if (body.action === "grant_invite") {
      if (!existing.subscribed_at) {
        return NextResponse.json(
          {
            error:
              "This Stripe-linked account has no local access stamp. Review its exact billing state before granting invite access.",
          },
          { status: 409 }
        );
      }
      if (existing.access_granted_at) {
        if (!existing.access_requested_at) {
          return NextResponse.json({ ok: true, alreadyGranted: true });
        }
        const { data: reviewed, error: reviewError } = await sb
          .from("users")
          .update({ access_requested_at: null })
          .eq("id", body.userId)
          .eq("stripe_customer_id", existing.stripe_customer_id)
          .eq("subscribed_at", existing.subscribed_at)
          .eq("access_requested_at", existing.access_requested_at)
          .eq("access_granted_at", existing.access_granted_at)
          .select("id");
        if (reviewError || !reviewed || reviewed.length === 0) {
          return NextResponse.json(
            { error: "The account changed while its request was being reviewed. Refresh and try again." },
            { status: reviewError ? 500 : 409 }
          );
        }
        return NextResponse.json({ ok: true, alreadyGranted: true });
      }
      const grantedAt = new Date().toISOString();
      let grant = sb
        .from("users")
        .update({ access_requested_at: null, access_granted_at: grantedAt })
        .eq("id", body.userId)
        .eq("stripe_customer_id", existing.stripe_customer_id)
        .eq("subscribed_at", existing.subscribed_at);
      grant = existing.access_requested_at
        ? grant.eq("access_requested_at", existing.access_requested_at)
        : grant.is("access_requested_at", null);
      const { data: updated, error } = await grant
        .is("access_granted_at", null)
        .select("id");
      if (error) {
        console.error("[admin/users] grant_invite failed");
        return NextResponse.json(
          { error: "Couldn't grant invite access. Try again." },
          { status: 500 }
        );
      }
      if (!updated || updated.length === 0) {
        return NextResponse.json(
          { error: "The account changed while access was being granted. Refresh and try again." },
          { status: 409 }
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (!existing.access_granted_at) {
      return NextResponse.json({ ok: true, alreadyRevoked: true });
    }
    let revoke = sb
      .from("users")
      .update({ access_requested_at: null, access_granted_at: null })
      .eq("id", body.userId)
      .eq("stripe_customer_id", existing.stripe_customer_id)
      .eq("access_granted_at", existing.access_granted_at);
    revoke = existing.access_requested_at
      ? revoke.eq("access_requested_at", existing.access_requested_at)
      : revoke.is("access_requested_at", null);
    const { data: updated, error } = await revoke
      .select("id");
    if (error) {
      console.error("[admin/users] revoke_invite failed");
      return NextResponse.json(
        { error: "Couldn't revoke invite access. Try again." },
        { status: 500 }
      );
    }
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        { error: "The account changed while access was being revoked. Refresh and try again." },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "grant_free") {
    const { data: existing, error: existingError } = await sb
      .from("users")
      .select(
        "email, stripe_customer_id, stripe_subscription_id, subscribed_at, cancelled_at, access_requested_at, access_granted_at, unsubscribed_at, bounced_at, complained_at, suppression_cleanup_pending_at, delivery_suppression_cleared_at"
      )
      .eq("id", body.userId)
      .maybeSingle();
    if (existingError) {
      console.error("[admin/users] grant_free: pre-fetch failed:", existingError.message);
      return NextResponse.json({ error: "Couldn't verify user. Try again." }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    const normalizedEmail = existing.email?.toLowerCase().trim();
    if (!normalizedEmail || normalizedEmail !== existing.email) {
      return NextResponse.json(
        { error: "Repair this account's canonical email before granting access." },
        { status: 409 }
      );
    }
    if (
      !isFreeGrantEligible(existing.stripe_customer_id) ||
      existing.stripe_subscription_id
    ) {
      return NextResponse.json(
        {
          error:
            "User has a Stripe billing binding. Review the exact Customer and Subscription instead of granting free access.",
        },
        { status: 400 }
      );
    }

    // Access approval is independent from delivery policy. Do not clear an
    // unsubscribe, bounce, complaint, pending cleanup, or causal watermark
    // here. Manual provider suppression removal remains on a safety hold.
    const grantedAt = new Date().toISOString();
    let grant = sb
      .from("users")
      .update({
        subscribed_at: grantedAt,
        access_requested_at: null,
        access_granted_at: grantedAt,
        cancelled_at: null,
      })
      .eq("id", body.userId)
      .eq("email", existing.email)
      .is("stripe_customer_id", null)
      .is("stripe_subscription_id", null);
    grant = existing.subscribed_at
      ? grant.eq("subscribed_at", existing.subscribed_at)
      : grant.is("subscribed_at", null);
    grant = existing.cancelled_at
      ? grant.eq("cancelled_at", existing.cancelled_at)
      : grant.is("cancelled_at", null);
    grant = existing.access_requested_at
      ? grant.eq("access_requested_at", existing.access_requested_at)
      : grant.is("access_requested_at", null);
    grant = existing.access_granted_at
      ? grant.eq("access_granted_at", existing.access_granted_at)
      : grant.is("access_granted_at", null);
    grant = existing.unsubscribed_at
      ? grant.eq("unsubscribed_at", existing.unsubscribed_at)
      : grant.is("unsubscribed_at", null);
    grant = existing.bounced_at
      ? grant.eq("bounced_at", existing.bounced_at)
      : grant.is("bounced_at", null);
    grant = existing.complained_at
      ? grant.eq("complained_at", existing.complained_at)
      : grant.is("complained_at", null);
    grant = existing.suppression_cleanup_pending_at
      ? grant.eq(
          "suppression_cleanup_pending_at",
          existing.suppression_cleanup_pending_at
        )
      : grant.is("suppression_cleanup_pending_at", null);
    grant = existing.delivery_suppression_cleared_at
      ? grant.eq(
          "delivery_suppression_cleared_at",
          existing.delivery_suppression_cleared_at
        )
      : grant.is("delivery_suppression_cleared_at", null);
    const { error, data: updated } = await grant
      .select("id");
    if (error) {
      console.error("[admin/users] grant_free failed:", error.message);
      return NextResponse.json({ error: "Couldn't grant free access. Try again." }, { status: 500 });
    }
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        {
          error:
            "The account changed while access was being granted. Refresh and review it before retrying.",
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true });
  }

  if (body.action === "revoke_free") {
    // Only revokes the free-grant flag — does NOT touch real Stripe bindings.
    // Guard both IDs so an incomplete legacy binding cannot be treated as a comp.
    // alpha-drift-r26-01 (2026-08-14): check error before checking !row, same
    // reasoning as grant_free above.
    const { data: row, error: rowError } = await sb
      .from("users")
      .select(
        "stripe_customer_id, stripe_subscription_id, access_requested_at, subscribed_at, access_granted_at, cancelled_at"
      )
      .eq("id", body.userId)
      .maybeSingle();
    if (rowError) {
      console.error("[admin/users] revoke_free: pre-fetch failed:", rowError.message);
      return NextResponse.json({ error: "Couldn't verify user. Try again." }, { status: 500 });
    }
    // alpha-drift-r17-01: same missing-row check as grant_free above.
    if (!row) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    if (!isFreeGrantEligible(row.stripe_customer_id) || row.stripe_subscription_id) {
      return NextResponse.json(
        { error: "User has a Stripe billing binding. Review it before revoking free access." },
        { status: 400 }
      );
    }
    // alpha-drift-r32-01 (2026-08-14): same race as grant_free above -- fold
    // the eligibility re-check into the UPDATE's WHERE so a Stripe binding
    // that lands between the pre-fetch and this write can't get silently
    // un-comped (revoke_free would otherwise blow away a now-real paid
    // subscription's subscribed_at). .select("id") detects the lost race.
    // Revoking a comp must close read access immediately as well as stop
    // future sends. Archive and tokenized-letter gates use cancelled_at,
    // while the cron uses subscribed_at, so write both in the same atomic
    // UPDATE. Clearing only subscribed_at left every already-created issue
    // readable indefinitely because hasActiveAccess(null) is true.
    const revokedAt = new Date().toISOString();
    let revoke = sb
      .from("users")
      .update({
        subscribed_at: null,
        access_requested_at: null,
        access_granted_at: null,
        cancelled_at: revokedAt,
      })
      .eq("id", body.userId);
    revoke = row.access_requested_at
      ? revoke.eq("access_requested_at", row.access_requested_at)
      : revoke.is("access_requested_at", null);
    revoke = row.subscribed_at
      ? revoke.eq("subscribed_at", row.subscribed_at)
      : revoke.is("subscribed_at", null);
    revoke = row.access_granted_at
      ? revoke.eq("access_granted_at", row.access_granted_at)
      : revoke.is("access_granted_at", null);
    revoke = row.cancelled_at
      ? revoke.eq("cancelled_at", row.cancelled_at)
      : revoke.is("cancelled_at", null);
    const { error, data: updated } = await revoke
      .is("stripe_customer_id", null)
      .is("stripe_subscription_id", null)
      .select("id");
    if (error) {
      console.error("[admin/users] revoke_free failed:", error.message);
      return NextResponse.json({ error: "Couldn't revoke free access. Try again." }, { status: 500 });
    }
    if (!updated || updated.length === 0) {
      console.error(`[admin/users] revoke_free: lost race, access or billing changed between pre-fetch and update for ${body.userId}`);
      return NextResponse.json(
        { error: "This user's access or billing changed. Refresh and review it instead." },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
