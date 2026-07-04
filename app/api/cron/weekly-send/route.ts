import { NextResponse, after } from "next/server";
import crypto from "crypto";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { generateIssue } from "@/lib/engine/assemble";
import { poolCap } from "@/lib/engine/select-sections";
import { sendLetterNotification, resendConfigured, sendOpsAlert } from "@/lib/email";
import { letterUrl as buildLetterUrl } from "@/lib/letter-token";
import { currentPeriodIso, sinceLastSendWindow } from "@/lib/cadence";
import { braveRateLimitedCount } from "@/lib/brave";
import { topicLabel, mapTopicsForUser } from "@/lib/topics";
import { withDeadline } from "@/lib/with-deadline";
import type { UserProfile, TopicId } from "@/lib/types";
import { clampQuota } from "@/lib/types";
import { coerceGender } from "@/lib/demographics";
import { coerceThemeId } from "@/lib/themes";

export const runtime = "nodejs";
export const maxDuration = 800; // Vercel Pro cap

// Constant-time bearer-token check (avoids the timing side-channel of `===`
// on a secret; CWE-208). Hash both sides to equal length so timingSafeEqual
// never throws on length mismatch.
function bearerMatches(authHeader: string | null, expected: string): boolean {
  if (!authHeader) return false;
  const a = crypto.createHash("sha256").update(authHeader).digest();
  const b = crypto.createHash("sha256").update(`Bearer ${expected}`).digest();
  return crypto.timingSafeEqual(a, b);
}

// Hard per-subscriber generation deadline. generateIssue's own I/O is already
// bounded (Anthropic 60s, Brave 5s, deep-read 7s each), but this is a backstop
// so one pathologically slow user can't consume the whole cron budget and
// starve every later subscriber that send. On timeout the per-user catch counts
// it failed and the loop moves on (the underlying work keeps running detached
// but is self-bounded, so it can't leak indefinitely). withDeadline is the
// shared helper (also used by the onboarding /api/generate route).
const PER_USER_DEADLINE_MS = 110_000;

// Bounds the persist-and-send tail (issue upsert, delivered_at claim, the
// Resend send, and its rollback-on-failure) that runs after generateIssue
// succeeds. Before this, that tail had NO timeout at all — a genuinely hung
// Supabase or Resend call would park the whole per-subscriber loop until
// Vercel's hard maxDuration kill, silently dropping every later subscriber in
// the same run with no ops alert (that code never runs after a kill). Safe to
// bound: withDeadline only stops WAITING, it doesn't cancel the underlying
// call, so the detached continuation (including the send-failure rollback)
// still runs to completion in the background regardless of whether this
// timeout fires — a slow-but-eventually-successful send still lands and its
// delivered_at claim stays correctly set, so this can't cause a duplicate
// email on the next run's retry. Generous relative to normal latency (a
// couple of Supabase round trips + one Resend call), tight relative to
// CRON_SAFETY_MARGIN_MS below (110s generation + 45s here = 155s max real
// per-subscriber time, under the 170s reserved).
const PERSIST_AND_SEND_DEADLINE_MS = 45_000;

// Time-budget safety valve. The loop below is sequential (topic-blurb caching
// is what bounds cost, not parallelism), so at enough subscribers a run of
// near-deadline generations can approach the 800s maxDuration cap. Reserve
// enough of it to (a) let the LAST subscriber we DO start run its full
// PER_USER_DEADLINE_MS before we'd hit the wall, and (b) leave real margin
// after that for the summary + ops-alert email. Past this point, remaining
// subscribers are DEFERRED (recorded, not attempted) rather than risking a
// Vercel hard-kill mid-loop — which would silently truncate the send with no
// ops alert (that code never runs after a kill) and no auto-resume (tomorrow's
// cron computes a NEW weekOf, so it never revisits today's unprocessed tail).
// This is an interim safety net, not the full fix (chunked sends via a cursor
// param + multiple cron slots) — sufficient at the current subscriber count,
// revisit if the list grows enough to actually hit it in practice.
const CRON_SAFETY_MARGIN_MS = PER_USER_DEADLINE_MS + 60_000;
const CRON_TIME_BUDGET_MS = maxDuration * 1000 - CRON_SAFETY_MARGIN_MS;

