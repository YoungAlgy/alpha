import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { cleanUpStripeCustomerBeforeDelete, deleteSupportTicketsBeforeDelete } from "@/lib/stripe-cancel";
import { hasActiveAccess, ADMIN_EMAIL } from "@/lib/access";
import { rateLimit } from "@/lib/rate-limit";
import { isFreeGrantEligible } from "@/lib/admin-users-guards";
import { isUserNotFoundError } from "@/lib/gotrue-errors";
import { removeResendSuppression } from "@/lib/email";

export const runtime = "nodejs";

interface Stats {
  totalUsers: number;
  paying: number;
  freeGranted: number;
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
  };
  const rows: StatsRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page } = await sb
      .from("users")
      .select("subscribed_at, cancelled_at, unsubscribed_at, stripe_customer_id")
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const stats = {
    totalUsers: rows.length,
    paying: 0,
    freeGranted: 0,
    cancelled: 0,
    unsubscribed: 0,
    notSubscribed: 0,
  };
  // Mutually exclusive buckets so the counts sum to totalUsers (the old
  // version double-counted a user who was both unsubscribed and paying).
  // Priority mirrors what the owner cares about most: opted out > cancelled >
  // paying > free > never-subscribed.
  for (const r of rows) {
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
  const { data: latestIssues } = await sb
    .from("issues")
    .select("week_of")
    .order("week_of", { ascending: false })
    .limit(1);
  const latestWeekOf = latestIssues?.[0]?.week_of ?? null;

  let latestIssueCount = 0;
  if (latestWeekOf) {
    const { count } = await sb
      .from("issues")
      .select("*", { count: "exact", head: true })
      .eq("week_of", latestWeekOf);
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

  // alpha-drift-r26-08 (2026-08-14): `before` used to reach the .lt() filter
  // below completely unvalidated -- a malformed value (?before=not-a-date)
  // reached Postgres as an invalid timestamp literal, which failed the
  // query and surfaced as a bare 500 "Couldn't load users. Try again."
  // instead of a clean 400 naming the actual problem. Low real exposure
  // (requireAdmin() gates this to one fixed trusted account, and the real
  // frontend always round-trips a genuine created_at value it already got
  // back from this same route), but a real gap on an otherwise carefully-
  // validated route -- and a clean error is cheap here regardless.
  if (before && Number.isNaN(new Date(before).getTime())) {
    return NextResponse.json({ error: "Invalid 'before' cursor." }, { status: 400 });
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
    // for an admin to even SEE it happened, let alone fix it. See the new
    // clear_suppression action below.
    .select("id, email, first_name, city, birthday, gender, theme, topics, stripe_customer_id, subscribed_at, cancelled_at, unsubscribed_at, bounced_at, complained_at, created_at")
    .order("created_at", { ascending: false });
  if (escapedQ) {
    usersQuery = usersQuery.ilike("email", `%${escapedQ}%`);
  } else if (before) {
    usersQuery = usersQuery.lt("created_at", before).limit(200);
  } else {
    usersQuery = usersQuery.limit(200);
  }

  const [{ data: users, error }, stats] = await Promise.all([
    usersQuery,
    gatherStats(),
  ]);

  if (error) {
    console.error("[admin/users] users query failed:", error.message);
    return NextResponse.json({ error: "Couldn't load users. Try again." }, { status: 500 });
  }
  return NextResponse.json({ users, stats });
}

const ActionBodySchema = z.object({
  action: z.enum(["delete", "grant_free", "revoke_free", "clear_suppression"]),
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

  const sb = await supabaseServiceClient();

  if (body.action === "delete") {
    // alpha-drift-r20-01 (found+fixed 2026-08-13): need the email BEFORE the
    // cascade-delete below removes it, to clear any Resend suppression-list
    // trace tied to it (see the removeResendSuppression call further down).
    // alpha-drift-r24-06 (2026-08-14): also select stripe_customer_id here
    // and pass it straight through to cleanUpStripeCustomerBeforeDelete --
    // it used to re-select the same row itself for that one column, a second
    // query for data this route was already fetching.
    //
    // alpha-drift-r26-01 (2026-08-14): this used to discard `error` from
    // maybeSingle() entirely, the same gap the GET handler above already
    // avoids (it checks error and logs+500s). A genuinely failed query
    // (connection blip, RLS hiccup -- resolves as {data:null, error:{...}},
    // never throws) then looked IDENTICAL to "this row doesn't exist" --
    // and combined with round 25's own `targetUser ? ... : null` fix below,
    // a failed pre-fetch was silently treated as "confirmed no Stripe
    // customer," so cleanUpStripeCustomerBeforeDelete skipped its cleanup
    // entirely while auth.admin.deleteUser() still deleted the account —
    // an active subscription left billing forever with zero log trail.
    // Checking error first and bailing before any destructive step closes
    // both the observability gap and that billing-leak path in one fix.
    const { data: targetUser, error: targetUserError } = await sb
      .from("users")
      .select("email, stripe_customer_id")
      .eq("id", body.userId)
      .maybeSingle();
    if (targetUserError) {
      console.error("[admin/users] delete: pre-fetch failed:", targetUserError.message);
      return NextResponse.json({ error: "Couldn't verify user before delete. Try again." }, { status: 500 });
    }
    // Cancel any Stripe subscription and delete the Customer object FIRST
    // (mirrors self-serve account/delete): deleting the auth user cascades
    // public.users away incl. stripe_customer_id, so a still-active sub
    // would bill forever with no way to stop it. Best-effort — a Stripe
    // hiccup must never block the admin delete.
    //
    // alpha-drift-r25-02 (2026-08-14): `targetUser?.stripe_customer_id`
    // collapsed TWO different situations to the same `undefined` value --
    // "the row has no stripe_customer_id" (a real answer) and "targetUser
    // itself is null because the row is already gone" (also a real answer,
    // per this SAME file's own alpha-drift-r17-02 comment: a stale admin
    // tab or a race with the user's own self-delete). Both should skip
    // cleanUpStripeCustomerBeforeDelete's internal re-lookup -- only a
    // genuinely omitted argument should trigger it. The ternary below makes
    // that explicit: a missing row passes `null` (a real "already checked,
    // nothing there" answer), never `undefined` (which reads as "caller
    // didn't pre-fetch this").
    await cleanUpStripeCustomerBeforeDelete(
      sb,
      body.userId,
      "[admin/delete]",
      undefined,
      targetUser ? targetUser.stripe_customer_id : null
    );
    // Same reasoning as self-serve account/delete: support_tickets.user_id is
    // ON DELETE SET NULL, not CASCADE, so skipping this would leave an
    // admin-initiated delete short of the "all associated data" promise on
    // the privacy page while self-serve deletes correctly clear it.
    await deleteSupportTicketsBeforeDelete(sb, body.userId, "[admin/delete]");
    // Same reasoning as self-serve account/delete: a real third-party
    // suppression record can outlive every Supabase trace otherwise.
    if (targetUser?.email) {
      await removeResendSuppression(targetUser.email);
    }
    // Delete the auth user — cascade removes their public.users + issues rows.
    const { error } = await sb.auth.admin.deleteUser(body.userId);
    if (error) {
      // alpha-drift-r17-02 (found+fixed 2026-08-07): the self-serve
      // account/delete route already treats a not-found error as success
      // (a race with a second click/tab hitting an already-deleted user) --
      // this identical deleteUser call site never got the same fix, so an
      // admin hit a scary generic 500 on a user that was, in fact, already
      // gone (e.g. a stale admin tab, or the user self-deleted moments
      // before the admin's click landed).
      if (isUserNotFoundError(error)) {
        console.warn(`[admin/users] deleteUser reported not-found for ${body.userId} — already deleted, treating as success`);
      } else {
        console.error("[admin/users] delete failed:", error.message);
        return NextResponse.json({ error: "Couldn't delete user. Try again." }, { status: 500 });
      }
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "grant_free") {
    // Don't let a comp grant clobber a REAL Stripe subscriber's cancellation
    // state (the cancelled_at: null below would un-cancel them in our mirror).
    // Mirror revoke_free's guard: refuse if they have a real Stripe customer —
    // a paying sub is managed in Stripe, never comped over.
    // alpha-drift-r26-01 (2026-08-14): check error before checking !existing --
    // otherwise a genuinely failed query (never throws, resolves as
    // {data:null, error:{...}}) reads as "user not found" with zero log trail.
    const { data: existing, error: existingError } = await sb
      .from("users")
      .select("stripe_customer_id, email")
      .eq("id", body.userId)
      .maybeSingle();
    if (existingError) {
      console.error("[admin/users] grant_free: pre-fetch failed:", existingError.message);
      return NextResponse.json({ error: "Couldn't verify user. Try again." }, { status: 500 });
    }
    // alpha-drift-r17-01 (found+fixed 2026-08-07): isFreeGrantEligible(undefined)
    // returns true (its whole contract is "no stripe_customer_id on file"), so
    // a userId that matches NO ROW AT ALL (deleted, stale id from another
    // admin tab) used to pass this guard the same as a genuinely free-grant-
    // eligible user -- the update below then matched zero rows (no error from
    // a 0-row update) and this route reported { ok: true } for a write that
    // never happened. Check existence explicitly first, as its own distinct
    // failure reason from "has a real Stripe subscription."
    if (!existing) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    if (!isFreeGrantEligible(existing.stripe_customer_id)) {
      return NextResponse.json(
        { error: "User has a real Stripe subscription. Manage in Stripe, don't comp." },
        { status: 400 }
      );
    }
    // Mark as subscribed without a Stripe customer. App checks subscribed_at.
    // Clear unsubscribed_at too: a comp grant is an explicit admin decision to
    // send letters, so it must re-consent a previously-opted-out user (mirrors
    // the paid checkout path) — otherwise re-comping an unsubscribed reader
    // would silently leave them dropped from every send. Clear
    // bounced_at/complained_at for the same reason (alpha-drift-r17-05,
    // same round) -- these are Resend delivery-suppression columns, and an
    // admin's explicit comp decision is exactly the same kind of re-consent
    // as a paid checkout, which lib/webhook-user-mutation.ts's
    // checkoutUserMutation clears them on -- an un-comped-then-recomped
    // reader must not stay permanently excluded from the cron's
    // `.is("bounced_at", null).is("complained_at", null)` filter.
    const { error } = await sb
      .from("users")
      .update({
        subscribed_at: new Date().toISOString(),
        cancelled_at: null,
        unsubscribed_at: null,
        bounced_at: null,
        complained_at: null,
      })
      .eq("id", body.userId);
    if (error) {
      console.error("[admin/users] grant_free failed:", error.message);
      return NextResponse.json({ error: "Couldn't grant free access. Try again." }, { status: 500 });
    }
    // alpha-drift-r17-06: this app's own bounced_at/complained_at columns
    // are only half the fix -- Resend maintains its own separate account-
    // level suppression list that also has to be cleared, or the cron
    // would keep calling sendLetterNotification for an "active" subscriber
    // Resend silently keeps skipping. Awaited (not fire-and-forget) so it
    // gets a real chance to complete before this handler returns; a
    // failure here never fails the grant itself (removeResendSuppression
    // already swallows and logs its own errors).
    if (existing.email) {
      await removeResendSuppression(existing.email);
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "revoke_free") {
    // Only revokes the free-grant flag — does NOT touch real Stripe subs.
    // Guard: only revoke if there's no stripe_customer_id (i.e., they were free-granted).
    // alpha-drift-r26-01 (2026-08-14): check error before checking !row, same
    // reasoning as grant_free above.
    const { data: row, error: rowError } = await sb
      .from("users")
      .select("stripe_customer_id")
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
    if (!isFreeGrantEligible(row.stripe_customer_id)) {
      return NextResponse.json(
        { error: "User has a real Stripe subscription. Manage in Stripe." },
        { status: 400 }
      );
    }
    const { error } = await sb
      .from("users")
      .update({ subscribed_at: null })
      .eq("id", body.userId);
    if (error) {
      console.error("[admin/users] revoke_free failed:", error.message);
      return NextResponse.json({ error: "Couldn't revoke free access. Try again." }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "clear_suppression") {
    // alpha-drift-r20-06 (found+fixed 2026-08-13): bounced_at/complained_at
    // (this app's DB flags) and Resend's own account-level suppression list
    // were ONLY ever cleared on a re-consent moment -- a fresh Stripe
    // checkout (lib/webhook-user-mutation.ts) or a first-time
    // signup/resubscribe-after-deletion (lib/engine/persist.ts, gated on
    // verificationType !== "magiclink"). A CONTINUOUSLY-subscribed reader
    // (never re-checks out, never gets deleted) who bounces or complains
    // mid-subscription -- e.g. a transient bounce on one day's send -- has
    // no such moment ahead of them: every later magic-link exchange for an
    // existing user resolves to "magiclink", so persist.ts's gate never
    // fires again, and grant_free (the only other clearer) explicitly
    // REFUSES to act on anyone with a real Stripe subscription. That left a
    // PAYING subscriber with literally no recovery path -- silently
    // excluded from every future send by the cron's own
    // .is("bounced_at", null).is("complained_at", null) filter, forever.
    // This is deliberately its own action, not folded into grant_free/
    // revoke_free: deliverability suppression is orthogonal to billing
    // state, so unlike those two, this one has NO isFreeGrantEligible gate
    // -- it must work on a real paying subscriber, which is exactly the
    // case those two can't touch.
    //
    // alpha-drift-r21-06 (found+fixed 2026-08-14, self-audit): this used to
    // clear the DB flags FIRST, then call removeResendSuppression after --
    // the daily cron's own eligibility filter (.is("bounced_at",
    // null).is("complained_at", null)) reads the DB directly, so the instant
    // that UPDATE committed, this reader became cron-eligible again even
    // though Resend's own suppression entry hadn't actually been removed
    // yet. A send landing in that window would be silently dropped by
    // Resend with nothing in this app's own tables ever showing it failed --
    // reintroducing, in a narrow window, the exact problem this action
    // exists to fix. Reordered to match the ALREADY-correct pattern
    // lib/engine/persist.ts uses (Resend cleared before any DB write): clear
    // Resend FIRST, and only clear the DB flags -- the thing the cron
    // actually reads -- once that's confirmed to have actually worked.
    // alpha-drift-r26-01 (2026-08-14): check error before checking !row, same
    // reasoning as grant_free/revoke_free above.
    const { data: row, error: rowError } = await sb
      .from("users")
      .select("email")
      .eq("id", body.userId)
      .maybeSingle();
    if (rowError) {
      console.error("[admin/users] clear_suppression: pre-fetch failed:", rowError.message);
      return NextResponse.json({ error: "Couldn't verify user. Try again." }, { status: 500 });
    }
    if (!row) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    if (row.email) {
      const cleared = await removeResendSuppression(row.email);
      if (!cleared) {
        console.error(`[admin/users] clear_suppression: removeResendSuppression failed for ${body.userId}, leaving DB flags untouched`);
        return NextResponse.json(
          { error: "Couldn't clear the Resend suppression. Left the DB flags untouched so the cron doesn't pick this reader up while Resend is still silently dropping their mail. Try again." },
          { status: 502 }
        );
      }
    }
    const { error } = await sb
      .from("users")
      .update({ bounced_at: null, complained_at: null })
      .eq("id", body.userId);
    if (error) {
      console.error("[admin/users] clear_suppression failed:", error.message);
      return NextResponse.json({ error: "Resend suppression cleared, but the DB update failed. Try again." }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
