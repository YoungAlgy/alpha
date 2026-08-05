import { NextResponse, after } from "next/server";
import crypto from "crypto";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { generateIssue, formatWeekOf } from "@/lib/engine/assemble";
import { poolCap } from "@/lib/engine/select-sections";
import { getCachedBlurbs } from "@/lib/engine/blurb-cache";
import { sendLetterNotification, resendConfigured, sendOpsAlert } from "@/lib/email";
import { letterUrl as buildLetterUrl } from "@/lib/letter-token";
import { currentPeriodIso, sinceLastSendWindow } from "@/lib/cadence";
import { braveRateLimitedCount } from "@/lib/brave";
import { youRateLimitedCount } from "@/lib/you-search";
import { groqRateLimitedCount } from "@/lib/engine/groq-client";
import { deepseekRateLimitedCount } from "@/lib/engine/deepseek-client";
import { topicLabel, mapTopicsForUser, GENERIC_FALLBACK_TOPICS } from "@/lib/topics";
import { withDeadline } from "@/lib/with-deadline";
import type { UserProfile, TopicId, Issue } from "@/lib/types";
import type { TopicBlurb } from "@/lib/engine/types";
import { clampQuota } from "@/lib/types";
import { coerceGender } from "@/lib/demographics";
import { coerceThemeId } from "@/lib/themes";

export const runtime = "nodejs";
// This value no longer means what its name implies. It WAS a Vercel Pro
// platform directive (Vercel reads `maxDuration` and enforces it); the send
// now runs via `next start` on GitHub Actions (.github/workflows/
// daily-send.yml), which reads nothing here and enforces nothing here — the
// real ceiling is that workflow's own `curl --max-time` (1500s) and job
// `timeout-minutes` (30). Kept only because CRON_TIME_BUDGET_MS below is
// still derived from it for the in-route deferral safety valve. Found stale
// live 2026-08-05: the old value (800, Vercel Pro's real cap) meant the
// route stopped starting new subscribers at ~630s while the actual host had
// ~25 minutes of real budget sitting unused — harmless at 4 subscribers,
// but it would silently start deferring readers well before necessary as
// the list grows. Set to match the workflow's real curl budget.
export const maxDuration = 1500;

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

