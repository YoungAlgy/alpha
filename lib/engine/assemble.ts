import { generateTopicBlurb } from "./topic-blurb";
import { generateEditorNote } from "./editor-note";
import { getSignal } from "./mock-signals";
import type { Issue, UserProfile } from "@/lib/types";

export async function generateIssue(
  user: UserProfile,
  weekOf: string,
): Promise<Issue> {
  // Step 1 — fetch (or generate) a shared topic blurb for each of the user's 5 topics.
  // Today these come from MOCK_SIGNALS; in production these are cached weekly per topic
  // so generation cost amortizes across all subscribers to that topic.
  const blurbPromises = user.topics.map(async (topicId) => {
    const signal = getSignal(topicId, weekOf) || getSignal(topicId);
    if (!signal) {
      throw new Error(`No signal available for topic: ${topicId}`);
    }
    return generateTopicBlurb(topicId, weekOf, signal);
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
        kind: "note" as const,
        headline: it.headline,
        body: it.body,
        source: it.source,
        sourceUrl: it.sourceUrl,
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
