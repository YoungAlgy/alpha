import { generateTopicBlurb } from "./topic-blurb";
import { generateEditorNote } from "./editor-note";
import { resolveTopicSignal } from "./source-resolver";
import type { Issue, UserProfile } from "@/lib/types";

export async function generateIssue(
  user: UserProfile,
  weekOf: string,
): Promise<Issue> {
  // Step 1 — for each topic, resolve signal (live via Brave Search if configured,
  // otherwise hand-written mock). Then synthesize a blurb via Claude.
  // V2 will cache (topic, week_of) → blurb in Supabase so the API costs amortize
  // across all subscribers to that topic.
  const blurbPromises = user.topics.map(async (topicId) => {
    const signal = await resolveTopicSignal(topicId, weekOf);
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
