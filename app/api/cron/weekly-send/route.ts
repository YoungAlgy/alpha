import { NextResponse, after } from "next/server";
import crypto from "crypto";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { generateIssue, formatWeekOf } from "@/lib/engine/assemble";
import { poolCap } from "@/lib/engine/select-sections";
import { getCachedBlurbs } from "@/lib/engine/blurb-cache";
import { sendLetterNotification, resendConfigured, sendOpsAlert } from "@/lib/email";
import { letterUrl as buildLetterUrl } from "@/lib/letter-token";
import { currentPeriodIso, sinceLastSendWindow, isSendDay } from "@/lib/cadence";
import { braveRateLimitedCount } from "@/lib/brave";
import { youRateLimitedCount } from "@/lib/you-search";
import { groqRateLimitedCount } from "@/lib/engine/groq-client";
import { deepseekRateLimitedCount, deepseekCallCount } from "@/lib/engine/deepseek-client";
import { topicBlurbPaidCallCount } from "@/lib/engine/topic-blurb";
import { topicLabel, mapTopicsForUser, GENERIC_FALLBACK_TOPICS } from "@/lib/topics";
import { withDeadline } from "@/lib/with-deadline";
import type { UserProfile, TopicId, Issue } from "@/lib/types";
import type { TopicBlurb } from "@/lib/engine/types";
import { clampQuota } from "@/lib/types";
import { coerceGender } from "@/lib/demographics";
import { coerceThemeId } from "@/lib/themes";
import { RECLAIM_GRANDFATHER_CUTOFF } from "@/lib/delivery-proof";

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
// couple of Supabase round trips +, since retryResendCall's 2026-08-05
// backoff-retry addition, up to 3 Resend attempts with ~2.4s of backoff
// delay between them on transient errors — still comfortably inside this
// budget), tight relative to CRON_SAFETY_MARGIN_MS below (110s generation +
// 45s here = 155s max real per-subscriber time, under the 170s reserved).
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

