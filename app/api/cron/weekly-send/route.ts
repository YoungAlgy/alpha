import { NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { generateIssue } from "@/lib/engine/assemble";
import { poolCap } from "@/lib/engine/select-sections";
import { sendLetterNotification, resendConfigured, sendOpsAlert } from "@/lib/email";
import { letterUrl as buildLetterUrl } from "@/lib/letter-token";
import { currentPeriodIso, sinceLastSendWindow } from "@/lib/cadence";
import { topicLabel } from "@/lib/topics";
import type { UserProfile, TopicId, ThemeId } from "@/lib/types";

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

interface SubscriberRow {
  id: string;
  email: string;
  first_name: string | null;
  city: string | null;
  job_blurb: string | null;
  project_blurb: string | null;
  fun_blurb: string | null;
  theme: string | null;
  topics: string[] | null;
  topic_quota: number | null;
}

// Multi-send cadence entrypoint (Sun + Tue + Thu). Vercel Cron sends an
// Authorization header of `Bearer ${CRON_SECRET}` automatically when the env
// var is set. We refuse anything else, so this can't be hit from the open web.
//
// Behavior:
//   1. Find all users where subscribed_at IS NOT NULL AND access is still live
//      (cancelled_at IS NULL or still in the future) AND unsubscribed_at IS NULL
//   2. For each, generate this send's Issue via the same engine /api/generate
//      uses (Brave + Claude + per-topic cache), persist via upsert on (user_id,
//      week_of), and send the letter email via Resend. The `week_of` column now
//      holds the SEND DATE (one row per send), so each Sun/Tue/Thu letter is its
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
  // CRON: a SINGLE Vercel cron drives all three sends, "0 14 * * 0,2,4" (Sun,
  // Tue, Thu at 14:00 UTC). It must be one entry: Vercel keys cron jobs by path,
  // so the earlier attempt at two entries differing only by ?slot=... query
  // collapsed to one job and the midweek send never fired. The handler derives
  // the period from today's date, so one schedule covers every send day.
  const url = new URL(req.url);
  const weekOfOverride = url.searchParams.get("weekOf");
  const weekOf =
    weekOfOverride && /^\d{4}-\d{2}-\d{2}$/.test(weekOfOverride)
      ? weekOfOverride
      : currentPeriodIso();
  // Search window for this send: everything new since the previous send in the
  // cadence (Thu->Sun is 3 days, Sun->Tue and Tue->Thu are 2). A topic with
  // nothing new in that window reads as empty and gets backfilled.
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
      "id, email, first_name, city, job_blurb, project_blurb, fun_blurb, theme, topics, topic_quota"
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

  // Prefetch each subscriber's PRIOR issue count (weeks strictly before this
  // one) in ONE query → "Issue N" in the email subject is this reader's Nth
  // letter (issueNumber = priorCount + 1), accurate on re-runs too.
  const priorIssueCount = new Map<string, number>();
  {
    const { data: priors } = await sb
      .from("issues")
      .select("user_id")
      .lt("week_of", weekOf);
    for (const p of (priors ?? []) as Array<{ user_id: string }>) {
      priorIssueCount.set(p.user_id, (priorIssueCount.get(p.user_id) ?? 0) + 1);
    }
  }

  // Sequential per-subscriber, but topic blurbs cache across subscribers so
  // total Claude time is bounded by topics-this-week, not users × topics.
  // NOTE for scale: at ~100+ subscribers the per-user generation time will
  // press against maxDuration — the path is chunked sends (cursor param +
  // multiple cron slots), not parallelism (Claude rate limits bind first).
  for (const row of rows) {
    // letterSize = sections they pay for. The topics array is their ranked
    // POOL — clamp it to poolCap (letterSize + backups, ≤25) so generation
    // stays bounded and a topics array written straight to the DB (the RLS
    // trigger permits the column) can't blow up cost. generateIssue fills the
    // letter with the top fresh topics and backfills from the rest.
    const letterSize = Math.max(5, Math.min(25, row.topic_quota ?? 5));
    const pool = ((row.topics ?? []) as TopicId[]).slice(0, poolCap(letterSize));
    if (!row.first_name || pool.length === 0) {
      // This is an ACTIVE PAID subscriber getting NOTHING this send — exactly
      // how a blanked profile (e.g. a fresh-device sign-in that nulled
      // first_name / topics) drops a reader off every letter unnoticed. Never
      // silent: count which case, record the email, and warn per-subscriber.
      if (!row.first_name) skippedNoName++;
      else skippedEmptyPool++;
      skippedBlankSubscribers.push(row.email);
      console.warn(
        `[cron/weekly-send] SKIPPED PAID SUBSCRIBER (got nothing) → ${row.email} ` +
          `first_name=${row.first_name ? "ok" : "MISSING"} pool=${pool.length}`
      );
      continue;
    }

    // Idempotency gate: if this (user, week) already has a delivered_at
    // stamp, skip the send entirely. Prevents duplicate emails when the
    // endpoint gets hit multiple times (admin re-trigger, Vercel cron retry,
    // ?weekOf= backfill, etc.). Override with ?force=1.
    if (!force && alreadyDelivered.has(row.id)) {
      skippedAlreadyDelivered++;
      console.log(`[cron/weekly-send] skipped (already delivered this week) → ${row.email}`);
      continue;
    }

    const profile: UserProfile = {
      firstName: row.first_name,
      city: row.city ?? "",
      jobBlurb: row.job_blurb ?? undefined,
      projectBlurb: row.project_blurb ?? undefined,
      funBlurb: row.fun_blurb ?? undefined,
      topics: pool,
      theme: ((row.theme as ThemeId) ?? "forest"),
      email: row.email,
    };

    try {
      const issue = await generateIssue(profile, weekOf, letterSize, freshness);

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
      if (resendConfigured()) {
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
        if (!force) {
          const { data: claimRows, error: claimErr } = await sb
            .from("issues")
            .update({ delivered_at: new Date().toISOString() })
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
            continue;
          }
        }

        const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://youngalgy.com";
        const inboxUrl = `${origin}/alpha/inbox`;
        try {
          await sendLetterNotification({
            to: row.email,
            firstName: row.first_name,
            issue,
            inboxUrl,
            // Tokenized view-in-browser link: the CTA opens the letter directly
            // with no session — no more "No letter yet" on a signed-out device.
            letterUrl: buildLetterUrl(row.id, origin),
            issueNumber: (priorIssueCount.get(row.id) ?? 0) + 1,
            userId: row.id,
          });
        } catch (sendErr) {
          if (!force) {
            // Release the claim so the next run retries this user cleanly.
            const { error: rollbackErr } = await sb
              .from("issues")
              .update({ delivered_at: null })
              .eq("user_id", row.id)
              .eq("week_of", weekOf);
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

        // Count + log only on an ACTUAL send — inside the resendConfigured()
        // block so a dev/misconfig run with Resend unset doesn't over-report
        // `sent` for letters that never went out.
        sent++;
        // Log the sections that actually made the letter (top fresh topics +
        // any backfill), not the whole pool.
        const labels = issue.sections
          .map((s) => s.topicLabel)
          .filter(Boolean)
          .join(" · ");
        console.log(`[cron/weekly-send] sent → ${row.email} (${labels})`);
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : "unknown";
      failures.push({ email: row.email, error: msg });
      console.error(`[cron/weekly-send] FAILED → ${row.email}: ${msg}`);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const summary = {
    weekOf,
    subscribers: rows.length,
    sent,
    skippedNoName,
    skippedEmptyPool,
    skippedBlankSubscribers,
    skippedAlreadyDelivered,
    failed,
    elapsedMs,
    failures: failures.slice(0, 25),
  };
  console.log("[cron/weekly-send] summary:", JSON.stringify(summary));

  // A paid subscriber getting nothing, or a hard send failure, should be LOUD —
  // not buried in logs the owner won't read until a letter is noticed missing.
  // Best-effort single email per run (sendOpsAlert never throws), only when
  // something actually went wrong.
  if (skippedBlankSubscribers.length > 0 || failed > 0) {
    const lines = [
      `weekOf=${weekOf}  sent=${sent}  subscribers=${rows.length}  failed=${failed}`,
      skippedBlankSubscribers.length
        ? `PAID subscribers who got NOTHING (blank name / empty topics): ${skippedBlankSubscribers.join(", ")}`
        : "",
      failures.length
        ? `Send failures: ${failures.map((f) => `${f.email} (${f.error})`).join("; ")}`
        : "",
    ].filter(Boolean);
    await sendOpsAlert(
      `[alpha] send ${weekOf}: ${skippedBlankSubscribers.length} blanked, ${failed} failed`,
      lines.join("\n")
    );
  }

  return NextResponse.json(summary);
}

