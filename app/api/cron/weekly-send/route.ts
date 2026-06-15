import { NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { generateIssue } from "@/lib/engine/assemble";
import { sendLetterNotification, resendConfigured } from "@/lib/email";
import { letterUrl as buildLetterUrl } from "@/lib/letter-token";
import { TOPIC_BY_ID } from "@/lib/topics";
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

// Sundays-at-10am-ET cron entrypoint. Vercel Cron sends an Authorization
// header of `Bearer ${CRON_SECRET}` automatically when the env var is set.
// We refuse anything else, so this can't be hit manually from the open web.
//
// Behavior:
//   1. Find all users where subscribed_at IS NOT NULL AND access is still live
//      (cancelled_at IS NULL or still in the future) AND unsubscribed_at IS NULL
//   2. For each, generate this Sunday's Issue via the same engine /api/generate
//      uses (Brave + Claude + per-topic cache), persist via upsert on (user_id,
//      week_of), and send the letter email via Resend.
//   3. Topic blurbs are cached per (topic_id, week_of) so the first user pays
//      the Claude cost and the rest reuse — order-of-N-topics calls, not
//      N-users × N-topics.
//   4. Per-user failures are caught and counted; the cron always returns 200
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
  // when the schedule hasn't fired yet). Defaults to most-recent-Sunday-UTC.
  const url = new URL(req.url);
  const weekOfOverride = url.searchParams.get("weekOf");
  const weekOf =
    weekOfOverride && /^\d{4}-\d{2}-\d{2}$/.test(weekOfOverride)
      ? weekOfOverride
      : currentSundayIso();
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
  let skippedNoTopics = 0;
  let skippedAlreadyDelivered = 0;
  let failed = 0;
  const failures: Array<{ email: string; error: string }> = [];

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
    // Clamp to the number of topics they're paid up for. Defends against a
    // topics array written directly to the DB (the RLS trigger permits the
    // topics column) that exceeds quota — both a billing bypass (more
    // sections than paid for) and a cost/timeout vector (a huge array would
    // fan out into that many Claude calls).
    const quota = Math.max(5, Math.min(25, row.topic_quota ?? 5));
    const topics = ((row.topics ?? []) as TopicId[]).slice(0, quota);
    if (!row.first_name || topics.length === 0) {
      skippedNoTopics++;
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
      topics,
      theme: ((row.theme as ThemeId) ?? "forest"),
      email: row.email,
    };

    try {
      const issue = await generateIssue(profile, weekOf);

      // Upsert the issue so re-runs are idempotent on (user_id, week_of).
      // THROW on failure (caught by the per-user catch below) — if this row
      // doesn't exist, the email must NOT go out: the delivered_at stamp after
      // the send would no-op against a missing row, and the next cron run
      // would regenerate AND RESEND — a duplicate email to the subscriber.
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
        const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://youngalgy.com";
        const inboxUrl = `${origin}/alpha/inbox`;
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
        // Stamp delivered_at so future runs of the cron skip this user this
        // week. Best-effort — if the update errors we still consider the send
        // successful (the email went out), we just log so we know to watch.
        const { error: stampErr } = await sb
          .from("issues")
          .update({ delivered_at: new Date().toISOString() })
          .eq("user_id", row.id)
          .eq("week_of", weekOf);
        if (stampErr) {
          console.warn(
            `[cron/weekly-send] sent but delivered_at stamp failed for ${row.email}: ${stampErr.message}`
          );
        }
      }

      sent++;
      // Log topic labels too so the runtime log is useful for content debugging
      const labels = topics
        .map((id) => TOPIC_BY_ID[id]?.label)
        .filter(Boolean)
        .join(" · ");
      console.log(`[cron/weekly-send] sent → ${row.email} (${labels})`);
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
    skippedNoTopics,
    skippedAlreadyDelivered,
    failed,
    elapsedMs,
    failures: failures.slice(0, 25),
  };
  console.log("[cron/weekly-send] summary:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

// Round-to-most-recent-Sunday-in-UTC, formatted as YYYY-MM-DD. The cron fires
// at 14:00 UTC on Sundays, so `today` will already be Sunday — the floor()
// just normalizes off-by-one timezone weirdness if anyone manually triggers
// the endpoint earlier in the week.
function currentSundayIso(): string {
  const d = new Date();
  const day = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
