import { generateTopicBlurb } from "./topic-blurb";
import { generateEditorNote } from "./editor-note";
import { resolveTopicSignal } from "./source-resolver";
import { getCachedBlurb, setCachedBlurb } from "./blurb-cache";
import { TOPIC_BY_ID } from "@/lib/topics";
import type { Issue, UserProfile } from "@/lib/types";

export async function generateIssue(
  user: UserProfile,
  weekOf: string,
): Promise<Issue> {
  // Step 1 — for each topic, check the per-(topic, week_of) cache in Supabase.
  // Cache hit → reuse the shared blurb. Cache miss → resolve signal (Brave or
  // mock), synthesize via Claude, write back to cache for future subscribers.
  // This is the cost unlock: 1 generation per topic-week instead of per user.
  const blurbPromises = user.topics.map(async (topicId) => {
    const cached = await getCachedBlurb(topicId, weekOf);
    if (cached) {
      // Fill the label from the topic registry (we don't store it in DB)
      const label = TOPIC_BY_ID[topicId]?.label || topicId;
      return { ...cached, topicLabel: label };
    }
    const signal = await resolveTopicSignal(topicId, weekOf);
    if (!signal) {
      throw new Error(`No signal available for topic: ${topicId}`);
    }
    const blurb = await generateTopicBlurb(topicId, weekOf, signal);
    // Fire-and-forget cache write — doesn't block the response
    setCachedBlurb(blurb).catch(() => undefined);
    return blurb;
  });

  // Resilient fan-out: a transient Brave/Claude failure on ONE topic must not
  // sink the whole letter. Keep the sections that succeeded (in the user's
  // chosen order); only fail outright if EVERY topic failed. The failed topic
  // retries on the next generation (cache miss).
  const settled = await Promise.allSettled(blurbPromises);
  const blurbs = settled
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof generateTopicBlurb>>> => r.status === "fulfilled")
    .map((r) => r.value);
  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      console.warn(`[assemble] topic "${user.topics[i]}" failed, skipping section: ${r.reason}`);
    }
  });
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
