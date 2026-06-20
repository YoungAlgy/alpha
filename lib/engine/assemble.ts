import { generateTopicBlurb } from "./topic-blurb";
import { generateEditorNote } from "./editor-note";
import { resolveTopicSignal, resolveMockSignal } from "./source-resolver";
import { getCachedBlurb, setCachedBlurb } from "./blurb-cache";
import { selectLetterSections } from "./select-sections";
import { topicLabel } from "@/lib/topics";
import { withDeadline } from "@/lib/with-deadline";
import type { Issue, UserProfile, TopicId } from "@/lib/types";
import type { TopicBlurb } from "./types";

// Per-topic generation deadline. The model call is bounded per-attempt (60s) but
// the SDK retry + topic-blurb's parse-retry can stack a single blurb past 2
// minutes. This caps ONE topic so a pathologically slow one is treated as
// "quiet" and BACKFILLED from a fresher backup, rather than dominating the
// parallel wave and forcing the outer route/cron deadline to drop the WHOLE
// letter. The reject lands in selectLetterSections' per-topic .catch → null.
const TOPIC_GEN_DEADLINE_MS = 75_000;

export async function generateIssue(
  user: UserProfile,
  weekOf: string,
  // How many sections the reader's letter holds (what they pay for). Their
  // `topics` is the ranked POOL — we fill the letter with the top topics that
  // have fresh info and use backups for any that are quiet. Defaults to the
  // whole pool (every caller that doesn't rank a deeper pool gets today's
  // behavior: every topic generated, in order).
  letterSize?: number,
  // Recency window for the live search. Defaults to past-week (the single
  // weekly letter). The multi-send cadence passes a "since the last letter"
  // date range so a topic with no NEW info reads as empty and gets backfilled
  // from a fresher one instead of repeating the same news across sends.
  freshness?: import("@/lib/brave").BraveSearchOptions["freshness"],
): Promise<Issue> {
  const pool = user.topics;
  const size = Math.max(1, letterSize ?? pool.length);

  // Generate a topic's section from FRESH live signal. Returns null WITHOUT a
  // model call when the topic has nothing new this period, so the selector can
  // skip it and reach for a backup. A cache hit = already generated this
  // period = include it. The per-(topic, week_of) cache is the cost unlock:
  // one generation per topic-week, shared across every subscriber to it.
  async function genLive(topicId: string): Promise<TopicBlurb | null> {
    const id = topicId as TopicId;
    const cached = await getCachedBlurb(id, weekOf);
    // Treat a cached blurb with no items as a miss. A section whose links all
    // got guard-dropped when it was generated isn't worth a slot, so it must
    // never be served (to this reader or any later one) and the topic should
    // backfill instead.
    if (cached && cached.items.length > 0) return { ...cached, topicLabel: topicLabel(id) };
    const signal = await resolveTopicSignal(id, weekOf, { liveOnly: true, freshness });
    if (!signal) return null; // no fresh signal — skip, no model call
    const blurb = await withDeadline(
      generateTopicBlurb(id, weekOf, signal),
      TOPIC_GEN_DEADLINE_MS,
      `topic-blurb ${id}`
    );
    // Only cache a real section. If the guard dropped every link (0 items),
    // don't cache the empty result — otherwise every later subscriber to this
    // topic would read the empty blurb back as a "hit" and ship a link-less
    // section. Return null so the selector backfills this topic instead.
    if (blurb.items.length === 0) return null;
    setCachedBlurb(blurb).catch(() => undefined);
    return blurb;
  }

  // Last-resort filler from the curated mock (catalog topics only) — keeps the
  // letter full when the whole ranked pool was quiet this period.
  //
  // NOTE: mock blurbs are intentionally NOT written to the shared cache. The
  // cache is the "live, fresh this period" store that genLive reads first; if a
  // mock blurb landed there, the NEXT subscriber's genLive would read it back
  // and treat evergreen filler as fresh signal (so that topic would never
  // backfill for anyone after the first dry user). Generating mock per-user is
  // cheap and rare (only fires when a reader's WHOLE pool is dry) and keeps
  // every reader's "thin topic -> fresher backup" behavior independent.
  async function genFiller(topicId: string): Promise<TopicBlurb | null> {
    const id = topicId as TopicId;
    // No cache read: genFiller only runs when genLive already returned null (no
    // live blurb cached this period), so a lookup here always misses. Mock
    // blurbs are deliberately never cached (see the note above), so generate it.
    const signal = resolveMockSignal(id, weekOf);
    if (!signal) return null;
    const blurb = await withDeadline(
      generateTopicBlurb(id, weekOf, signal),
      TOPIC_GEN_DEADLINE_MS,
      `topic-filler ${id}`
    );
    return blurb.items.length > 0 ? blurb : null;
  }

  // Pick the letter's sections from the ranked pool: top fresh topics first,
  // backups for the quiet ones, filler only as a last resort. Each generator
  // is individually error-trapped inside the selector, so one failed topic is
  // treated as "quiet" and backfilled rather than sinking the whole letter.
  const selection = await selectLetterSections(pool, size, genLive, genFiller);
  const blurbs = selection.chosen.map((c) => c.value);
  if (selection.skippedDry.length > 0) {
    console.warn(
      `[assemble] ${weekOf}: skipped ${selection.skippedDry.length} quiet topic(s): ${selection.skippedDry.join(", ")}`
    );
  }
  if (blurbs.length === 0) {
    throw new Error("All topic sections failed to generate");
  }

  // Step 2 — personalized editor's note weaving the sections. If it fails,
  // fall back to a clean standalone intro rather than sinking the letter.
  let editorIntro: string;
  try {
    editorIntro = await generateEditorNote(user, blurbs);
  } catch (e) {
    console.warn(`[assemble] editor note failed, using fallback intro: ${e instanceof Error ? e.message : e}`);
    const labels = blurbs.map((b) => b.topicLabel.toLowerCase());
    const list =
      labels.length > 1
        ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
        : labels[0];
    editorIntro = `A few things worth your time this week, across ${list}. Dig into whatever pulls at you and let the rest wait.`;
  }

  // Step 3 — assemble Issue
  const issue: Issue = {
    id: `${user.firstName.toLowerCase()}-${weekOf}`,
    volume: 1,
    number: 1,
    weekOf: formatWeekOf(weekOf),
    recipientFirstName: user.firstName,
    recipientCity: user.city,
    editorIntro,
    sections: blurbs.map((b) => ({
      topicId: b.topicId,
      topicLabel: b.topicLabel,
      intro: b.intro,
      items: b.items.map((it) => ({
        kind: it.kind,
        headline: it.headline,
        body: it.body,
        primaryRef: it.primaryRef,
        supplementaryRefs: it.supplementaryRefs,
      })),
    })),
  };

  return issue;
}

function formatWeekOf(iso: string): string {
  // 2026-05-17 → "Sunday, May 17, 2026"
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
