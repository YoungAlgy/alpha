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
  const blurbs = await Promise.all(blurbPromises);

  // Step 2 — generate personalized editor's note that weaves the 5 sections together
  const editorIntro = await generateEditorNote(user, blurbs);

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
