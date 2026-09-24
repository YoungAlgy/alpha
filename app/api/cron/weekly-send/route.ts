import { NextResponse, after } from "next/server";
import { SUBSCRIBER_LETTERS_ENABLED } from "@/lib/subscriber-delivery-policy";
import crypto from "crypto";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { generateIssue, formatWeekOf } from "@/lib/engine/assemble";
import { poolCap } from "@/lib/engine/select-sections";
import { getCachedBlurbs } from "@/lib/engine/blurb-cache";
import {
  prepareLetterNotification,
  resendConfigured,
  sendOpsAlert,
  sendPreparedSubscriberEmail,
} from "@/lib/email";
import { letterUrl as buildLetterUrl } from "@/lib/letter-token";
import { currentPeriodIso, sinceLastSendWindow, isSendDay } from "@/lib/cadence";
import { braveRateLimitedCount, type BraveQuotaState } from "@/lib/brave";
import { youRateLimitedCount } from "@/lib/you-search";
import { geminiRateLimitedCount } from "@/lib/engine/gemini-client";
import { groqRateLimitedCount } from "@/lib/engine/groq-client";
import { deepseekRateLimitedCount, deepseekCallCount } from "@/lib/engine/deepseek-client";
import { topicBlurbPaidCallCount } from "@/lib/engine/topic-blurb";
import { editorNoteAnthropicCallCount } from "@/lib/engine/editor-note";
import {
  paidCallsSinceBaseline,
  type PaidCallSnapshot,
} from "@/lib/engine/paid-call-budget";
import { createDailyPaidCallGuard } from "@/lib/paid-call-reservation";
import { topicLabel, mapTopicsForUser, GENERIC_FALLBACK_TOPICS } from "@/lib/topics";
import { withDeadline } from "@/lib/with-deadline";
import { hasReaderAccess } from "@/lib/access";
import type { UserProfile, TopicId, Issue } from "@/lib/types";
import type { TopicBlurb } from "@/lib/engine/types";
import { clampQuota } from "@/lib/types";
import { coerceGender, isValidCalendarDateString } from "@/lib/demographics";
import { coerceThemeId } from "@/lib/themes";
import { RECLAIM_GRANDFATHER_CUTOFF } from "@/lib/delivery-proof";
import { scrubExpiredCheckoutProfiles } from "@/lib/checkout-profile-retention";
import { sendWithResendDeliveryAttempt } from "@/lib/resend-delivery-attempt";

export const runtime = "nodejs";
// This value no longer means what its name implies. It WAS a Vercel Pro
// platform directive (Vercel reads `maxDuration` and enforces it); the send
// now runs via `next start` on GitHub Actions (.github/workflows/
// daily-send.yml), which reads nothing here and enforces nothing here — the
// real ceiling is that workflow's own `curl --max-time` (1500s) and job
// `timeout-minutes` (90). Kept only because CRON_TIME_BUDGET_MS below is
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
// Supabase or Resend call would park the whole per-subscriber loop until the
// real host ceiling kills it (the GitHub Actions workflow's own `curl
// --max-time` (1500s) / job `timeout-minutes` (90) — see the `maxDuration`
// comment above for why that value no longer means a Vercel platform
// directive), silently dropping every later subscriber in the same run with
// no ops alert (that code never runs after a kill). Safe to
// bound: withDeadline only stops WAITING, it doesn't cancel the underlying
// call, so the detached continuation (including the send-failure rollback)
// still runs to completion in the background regardless of whether this
// timeout fires — a slow-but-eventually-successful send still lands and its
// delivered_at claim stays correctly set, so this can't cause a duplicate
// email on the next run's retry. Generous relative to normal latency (a
// couple of Supabase round trips +, since retryResendCall's 2026-08-05
// backoff-retry addition, up to 3 Resend attempts with ~2.4s of backoff
// delay between them on transient errors — still comfortably inside this
  // budget), and included in the full worst-case safety margin below.
const PERSIST_AND_SEND_DEADLINE_MS = 45_000;

// Time-budget safety valve. The loop below is sequential (topic-blurb caching
// is what bounds cost, not parallelism), so at enough subscribers a run of
// near-deadline generations can approach the real host ceiling (the GitHub
// Actions workflow's 1500s curl budget / 90min job timeout — see the
// `maxDuration` comment above; this constant's own name is legacy from when
// that value was a Vercel platform directive). Reserve enough of it to (a)
// let the LAST subscriber we DO start exhaust primary generation, the fast
// generation fallback, and persistence/delivery before we'd hit the wall,
// then leave real margin for the summary + ops-alert email. Past this point,
// remaining subscribers are
// DEFERRED (recorded, not attempted) rather than risking a hard kill
// mid-loop, which would silently truncate the send before the ops alert can
// run. Deferred readers remain visibly uncovered. The inspected-position
// cursor still moves through the classified page, and later same-day slots
// wrap around to retry any reader without proof of delivery.
const CRON_SAFETY_MARGIN_MS =
  PER_USER_DEADLINE_MS +
  FAST_FALLBACK_DEADLINE_MS +
  PERSIST_AND_SEND_DEADLINE_MS +
  30_000;
const CRON_TIME_BUDGET_MS = maxDuration * 1000 - CRON_SAFETY_MARGIN_MS;

// Cost-aware brake, alongside the wall-clock one above (alpha-spend-cap-01,
// found in review 2026-08-06 — see alpha_full_app_review_2026-08-05.md).
// Gemini/Groq/Brave/You.com all have a real free-tier wall that organically
// stops a runaway (they just start 429ing); DeepSeek/Haiku/Sonnet don't — a
// real funded balance with no automatic backstop (see deepseek-client.ts's
// own header comment). This bounds the genuinely uncapped-cost tiers
// specifically: topicBlurbPaidCallCount() (Haiku+Sonnet),
// editorNoteAnthropicCallCount() (Opus, including its optional retry), plus
// deepseekCallCount(). Each increments before a real paid attempt. A normal
// run's topic-blurb cache means most days stay
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

function currentPaidCallSnapshot(): PaidCallSnapshot {
  return {
    topicBlurbAnthropic: topicBlurbPaidCallCount(),
    editorNoteAnthropic: editorNoteAnthropicCallCount(),
    deepseek: deepseekCallCount(),
  };
}

const PERSISTED_ITEM_KINDS = new Set([
  "read",
  "watch",
  "listen",
  "try",
  "post",
  "book",
  "event",
  "note",
]);

function isValidPersistedReference(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const ref = value as { label?: unknown; url?: unknown; note?: unknown };
  return (
    typeof ref.label === "string" &&
    typeof ref.url === "string" &&
    (ref.note === undefined || typeof ref.note === "string")
  );
}

function isValidPersistedItem(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as {
    kind?: unknown;
    headline?: unknown;
    body?: unknown;
    primaryRef?: unknown;
    supplementaryRefs?: unknown;
    source?: unknown;
    sourceUrl?: unknown;
  };
  return (
    typeof item.kind === "string" &&
    PERSISTED_ITEM_KINDS.has(item.kind) &&
    typeof item.headline === "string" &&
    typeof item.body === "string" &&
    (item.primaryRef === undefined || isValidPersistedReference(item.primaryRef)) &&
    (item.supplementaryRefs === undefined ||
      (Array.isArray(item.supplementaryRefs) &&
        item.supplementaryRefs.every(isValidPersistedReference))) &&
    (item.source === undefined || typeof item.source === "string") &&
    (item.sourceUrl === undefined || typeof item.sourceUrl === "string")
  );
}