interface SubscriberRow {
  id: string;
  email: string;
  first_name: string | null;
  city: string | null;
  job_blurb: string | null;
  project_blurb: string | null;
  fun_blurb: string | null;
  birthday: string | null;
  gender: string | null;
  theme: string | null;
  topics: string[] | null;
  topic_quota: number | null;
}

// Daily send entrypoint (every day since 2026-07-03; previously Sun/Tue/Thu).
// Vercel Cron sends an
// Authorization header of `Bearer ${CRON_SECRET}` automatically when the env
// var is set. We refuse anything else, so this can't be hit from the open web.
//
// Behavior:
//   1. Find all users where subscribed_at IS NOT NULL AND access is still live
//      (cancelled_at IS NULL or still in the future) AND unsubscribed_at IS NULL
//   2. For each, generate this send's Issue via the same engine /api/generate
//      uses (Brave + Claude + per-topic cache), persist via upsert on (user_id,
//      week_of), and send the letter email via Resend. The `week_of` column now
//      holds the SEND DATE (one row per send), so each daily letter is its
//      own period: distinct idempotency key, distinct blurb cache, no collision.
//   3. The live search uses a "since the last send" window, so a topic with no
//      NEW info that period comes back empty and the ranked-pool selector
//      backfills it from a fresher topic instead of repeating stale news.
//   4. Topic blurbs are cached per (topic_id, send_date) so the first user pays
//      the Claude cost and the rest reuse — order-of-N-topics calls, not
//      N-users × N-topics.
//   5. Per-user failures are caught and counted; the cron always returns 200
//      so Vercel doesn't keep retrying — failures surface in the response
//      summary and runtime logs.
export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  const auth = req.headers.get("authorization");
  if (!expected || !bearerMatches(auth, expected)) {
    console.warn("[cron/weekly-send] unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Allow ?weekOf=YYYY-MM-DD override (useful for backfills + admin testing
  // when the schedule hasn't fired yet). Defaults to today (the send date).
  // CRON: a SINGLE Vercel cron drives every send, "0 14 * * *" (14:00 UTC,
  // daily). It must be one entry: Vercel keys cron jobs by path, so an earlier
  // attempt at multiple entries differing only by a ?slot=... query collapsed
  // to one job and a scheduled send never fired. The handler derives the
  // period from today's date, so one schedule covers every send day.
  const url = new URL(req.url);
  const weekOfOverride = url.searchParams.get("weekOf");
  const weekOf =
    weekOfOverride && /^\d{4}-\d{2}-\d{2}$/.test(weekOfOverride)
      ? weekOfOverride
      : currentPeriodIso();
  // Search window for this send: everything new since the previous send, which
  // at daily cadence is always exactly 1 day back. A topic with nothing new in
  // that window reads as empty and gets backfilled.
  const freshness = sinceLastSendWindow(weekOf);
  const sb = await supabaseServiceClient();

  // Access runs through the end of the paid period. The webhook stores
  // cancelled_at as the date access ENDS, so a *future* cancelled_at means
  // "cancel-at-period-end scheduled but still paid up" — those readers must
  // keep getting letters. Only exclude null-or-future... i.e. include
  // (cancelled_at IS NULL OR cancelled_at > now). The old `.is(cancelled_at,
  // null)` cut these paying customers off weeks early. Mirrors
  // lib/access.hasActiveAccess().
  const nowIso = new Date().toISOString();
  const { data: subscribers, error } = await sb
    .from("users")
    .select(
      "id, email, first_name, city, job_blurb, project_blurb, fun_blurb, birthday, gender, theme, topics, topic_quota"
    )
    .not("subscribed_at", "is", null)
    .or(`cancelled_at.is.null,cancelled_at.gt.${nowIso}`)
    .is("unsubscribed_at", null);

  if (error) {
    console.error("[cron/weekly-send] subscriber fetch failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (subscribers ?? []) as SubscriberRow[];
  const startedAt = Date.now();
  // Snapshot the monotonic counter now; THIS run's 429 count is the delta at
  // the end minus this baseline. Diffing (not resetting) is what makes this
  // safe under two overlapping invocations on the same warm lambda — see the
  // comment on braveRateLimitedCount in lib/brave.ts.
  const braveBaseline = braveRateLimitedCount();
  let sent = 0;
  let skippedNoName = 0;
  let skippedEmptyPool = 0;
  let skippedAlreadyDelivered = 0;
  let failed = 0;
  const failures: Array<{ email: string; error: string }> = [];
  // Emails of ACTIVE PAID subscribers who got NOTHING this send (blank name or
  // empty topic pool). Every row in this loop already passed the subscribed +
  // live-access filter, so anything here is a paying reader silently receiving
  // no letter — surfaced in the summary + an ops alert so it can't go unnoticed.
  const skippedBlankSubscribers: string[] = [];
  // Subscribers who WOULD have gotten a real send but the time budget ran out
  // first (see CRON_TIME_BUDGET_MS) — surfaced the same way, so a run that
  // starts approaching the cap is loud instead of a silent Vercel kill.
  const deferred: string[] = [];

  // ONE dry-topic cache shared across every subscriber in THIS run — passed
  // into each generateIssue call so a topic with no fresh news spends its
  // Brave queries once per batch, not once per subscriber. Created fresh per
  // invocation (not module state) so it can never leak into a different run.
  const dryCache = new Set<string>();

  // Allow ?force=1 to override the delivered_at idempotency gate (only the
  // admin will ever hit this with the CRON_SECRET in hand; useful for explicit
  // resend-this-week ops, never set by the Vercel cron itself).
  const force = url.searchParams.get("force") === "1";

  console.log(
    `[cron/weekly-send] weekOf=${weekOf} subscribers=${rows.length} force=${force}`
  );

  // Prefetch this week's delivered stamps in ONE query (was a per-subscriber
  // lookup — N+1 that adds a round trip per user as the list grows).
  const alreadyDelivered = new Set<string>();
  if (!force) {
    const { data: stamps } = await sb
      .from("issues")
      .select("user_id")
      .eq("week_of", weekOf)
      .not("delivered_at", "is", null);
    for (const s of (stamps ?? []) as Array<{ user_id: string }>) {
      alreadyDelivered.add(s.user_id);
    }
  }

  // Prefetch each subscriber's PRIOR DELIVERED issue count (periods strictly
  // before this one) → "Issue N" in the email subject is this reader's Nth
  // letter actually delivered (issueNumber = priorCount + 1), accurate on
  // re-runs too. Filters delivered_at NOT NULL so a generated-but-never-sent
  // row doesn't inflate the number.
  //
  // COUNT queries, not row-fetch-and-tally: PostgREST silently caps a select
  // at 1,000 rows, and at daily cadence the subscriber base crosses 1,000
  // lifetime delivered rows within months — the old row-fetch would silently
  // undercount and every "Issue N" would go wrong with no error. One head
  // count per subscriber; N = this send's recipients, small. Revisit with a
  // grouped aggregate RPC if the list grows past ~100.
  const priorIssueCount = new Map<string, number>();
  await Promise.all(
    rows.map(async (r) => {
      const { count } = await sb
        .from("issues")
        .select("*", { count: "exact", head: true })
        .eq("user_id", r.id)
        .lt("week_of", weekOf)
        .not("delivered_at", "is", null);
      priorIssueCount.set(r.id, count ?? 0);
    })
  );

  // Sequential per-subscriber, but topic blurbs cache across subscribers so
  // total Claude time is bounded by topics-this-week, not users × topics.
  // NOTE for scale: at ~100+ subscribers the per-user generation time will
  // press against maxDuration. CRON_TIME_BUDGET_MS (below) is the interim
  // safety net — it stops starting new subscribers before that becomes a
  // silent Vercel kill, deferring the rest loudly instead. The real fix at
  // that scale is still chunked sends (cursor param + multiple cron slots),
  // not parallelism (Claude rate limits bind first) — not built yet.
  for (const row of rows) {
    // letterSize = sections they pay for. The topics array is their ranked
    // POOL — clamp it to poolCap (letterSize + backups, ≤25) so generation
    // stays bounded and a topics array written straight to the DB (the RLS
    // trigger permits the column) can't blow up cost. generateIssue fills the
    // letter with the top fresh topics and backfills from the rest.
    const letterSize = clampQuota(row.topic_quota ?? 5);
    const pool = ((row.topics ?? []) as TopicId[]).slice(0, poolCap(letterSize));
    // The EFFECTIVE pool after mapping the pickable "zodiac" to a per-sign id
    // (dropped if no birthday). A reader whose whole pool maps to empty (only
    // reachable via a raw DB write) is a "got nothing" blank skip here, not a
    // hard generateIssue failure later (generateIssue maps the same way).
    const effectivePool = mapTopicsForUser(pool, row.birthday ?? undefined);
    if (!row.first_name || effectivePool.length === 0) {
      // This is an ACTIVE PAID subscriber getting NOTHING this send — exactly
      // how a blanked profile (e.g. a fresh-device sign-in that nulled
      // first_name / topics) drops a reader off every letter unnoticed. Never
      // silent: count which case, record the email, and warn per-subscriber.
      if (!row.first_name) skippedNoName++;
      else skippedEmptyPool++;
      skippedBlankSubscribers.push(row.email);
      console.warn(
        `[cron/weekly-send] SKIPPED PAID SUBSCRIBER (got nothing) → ${row.email} ` +
          `first_name=${row.first_name ? "ok" : "MISSING"} pool=${effectivePool.length}`
      );
      continue;
    }

    // Idempotency gate: if this (user, week) already has a delivered_at
    // stamp, skip the send entirely. Prevents duplicate emails when the
    // endpoint gets hit multiple times (admin re-trigger, Vercel cron retry,
    // ?weekOf= backfill, etc.). Override with ?force=1.
    if (!force && alreadyDelivered.has(row.id)) {
      skippedAlreadyDelivered++;
      console.log(`[cron/weekly-send] skipped (already delivered this period) → ${row.email}`);
      continue;
    }

    // Time budget: stop STARTING new subscribers once we're close enough to
    // maxDuration that finishing this one could still blow the cap (see
    // CRON_TIME_BUDGET_MS). Checked here (after the cheap skip-checks above)
    // so a subscriber who didn't actually need work isn't misreported as
    // deferred.
    if (Date.now() - startedAt > CRON_TIME_BUDGET_MS) {
      deferred.push(row.email);
      console.warn(`[cron/weekly-send] DEFERRED (time budget exhausted) → ${row.email}`);
      continue;
    }

    const profile: UserProfile = {
      firstName: row.first_name,
      city: row.city ?? "",
      jobBlurb: row.job_blurb ?? undefined,
      projectBlurb: row.project_blurb ?? undefined,
      funBlurb: row.fun_blurb ?? undefined,
      birthday: row.birthday ?? undefined,
      gender: coerceGender(row.gender) ?? undefined,
      topics: pool,
      theme: coerceThemeId(row.theme) ?? "forest",
      email: row.email,
    };

    try {
      const issue = await withDeadline(
        generateIssue(profile, weekOf, letterSize, freshness, dryCache),
        PER_USER_DEADLINE_MS,
        `generateIssue(${row.email})`
      );

      // Persist + send, bounded by PERSIST_AND_SEND_DEADLINE_MS (see its
      // comment) so a hung Supabase/Resend call can't park this whole loop.
      // A timeout here throws into the per-subscriber catch below exactly
      // like any other failure. Registered with Next's after() UNCONDITIONALLY
      // (not just on timeout) so Vercel is told to keep this invocation's
      // lambda alive until the promise settles even if it's still running
      // once the whole cron GET returns its response — without this, a
      // subscriber whose persist+send outlives the response risks getting its
      // execution environment torn down mid-write (e.g. between claiming
      // delivered_at and actually sending), which could leave a claim stuck
      // with no email ever sent — a genuine silent-miss regression that did
      // not exist before this block was pulled out from the main sequential
      // await chain. after() on an already-settled promise is a harmless
      // no-op, so this is safe to call every time, not just in the timeout
      // path. NOTE: sent/failed/failures below can still end up double
      // -counting a subscriber whose send succeeds in the background AFTER
      // the timeout branch already ran (this run's ops-alert email may then
      // wrongly list them as failed) — accepted: the actual delivered_at
      // claim and the actual email are correct either way, this only risks a
      // cosmetic inaccuracy in one day's summary, not a duplicate or a
      // silent miss, and a fully precise fix needs deferred cross-subscriber
      // reconciliation that isn't proportionate to add tonight.
      const persistAndSend = (async () => {
          // Upsert the issue so re-runs are idempotent on (user_id, week_of).
          // THROW on failure (caught by the per-user catch below) — if this row
          // doesn't exist, the email must NOT go out: the delivered_at CLAIM below
          // targets this exact row, so a missing row means no claim and no send.
          // Skipping the send means the next run retries the whole user cleanly.
          const { error: issueUpsertErr } = await sb.from("issues").upsert(
            {
              user_id: row.id,
              week_of: weekOf,
              volume: issue.volume,
              number: issue.number,
              editor_intro: issue.editorIntro,
              sections: issue.sections,
            },
            { onConflict: "user_id,week_of" }
          );
          if (issueUpsertErr) {
            throw new Error(`issue upsert failed: ${issueUpsertErr.message}`);
          }

          // Send the letter via Resend (lib/email.ts).
          if (!resendConfigured()) return;

          // ATOMIC delivered_at CLAIM — the race-safe idempotency guard. The
          // prefetch Set above is a cheap fast-path for the common SEQUENTIAL
          // rerun; it does NOT stop two OVERLAPPING invocations (a Vercel retry
          // racing the scheduled run, or a manual run racing the cron) from both
          // seeing the user as undelivered and both sending a duplicate. This
          // UPDATE ... WHERE delivered_at IS NULL is an atomic compare-and-swap:
          // Postgres row-locks the issue so exactly ONE concurrent invocation
          // flips the stamp and proceeds; the loser updates 0 rows and skips. We
          // stamp BEFORE the send (was: best-effort stamp after) and roll back on
          // send failure — trading the old "stamp-fail/crash -> DUPLICATE" for a
          // far rarer "hard crash between claim and send -> missed once". A missed
          // letter is less harmful than a duplicate. ?force=1 bypasses the claim.
          let claimedAt: string | null = null;
          if (!force) {
            claimedAt = new Date().toISOString();
            const { data: claimRows, error: claimErr } = await sb
              .from("issues")
              .update({ delivered_at: claimedAt })
              .eq("user_id", row.id)
              .eq("week_of", weekOf)
              .is("delivered_at", null)
              .select("user_id");
            if (claimErr) {
              throw new Error(`delivered_at claim failed: ${claimErr.message}`);
            }
            if ((claimRows?.length ?? 0) === 0) {
              skippedAlreadyDelivered++;
              console.log(`[cron/weekly-send] skipped (claimed by a concurrent run) → ${row.email}`);
              return;
            }
          }

          const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://alpha.everyday.report";
          const inboxUrl = `${origin}/inbox`;
          try {
            await sendLetterNotification({
              to: row.email,
              // profile.firstName, not row.first_name: the null-check guard
              // above narrows row.first_name in the outer loop body, but that
              // narrowing doesn't carry into this nested closure, and
              // profile.firstName is already the guaranteed-non-null string.
              firstName: profile.firstName,
              issue,
              inboxUrl,
              // Tokenized view-in-browser link: the CTA opens the letter directly
              // with no session — no more "No letter yet" on a signed-out device.
              letterUrl: buildLetterUrl(row.id, origin, weekOf),
              issueNumber: (priorIssueCount.get(row.id) ?? 0) + 1,
              userId: row.id,
            });
          } catch (sendErr) {
            if (!force && claimedAt) {
              // Release the claim so the next run retries this user cleanly.
              // Predicate-guarded on OUR exact claim timestamp so we only ever
              // retract the stamp THIS invocation set — never one a concurrent
              // run wrote, which would risk nulling a real, just-sent delivery.
              const { error: rollbackErr } = await sb
                .from("issues")
                .update({ delivered_at: null })
                .eq("user_id", row.id)
                .eq("week_of", weekOf)
                .eq("delivered_at", claimedAt);
              if (rollbackErr) {
                console.warn(
                  `[cron/weekly-send] send failed AND claim rollback failed for ${row.email}: ${rollbackErr.message} — may be skipped (missed) next run.`
                );
              }
            }
            throw sendErr;
          }

          if (force) {
            // The force path skipped the claim; stamp after a successful resend so
            // a later normal run doesn't treat this user as undelivered and send
            // again. Best-effort — force is an admin-driven one-off.
            const { error: stampErr } = await sb
              .from("issues")
              .update({ delivered_at: new Date().toISOString() })
              .eq("user_id", row.id)
              .eq("week_of", weekOf);
            if (stampErr) {
              console.warn(
                `[cron/weekly-send] force resend sent but delivered_at stamp failed for ${row.email}: ${stampErr.message}`
              );
            }
          }

          // Count + log only on an ACTUAL send — inside resendConfigured's
          // early-return above so a dev/misconfig run with Resend unset
          // doesn't over-report `sent` for letters that never went out.
          sent++;
          // Log the sections that actually made the letter (top fresh topics +
          // any backfill), not the whole pool.
          const labels = issue.sections
            .map((s) => s.topicLabel)
            .filter(Boolean)
            .join(" · ");
          console.log(`[cron/weekly-send] sent → ${row.email} (${labels})`);
        })();

      after(persistAndSend.catch(() => undefined));
      await withDeadline(persistAndSend, PERSIST_AND_SEND_DEADLINE_MS, `persist+send(${row.email})`);
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : "unknown";
      failures.push({ email: row.email, error: msg });
      console.error(`[cron/weekly-send] FAILED → ${row.email}: ${msg}`);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const braveRateLimited = braveRateLimitedCount() - braveBaseline;
  const summary = {
    weekOf,
    subscribers: rows.length,
    sent,
    skippedNoName,
    skippedEmptyPool,
    skippedBlankSubscribers,
    skippedAlreadyDelivered,
    deferred,
    failed,
    braveRateLimited,
    elapsedMs,
    failures: failures.slice(0, 25),
  };
  console.log("[cron/weekly-send] summary:", JSON.stringify(summary));

  // A paid subscriber getting nothing, a hard send failure, Brave quota
  // exhaustion (letters silently degrade to stale filler — a subscriber
  // reported exactly this class of repeat content), or subscribers deferred
  // for time should be LOUD — not buried in logs the owner won't read until a
  // letter is noticed missing. Best-effort single email per run (sendOpsAlert
  // never throws), only when something actually went wrong.
  if (skippedBlankSubscribers.length > 0 || failed > 0 || braveRateLimited > 0 || deferred.length > 0) {
    const lines = [
      `weekOf=${weekOf}  sent=${sent}  subscribers=${rows.length}  failed=${failed}`,
      skippedBlankSubscribers.length
        ? `PAID subscribers who got NOTHING (blank name / empty topics): ${skippedBlankSubscribers.join(", ")}`
        : "",
      failures.length
        ? `Send failures: ${failures.map((f) => `${f.email} (${f.error})`).join("; ")}`
        : "",
      braveRateLimited > 0
        ? `Brave returned 429 on ${braveRateLimited} queries — monthly search quota likely exhausted; letters are degrading to filler. Fix: upgrade the Brave plan (https://api.search.brave.com), ~$5-10/mo at this volume.`
        : "",
      deferred.length
        ? `Time budget exhausted before reaching everyone — ${deferred.length} subscriber(s) got NO letter this run: ${deferred.join(", ")}. Safe to recover: rerun this exact date with ?weekOf=${weekOf} (already-delivered subscribers are skipped automatically). This is a scale signal — the subscriber list is big enough that the daily run is pressing against Vercel's time cap.`
        : "",
    ].filter(Boolean);
    await sendOpsAlert(
      `[alpha] send ${weekOf}: ${skippedBlankSubscribers.length} blanked, ${failed} failed${braveRateLimited > 0 ? ", Brave quota hit" : ""}${deferred.length > 0 ? `, ${deferred.length} deferred (time budget)` : ""}`,
      lines.join("\n")
    );
  }

  return NextResponse.json(summary);
}