// Cost-aware brake, alongside the wall-clock one above (alpha-spend-cap-01,
// found in review 2026-08-06 — see alpha_full_app_review_2026-08-05.md).
// Gemini/Groq/Brave/You.com all have a real free-tier wall that organically
// stops a runaway (they just start 429ing); DeepSeek/Haiku/Sonnet don't — a
// real funded balance with no automatic backstop (see deepseek-client.ts's
// own header comment). This bounds the genuinely uncapped-cost tiers
// specifically: topicBlurbPaidCallCount() (Haiku+Sonnet, incremented once
// per real anthropicClient().messages.create() call, retries included) plus
// deepseekCallCount(). A normal run's topic-blurb cache means most days stay
// a small fraction of this (only DISTINCT topics across the whole
// subscriber list ever reach a paid tier, and most drafts succeed at the
// free Gemini/Groq tiers first) — this is a circuit breaker for the
// described failure mode (a bug or provider incident forcing every topic
// through the full waterfall), not a model of normal usage. FIRST-PASS
// ESTIMATE, not measured against real production totals (no live spend
// telemetry to calibrate against yet) — generous enough not to false-trip a
// busy day, tight enough to stop real bleeding well before it becomes a
// large bill. Revisit once a real run's totals are observed (the summary
// below logs them every run specifically so this can be tuned later).
const PAID_CALL_CEILING = 400;

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
  // Cadence gate. CADENCE_UTC_DAYS is every day today, so this is currently a
  // no-op -- but nothing else in this route or the GitHub Actions schedule
  // that drives it (daily-send.yml fires every calendar day, no day-of-week
  // restriction) enforces cadence at all. Without this check, narrowing
  // CADENCE_UTC_DAYS in the future would silently do nothing: the cron would
  // keep firing and this route would keep sending every subscriber a letter
  // every day regardless. An explicit ?weekOf= override always bypasses this
  // (a backfill/admin call must still work on an off-cadence historical date).
  if (!weekOfOverride && !isSendDay(weekOf)) {
    return NextResponse.json({ skipped: "not a scheduled cadence day", weekOf });
  }
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
  // Paginated fetch -- an unbounded .select() here silently truncates at
  // PostgREST's default db.max_rows (1,000), and does so with error === null,
  // so nothing downstream would ever see a failure. Every guard built on top
  // of `rows` further down (alreadyDelivered's and pendingIssues' own
  // .in("user_id", rows.map(...)) prefetches below, priorIssueCountsPromise's
  // RPC, the send loop itself) is correctly bounded RELATIVE TO rows -- but
  // all of that is moot if `rows` was already missing subscribers before any
  // of them ran. Past ~1,000 active subscribers, and with no .order() an
  // unbounded select's row order isn't even guaranteed stable run to run, so
  // the dropped slice isn't reliably "the newest 1,000" -- it's arbitrary,
  // and those subscribers get zero letter, zero `deferred` entry, and zero
  // ops alert. Same fix, same reasoning as gatherStats() in
  // app/api/admin/users/route.ts.
  const SUBSCRIBER_PAGE_SIZE = 1000;
  const rows: SubscriberRow[] = [];
  for (let from = 0; ; from += SUBSCRIBER_PAGE_SIZE) {
    const { data: page, error } = await sb
      .from("users")
      .select(
        "id, email, first_name, city, job_blurb, project_blurb, fun_blurb, birthday, gender, theme, topics, topic_quota"
      )
      .not("subscribed_at", "is", null)
      .or(`cancelled_at.is.null,cancelled_at.gt.${nowIso}`)
      .is("unsubscribed_at", null)
      .order("id")
      .range(from, from + SUBSCRIBER_PAGE_SIZE - 1);

    if (error) {
      console.error("[cron/weekly-send] subscriber fetch failed:", error.message);
      return NextResponse.json({ error: "Couldn't fetch subscribers. Try again." }, { status: 500 });
    }
    if (!page || page.length === 0) break;
    rows.push(...(page as SubscriberRow[]));
    if (page.length < SUBSCRIBER_PAGE_SIZE) break;
  }

  // Kick off the PRIOR DELIVERED issue count RPC right away, unawaited --
  // it queries week_of < weekOf, a disjoint, strictly-earlier row set than
  // every other query in this file (all scoped to week_of = weekOf), so it
  // has no ordering dependency on the reclaim write or the two prefetches
  // below and can run the whole time they do instead of adding a fifth,
  // fully-serial round trip. Awaited further down where priorIssueCount is
  // populated -- see that block's own comment for why this is a single
  // grouped-aggregate RPC in the first place.
  //
  // The trailing .then((r) => r) is load-bearing, not decoration: supabase-js
  // query builders (confirmed by reading node_modules/@supabase/postgrest-js)
  // are LAZY thenables — the underlying fetch only fires the first time
  // something calls .then()/await on the builder, not when the builder is
  // constructed. Without this, holding the bare builder in a variable and
  // awaiting it later doesn't kick anything off early at all — the request
  // would only start at the same point the old fully-sequential code did,
  // silently defeating this whole optimization while looking identical to a
  // real fix. Calling .then() here converts it into an already-in-flight
  // native Promise immediately; the later `await priorIssueCountsPromise`
  // just awaits that Promise and never re-invokes the builder.
  const priorIssueCountsPromise =
    rows.length > 0
      ? sb
          .rpc("prior_issue_counts", {
            week_of_cutoff: weekOf,
            target_user_ids: rows.map((r) => r.id),
          })
          .then((r) => r)
      : null;
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
  // Baselined the same way as the four rate-limit counters above, but this
  // pair feeds an actual mid-loop brake (PAID_CALL_CEILING below), not just
  // the post-run summary — see that constant's comment for why.
  const paidCallBaseline = topicBlurbPaidCallCount() + deepseekCallCount();
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
  // Also holds anyone deferred by PAID_CALL_CEILING (paidCallCeilingHit
  // below distinguishes which one, for the ops alert) — same recovery path
  // either way (?weekOf= backfill), so one shared list is enough.
  const deferred: string[] = [];
  // Set once PAID_CALL_CEILING trips, so the ops alert below can name the
  // real cause instead of lumping a cost-brake defer in with a scale one.
  let paidCallCeilingHit = false;

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
  // ONE hard-failure cache shared across every subscriber in THIS run, same
  // sharing model as dryCache/inFlight above — see generateIssue's own
  // comment on the failedCache param (alpha-spend-cap-02). Stops a topic
  // that exhausted every generation tier for one subscriber from paying the
  // full waterfall again for the filler pass, the fast-fallback layer below,
  // or any later subscriber sharing that topic this run.
  const failedCache = new Set<string>();

  // Allow ?force=1 to override the delivered_at idempotency gate (only the
  // admin will ever hit this with the CRON_SECRET in hand; useful for explicit
  // resend-this-week ops, never set by the Vercel cron itself).
  const force = url.searchParams.get("force") === "1";

  console.log(
    `[cron/weekly-send] weekOf=${weekOf} subscribers=${rows.length} force=${force}`
  );

  // RECLAIM stuck claims for this week_of before anything else runs. Closes
  // the biggest remaining single point of failure the 2026-08-05 resilience
  // audit found: runPersistAndSend stamps delivered_at as an atomic CLAIM
  // BEFORE calling Resend (see its own comment). If the process dies in
  // between -- a killed GitHub Actions runner, an OOM -- the row is left
  // with delivered_at set and no email ever sent, and every other check in
  // this file (alreadyDelivered below, the RETRY-SAFETY reuse block, the
  // watchdog's own delivered_count) reads that as "done." A row matching
  // delivered_at set + resend_message_id still null + past a safety margin
  // comfortably longer than any legitimate in-flight send
  // (PERSIST_AND_SEND_DEADLINE_MS is 45s, plus the drain-on-kill grace) is
  // unambiguously stuck, not just slow -- nulling delivered_at puts that
  // subscriber back in the normal undelivered pool for THIS run.
  const RECLAIM_SAFETY_MARGIN_MS = 10 * 60 * 1000; // 10 minutes
  // Grandfather cutoff (imported, see lib/delivery-proof.ts), same value and
  // same reasoning as watchdog_delivery_check()'s 2026-08-05 migration:
  // resend_message_id was added to the schema AFTER that day's real 14:00
  // UTC send already ran on the old code, so every one of that day's
  // genuine deliveries has delivered_at set and resend_message_id null --
  // not because they're stuck, but because the column didn't exist yet.
  // Without this, re-processing weekOf=2026-08-05 for any reason (a manual
  // admin re-run, a ?weekOf= backfill) would "reclaim" real,
  // already-delivered letters and reprocess them. Harmless to send (Resend's
  // idempotency key + RETRY-SAFETY content reuse dedupe it), but it's still
  // wrong to treat a real success as broken, and it would fire a false
  // "reclaimed a stuck claim" ops alert. Irrelevant for every future day's
  // send -- only matters for reprocessing this exact date.
  if (!force) {
    const reclaimCutoff = new Date(Date.now() - RECLAIM_SAFETY_MARGIN_MS).toISOString();
    const { data: reclaimed, error: reclaimErr } = await sb
      .from("issues")
      .update({ delivered_at: null })
      .eq("week_of", weekOf)
      .is("resend_message_id", null)
      .not("delivered_at", "is", null)
      .gte("delivered_at", RECLAIM_GRANDFATHER_CUTOFF)
      .lt("delivered_at", reclaimCutoff)
      .select("user_id");
    if (reclaimErr) {
      // Safe to continue without reclaiming -- worst case, a stuck row
      // just stays stuck one more run and gets caught next time.
      console.warn(
        `[cron/weekly-send] stuck-claim reclaim query failed: ${reclaimErr.message} — continuing without reclaiming.`
      );
    } else if ((reclaimed?.length ?? 0) > 0) {
      const ids = reclaimed!.map((r) => r.user_id).join(", ");
      console.warn(
        `[cron/weekly-send] RECLAIMED ${reclaimed!.length} stuck claim(s) for weekOf=${weekOf} (delivered_at was set with no proof of send, older than ${RECLAIM_SAFETY_MARGIN_MS / 60000}min): ${ids}`
      );
      // Visible on purpose: a reclaim means a PRIOR run genuinely died
      // mid-send. That's worth Algy knowing happened even though this run
      // is about to self-heal it -- silently fixing it would just move the
      // "nothing noticed" gap one step over. Best-effort, never blocks.
      await sendOpsAlert(
        `[alpha] Reclaimed ${reclaimed!.length} stuck claim(s)`,
        `weekOf=${weekOf}: ${reclaimed!.length} subscriber(s) had delivered_at set with no proof of send (older than ${RECLAIM_SAFETY_MARGIN_MS / 60000} minutes) -- a prior run likely died between claiming and Resend confirming. Reclaimed and will be retried this run. user_id(s): ${ids}`
      );
    }
  }

  // Prefetch this week's delivered stamps and each subscriber's persisted-
  // but-undelivered issue together via Promise.all -- neither query depends
  // on the other's result (only on the reclaim write above, which both read
  // after), so there's no reason to pay for them as two serial round trips.
  // Each query keeps its own original guard/comment below.
  const alreadyDelivered = new Set<string>();
  const pendingIssues = new Map<
    string,
    { volume: number; number: number; editor_intro: string; sections: Issue["sections"] }
  >();
  {
    // Both queries below filter with .in("user_id", ...) rather than a
    // .rpc() (contrast priorIssueCountsPromise above), so supabase-js sends
    // them as a GET with the id list serialized into the URL's query string
    // (confirmed by reading node_modules/@supabase/postgrest-js) -- roughly
    // 37 chars per UUID. Unchunked, that scales the URL directly with
    // rows.length: ~18.5KB at 500 subscribers, ~37KB at 1,000, well past
    // Cloudflare Workers' documented 16KB fetch() URL limit and Supabase's
    // own gateway cap. Left unchunked, the 1,000-row select-cap problem this
    // block was written to close (see below) would just be traded for a
    // 400/414 -- or a silent proxy-level truncation -- at a similar or lower
    // subscriber count. Chunking the id list keeps every request's filter
    // comfortably under those limits no matter how large rows.length grows.
    const PREFETCH_ID_CHUNK_SIZE = 200;
    const idChunks: string[][] = [];
    for (let i = 0; i < rows.length; i += PREFETCH_ID_CHUNK_SIZE) {
      idChunks.push(rows.slice(i, i + PREFETCH_ID_CHUNK_SIZE).map((r) => r.id));
    }

    // Prefetch this week's delivered stamps in one query PER CHUNK (was a
    // per-subscriber lookup — N+1 that adds a round trip per user as the
    // list grows). Scoped with .in("user_id", ...) to exactly this run's
    // active subscriber list -- besides narrowing the scan, this also
    // bounds the row count to rows.length instead of "however many
    // subscribers got a letter today across the whole table", so
    // PostgREST's silent 1,000-row select cap can't bite even once
    // active-subscriber count is large (a much higher, less urgent bar than
    // priorIssueCount's LIFETIME-count problem below, but free to close
    // outright here rather than just deferring it).
    const stampsPromise =
      !force && rows.length > 0
        ? Promise.all(
            idChunks.map((ids) =>
              sb
                .from("issues")
                .select("user_id")
                .eq("week_of", weekOf)
                .not("delivered_at", "is", null)
                .in("user_id", ids)
            )
          ).then((results) => results.flatMap((r) => r.data ?? []))
        : null;
    // Prefetch each subscriber's persisted-but-undelivered issue (retry-safety
    // reuse below, near runPersistAndSend) in one query PER CHUNK — was a
    // per-subscriber lookup inside the loop, mirroring the alreadyDelivered
    // fix above.
    const pendingPromise = Promise.all(
      idChunks.map((ids) =>
        sb
          .from("issues")
          .select("user_id, volume, number, editor_intro, sections")
          .eq("week_of", weekOf)
          .is("delivered_at", null)
          .in("user_id", ids)
      )
    ).then((results) => results.flatMap((r) => r.data ?? []));

    const [stampsResult, pendingResult] = await Promise.all([
      stampsPromise ?? Promise.resolve(null),
      pendingPromise,
    ]);
    for (const s of (stampsResult ?? []) as Array<{ user_id: string }>) {
      alreadyDelivered.add(s.user_id);
    }
    for (const p of (pendingResult ?? []) as Array<{
      user_id: string;
      volume: number;
      number: number;
      editor_intro: string;
      sections: Issue["sections"];
    }>) {
      pendingIssues.set(p.user_id, p);
    }
  }

  // Prefetch each subscriber's PRIOR DELIVERED issue count (periods strictly
  // before this one) → "Issue N" in the email subject is this reader's Nth
  // letter actually delivered (issueNumber = priorCount + 1), accurate on
  // re-runs too. Filters delivered_at NOT NULL so a generated-but-never-sent
  // row doesn't inflate the number.
  //
  // ONE grouped-aggregate RPC call, not N per-subscriber COUNT queries (was
  // Promise.all(rows.map(...)) -- parallel, not sequential, but still N
  // round trips). This value is a per-subscriber LIFETIME count, which grows
  // unbounded with time (unlike alreadyDelivered above, which is bounded by
  // today's active-subscriber count) -- still deliberately a COUNT
  // aggregate, not a row-fetch-and-tally, since PostgREST's silent 1,000-row
  // select cap would otherwise start silently undercounting "Issue N" within
  // a few years at daily cadence. See the prior_issue_counts() migration
  // (2026-08-05) for the SQL; this was the "revisit with a grouped aggregate
  // RPC" the old comment here already flagged as the eventual fix. Started
  // above (priorIssueCountsPromise) so its round trip overlaps the reclaim
  // and Promise.all prefetches instead of stacking after them; awaited here.
  const priorIssueCount = new Map<string, number>();
  if (priorIssueCountsPromise) {
    const { data: counts, error: countsErr } = await priorIssueCountsPromise;
    if (countsErr) {
      // Fail soft, not hard: a missing/wrong "Issue N" is a cosmetic subject-
      // line problem, never a reason to block the actual send. Every
      // subscriber just falls back to priorCount=0 (issueNumber=1) for this
      // run only -- annoying if it happens, but self-corrects the next time
      // this query succeeds since it's recomputed fresh every run, not
      // persisted state that could get stuck wrong.
      console.warn(`[cron/weekly-send] prior_issue_counts RPC failed: ${countsErr.message} — "Issue N" will read 1 for everyone this run.`);
    } else {
      for (const c of (counts ?? []) as Array<{ user_id: string; prior_count: number }>) {
        priorIssueCount.set(c.user_id, c.prior_count);
      }
    }
  }

  // Sequential per-subscriber, but topic blurbs cache across subscribers so
  // total Claude time is bounded by topics-this-week, not users × topics.
  // NOTE for scale: "~100+ subscribers" undersells where the real ceiling
  // is. Even with every topic cached (zero generation cost), each
  // subscriber still pays runPersistAndSend's ~3-4 sequential network round
  // trips (issue upsert, delivered_at claim, Resend call, proof-of-send
  // write) — at a conservative ~400-600ms combined, that alone is a fixed
  // floor of roughly 2,200-3,300 subscribers before CRON_TIME_BUDGET_MS
  // (below) is exhausted by overhead, independent of and well before any
  // generation cost becomes the bottleneck. CRON_TIME_BUDGET_MS is the
  // interim safety net — it stops starting new subscribers before that
  // becomes a silent Vercel kill, deferring the rest loudly instead (though
  // a deferred subscriber is effectively skipped, not delayed: tomorrow's
  // cron computes a new weekOf and never revisits today's unprocessed
  // tail). The real fix at that scale is still chunked sends (cursor param
  // + multiple cron slots) — not parallelizing generation (Claude rate
  // limits bind first there), though batching the persist+send tail alone
  // would push the overhead floor above out further — not built yet.
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
        `[cron/weekly-send] SKIPPED PAID SUBSCRIBER (got nothing) → ${row.id} ` +
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
      console.log(`[cron/weekly-send] skipped (already delivered this period) → ${row.id}`);
      continue;
    }

    // Time budget: stop STARTING new subscribers once we're close enough to
    // maxDuration that finishing this one could still blow the cap (see
    // CRON_TIME_BUDGET_MS). Checked here (after the cheap skip-checks above)
    // so a subscriber who didn't actually need work isn't misreported as
    // deferred.
    if (Date.now() - startedAt > CRON_TIME_BUDGET_MS) {
      deferred.push(row.email);
      console.warn(`[cron/weekly-send] DEFERRED (time budget exhausted) → ${row.id}`);
      continue;
    }

    // Cost budget: same defer-not-crash treatment as the time budget above,
    // but for real spend instead of wall-clock (see PAID_CALL_CEILING).
    // Checked every iteration (cheap — two counter reads) so a mid-run spike
    // stops the bleeding immediately rather than waiting for the next batch.
    if (topicBlurbPaidCallCount() + deepseekCallCount() - paidCallBaseline > PAID_CALL_CEILING) {
      paidCallCeilingHit = true;
      deferred.push(row.email);
      console.warn(`[cron/weekly-send] DEFERRED (paid-call ceiling exhausted) → ${row.id}`);
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
      // Not built on lib/letter-delivery.ts's shared DeliveryStore/
      // deliverLetterOnce (used by /api/generate's onboarding first-letter
      // path) — deliberately: that interface's claim() only takes
      // (userId, weekOf, stamp), with no way to bundle arbitrary content
      // fields into the same atomic write, which this UPDATE needs to do
      // (see below). Both implementations still share the identical
      // `.eq(user_id).eq(week_of).is("delivered_at", null)` compare-and-swap
      // predicate — keep that predicate in sync if either changes. The
      // reclaim step above isn't scoped to claims THIS file created: it
      // queries by week_of alone, so a stuck claim left by /api/generate
      // (e.g. a hard crash between its claim and release) gets swept up and
      // retried here too, on this period's next cron tick.
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
        // Re-check unsubscribed_at RIGHT before the claim (alpha-spend-cap-
        // adjacent finding, round 12, 2026-08-06): `rows` is a snapshot taken
        // once at the top of the run (`.is("unsubscribed_at", null)`), but a
        // run can span the loop's full sequential duration — a subscriber
        // who unsubscribes after being snapshotted but before their own turn
        // would otherwise still get sent that day's letter (including a
        // resend of a PRIOR letter, if a backup layer below ends up covering
        // them), minutes after explicitly opting out. Can't fold this into
        // the atomic claim UPDATE below -- unsubscribed_at lives on `users`,
        // that UPDATE targets `issues`, and PostgREST doesn't support a
        // cross-table filter on an UPDATE. One extra read narrows the race
        // window from "the whole run" to "one Supabase round trip" instead.
        const { data: freshUser, error: freshUserErr } = await sb
          .from("users")
          .select("unsubscribed_at")
          .eq("id", row.id)
          .maybeSingle();
        if (freshUserErr) {
          // Fail open, same reasoning as every other best-effort guard in
          // this file: a lookup hiccup must never block a legitimate send.
          console.warn(`[cron/weekly-send] unsubscribed_at re-check failed → ${row.id}: ${freshUserErr.message}`);
        } else if (freshUser?.unsubscribed_at) {
          console.log(`[cron/weekly-send] skipped (unsubscribed mid-run) → ${row.id}`);
          return;
        }

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
          console.log(`[cron/weekly-send] skipped (claimed by a concurrent run) → ${row.id}`);
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
      let resendMessageId: string | undefined;
      try {
        const sendResult = await sendLetterNotification({
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
        resendMessageId = sendResult.id || undefined;
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
              `[cron/weekly-send] send failed AND claim rollback failed for ${row.id}: ${rollbackErr.message} — may be skipped (missed) next run.`
            );
          }
        }
        throw sendErr;
      }

      // Proof of send -- the fix for the "stuck claim" gap flagged by the
      // 2026-08-05 resilience audit as the biggest remaining single point of
      // failure: delivered_at is stamped as a CLAIM before this point, so a
      // process that dies between winning the claim and Resend confirming
      // (a killed runner, an OOM) leaves a row that reads as "delivered" to
      // every check in the system forever, with no email ever having gone
      // out. Only ever set here, AFTER sendLetterNotification has already
      // returned successfully -- this column existing (or not) on a
      // delivered_at-set row is exactly what the reclaim step near the top
      // of this handler uses to tell a genuine success from a stuck claim.
      // Best-effort: the email already sent, so a failure to record this
      // must never fail the request -- it only means this row looks like a
      // stuck claim until the NEXT run's reclaim step, which is always safe
      // (a spurious reclaim just costs one redundant Resend call, which
      // Resend's own idempotency key collapses harmlessly).
      if (resendMessageId) {
        const { error: proofErr } = await sb
          .from("issues")
          .update({ resend_message_id: resendMessageId })
          .eq("user_id", row.id)
          .eq("week_of", weekOf);
        if (proofErr) {
          console.warn(
            `[cron/weekly-send] sent OK but proof-of-send write failed for ${row.id}: ${proofErr.message} — row will look like a stuck claim until the next reclaim pass (harmless, Resend idempotency covers the redundant retry).`
          );
        }
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
            `[cron/weekly-send] force resend sent but delivered_at stamp failed for ${row.id}: ${stampErr.message}`
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
        console.log(`[cron/weekly-send] sent BACKUP-SHARED (borrowed from today's cache) → ${row.id} (${labels})`);
      } else if (kind === "backup-fresh") {
        backupFreshSent++;
        backupFreshSentEmails.push(row.email);
        console.log(`[cron/weekly-send] sent BACKUP-FRESH (small fast retry) → ${row.id} (${labels})`);
      } else if (kind === "backup-stale") {
        backupStaleSent++;
        backupStaleSentEmails.push(row.email);
        console.log(`[cron/weekly-send] sent BACKUP-STALE (resend of a prior letter) → ${row.id} (${labels})`);
      } else {
        sent++;
        console.log(`[cron/weekly-send] sent → ${row.id} (${labels})`);
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
              generateIssue(profile, weekOf, letterSize, freshness, dryCache, inFlight, failedCache),
              PER_USER_DEADLINE_MS,
              `generateIssue(${row.id})`
            );
      if (reusableSections && reusableSections.length > 0) {
        console.log(`[cron/weekly-send] reusing already-generated issue (retry, zero new AI cost) → ${row.id}`);
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
      await withDeadline(persistAndSend, PERSIST_AND_SEND_DEADLINE_MS, `persist+send(${row.id})`);
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : "unknown";
      failures.push({ email: row.email, error: msg });
      console.error(`[cron/weekly-send] FAILED → ${row.id}: ${msg}`);

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
          console.warn(`[cron/weekly-send] cache-borrow succeeded → ${row.id} (${chosen.length} shared topics)`);
        }
      } catch (cacheErr) {
        console.warn(
          `[cron/weekly-send] cache-borrow check failed → ${row.id}: ${cacheErr instanceof Error ? cacheErr.message : cacheErr}`
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
              generateIssue({ ...profile, topics: smallPool }, weekOf, smallPool.length, freshness, dryCache, inFlight, failedCache),
              FAST_FALLBACK_DEADLINE_MS,
              `fast-fallback(${row.id})`
            );
            backupKind = "backup-fresh";
            console.warn(`[cron/weekly-send] fast fallback succeeded → ${row.id} (${smallPool.length} topics)`);
          }
        } catch (fastErr) {
          console.warn(
            `[cron/weekly-send] fast fallback ALSO failed → ${row.id}: ${fastErr instanceof Error ? fastErr.message : fastErr}`
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
            `[cron/weekly-send] backup lookup failed → ${row.id}: ${lookupErr instanceof Error ? lookupErr.message : lookupErr}`
          );
        }
      }

      if (backupIssue && backupKind) {
        try {
          const backupSend = runPersistAndSend(backupIssue, backupKind);
          after(backupSend.catch(() => undefined));
          await withDeadline(backupSend, PERSIST_AND_SEND_DEADLINE_MS, `backup-send(${row.id})`);
        } catch (backupErr) {
          console.error(
            `[cron/weekly-send] backup send failed → ${row.id}: ${backupErr instanceof Error ? backupErr.message : backupErr}`
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
  // Logged every run (not just when the ceiling trips) specifically so a
  // real day's totals can calibrate PAID_CALL_CEILING's first-pass estimate
  // — see that constant's comment.
  const paidCallsThisRun = topicBlurbPaidCallCount() + deepseekCallCount() - paidCallBaseline;
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
    paidCallsThisRun,
    paidCallCeilingHit,
    elapsedMs,
    failures: failures.slice(0, 25),
  };
  // Log a redacted copy -- `summary` itself (with real emails) stays intact
  // below for the CRON_SECRET-gated JSON response and the ops-alert email,
  // both more access-controlled surfaces than the Cloudflare Worker log
  // stream. A bad run (many skips/failures/deferrals) would otherwise put a
  // large slice of the subscriber list's raw emails into one log line.
  console.log("[cron/weekly-send] summary:", JSON.stringify({
    ...summary,
    backupSharedSentEmails: backupSharedSentEmails.length,
    backupFreshSentEmails: backupFreshSentEmails.length,
    backupStaleSentEmails: backupStaleSentEmails.length,
    skippedBlankSubscribers: skippedBlankSubscribers.length,
    deferred: deferred.length,
    failures: failures.length,
  }));

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
    deferred.length > 0 ||
    paidCallCeilingHit
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
        ? `${paidCallCeilingHit ? "Time budget and/or the paid-call cost ceiling" : "Time budget"} exhausted before reaching everyone — ${deferred.length} subscriber(s) got NO letter this run: ${deferred.join(", ")}. Safe to recover: rerun this exact date with ?weekOf=${weekOf} (already-delivered subscribers are skipped automatically).${paidCallCeilingHit ? "" : " This is a scale signal — the subscriber list is big enough that the daily run is pressing against Vercel's time cap."}`
        : "",
      // PAID_CALL_CEILING tripped — a materially different signal than a
      // scale-driven time-budget defer above: this means Haiku+Sonnet+
      // DeepSeek combined made more real, billed calls than a normal day's
      // topic-cache-sharing should ever produce, which is exactly the
      // "systemic failure forcing every topic through the full waterfall"
      // scenario alpha-spend-cap-01 exists to catch. Worth checking
      // Anthropic/DeepSeek dashboards for actual spend, not just quota.
      paidCallCeilingHit
        ? `COST BRAKE TRIPPED: paid-tier calls (Haiku+Sonnet+DeepSeek) hit ${paidCallsThisRun} this run, over the ${PAID_CALL_CEILING} ceiling — stopped starting new subscribers early. Check for a systemic generation failure (every topic escalating through the full waterfall) rather than assuming this is just a busy day.`
        : "",
    ].filter(Boolean);
    await sendOpsAlert(
      `[alpha] send ${weekOf}: ${skippedBlankSubscribers.length} blanked, ${failed} failed (${genuinelyMissed} genuinely missed)${braveRateLimited > 0 ? ", Brave quota hit" : ""}${groqRateLimited > 0 ? ", Groq quota hit" : ""}${deepseekRateLimited > 0 ? ", DeepSeek quota hit" : ""}${deferred.length > 0 ? `, ${deferred.length} deferred` : ""}${paidCallCeilingHit ? ", COST BRAKE TRIPPED" : ""}`,
      lines.join("\n")
    );
  }

  return NextResponse.json(summary);
}