// Shape guard for a persisted `issues.sections` row before the RETRY-SAFETY
// path (below) trusts it enough to skip generateIssue() entirely and email
// it as-is. That path exists specifically to reuse content a PRIOR call
// already wrote (see its own comment on the Resend idempotency-key mismatch
// this avoids), so in the common case the row is well-formed. But JSONB
// carries no runtime shape guarantee -- a partial write from a killed
// process, a future upsert-shape change, or a manual Supabase edit would
// otherwise flow straight into a real subscriber's email unvalidated. Mirrors
// topic-blurb.ts's extractJson's own shape check on model output, just
// applied to DB-read content instead.
function isValidPersistedSections(sections: unknown): sections is Issue["sections"] {
  return (
    Array.isArray(sections) &&
    sections.length > 0 &&
    sections.every(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof (s as { topicId?: unknown }).topicId === "string" &&
        typeof (s as { topicLabel?: unknown }).topicLabel === "string" &&
        typeof (s as { intro?: unknown }).intro === "string" &&
        Array.isArray((s as { items?: unknown }).items) &&
        ((s as { items: unknown[] }).items.length > 0) &&
        (s as { items: unknown[] }).items.every(isValidPersistedItem)
    )
  );
}

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

type DeliveryAttemptOutcome = "settled" | "retry-required";
type DeliveryCursorState =
  | "advanced"
  | "advanced_with_retry"
  | "override_read_only"
  | "empty"
  | "advance_failed";