// Second-chance budget when the FULL attempt above fails or times out — a
// small, fast, genuinely FRESH retry before ever falling back to stale
// content (see the catch block below). Reuses the same generation pipeline,
// just a smaller topic pool, so a real provider outage still fails fast here
// too; this specifically catches the "unusually slow this run, but the
// providers ARE actually up" case — exactly what caused the 2026-07-29
// incident — with real content instead of a repeat. Measured live (3 real
// topics, current degraded conditions — Brave capped, Gemini quota
// exhausted) at ~32s twice in a row; note the floor doesn't shrink linearly
// with fewer topics since they run in parallel and the SLOWEST one that
// needs the full tier-escalation chain sets the wall-clock time regardless
// of pool size — fewer topics mainly lowers the ODDS several hit that worst
// case at once, not the per-call floor.
//
// MUST exceed assemble.ts's own TOPIC_GEN_DEADLINE_MS (75s) — this call is
// generateIssue() itself, whose Pass-1 wave is individually capped at 75s per
// topic, plus a sequential editor's-note call after that. An outer deadline
// SHORTER than an inner one it wraps means this layer can spuriously fail
// (and fall through to the stale-resend layer) on a topic that was about to
// legitimately succeed via its own inner deadline — the same
// outer-must-exceed-inner mistake CRON_SAFETY_MARGIN_MS below exists to avoid
// for PER_USER_DEADLINE_MS. 90s = 75s inner ceiling + 15s margin for the
// editor's note + overhead (found in review, 2026-07-29 — the original 60s
// was measured against a run that never actually reached the 75s per-topic
// ceiling, so the gap went unnoticed).
const FAST_FALLBACK_DEADLINE_MS = 90_000;
// How many of the reader's top-ranked topics the fast fallback attempts.
// Fewer topics means less concurrent load on the same Anthropic/Gemini
// account, which is the actual mechanism that made the full pool slow in
// the first place — not just "less to generate."
const FAST_FALLBACK_TOPIC_COUNT = 3;

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
// GitHub Actions' daily-send.yml sends the Authorization header of
// `Bearer ${CRON_SECRET}` via curl (its "Start the server and run the real
// daily send" step). We refuse anything else, so this can't be hit from the
// open web.
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
//   5. Per-user failures are caught and counted; the route always returns 200
//      so a partial run still reads as a completed call — failures surface in
//      the response summary and runtime logs (daily-send.yml separately fails
//      the job if that summary shows any subscriber left uncovered).
export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  const auth = req.headers.get("authorization");
  if (!expected || !bearerMatches(auth, expected)) {
    console.warn("[cron/weekly-send] unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Allow ?weekOf=YYYY-MM-DD override (useful for backfills + admin testing
  // when the schedule hasn't fired yet). Defaults to today (the send date).
  // CRON: GitHub Actions' daily-send.yml drives every send, "0 14 * * *"
  // (14:00 UTC primary) plus an offset "0 15 * * *" retry for a dropped or
  // failed primary run. The handler derives the period from today's date, so
  // one schedule covers every send day.
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
  // comment on braveRateLimitedCount in lib/brave.ts. Same reasoning for
  // You.com's counter (lib/you-search.ts) — without this baseline+delta, a
  // struggling 3rd search tier would have zero operator-visible signal, the
  // same gap Brave's own counter exists to close. Groq/DeepSeek (2026-07-29)
  // are content-GENERATION fallbacks rather than search, but the same gap
  // applies: without this, a struggling free/backstop tier degrades every
  // reader straight to Haiku/Sonnet spend (or the stale-resend layer, if
  // Anthropic isn't funded) with zero operator-visible signal.
  const braveBaseline = braveRateLimitedCount();
  const youBaseline = youRateLimitedCount();
  const groqBaseline = groqRateLimitedCount();
  const deepseekBaseline = deepseekRateLimitedCount();
  let sent = 0;
  // Live generation failed/timed out but a backup layer covered it (see the
  // catch block below) — counted separately from `sent`/`failed` so the
  // summary distinguishes "the pipeline had a problem, but nobody got
  // nothing" from either a clean run or a genuine miss. Split by which layer
  // rescued it: shared (borrowed from broadly-appealing content another
  // topic already cached today — zero new AI calls, the fastest/most
  // reliable), fresh (a small fast retry, real new content this reader's
  // own), or stale (a repeat of their last letter, the true last resort).
  let backupSharedSent = 0;
  let backupFreshSent = 0;
  let backupStaleSent = 0;
  let skippedNoName = 0;
  let skippedEmptyPool = 0;
  let skippedAlreadyDelivered = 0;
  let failed = 0;
  const failures: Array<{ email: string; error: string }> = [];
  const backupSharedSentEmails: string[] = [];
  const backupFreshSentEmails: string[] = [];
  const backupStaleSentEmails: string[] = [];
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
  // ONE in-flight de-dup map shared the same way as dryCache — see its own
  // comment on generateIssue's signature (assemble.ts). Closes a real gap
  // (2026-07-29 review): withDeadline never cancels the underlying work, so a
  // timed-out live attempt keeps searching/generating in the background —
  // without this, the fast-fallback layer's smaller topic slice (a guaranteed
  // prefix-overlap with the timed-out attempt's first wave) would pay for the
  // identical search+generation a second time on the exact rate-limited
  // accounts the fallback exists to relieve.
  const inFlight = new Map<string, Promise<TopicBlurb | null>>();

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

  // Prefetch each subscriber's persisted-but-undelivered issue (retry-safety
  // reuse below, near runPersistAndSend) in ONE query — was a per-subscriber
  // lookup inside the loop, mirroring the alreadyDelivered fix above.
  const pendingIssues = new Map<
    string,
    { volume: number; number: number; editor_intro: string; sections: Issue["sections"] }
  >();
  {
    const { data: pending } = await sb
      .from("issues")
      .select("user_id, volume, number, editor_intro, sections")
      .eq("week_of", weekOf)
      .is("delivered_at", null)
      .in("user_id", rows.map((r) => r.id));
    for (const p of (pending ?? []) as Array<{
      user_id: string;
      volume: number;
      number: number;
      editor_intro: string;
      sections: Issue["sections"];
    }>) {
      pendingIssues.set(p.user_id, p);
    }
  }

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

    // Persist + send ONE issue for this subscriber, bounded by
    // PERSIST_AND_SEND_DEADLINE_MS (see its comment above) so a hung
    // Supabase/Resend call can't park this whole loop. Shared by the normal
    // live-generated send below AND both backup layers in the catch block —
    // identical idempotency/claim/rollback guarantees every time; the only
    // difference is which Issue gets persisted and which counter it credits.
    async function runPersistAndSend(issue: Issue, kind: "live" | "backup-shared" | "backup-fresh" | "backup-stale"): Promise<void> {
      // Ensure the row EXISTS so the atomic claim below (an UPDATE) has
      // something to match — but never overwrite content here.
      // ignoreDuplicates makes this INSERT ... ON CONFLICT DO NOTHING: if the
      // row already exists (created by an earlier attempt for this same
      // subscriber+week, live or backup), this is a no-op. THROW on failure —
      // same reasoning as before: if the row can't even be created, the email
      // must NOT go out, since the claim below has nothing to target.
      //
      // Found live 2026-08-05 (adversarial audit, same day as the resilience
      // hardening): the OLD code unconditionally upserted content here on
      // every call, before the claim. Two calls for the same (user_id,
      // week_of) — e.g. a live send still finishing in the background past
      // its deadline (kept alive via after()) racing a backup layer's retry —
      // would both overwrite this row's content, and whichever wrote LAST won
      // regardless of which one actually WON the delivered_at claim below (or
      // whether either even sent an email at all yet). /letter and /inbox
      // read sections straight from this row, so the wrong content could be
      // shown even when the right email had already gone out — and in the
      // failure-ordering variant, a same-day retry could resend the loser's
      // placeholder content as if it were the real thing. See
      // alpha_full_app_review_2026-08-05.md in Claude's memory for the full
      // writeup and scripts/verify-persist-claim-atomicity.mts for the proof.
      const { error: ensureExistsErr } = await sb.from("issues").upsert(
        {
          user_id: row.id,
          week_of: weekOf,
          volume: issue.volume,
          number: issue.number,
          editor_intro: issue.editorIntro,
          sections: issue.sections,
        },
        { onConflict: "user_id,week_of", ignoreDuplicates: true }
      );
      if (ensureExistsErr) {
        throw new Error(`issue upsert failed: ${ensureExistsErr.message}`);
      }

      // Send the letter via Resend (lib/email.ts). THROW, don't silently
      // return — found live 2026-08-05: a silent return here means a missing
      // RESEND_API_KEY makes the ENTIRE run a no-op that still reports
      // sent=0/failed=0, fires no ops alert (the trigger condition below
      // needs failed>0 or similar), and returns HTTP 200 — a full day's
      // spend on real Anthropic/Gemini/Groq/DeepSeek generation for every
      // subscriber, with nothing to show for it and no signal anywhere that
      // anything went wrong. Throwing routes this through the same per-user
      // catch as every other failure, so it's counted, alerted on, and
      // (once a persisted-issue-row retry path exists) safely retryable.
      if (!resendConfigured()) {
        throw new Error("Resend is not configured (RESEND_API_KEY missing) — cannot send.");
      }

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
      //
      // Content fields ride along in THIS same atomic UPDATE now (they used
      // to be written unconditionally above, before the claim existed at
      // all — see the ensure-exists comment above for why that was a real
      // bug). Bundling them here means only the WINNER of the compare-and-
      // swap ever writes content: the loser's UPDATE matches 0 rows, so
      // neither its claim nor its content-write happens. No separate
      // "did we win, now also write content" step is needed or possible to
      // get wrong.
      let claimedAt: string | null = null;
      if (!force) {
        claimedAt = new Date().toISOString();
        const { data: claimRows, error: claimErr } = await sb
          .from("issues")
          .update({
            delivered_at: claimedAt,
            volume: issue.volume,
            number: issue.number,
            editor_intro: issue.editorIntro,
            sections: issue.sections,
          })
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
      } else {
        // force=1 bypasses the claim entirely (admin one-off) -- write this
        // call's content unconditionally, matching the original explicit-
        // override intent (force means "just do it", not "only if I win").
        const { error: forceWriteErr } = await sb
          .from("issues")
          .update({
            volume: issue.volume,
            number: issue.number,
            editor_intro: issue.editorIntro,
            sections: issue.sections,
          })
          .eq("user_id", row.id)
          .eq("week_of", weekOf);
        if (forceWriteErr) {
          throw new Error(`force content write failed: ${forceWriteErr.message}`);
        }
      }

      const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://alpha.everyday.report";
      const inboxUrl = `${origin}/inbox`;
      try {
        await sendLetterNotification({
          to: row.email,
          // profile.firstName, not row.first_name: the null-check guard
          // above narrows row.first_name in the outer loop body, but that
          // narrowing doesn't carry into this nested function, and
          // profile.firstName is already the guaranteed-non-null string.
          firstName: profile.firstName,
          issue,
          inboxUrl,
          // Tokenized view-in-browser link: the CTA opens the letter directly
          // with no session — no more "No letter yet" on a signed-out device.
          letterUrl: buildLetterUrl(row.id, origin, weekOf),
          issueNumber: (priorIssueCount.get(row.id) ?? 0) + 1,
          userId: row.id,
          // A backup kind must never share the live send's idempotency key —
          // see the comment on idempotencyKey in lib/email.ts. "live" is the
          // default there, so this is only needed for the backup kinds, but
          // passing it always keeps the two call sites obviously in sync.
          idempotencyKind: kind,
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
      // early-return above so a dev/misconfig run with Resend unset doesn't
      // over-report for letters that never went out.
      const labels = issue.sections.map((s) => s.topicLabel).filter(Boolean).join(" · ");
      if (kind === "backup-shared") {
        backupSharedSent++;
        backupSharedSentEmails.push(row.email);
        console.log(`[cron/weekly-send] sent BACKUP-SHARED (borrowed from today's cache) → ${row.email} (${labels})`);
      } else if (kind === "backup-fresh") {
        backupFreshSent++;
        backupFreshSentEmails.push(row.email);
        console.log(`[cron/weekly-send] sent BACKUP-FRESH (small fast retry) → ${row.email} (${labels})`);
      } else if (kind === "backup-stale") {
        backupStaleSent++;
        backupStaleSentEmails.push(row.email);
        console.log(`[cron/weekly-send] sent BACKUP-STALE (resend of a prior letter) → ${row.email} (${labels})`);
      } else {
        sent++;
        console.log(`[cron/weekly-send] sent → ${row.email} (${labels})`);
      }
    }

    // RETRY-SAFETY: if a PRIOR run already generated and persisted this
    // subscriber's issue but never successfully delivered it (a same-day
    // retry after a transient send failure — see the offset retry trigger),
    // reuse that exact persisted content instead of regenerating. Found live
    // 2026-08-05: the per-user editor's note (assemble.ts's
    // generateEditorNote) is never cached, so a regenerated retry produces a
    // DIFFERENT payload — but sendLetterNotification's Resend idempotency
    // key is stable per (user, week_of, kind) (lib/email.ts), so Resend
    // correctly 409s the mismatched retry as invalid_idempotent_request,
    // meaning the retry built specifically to rescue a transient Resend
    // error was GUARANTEED to fail on exactly that case. Reusing the
    // already-upserted row keeps the payload byte-identical, so the shared
    // idempotency key works as designed and the retry costs zero new AI
    // calls on top of being correct.
    const persistedRetry = pendingIssues.get(row.id);
    const reusableSections = persistedRetry?.sections as Issue["sections"] | undefined;

    try {
      const issue: Issue =
        reusableSections && reusableSections.length > 0
          ? {
              id: `${profile.firstName.toLowerCase()}-${weekOf}`,
              volume: persistedRetry!.volume,
              number: persistedRetry!.number,
              weekOf: formatWeekOf(weekOf),
              recipientFirstName: profile.firstName,
              recipientCity: profile.city,
              editorIntro: persistedRetry!.editor_intro,
              sections: reusableSections,
            }
          : await withDeadline(
              generateIssue(profile, weekOf, letterSize, freshness, dryCache, inFlight),
              PER_USER_DEADLINE_MS,
              `generateIssue(${row.email})`
            );
      if (reusableSections && reusableSections.length > 0) {
        console.log(`[cron/weekly-send] reusing already-generated issue (retry, zero new AI cost) → ${row.email}`);
      }

      // Registered with Next's after() UNCONDITIONALLY (not just on timeout)
      // so Vercel is told to keep this invocation's lambda alive until the
      // promise settles even if it's still running once the whole cron GET
      // returns its response — without this, a subscriber whose persist+send
      // outlives the response risks getting its execution environment torn
      // down mid-write (e.g. between claiming delivered_at and actually
      // sending), which could leave a claim stuck with no email ever sent.
      // after() on an already-settled promise is a harmless no-op, so this is
      // safe to call every time, not just in the timeout path. NOTE:
      // sent/failed/failures below can still end up double-counting a
      // subscriber whose send succeeds in the background AFTER the timeout
      // branch already ran (this run's ops-alert email may then wrongly list
      // them as failed) — accepted: the actual delivered_at claim and the
      // actual email are correct either way, this only risks a cosmetic
      // inaccuracy in one day's summary, not a duplicate or a silent miss.
      const persistAndSend = runPersistAndSend(issue, "live");
      after(persistAndSend.catch(() => undefined));
      await withDeadline(persistAndSend, PERSIST_AND_SEND_DEADLINE_MS, `persist+send(${row.email})`);
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : "unknown";
      failures.push({ email: row.email, error: msg });
      console.error(`[cron/weekly-send] FAILED → ${row.email}: ${msg}`);

      // Three-layer backup (incident 2026-07-29 — see memory). A stale
      // resend ALONE isn't good enough: if the underlying problem persists
      // across days, every subscriber would get the identical repeat letter
      // day after day — recreating the exact "same content every time"
      // complaint that started this whole investigation. So try the
      // cheapest/fastest/most-reliable real option first, then a small
      // fresh live retry, and only fall back to a repeat as the true last
      // resort.
      let backupIssue: Issue | null = null;
      let backupKind: "backup-shared" | "backup-fresh" | "backup-stale" | null = null;

      // Shared shell for a manually-built backup Issue (layers 0 and 2 —
      // layer 1 gets a real Issue straight from generateIssue() and doesn't
      // need this). Factored out so the two call sites can't drift apart on
      // these fields independently — same reasoning as runPersistAndSend
      // above being one shared function instead of two near-copies.
      function buildBackupIssue(editorIntro: string, sections: Issue["sections"]): Issue {
        return {
          id: `${profile.firstName.toLowerCase()}-${weekOf}-backup`,
          volume: 1,
          number: 1,
          weekOf: formatWeekOf(weekOf),
          recipientFirstName: profile.firstName,
          recipientCity: profile.city,
          editorIntro,
          sections,
        };
      }

      // LAYER 0 — cache-borrow: check for content ALREADY cached today
      // across broadly-appealing topics (GENERIC_FALLBACK_TOPICS — the same
      // deliberately non-personal, non-niche tail used for ordinary
      // backfill, not this reader's own narrow picks — "relevant to anyone,
      // not just what they chose" per Algy). Zero new AI calls, a single
      // fast DB read, and doesn't depend on ANY provider being up — the
      // cheapest, fastest, and most reliable option, so it's tried FIRST.
      // Genuinely fresh (today's real content), just not this reader's own
      // topics. Empty most of the time this run is the FIRST subscriber
      // processed (nothing cached yet) — falls through to layer 1 then.
      try {
        const cached = await getCachedBlurbs(GENERIC_FALLBACK_TOPICS, weekOf);
        const available = [...cached.values()].filter((b) => b.items.length > 0);
        // Floor of 2: a 1-section backup letter reads too thin to send as a
        // real issue — falls through to layer 1's fast fresh retry instead of
        // shipping something that thin.
        if (available.length >= 2) {
          const chosen = available.slice(0, FAST_FALLBACK_TOPIC_COUNT);
          // A short, sentence-friendly form, not the full catalog label
          // (e.g. topicLabel("ai-news") is "AI: news, releases & tools for
          // work" — reads fine as a menu entry, awkward mid-sentence).
          const labels = chosen.map((b) => b.topicId.replace(/-/g, " "));
          const list =
            labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : labels[0];
          backupIssue = buildBackupIssue(
            `Your usual letter needs a bit more time today, so here's what's fresh right now across ${list}.`,
            chosen.map((b) => ({
              topicId: b.topicId,
              topicLabel: topicLabel(b.topicId),
              intro: b.intro,
              items: b.items,
            }))
          );
          backupKind = "backup-shared";
          console.warn(`[cron/weekly-send] cache-borrow succeeded → ${row.email} (${chosen.length} shared topics)`);
        }
      } catch (cacheErr) {
        console.warn(
          `[cron/weekly-send] cache-borrow check failed → ${row.email}: ${cacheErr instanceof Error ? cacheErr.message : cacheErr}`
        );
      }

      // LAYER 1 — fast fallback: a small, tightly-bounded retry through the
      // SAME (now-fixed) generation pipeline, just fewer topics. Catches the
      // "unusually slow this run but the providers ARE up" case — the actual
      // mechanism behind the incident — with real content, not a repeat. A
      // genuine full provider outage still fails this fast (bounded by
      // FAST_FALLBACK_DEADLINE_MS) and falls through to layer 2 below.
      if (!backupIssue) {
        try {
          const smallPool = pool.slice(0, FAST_FALLBACK_TOPIC_COUNT);
          if (smallPool.length > 0) {
            backupIssue = await withDeadline(
              generateIssue({ ...profile, topics: smallPool }, weekOf, smallPool.length, freshness, dryCache, inFlight),
              FAST_FALLBACK_DEADLINE_MS,
              `fast-fallback(${row.email})`
            );
            backupKind = "backup-fresh";
            console.warn(`[cron/weekly-send] fast fallback succeeded → ${row.email} (${smallPool.length} topics)`);
          }
        } catch (fastErr) {
          console.warn(
            `[cron/weekly-send] fast fallback ALSO failed → ${row.email}: ${fastErr instanceof Error ? fastErr.message : fastErr}`
          );
        }
      }

      // LAYER 2 — true last resort: even the small fresh retry failed (a
      // genuine outage, not just slowness), and nothing else was cached
      // today either. Resend their most recent successfully-delivered
      // letter rather than nothing. Zero new AI calls, so it can't fail the
      // same way either layer above just did. No prior letter (a brand-new
      // subscriber) means nothing to fall back to — stays a hard failure,
      // same as today. Honest that it's a repeat.
      if (!backupIssue) {
        try {
          const { data: prior } = await sb
            .from("issues")
            .select("sections")
            .eq("user_id", row.id)
            .not("delivered_at", "is", null)
            .lt("week_of", weekOf)
            .order("week_of", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (prior?.sections) {
            backupIssue = buildBackupIssue(
              "Quick note: today's letter is running behind, so here's a repeat of your last one while it catches up.",
              prior.sections
            );
            backupKind = "backup-stale";
          }
        } catch (lookupErr) {
          console.error(
            `[cron/weekly-send] backup lookup failed → ${row.email}: ${lookupErr instanceof Error ? lookupErr.message : lookupErr}`
          );
        }
      }

      if (backupIssue && backupKind) {
        try {
          const backupSend = runPersistAndSend(backupIssue, backupKind);
          after(backupSend.catch(() => undefined));
          await withDeadline(backupSend, PERSIST_AND_SEND_DEADLINE_MS, `backup-send(${row.email})`);
        } catch (backupErr) {
          console.error(
            `[cron/weekly-send] backup send failed → ${row.email}: ${backupErr instanceof Error ? backupErr.message : backupErr}`
          );
        }
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const braveRateLimited = braveRateLimitedCount() - braveBaseline;
  const youRateLimited = youRateLimitedCount() - youBaseline;
  const groqRateLimited = groqRateLimitedCount() - groqBaseline;
  const deepseekRateLimited = deepseekRateLimitedCount() - deepseekBaseline;
  const summary = {
    weekOf,
    subscribers: rows.length,
    sent,
    backupSharedSent,
    backupSharedSentEmails,
    backupFreshSent,
    backupFreshSentEmails,
    backupStaleSent,
    backupStaleSentEmails,
    skippedNoName,
    skippedEmptyPool,
    skippedBlankSubscribers,
    skippedAlreadyDelivered,
    deferred,
    failed,
    braveRateLimited,
    youRateLimited,
    groqRateLimited,
    deepseekRateLimited,
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
  if (
    skippedBlankSubscribers.length > 0 ||
    failed > 0 ||
    braveRateLimited > 0 ||
    groqRateLimited > 0 ||
    deepseekRateLimited > 0 ||
    deferred.length > 0
  ) {
    // A "failed" subscriber isn't necessarily one who got nothing anymore —
    // some were caught by a backup layer. genuinelyMissed is the real
    // severity signal: failed minus however many were rescued either way.
    const genuinelyMissed = failed - backupSharedSent - backupFreshSent - backupStaleSent;
    const lines = [
      `weekOf=${weekOf}  sent=${sent}  backupSharedSent=${backupSharedSent}  backupFreshSent=${backupFreshSent}  backupStaleSent=${backupStaleSent}  subscribers=${rows.length}  failed=${failed}  genuinelyMissed=${genuinelyMissed}`,
      backupSharedSent > 0
        ? `Live generation failed for ${failed} subscriber(s); ${backupSharedSent} of them got fresh, real content borrowed from a broadly-appealing topic already cached today (zero new AI calls): ${backupSharedSentEmails.join(", ")}.`
        : "",
      backupFreshSent > 0
        ? `${backupFreshSent} needed the next layer — a real, FRESH (shorter) letter via the small fast-fallback retry: ${backupFreshSentEmails.join(", ")}.`
        : "",
      backupStaleSent > 0
        ? `${backupStaleSent} subscriber(s) needed the true last resort — their most recent prior letter, resent (they were told it's a repeat): ${backupStaleSentEmails.join(", ")}. Worth a closer look if this keeps happening — it means even the cache-borrow and the fast retry are both failing, not just the full generation.`
        : "",
      skippedBlankSubscribers.length
        ? `PAID subscribers who got NOTHING (blank name / empty topics): ${skippedBlankSubscribers.join(", ")}`
        : "",
      failures.length
        ? `Underlying generation failures (root cause, investigate this even if a backup layer covered it): ${failures.map((f) => `${f.email} (${f.error})`).join("; ")}`
        : "",
      braveRateLimited > 0
        ? `Brave returned 429 on ${braveRateLimited} queries — monthly search quota likely exhausted; letters are degrading to filler. Fix: upgrade the Brave plan (https://api.search.brave.com), ~$5-10/mo at this volume.`
        : "",
      // Can only be nonzero when braveRateLimited is also nonzero this same
      // run (You.com only ever gets tried after Brave itself 429s/402s — see
      // resolveTopicSignal in source-resolver.ts), so this never fires the
      // alert on its own — it's a severity signal layered on top of the
      // Brave line above: even the 3rd, genuinely independent search tier is
      // hitting its own limit.
      youRateLimited > 0
        ? `You.com (the 3rd search tier) ALSO returned 429 on ${youRateLimited} queries this run — the fallback chain is running three-deep and still straining. Worth checking the You.com dashboard for remaining credit.`
        : "",
      // UNLIKE youRateLimited above, Groq/DeepSeek are content-GENERATION
      // fallbacks (2026-07-29), not chained behind Brave's search tiers — Groq
      // gets tried whenever GEMINI's own generation quota is tapped out,
      // completely independent of whether search succeeded. So this CAN be
      // the only rate-limit signal on a run where Brave was fine, which is
      // why it's in the alert's trigger condition above (not just appended
      // like You.com's nested case).
      groqRateLimited > 0
        ? `Groq (2nd content-generation tier) returned 429 on ${groqRateLimited} calls this run — its free-tier quota is under pressure. Escalates automatically to DeepSeek, so likely not a reader-visible problem yet, but worth watching if it keeps climbing.`
        : "",
      // DeepSeek is meant to be UNCAPPED (a funded balance, concurrency-limited
      // only) — a real 429 here means even the backstop tier is straining,
      // which is a materially more serious signal than Groq's free-tier limit
      // above.
      deepseekRateLimited > 0
        ? `DeepSeek (the uncapped backstop tier) returned 429 on ${deepseekRateLimited} calls this run — that shouldn't normally happen on a funded account. Worth checking the DeepSeek dashboard for balance/concurrency issues.`
        : "",
      deferred.length
        ? `Time budget exhausted before reaching everyone — ${deferred.length} subscriber(s) got NO letter this run: ${deferred.join(", ")}. Safe to recover: rerun this exact date with ?weekOf=${weekOf} (already-delivered subscribers are skipped automatically). This is a scale signal — the subscriber list is big enough that the daily run is pressing against Vercel's time cap.`
        : "",
    ].filter(Boolean);
    await sendOpsAlert(
      `[alpha] send ${weekOf}: ${skippedBlankSubscribers.length} blanked, ${failed} failed (${genuinelyMissed} genuinely missed)${braveRateLimited > 0 ? ", Brave quota hit" : ""}${groqRateLimited > 0 ? ", Groq quota hit" : ""}${deepseekRateLimited > 0 ? ", DeepSeek quota hit" : ""}${deferred.length > 0 ? `, ${deferred.length} deferred (time budget)` : ""}`,
      lines.join("\n")
    );
  }

  return NextResponse.json(summary);
}

