import { generateTopicBlurb } from "./topic-blurb";
import { generateEditorNote } from "./editor-note";
import { resolveTopicSignal, resolveMockSignal } from "./source-resolver";
import { getCachedBlurb, setCachedBlurb } from "./blurb-cache";
import { selectLetterSections } from "./select-sections";
import { topicLabel } from "@/lib/topics";
import type { Issue, UserProfile, TopicId } from "@/lib/types";
import type { TopicBlurb } from "./types";

export async function generateIssue(
  user: UserProfile,
  weekOf: string,
  // How many sections the reader's letter holds (what they pay for). Their
  // `topics` is the ranked POOL — we fill the letter with the top topics that
  // have fresh info and use backups for any that are quiet. Defaults to the
  // whole pool (every caller that doesn't rank a deeper pool gets today's
  // behavior: every topic generated, in order).
  letterSize?: number,
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
    if (cached) return { ...cached, topicLabel: topicLabel(id) };
    const signal = await resolveTopicSignal(id, weekOf, { liveOnly: true });
    if (!signal) return null; // no fresh signal — skip, no model call
    const blurb = await generateTopicBlurb(id, weekOf, signal);
    setCachedBlurb(blurb).catch(() => undefined);
    // A section whose links all got dropped by the guard isn't worth a slot.
    return blurb.items.length > 0 ? blurb : null;
  }

  // Last-resort filler from the curated mock (catalog topics only) — keeps the
  // letter full when the whole ranked pool was quiet this period.
  async function genFiller(topicId: string): Promise<TopicBlurb | null> {
    const id = topicId as TopicId;
    const cached = await getCachedBlurb(id, weekOf);
    if (cached) return { ...cached, topicLabel: topicLabel(id) };
    const signal = resolveMockSignal(id, weekOf);
    if (!signal) return null;
    const blurb = await generateTopicBlurb(id, weekOf, signal);
    setCachedBlurb(blurb).catch(() => undefined);
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