// Daily send entrypoint (every day since 2026-07-03; previously Sun/Tue/Thu).
// GitHub Actions' daily-send.yml sends the Authorization header of
// `Bearer ${CRON_SECRET}` via curl (its "Start the server and run the real
// daily send" step). We refuse anything else, so this can't be hit from the
// open web.
//
// Behavior:
//   1. Find all users where subscribed_at IS NOT NULL AND access is still live
//      (cancelled_at IS NULL or still in the future) AND unsubscribed_at IS NULL
//      AND bounced_at IS NULL AND complained_at IS NULL
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

  if (!SUBSCRIBER_LETTERS_ENABLED) {
    return NextResponse.json(
      { ok: true, paused: true, reason: "subscriber_delivery_paused" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const url = new URL(req.url);
  // Initial owner-reviewed rollout only sends the current issue once.
  // Keep historical and forced delivery paths closed until separately reviewed.
  if (url.searchParams.has("weekOf") || url.searchParams.get("force") === "1") {
    return NextResponse.json(
      { error: "Historical and forced sends are paused during the delivery rollout." },
      { status: 403 }
    );
  }
  const weekOfOverride = url.searchParams.get("weekOf");
  if (
    weekOfOverride !== null &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(weekOfOverride) ||
      !isValidCalendarDateString(weekOfOverride))
  ) {
    return NextResponse.json(
      { error: "weekOf must be a real calendar date in YYYY-MM-DD format." },
      { status: 400 }
    );
  }

  // A forced resend is a protected operator action, but it still needs
  // provider-level retry safety. The operator supplies one UUID per intended
  // resend. Retrying the same action reuses the same lane, while a genuinely
  // new resend requires a new UUID. This keeps an ambiguous provider response
  // from turning a transport retry into another email.
  const forceRaw = url.searchParams.get("force");
  const force = forceRaw === "1";
  const forceIdRaw = url.searchParams.get("forceId");
  const forceId = forceIdRaw?.trim().toLowerCase() || null;
  if (
    (forceRaw !== null && forceRaw !== "0" && forceRaw !== "1") ||
    (force &&
      (!forceId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          forceId
        ))) ||
    (!force && forceIdRaw !== null)
  ) {
    return NextResponse.json(
      { error: "force=1 requires a valid forceId UUID." },
      { status: 400 }
    );
  }
  const deliveryIdempotencyKind = force ? `force-${forceId}` : "live";

  const sb = await supabaseServiceClient();
  const retentionNow = new Date().toISOString();
  // Keep the pre-send maintenance leg database-only. Provider-backed Stripe
  // and deletion repair runs through the separate maintenance endpoint after
  // delivery, so an outage there cannot delay active subscribers' letters.
  const retentionErrors = await scrubExpiredCheckoutProfiles(
    sb,
    retentionNow,
    false
  );
  for (const retentionError of retentionErrors) {
    console.warn(
      "[cron/weekly-send] checkout retention cleanup failed:",
      retentionError
    );
  }
  // alpha-drift-r22-01 (found+fixed 2026-08-14): every per-subscriber email
  // list this route builds used to go into the ops-alert email AND the
  // CRON_SECRET-gated JSON response completely unbounded -- fine on an
  // ordinary day (a handful of names), but a genuinely bad run (a systemic
  // outage failing most of the subscriber list) could dump thousands of
  // real subscriber email addresses into one alert email and one API
  // response with no cap at all. One shared cap + one shared helper feeds
  // every list this route builds, so they can't independently drift apart
  // the way `failures`'s alert-email copy and JSON-summary copy already had.
  //
  // alpha-drift-r23-04 (found+fixed 2026-08-14, self-audit): this used to
  // live much further down, right before the JSON summary is built -- but
  // the stuck-claim RECLAIM block runs long before that point and builds
  // its own separate, still-uncapped user_id list into an ops-alert email
  // (a prior run dying mid-send, exactly the scenario that block exists to
  // detect and recover from, is also exactly the scenario that could
  // realistically reclaim a large slice of the subscriber list at once).
  // Moved to the top of the handler so every list-building site in this
  // route -- not just the ones after this comment used to sit -- shares the
  // same cap.
  const EMAIL_LIST_CAP = 25;
  const capList = (arr: string[]) => arr.slice(0, EMAIL_LIST_CAP);
  const capListLine = (arr: string[]) =>
    capList(arr).join(", ") + (arr.length > EMAIL_LIST_CAP ? ` (+${arr.length - EMAIL_LIST_CAP} more)` : "");

  // Allow ?weekOf=YYYY-MM-DD override (useful for backfills + admin testing
  // when the schedule hasn't fired yet). Defaults to today (the send date).
  // CRON: GitHub Actions' daily-send.yml drives every send: "0 14 * * *"
  // (14:00 UTC primary), "0 15 * * *" (first offset retry, added 2026-08-05),
  // and "0 18 * * *" (second offset retry, added 2026-08-06 after a real
  // GitHub Actions platform-wide outage took out both the 14:00 and 15:00
  // runs the same day -- alpha-drift-r51-01, 2026-08-20: this comment used
  // to only mention two of the three, README.md already had the correct
  // count). The handler derives the period from today's date, so one
  // schedule set covers every send day.
  // Spend is incurred on the invocation date, even when an explicitly
  // authorized backfill targets an older issue date. Keying the hard budget
  // to weekOf would let repeated historical overrides open a fresh 400-call
  // allowance for every date in one real day.
  const paidCallBudgetDate = currentPeriodIso();
  // alpha-drift-r26-06 (2026-08-14): a shape-only regex check accepts an
  // impossible calendar date (e.g. "2026-04-31") that JS's Date parser
  // silently rolls over rather than rejecting -- the same gap fixed in
  // app/api/generate/route.ts's weekOf schema. Lower real exposure here
  // (CRON_SECRET-gated, trusted-operator-only), but the fix is one shared
  // helper call away, so there's no reason to leave the weaker check.
  const weekOf = weekOfOverride ?? paidCallBudgetDate;
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
  // Paid provider attempts reserve from one database-backed ceiling keyed by
  // the real invocation date. The guard is lazy, so a run satisfied by cache/free
  // providers performs no reservation. Small chunks keep a killed process
  // from stranding more than a bounded amount of the day's allowance.
  const dailyPaidCallBudget = createDailyPaidCallGuard(
    sb,
    paidCallBudgetDate,
    25
  );
  // Search window for this send: everything new since the previous send, which
  // at daily cadence is always exactly 1 day back. A topic with nothing new in
  // that window reads as empty and gets backfilled.
  const freshness = sinceLastSendWindow(weekOf);

  // Access runs through the end of the paid period. The webhook stores
  // cancelled_at as the date access ENDS, so a *future* cancelled_at means
  // "cancel-at-period-end scheduled but still paid up" — those readers must
  // keep getting letters. Only exclude null-or-future... i.e. include
  // (cancelled_at IS NULL OR cancelled_at > now). The old `.is(cancelled_at,
  // null)` cut these paying customers off weeks early. Mirrors
  // lib/access.hasActiveAccess().
  const nowIso = new Date().toISOString();
  // Bounded ordered fetch. Each route call processes one page. The workflow
  // drains pages in the same run. The explicit read-only afterUserId view is
  // reserved for a cursor compare-and-swap conflict so later readers still get
  // an attempt without claiming another runner's durable progress.
  const SUBSCRIBER_BATCH_SIZE = 250;
  // One-row lookahead makes deliveryHasMore exact. Without it, an exact final
  // page of 250 looked indistinguishable from a page with another reader after
  // it and forced an unnecessary probe request.
  const SUBSCRIBER_QUERY_LIMIT = SUBSCRIBER_BATCH_SIZE + 1;
  const cursorOverrideRaw = url.searchParams.get("afterUserId");
  const cursorOverride = cursorOverrideRaw?.trim() || null;
  if (
    cursorOverrideRaw !== null &&
    (!cursorOverride ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        cursorOverride
      ))
  ) {
    return NextResponse.json({ error: "afterUserId must be a UUID." }, { status: 400 });
  }
  let persistedDeliveryCursor: string | null = null;
  if (!cursorOverride) {
    const { data: cursorRow, error: cursorError } = await sb
      .from("weekly_send_delivery_cursors")
      .select("cursor_user_id")
      .eq("week_of", weekOf)
      .maybeSingle();
    if (cursorError) {
      console.error("[cron/weekly-send] delivery cursor fetch failed:", cursorError.message);
      return NextResponse.json({ error: "Couldn't fetch delivery cursor. Try again." }, { status: 500 });
    }
    persistedDeliveryCursor = cursorRow?.cursor_user_id ?? null;
  }
  const deliveryCursor = cursorOverride ?? persistedDeliveryCursor;
  // The former unbounded .select() silently truncated at
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
  const fetchSubscriberPage = async (afterUserId: string | null) => {
    let query = sb
      .from("users")
      .select(
        "id, email, first_name, city, job_blurb, project_blurb, fun_blurb, birthday, gender, theme, topics, topic_quota"
      )
      .eq("delivery_enrolled", true)
      .not("subscribed_at", "is", null)
      .or(
        `access_granted_at.not.is.null,cancelled_at.is.null,cancelled_at.gt.${nowIso}`
      )
      .is("unsubscribed_at", null)
      // alpha-deliverability-01: a hard bounce or spam complaint (Resend
      // webhook, app/api/webhooks/resend/route.ts) means this address is
      // either dead or doesn't want mail -- sending anyway keeps hammering
      // an address that will bounce again, dragging down everyday.report's
      // sender reputation for every other subscriber too.
      .is("bounced_at", null)
      .is("complained_at", null)
      .is("suppression_cleanup_pending_at", null)
      .order("id")
      .limit(SUBSCRIBER_QUERY_LIMIT);
    if (afterUserId) query = query.gt("id", afterUserId);
    return query;
  };

  const rows: SubscriberRow[] = [];
  let deliveryWrapped = false;
  let deliveryHasMore = false;
  {
    let { data: page, error } = await fetchSubscriberPage(deliveryCursor);

    // UUIDs are not chronological. A reader approved after this run's cursor
    // can sort before it, and an earlier failed reader also remains before it.
    // Once the tail is exhausted, wrap to the start on the same date so later
    // slots can retry uncovered readers instead of getting stuck on an empty
    // tail until tomorrow.
    if (
      !error &&
      !cursorOverride &&
      deliveryCursor &&
      (!page || page.length === 0)
    ) {
      deliveryWrapped = true;
      ({ data: page, error } = await fetchSubscriberPage(null));
    }

    if (error) {
      console.error("[cron/weekly-send] subscriber fetch failed:", error.message);
      return NextResponse.json({ error: "Couldn't fetch subscribers. Try again." }, { status: 500 });
    }
    deliveryHasMore = (page?.length ?? 0) > SUBSCRIBER_BATCH_SIZE;
    if (page) rows.push(...((page as SubscriberRow[]).slice(0, SUBSCRIBER_BATCH_SIZE)));
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
  // safe under concurrent per-topic calls sharing the counter within one
  // invocation — see the comment on braveRateLimitedCount in lib/brave.ts
  // (alpha-drift-r49-06, 2026-08-20: this same "warm lambda" phrase was
  // dropped from that comment for the identical reason — see its own note).
  // Same reasoning for
  // You.com's counter (lib/you-search.ts) — without this baseline+delta, a
  // struggling 3rd search tier would have zero operator-visible signal, the
  // same gap Brave's own counter exists to close. Groq/DeepSeek (2026-07-29)
  // are content-GENERATION fallbacks rather than search, but the same gap
  // applies: without this, a struggling free/backstop tier degrades every
  // reader straight to Haiku/Sonnet spend (or the stale-resend layer, if
  // Anthropic isn't funded) with zero operator-visible signal.
  const braveBaseline = braveRateLimitedCount();
  const youBaseline = youRateLimitedCount();
  // alpha-drift-r60-09 (2026-08-20, duplicate-code-audit-r10): Gemini is the
  // PRIMARY generation tier (tried FIRST for every blurb, not a downstream
  // fallback like Groq/DeepSeek) and had no counter at all until now --
  // baselined the same way as its four siblings.
  const geminiBaseline = geminiRateLimitedCount();
  const groqBaseline = groqRateLimitedCount();
  const deepseekBaseline = deepseekRateLimitedCount();
  // Baselined the same way as the four rate-limit counters above, but this
  // snapshot feeds an actual mid-loop brake (PAID_CALL_CEILING below), not just
  // the post-run summary — see that constant's comment for why.
  const paidCallBaseline = currentPaidCallSnapshot();
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
  // Emails of eligible readers who got NOTHING this send (blank name or empty
  // topic pool). Every row in this loop already passed the subscribed +
  // live-access filter, so anything here is a reader silently receiving
  // no letter — surfaced in the summary + an ops alert so it can't go unnoticed.
  const skippedBlankSubscribers: string[] = [];
  // Subscribers who WOULD have gotten a real send but the time budget ran out
  // first (see CRON_TIME_BUDGET_MS) — surfaced the same way, so a run that
  // starts approaching the cap is loud instead of a silent hard kill (the
  // GitHub Actions workflow's own curl --max-time / job timeout-minutes --
  // see the `maxDuration` comment near the top of this file).
  // Paid-call exhaustion does not add subscribers here. They continue through
  // cached content, free tiers, deterministic intro, and prior-issue backup.
  const deferred: string[] = [];
  // Exact per-page retry state. Aggregate counters are not enough here: one
  // reader can fail generation and then become ineligible during the backup
  // attempt, while another reader can become ineligible without any failure.
  // Tracking the row itself keeps cursor advancement tied to real coverage
  // without exposing the retrying readers in logs or the JSON response.
  const deliveryRetryRequiredUserIds = new Set<string>();
  // Set once PAID_CALL_CEILING trips, so the ops alert below can distinguish
  // paid-tier degradation from a scale-driven time-budget deferral.
  let paidCallCeilingHit = false;
  // Passed through assembly into both topic and editor generation. Every paid
  // Anthropic or DeepSeek attempt, including retries, reserves against the
  // same durable date-level ceiling immediately before its provider starts.
  const paidCallAllowed = async (): Promise<boolean> => {
    const allowed = await dailyPaidCallBudget.allow();
    if (!allowed) paidCallCeilingHit = true;
    return allowed;
  };
  // Three counters for today's (2026-08-06) new code, added in review the
  // same day per the "if this breaks, would anyone notice" pass -- each of
  // these paths already fails safe/self-heals on its own, but previously had
  // NO run-level signal, only scattered per-subscriber console.warn lines
  // easy to miss in the Cloudflare log stream.
  let unsubscribedMidRunSkips = 0;
  // alpha-drift-r29-04 (2026-08-14): the re-check right below used to read
  // ONLY unsubscribed_at, despite the initial snapshot filtering on
  // cancelled_at/bounced_at/complained_at too -- a subscriber whose access
  // ended mid-run (customer.subscription.deleted or charge.dispute.created,
  // both of which write an IMMEDIATE cancelled_at, not a future one) or who
  // bounced/complained mid-run still got that run's letter, real Anthropic/
  // Brave spend and all, exactly the outcome each of those webhooks exists
  // to prevent. Broadened into ONE query covering all 4 columns; failures
  // renamed from unsubscribedRecheckFailures to reflect that broader scope.
  let cancelledMidRunSkips = 0;
  let unenrolledMidRunSkips = 0;
  let suppressedMidRunSkips = 0;
  let eligibilityRecheckFailures = 0;

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
  // One confirmed monthly cap skips later Brave calls in this batch only.
  // A fresh request can detect a recovered quota without persistent lockout.
  const sourceQuotaState: BraveQuotaState = { monthlyExhausted: false };

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
      console.warn(
        `[cron/weekly-send] RECLAIMED ${reclaimed!.length} stuck claim(s) for weekOf=${weekOf} (delivered_at was set with no proof of send, older than ${RECLAIM_SAFETY_MARGIN_MS / 60000}min)`
      );
      // Visible on purpose: a reclaim means a PRIOR run genuinely died
      // mid-send. That's worth Algy knowing happened even though this run
      // is about to self-heal it -- silently fixing it would just move the
      // "nothing noticed" gap one step over. Best-effort, never blocks.
      await sendOpsAlert(
        `[alpha] Reclaimed ${reclaimed!.length} stuck claim(s)`,
        `weekOf=${weekOf}: ${reclaimed!.length} subscriber(s) had delivered_at set with no proof of send (older than ${RECLAIM_SAFETY_MARGIN_MS / 60000} minutes). A prior run likely died between claiming and Resend confirming. The claims were reclaimed and will be retried this run. Use the protected issue records for exact subscribers.`
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
    // alpha-drift-r70-01 (2026-08-21, silent-catch-audit-reverify, first
    // raised round 69): each chunk's own Supabase `error` used to be
    // discarded inside .then(flatMap) -- a failed chunk was silently
    // indistinguishable from a chunk with zero real rows, unlike every
    // other query in this file (reclaimErr just above, countsErr below).
    // At this app's real ~4-6 users there's exactly one chunk, so ANY
    // transient failure here reads as "nobody already delivered" and skips
    // the fast-path idempotency check at the alreadyDelivered.has() read
    // below -- real wasted generation spend, not a duplicate send (the
    // atomic delivered_at claim still catches it), so this is a log-only
    // fix, not a behavior change.
    const warnOnChunkErrors = (results: Array<{ error: { message: string } | null }>, label: string) => {
      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        console.warn(
          `[cron/weekly-send] ${label} prefetch: ${failed.length}/${results.length} chunk(s) failed — ${failed
            .map((r) => r.error!.message)
            .join("; ")}`
        );
      }
    };
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
          ).then((results) => {
            warnOnChunkErrors(results, "alreadyDelivered");
            return results.flatMap((r) => r.data ?? []);
          })
        : null;
    // Prefetch each subscriber's persisted-but-undelivered issue (retry-safety
    // reuse below, near runPersistAndSend) in one query PER CHUNK — was a
    // per-subscriber lookup inside the loop, mirroring the alreadyDelivered
    // fix above.
    const pendingPromise = Promise.all(
      idChunks.map((ids) => {
        let query = sb
          .from("issues")
          .select("user_id, volume, number, editor_intro, sections")
          .eq("week_of", weekOf)
          .in("user_id", ids);
        // Normal delivery only needs rows without proof of delivery. A forced
        // resend must replay the already-persisted issue body, including rows
        // already delivered, so a retry with the same forceId stays stable.
        if (!force) query = query.is("delivered_at", null);
        return query;
      })
    );

    const [stampsResult, pendingChunkResults] = await Promise.all([
      stampsPromise ?? Promise.resolve(null),
      pendingPromise,
    ]);
    const pendingChunkFailures = pendingChunkResults.filter((result) => result.error);
    if (pendingChunkFailures.length > 0) {
      // A missing pending row is not equivalent to no retry. Regenerating in
      // this uncertain state could overwrite the exact payload from an email
      // Resend accepted before its response was lost, then make the stable-key
      // retry fail as a payload mismatch. Stop before generation or cursor CAS.
      console.error(
        `[cron/weekly-send] pendingIssues prefetch failed in ${pendingChunkFailures.length}/${pendingChunkResults.length} chunk(s)`
      );
      return NextResponse.json(
        { error: "Couldn't fetch pending delivery state. Try again." },
        { status: 500 }
      );
    }
    const pendingResult = pendingChunkResults.flatMap((result) => result.data ?? []) as Array<{
      user_id: string;
      volume: number;
      number: number;
      editor_intro: string;
      sections: unknown;
    }>;
    const invalidPendingRows = pendingResult.filter(
      (row) =>
        typeof row?.user_id !== "string" ||
        !Number.isFinite(row.volume) ||
        !Number.isFinite(row.number) ||
        typeof row.editor_intro !== "string" ||
        !isValidPersistedSections(row.sections)
    );
    const pendingUserIds = new Set(pendingResult.map((row) => row.user_id));
    const forceMissingRows = force
      ? rows.filter((row) => !pendingUserIds.has(row.id)).length
      : 0;
    if (invalidPendingRows.length > 0 || forceMissingRows > 0) {
      // Any row returned here is the canonical provider payload for this
      // reader/date. Regenerating over a malformed row, or inventing content
      // for a requested resend, could mismatch an accepted-but-unconfirmed
      // send. Stop the whole page before generation, writes, sends, or cursor
      // progress. The protected data stays available for operator repair.
      console.error(
        `[cron/weekly-send] stable issue payload unavailable: invalid=${invalidPendingRows.length} missing_for_force=${forceMissingRows}`
      );
      return NextResponse.json(
        { error: "Couldn't prove a stable issue payload for this delivery. Try again." },
        { status: 500 }
      );
    }
    for (const s of (stampsResult ?? []) as Array<{ user_id: string }>) {
      alreadyDelivered.add(s.user_id);
    }
    for (const p of pendingResult) {
      pendingIssues.set(p.user_id, {
        ...p,
        sections: p.sections as Issue["sections"],
      });
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
      // Issue N is part of the provider payload. Guessing 1 here could change
      // the subject on a stable-key retry after Resend accepted the prior send
      // but its response was lost. Stop before any send or cursor CAS.
      console.error(
        `[cron/weekly-send] prior_issue_counts RPC failed: ${countsErr.message}`
      );
      return NextResponse.json(
        { error: "Couldn't determine stable issue numbers. Try again." },
        { status: 500 }
      );
    }
    for (const c of (counts ?? []) as Array<{ user_id: string; prior_count: number }>) {
      priorIssueCount.set(c.user_id, c.prior_count);
    }
  }

  // Sequential per-subscriber, but topic blurbs cache across subscribers so
  // total Claude time is bounded by topics-this-week, not users × topics.
  // Scale is bounded explicitly rather than estimated from optimistic request
  // latency. This route handles one 250-candidate page. daily-send.yml drains
  // pages until MAX_DELIVERY_PAGES or DELIVERY_DRAIN_SECONDS is reached. Each
  // fully classified normal page advances the fair scan position, including a
  // page with retry-required readers. Coverage stays red until later slots wrap
  // and recover them. A cursor CAS conflict uses read-only continuation. Any
  // retry outcome or undrained tail makes the workflow fail after maintenance.
  // CRON_TIME_BUDGET_MS remains the per-page hard-kill safety valve.
  for (const row of rows) {
    // Starts from the bounded page snapshot, then updates from the just-in-time
    // account read immediately before a provider call. Protected summaries use
    // the same value so they identify the address that was actually targeted.
    let currentDeliveryEmail = row.email;
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
      // This is an eligible reader getting NOTHING this send, exactly
      // how a blanked profile (e.g. a fresh-device sign-in that nulled
      // first_name / topics) drops a reader off every letter unnoticed. Never
      // silent: count which case, record the email, and warn per-subscriber.
      if (!row.first_name) skippedNoName++;
      else skippedEmptyPool++;
      skippedBlankSubscribers.push(currentDeliveryEmail);
      deliveryRetryRequiredUserIds.add(row.id);
      console.warn(
        `[cron/weekly-send] SKIPPED ELIGIBLE READER (got nothing): ` +
          `first_name=${row.first_name ? "ok" : "MISSING"} pool=${effectivePool.length}`
      );
      continue;
    }

    // Idempotency gate: if this (user, week) already has a delivered_at
    // stamp, skip the send entirely. Prevents duplicate emails when the
    // endpoint gets hit multiple times (admin re-trigger, a retried
    // scheduled run, ?weekOf= backfill, etc.). Override with ?force=1.
    if (!force && alreadyDelivered.has(row.id)) {
      skippedAlreadyDelivered++;
      console.log("[cron/weekly-send] skipped (already delivered this period)");
      continue;
    }

    // Time budget: stop STARTING new subscribers once we're close enough to
    // maxDuration that finishing this one could still blow the cap (see
    // CRON_TIME_BUDGET_MS). Checked here (after the cheap skip-checks above)
    // so a subscriber who didn't actually need work isn't misreported as
    // deferred.
    if (Date.now() - startedAt > CRON_TIME_BUDGET_MS) {
      deferred.push(currentDeliveryEmail);
      deliveryRetryRequiredUserIds.add(row.id);
      console.warn("[cron/weekly-send] DEFERRED (time budget exhausted)");
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
      email: currentDeliveryEmail,
    };

    // Persist + send ONE issue for this subscriber, bounded by
    // PERSIST_AND_SEND_DEADLINE_MS (see its comment above) so a hung
    // Supabase/Resend call can't park this whole loop. Shared by the normal
    // live-generated send below AND both backup layers in the catch block —
    // identical idempotency/claim/rollback guarantees every time; the only
    // difference is which Issue gets persisted and which counter it credits.
    async function runPersistAndSend(
      issue: Issue,
      kind: "live" | "backup-shared" | "backup-fresh" | "backup-stale"
    ): Promise<DeliveryAttemptOutcome> {
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
      // rerun; it does NOT stop two OVERLAPPING invocations (a retried
      // scheduled run racing the original, or a manual run racing the cron) from both
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
      // Re-check access, suppression, and the CURRENT delivery address right
      // before every provider call, including a forced resend. `rows` is a
      // snapshot and one page can run long enough for any of those fields to
      // change. Sending to its stale address after the account email moved is
      // a privacy failure, so a missing current address also fails closed.
      const { data: freshUser, error: freshUserErr } = await sb
        .from("users")
        .select(
          "email, delivery_enrolled, subscribed_at, access_granted_at, unsubscribed_at, cancelled_at, bounced_at, complained_at, suppression_cleanup_pending_at"
        )
        .eq("id", row.id)
        .maybeSingle();
      if (freshUserErr || !freshUser) {
        // Eligibility is a privacy and access decision. If the current row
        // cannot be checked or no longer exists, do not guess that an access
        // grant or delivery permission still exists. The persisted issue stays
        // retryable and the watchdog keeps this subscriber visible.
        eligibilityRecheckFailures++;
        console.warn("[cron/weekly-send] eligibility re-check could not prove access");
        return "retry-required";
      } else if (freshUser.delivery_enrolled !== true) {
        unenrolledMidRunSkips++;
        console.log("[cron/weekly-send] skipped (delivery enrollment ended mid-run)");
        return "settled";
      } else if (freshUser.unsubscribed_at) {
        unsubscribedMidRunSkips++;
        console.log("[cron/weekly-send] skipped (unsubscribed mid-run)");
        return "settled";
      } else if (
        !hasReaderAccess(
          freshUser.subscribed_at,
          freshUser.cancelled_at,
          freshUser.access_granted_at
        )
      ) {
        cancelledMidRunSkips++;
        console.log("[cron/weekly-send] skipped (access ended mid-run)");
        return "settled";
      } else if (freshUser.bounced_at || freshUser.complained_at) {
        suppressedMidRunSkips++;
        console.log("[cron/weekly-send] skipped (bounced/complained mid-run)");
        return "settled";
      } else if (freshUser.suppression_cleanup_pending_at) {
        suppressedMidRunSkips++;
        console.log(
          "[cron/weekly-send] skipped (provider suppression cleanup pending)"
        );
        return "settled";
      } else if (typeof freshUser.email !== "string" || !freshUser.email.trim()) {
        eligibilityRecheckFailures++;
        console.warn("[cron/weekly-send] delivery address re-check returned no address");
        return "retry-required";
      }
      currentDeliveryEmail = freshUser.email.trim();

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
          console.log("[cron/weekly-send] skipped (claimed by a concurrent run)");
          return "settled";
        }
      } else {
        // force=1 bypasses the ordinary delivered_at claim. The page-level
        // preflight already proved this is the persisted issue requested for
        // replay, and forceId supplies a distinct provider retry lane.
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
      let providerSent = false;
      try {
        const preparedEmail = prepareLetterNotification({
          to: currentDeliveryEmail,
          firstName: profile.firstName,
          issue,
          inboxUrl,
          // Tokenized view-in-browser CTA. Opens the letter with no session.
          letterUrl: buildLetterUrl(row.id, origin, weekOf),
          issueNumber: (priorIssueCount.get(row.id) ?? 0) + 1,
          userId: row.id,
          idempotencyKind: deliveryIdempotencyKind,
          deliveryDate: weekOf,
        });
        const delivery = await sendWithResendDeliveryAttempt({
          sb,
          userId: row.id,
          weekOf,
          recipient: preparedEmail.recipient,
          deliveryLane: deliveryIdempotencyKind,
          payloadFingerprint: preparedEmail.requestFingerprint,
          expectedClaimedAt: force ? null : claimedAt,
          send: (storedRecipient) => {
            if (storedRecipient !== preparedEmail.recipient) {
              throw new Error("staged recipient changed before provider send");
            }
            return sendPreparedSubscriberEmail(preparedEmail);
          },
        });
        providerSent = delivery.providerSent;
        if (delivery.suppressionReviewRequired) {
          console.warn(
            "[cron/weekly-send] provider accepted the letter but its suppression evidence needs review"
          );
        }
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
              `[cron/weekly-send] send failed AND claim rollback failed: ${rollbackErr.message}. The subscriber may be skipped next run.`
            );
          }
        }
        throw sendErr;
      }
      if (!providerSent) {
        console.log(
          "[cron/weekly-send] skipped provider call (delivery lane already finalized)"
        );
        return "settled";
      }

      // Count + log only on an ACTUAL send — inside resendConfigured's
      // early-return above so a dev/misconfig run with Resend unset doesn't
      // over-report for letters that never went out.
      if (kind === "backup-shared") {
        backupSharedSent++;
        backupSharedSentEmails.push(currentDeliveryEmail);
        console.log(
          `[cron/weekly-send] sent BACKUP-SHARED (borrowed from today's cache, ${issue.sections.length} section(s))`
        );
      } else if (kind === "backup-fresh") {
        backupFreshSent++;
        backupFreshSentEmails.push(currentDeliveryEmail);
        console.log(
          `[cron/weekly-send] sent BACKUP-FRESH (small fast retry, ${issue.sections.length} section(s))`
        );
      } else if (kind === "backup-stale") {
        backupStaleSent++;
        backupStaleSentEmails.push(currentDeliveryEmail);
        console.log(
          `[cron/weekly-send] sent BACKUP-STALE (resend of a prior letter, ${issue.sections.length} section(s))`
        );
      } else {
        sent++;
        console.log(
          `[cron/weekly-send] sent (${issue.sections.length} section(s))`
        );
      }
      return "settled";
    }

    // withDeadline stops waiting but does not cancel the provider/Supabase
    // tail. If a timed-out attempt settles before this route builds its
    // summary, reconcile the row-level retry set with that final outcome so
    // response coverage cannot disagree with counters the same tail updated.
    const trackDeliveryOutcome = (
      attempt: Promise<DeliveryAttemptOutcome>
    ): Promise<DeliveryAttemptOutcome> =>
      attempt.then((outcome) => {
        if (outcome === "settled") {
          deliveryRetryRequiredUserIds.delete(row.id);
        } else {
          deliveryRetryRequiredUserIds.add(row.id);
        }
        return outcome;
      });

    // RETRY-SAFETY: if a PRIOR run already generated and persisted this
    // subscriber's issue but never successfully delivered it (a same-day
    // retry after a transient send failure — see the offset retry triggers),
    // reuse that exact persisted content instead of regenerating. Found live
    // 2026-08-05: the per-user editor's note (assemble.ts's
    // generateEditorNote) is never cached, so a regenerated retry produces a
    // DIFFERENT payload, but sendLetterNotification's Resend idempotency key
    // is stable per (user, week_of) for every scheduled content kind, so Resend
    // correctly 409s the mismatched retry as invalid_idempotent_request,
    // meaning the retry built specifically to rescue a transient Resend
    // error was GUARANTEED to fail on exactly that case. Reusing the
    // already-upserted row keeps the payload byte-identical, so the shared
    // idempotency key works as designed and the retry costs zero new AI
    // calls on top of being correct.
    const persistedRetry = pendingIssues.get(row.id);

    let usableIssue: Issue | null = null;
    try {
      const issue: Issue =
        persistedRetry
          ? {
              id: `${profile.firstName.toLowerCase()}-${weekOf}`,
              volume: persistedRetry.volume,
              number: persistedRetry.number,
              weekOf: formatWeekOf(weekOf),
              recipientFirstName: profile.firstName,
              recipientCity: profile.city,
              editorIntro: persistedRetry.editor_intro,
              sections: persistedRetry.sections,
            }
          : await withDeadline(
              generateIssue(
                profile,
                weekOf,
                letterSize,
                freshness,
                dryCache,
                inFlight,
                failedCache,
                paidCallAllowed,
                sourceQuotaState
              ),
              PER_USER_DEADLINE_MS,
              "generateIssue(subscriber)"
            );
      usableIssue = issue;
      if (persistedRetry) {
        console.log(
          "[cron/weekly-send] reusing already-generated issue (retry, zero new AI cost)"
        );
      }

      // alpha-drift-r49-01 (2026-08-20, self-audit-r48 -- round 48's own
      // rewrite of this comment claimed this route runs on Cloudflare
      // Workers via ctx.waitUntil, and pointed at app/api/admin/users/
      // route.ts's alpha-drift-r35-03 -- BOTH wrong. This file's own
      // maxDuration comment a few dozen lines up already says the send
      // "now runs via `next start` on GitHub Actions
      // (.github/workflows/daily-send.yml)" -- a plain long-running Node.js
      // process on a GitHub Actions runner, never touching the deployed
      // Cloudflare Workers site (daily-send.yml's Build step is explicitly
      // labeled "NOT the Cloudflare/OpenNext bundle, just a runnable
      // server"; wrangler.jsonc deliberately has no triggers.crons). The
      // real alpha-drift-r35-03 tag lives in app/api/account/email/
      // reconcile/route.ts, not admin/users/route.ts.
      //
      // Registered with Next's after() UNCONDITIONALLY (not just on timeout)
      // so this plain Node.js process is kept alive until the promise
      // settles even if it's still running once the whole cron GET returns
      // its response — without this, a subscriber whose persist+send
      // outlives the response risks the process moving on (or the workflow
      // step ending) mid-write (e.g. between claiming delivered_at and
      // actually sending), which could leave a claim stuck with no email
      // ever sent.
      // after() on an already-settled promise is a harmless no-op, so this is
      // safe to call every time, not just in the timeout path. NOTE:
      // sent/failed/failures below can still end up double-counting a
      // subscriber whose send succeeds in the background AFTER the timeout
      // branch already ran (this run's ops-alert email may then wrongly list
      // them as failed) — accepted: the actual delivered_at claim and the
      // actual email are correct either way, this only risks a cosmetic
      // inaccuracy in one day's summary, not a duplicate or a silent miss.
      const persistAndSend = trackDeliveryOutcome(
        runPersistAndSend(issue, "live")
      );
      after(persistAndSend.catch(() => undefined));
      const deliveryOutcome = await withDeadline(
        persistAndSend,
        PERSIST_AND_SEND_DEADLINE_MS,
        "persist+send(subscriber)"
      );
      if (deliveryOutcome === "retry-required") {
        deliveryRetryRequiredUserIds.add(row.id);
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : "unknown";
      failures.push({ email: currentDeliveryEmail, error: msg });
      console.error(`[cron/weekly-send] FAILED: ${msg}`);

      // Once a complete issue exists, a persistence or delivery failure must
      // never replace it with different content in this same run. Keep the
      // live issue as the durable retry candidate. The next scheduled attempt
      // reuses the exact persisted payload and the same provider idempotency
      // key, which is safe even when the prior transport outcome was unclear.
      if (usableIssue) {
        console.warn(
          "[cron/weekly-send] preserving completed issue for exact retry; content backups skipped"
        );
        deliveryRetryRequiredUserIds.add(row.id);
        continue;
      }

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
          // Keep the delivery-visible issue identity identical to the pending
          // issue reconstructed on a later slot. Resend compares the full
          // payload when the stable idempotency key is reused.
          id: `${profile.firstName.toLowerCase()}-${weekOf}`,
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
          console.warn(
            `[cron/weekly-send] cache-borrow succeeded (${chosen.length} shared topics)`
          );
        }
      } catch (cacheErr) {
        console.warn(
          `[cron/weekly-send] cache-borrow check failed: ${cacheErr instanceof Error ? cacheErr.message : cacheErr}`
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
              generateIssue(
                { ...profile, topics: smallPool },
                weekOf,
                smallPool.length,
                freshness,
                dryCache,
                inFlight,
                failedCache,
                paidCallAllowed,
                sourceQuotaState
              ),
              FAST_FALLBACK_DEADLINE_MS,
              "fast-fallback(subscriber)"
            );
            backupKind = "backup-fresh";
            console.warn(
              `[cron/weekly-send] fast fallback succeeded (${smallPool.length} topics)`
            );
          }
        } catch (fastErr) {
          console.warn(
            `[cron/weekly-send] fast fallback ALSO failed: ${fastErr instanceof Error ? fastErr.message : fastErr}`
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
          // alpha-drift-r61-06 (2026-08-20, silent-catch-audit-r7): `error`
          // used to be discarded -- since this sits in a try/catch but
          // Supabase resolves rather than throws on a query error, a real
          // DB failure here never reached the catch below; it just left
          // `prior` undefined, indistinguishable in the logs from "this
          // subscriber genuinely has no prior delivered issue." Purely a
          // logging fix: the subscriber-facing outcome (no backup this run)
          // is correct either way and doesn't change -- this just lets a
          // real failure in the last-resort fallback be told apart from a
          // subscriber having no delivery history, which matters for
          // diagnosing whether the fallback itself is broken mid-outage.
          const { data: prior, error: priorErr } = await sb
            .from("issues")
            .select("sections")
            .eq("user_id", row.id)
            .not("delivered_at", "is", null)
            .lt("week_of", weekOf)
            .order("week_of", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (priorErr) {
            console.error(
              `[cron/weekly-send] backup lookup query failed: ${priorErr.message}`
            );
          }
          if (prior?.sections) {
            backupIssue = buildBackupIssue(
              "Quick note: today's letter is running behind, so here's a repeat of your last one while it catches up.",
              prior.sections
            );
            backupKind = "backup-stale";
          }
        } catch (lookupErr) {
          console.error(
            `[cron/weekly-send] backup lookup failed: ${lookupErr instanceof Error ? lookupErr.message : lookupErr}`
          );
        }
      }

      if (backupIssue && backupKind) {
        try {
          const backupSend = trackDeliveryOutcome(
            runPersistAndSend(backupIssue, backupKind)
          );
          after(backupSend.catch(() => undefined));
          const backupOutcome = await withDeadline(
            backupSend,
            PERSIST_AND_SEND_DEADLINE_MS,
            "backup-send(subscriber)"
          );
          if (backupOutcome === "retry-required") {
            deliveryRetryRequiredUserIds.add(row.id);
          }
        } catch (backupErr) {
          deliveryRetryRequiredUserIds.add(row.id);
          console.error(
            `[cron/weekly-send] backup send failed: ${backupErr instanceof Error ? backupErr.message : backupErr}`
          );
        }
      } else {
        deliveryRetryRequiredUserIds.add(row.id);
      }
    }
  }

  const cappedBackupSharedSentEmails = capList(backupSharedSentEmails);
  const cappedBackupFreshSentEmails = capList(backupFreshSentEmails);
  const cappedBackupStaleSentEmails = capList(backupStaleSentEmails);
  const cappedSkippedBlankSubscribers = capList(skippedBlankSubscribers);
  const cappedDeferred = capList(deferred);
  const cappedFailures = failures.slice(0, EMAIL_LIST_CAP);

  const elapsedMs = Date.now() - startedAt;
  const braveRateLimited = braveRateLimitedCount() - braveBaseline;
  const youRateLimited = youRateLimitedCount() - youBaseline;
  const geminiRateLimited = geminiRateLimitedCount() - geminiBaseline;
  const groqRateLimited = groqRateLimitedCount() - groqBaseline;
  const deepseekRateLimited = deepseekRateLimitedCount() - deepseekBaseline;
  // Logged every run (not just when the ceiling trips) specifically so a
  // real day's totals can calibrate PAID_CALL_CEILING's first-pass estimate
  // — see that constant's comment.
  const paidCallCounterDelta = paidCallsSinceBaseline(
    paidCallBaseline,
    currentPaidCallSnapshot()
  );
  const paidCallBudget = dailyPaidCallBudget.snapshot();
  // The durable guard is invocation-scoped and therefore remains exact even
  // if two requests share one warm process and its legacy module counters.
  const paidCallsThisRun = paidCallBudget.used;
  const deliveryRetryRequiredTotal = deliveryRetryRequiredUserIds.size;
  const deliveryPageComplete = deliveryRetryRequiredTotal === 0;
  const deliveryPageLastUserId = rows.length > 0 ? rows[rows.length - 1].id : null;
  let deliveryCursorNext = deliveryCursor;
  let deliveryCursorAdvanceFailed = false;
  let deliveryCursorState: DeliveryCursorState;

  // An explicit afterUserId is a read-only recovery view. It never moves
  // scheduled progress. A normal page records the last inspected row even
  // when one reader needs retry. The exact retry count keeps the workflow red,
  // and proof-of-delivery coverage makes later same-day slots wrap and retry
  // unresolved readers without starving readers beyond a bounded page cap.
  if (cursorOverride) {
    deliveryCursorState = "override_read_only";
  } else if (!deliveryPageLastUserId) {
    deliveryCursorState = "empty";
  } else {
    const { data: cursorAdvanced, error: cursorWriteError } = await sb.rpc(
      "advance_weekly_send_cursor",
      {
        p_week_of: weekOf,
        p_expected_cursor_user_id: persistedDeliveryCursor,
        p_cursor_user_id: deliveryPageLastUserId,
      }
    );
    if (cursorWriteError || cursorAdvanced !== true) {
      console.error(
        "[cron/weekly-send] delivery cursor advance failed:",
        cursorWriteError?.message ?? "cursor changed concurrently"
      );
      deliveryCursorAdvanceFailed = true;
      deliveryCursorState = "advance_failed";
    } else {
      deliveryCursorNext = deliveryPageLastUserId;
      deliveryCursorState = deliveryPageComplete
        ? "advanced"
        : "advanced_with_retry";
    }
  }

  const deliveryPageBlocked =
    !deliveryPageComplete || deliveryCursorAdvanceFailed;
  const summary = {
    weekOf,
    subscribers: rows.length,
    sent,
    backupSharedSent,
    // alpha-drift-r22-01: capped to EMAIL_LIST_CAP (see that constant's
    // comment) -- the *Sent counts above already carry the TRUE total, so
    // capping the email list itself loses no information a reader needs.
    backupSharedSentEmails: cappedBackupSharedSentEmails,
    backupFreshSent,
    backupFreshSentEmails: cappedBackupFreshSentEmails,
    backupStaleSent,
    backupStaleSentEmails: cappedBackupStaleSentEmails,
    skippedNoName,
    skippedEmptyPool,
    skippedBlankSubscribers: cappedSkippedBlankSubscribers,
    skippedBlankSubscribersTotal: skippedBlankSubscribers.length,
    skippedAlreadyDelivered,
    deferred: cappedDeferred,
    deferredTotal: deferred.length,
    failed,
    braveRateLimited,
    youRateLimited,
    geminiRateLimited,
    groqRateLimited,
    deepseekRateLimited,
    paidCallsThisRun,
    paidCallCounterDelta,
    paidCallBudgetDate,
    paidCallCeilingHit,
    paidCallReservationsGranted: paidCallBudget.granted,
    paidCallReservationsUsed: paidCallBudget.used,
    paidCallReservationsUnused: paidCallBudget.remaining,
    paidCallReservationExhausted: paidCallBudget.exhausted,
    paidCallReservationError: paidCallBudget.error,
    // hardFailedTopics: distinct topics that exhausted every generation tier
    // this run (failedCache, alpha-spend-cap-02) — a systemic provider
    // outage failing topics before paidCallCount climbs enough to trip
    // PAID_CALL_CEILING would otherwise look identical to an ordinary slow-
    // news day in this summary. Found in review 2026-08-06.
    hardFailedTopics: failedCache.size,
    unsubscribedMidRunSkips,
    cancelledMidRunSkips,
    unenrolledMidRunSkips,
    suppressedMidRunSkips,
    eligibilityRecheckFailures,
    checkoutRetentionErrors: retentionErrors.length,
    suppressionReconciliation: { deferredToPostSendMaintenance: true },
    elapsedMs,
    failures: cappedFailures,
    failuresTotal: failures.length,
    deliveryCursor,
    deliveryWrapped,
    deliveryCursorNext,
    deliveryCursorState,
    deliveryCursorAdvanceFailed,
    deliveryBatchSize: SUBSCRIBER_BATCH_SIZE,
    deliveryPageCount: rows.length,
    deliveryPageComplete,
    deliveryRetryRequired: !deliveryPageComplete,
    deliveryRetryRequiredTotal,
    deliveryPageBlocked,
    deliveryPageLastUserId,
    deliveryHasMore,
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
    deliveryCursor: deliveryCursor ? "[redacted]" : null,
    deliveryCursorNext: deliveryCursorNext ? "[redacted]" : null,
    deliveryPageLastUserId: deliveryPageLastUserId ? "[redacted]" : null,
  }));

  // An eligible reader getting nothing, a hard send failure, search quota
  // exhaustion, or readers deferred for time should be loud and visible.
  // letter is noticed missing. Best-effort single email per run (sendOpsAlert
  // never throws), only when something actually went wrong.
  if (
    skippedBlankSubscribers.length > 0 ||
    failed > 0 ||
    braveRateLimited > 0 ||
    geminiRateLimited > 0 ||
    groqRateLimited > 0 ||
    deepseekRateLimited > 0 ||
    deferred.length > 0 ||
    paidCallCeilingHit ||
    eligibilityRecheckFailures > 0 ||
    retentionErrors.length > 0 ||
    deliveryCursorAdvanceFailed
  ) {
    // This exact set is also the cursor-advance guard. It avoids inferring
    // coverage from aggregate counters when a failed generation was rescued,
    // or when a reader became ineligible during a backup attempt.
    const genuinelyMissed = deliveryRetryRequiredTotal;
    const lines = [
      `weekOf=${weekOf}  sent=${sent}  backupSharedSent=${backupSharedSent}  backupFreshSent=${backupFreshSent}  backupStaleSent=${backupStaleSent}  subscribers=${rows.length}  failed=${failed}  genuinelyMissed=${genuinelyMissed}`,
      backupSharedSent > 0
        ? `Live generation failed for ${failed} subscriber(s); ${backupSharedSent} of them got fresh, real content borrowed from a broadly-appealing topic already cached today (zero new AI calls): ${capListLine(backupSharedSentEmails)}.`
        : "",
      backupFreshSent > 0
        ? `${backupFreshSent} needed the next layer — a real, FRESH (shorter) letter via the small fast-fallback retry: ${capListLine(backupFreshSentEmails)}.`
        : "",
      backupStaleSent > 0
        ? `${backupStaleSent} subscriber(s) needed the true last resort — their most recent prior letter, resent (they were told it's a repeat): ${capListLine(backupStaleSentEmails)}. Worth a closer look if this keeps happening — it means even the cache-borrow and the fast retry are both failing, not just the full generation.`
        : "",
      skippedBlankSubscribers.length
        ? `Eligible readers who got NOTHING (blank name / empty topics): ${capListLine(skippedBlankSubscribers)}`
        : "",
      failures.length
        ? `Underlying generation failures (root cause, investigate this even if a backup layer covered it): ${cappedFailures.map((f) => `${f.email} (${f.error})`).join("; ")}${failures.length > EMAIL_LIST_CAP ? ` (+${failures.length - EMAIL_LIST_CAP} more)` : ""}`
        : "",
      braveRateLimited > 0
        ? `Brave returned 429 on ${braveRateLimited} queries. The fallback chain stayed active. Review free-tier quota, caching, and alternate search health before considering any paid change.`
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
      // alpha-drift-r60-09 (2026-08-20, duplicate-code-audit-r10): Gemini
      // had NO counter at all until now, despite being the PRIMARY
      // generation tier (tried FIRST for every blurb, unlike Groq/DeepSeek
      // below which are downstream fallbacks) -- a sustained Gemini-only
      // outage previously produced zero signal here, silently shifting all
      // blurb load onto Groq then DeepSeek. Placed ahead of Groq/DeepSeek's
      // lines since a nonzero count here is the more urgent signal: the
      // tier every blurb tries first is straining, not just a fallback.
      geminiRateLimited > 0
        ? `Gemini (the PRIMARY, first-tried generation tier for every topic blurb) returned 429 or 402 on ${geminiRateLimited} calls this run — its free-tier quota may be exhausted or the API key may be invalid/rotated (both have happened before, see lib/you-search.ts's 2026-07-29 incident note). Escalates automatically to Groq then DeepSeek, so likely not a reader-visible problem yet, but this is the tier every blurb tries first — worth checking sooner than the Groq/DeepSeek lines below.`
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
      // only) — a real 429/402 here means even the backstop tier is straining,
      // which is a materially more serious signal than Groq's free-tier limit
      // above.
      //
      // alpha-drift-r54-01 (2026-08-20, self-audit-r53): round 53 widened
      // deepseekRateLimitedCount() (via lib/engine/openai-compat.ts's
      // throwCompatError) to also count 402 -- DeepSeek's own documented
      // real failure mode is running out of a funded balance, not a
      // rate-limit wall -- but this message still said "returned 429"
      // unconditionally, which would assert a factually wrong status code
      // to Algy in exactly the incident that fix was built to surface.
      deepseekRateLimited > 0
        ? `DeepSeek (the uncapped backstop tier) hit a quota/balance wall on ${deepseekRateLimited} calls this run (429 or 402) — that shouldn't normally happen on a funded account. Worth checking the DeepSeek dashboard for balance/concurrency issues.`
        : "",
      deferred.length
        ? `Time budget exhausted before reaching everyone. ${deferred.length} subscriber(s) got NO letter this run: ${capListLine(deferred)}. Safe to recover: rerun this exact date with ?weekOf=${weekOf} (already-delivered subscribers are skipped automatically). This is a scale signal. The subscriber list is big enough that the daily run is pressing against the workflow's time budget.`
        : "",
      // PAID_CALL_CEILING tripped — a materially different signal than a
      // scale-driven time-budget defer above: this means Haiku+Sonnet+Opus+
      // DeepSeek combined reached the maximum real, billed calls a normal day's
      // topic-cache-sharing should ever produce, which is exactly the
      // "systemic failure forcing every topic through the full waterfall"
      // scenario alpha-spend-cap-01 exists to catch. Worth checking
      // Anthropic/DeepSeek dashboards for actual spend, not just quota.
      paidCallCeilingHit
        ? paidCallBudget.error
          ? `COST BRAKE TRIPPED: the durable paid-call reservation failed (${paidCallBudget.error}). No unreserved paid call was started. Cached content, free tiers, deterministic intro, and prior-issue backup remained available.`
          : `COST BRAKE TRIPPED: paid-tier calls (Haiku+Sonnet+Opus+DeepSeek) exhausted Alpha's shared ${PAID_CALL_CEILING}-call allowance for invocation date ${paidCallBudgetDate}. This invocation used ${paidCallBudget.used} of ${paidCallBudget.granted} slots it reserved. Stopped starting new paid calls while cached content, free tiers, deterministic intro, and prior-issue backup remained available. Check for a systemic generation failure (every topic escalating through the full waterfall) rather than assuming this is just a busy day.`
        : "",
      // A persistent failure here means the round-12 mid-run eligibility guard
      // is skipping sends because it cannot prove current access. Keep it loud
      // so the blocked readers can be recovered after the read path is fixed.
      eligibilityRecheckFailures > 0
        ? `The mid-run eligibility re-check could not prove access ${eligibilityRecheckFailures} time(s). Those sends were skipped. Check Supabase connectivity, permissions, and recent account deletion activity.`
        : "",
      retentionErrors.length > 0
        ? `Checkout privacy retention failed ${retentionErrors.length} time(s). Raw staged profile cleanup needs immediate review.`
        : "",
      deliveryCursorAdvanceFailed
        ? "The durable delivery cursor compare-and-swap failed. This page was treated as blocked and scheduled progress was not claimed."
        : "",
    ].filter(Boolean);
    await sendOpsAlert(
      `[alpha] send ${weekOf}: ${skippedBlankSubscribers.length} blanked, ${failed} failed (${genuinelyMissed} retry required)${braveRateLimited > 0 ? ", Brave quota hit" : ""}${geminiRateLimited > 0 ? ", Gemini quota hit" : ""}${groqRateLimited > 0 ? ", Groq quota hit" : ""}${deepseekRateLimited > 0 ? ", DeepSeek quota hit" : ""}${deferred.length > 0 ? `, ${deferred.length} deferred` : ""}${paidCallCeilingHit ? ", COST BRAKE TRIPPED" : ""}${eligibilityRecheckFailures > 0 ? `, eligibility-recheck failed x${eligibilityRecheckFailures}` : ""}${retentionErrors.length > 0 ? `, retention failed x${retentionErrors.length}` : ""}${deliveryCursorAdvanceFailed ? ", cursor CAS failed" : ""}`,
      lines.join("\n")
    );
  }

  return NextResponse.json(summary);
}

