import { NextResponse } from "next/server";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { generateIssue } from "@/lib/engine/assemble";
import { sendLetterNotification, resendConfigured } from "@/lib/email";
import { TOPIC_BY_ID } from "@/lib/topics";
import type { UserProfile, TopicId, ThemeId } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 800; // Vercel Pro cap

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
}

// Sundays-at-10am-ET cron entrypoint. Vercel Cron sends an Authorization
// header of `Bearer ${CRON_SECRET}` automatically when the env var is set.
// We refuse anything else, so this can't be hit manually from the open web.
//
// Behavior:
//   1. Find all users where subscribed_at IS NOT NULL AND cancelled_at IS NULL
//   2. For each, generate this Sunday's Issue via the same engine /api/generate
//      uses (Brave + Claude + per-topic cache), persist via upsert on (user_id,
//      week_of), and send the letter email via the dual SES → Resend pipeline.
//   3. Topic blurbs are cached per (topic_id, week_of) so the first user pays
//      the Claude cost and the rest reuse — order-of-N-topics calls, not
//      N-users × N-topics.
//   4. Per-user failures are caught and counted; the cron always returns 200
//      so Vercel doesn't keep retrying — failures surface in the response
//      summary and runtime logs.
export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  const auth = req.headers.get("authorization");
  if (!expected || auth !== `Bearer ${expected}`) {
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

  const { data: subscribers, error } = await sb
    .from("users")
    .select(
      "id, email, first_name, city, job_blurb, project_blurb, fun_blurb, theme, topics"
    )
    .not("subscribed_at", "is", null)
    .is("cancelled_at", null)
    .is("unsubscribed_at", null);

  if (error) {
    console.error("[cron/weekly-send] subscriber fetch failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (subscribers ?? []) as SubscriberRow[];
  const startedAt = Date.now();
  let sent = 0;
  let skippedNoTopics = 0;
  let failed = 0;
  const failures: Array<{ email: string; error: string }> = [];

  console.log(
    `[cron/weekly-send] weekOf=${weekOf} subscribers=${rows.length}`
  );

  // Sequential per-subscriber, but topic blurbs cache across subscribers so
  // total Claude time is bounded by topics-this-week, not users × topics.
  for (const row of rows) {
    const topics = (row.topics ?? []) as TopicId[];
    if (!row.first_name || topics.length === 0) {
      skippedNoTopics++;
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
      await sb.from("issues").upsert(
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

      // Send the letter. lib/email.ts prefers SES; falls back to Resend.
      if (resendConfigured() || process.env.AWS_ACCESS_KEY_ID) {
        const origin = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://youngalgy.com";
        const inboxUrl = `${origin}/alpha/inbox`;
        await sendLetterNotification({
          to: row.email,
          firstName: row.first_name,
          issue,
          inboxUrl,
          magicLink: null, // no auto-sign-in for weekly emails; user clicks /inbox
          userId: row.id,
        });
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
