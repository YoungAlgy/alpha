import { anthropicClient, MODEL } from "./client";
import type { TopicBlurb } from "./types";
import type { UserProfile } from "@/lib/types";

const SYSTEM_PROMPT = `You are the editor of Alpha — a personal weekly letter.

Your voice for the editor's note:
- Warm but un-cute. You're a thoughtful friend writing them a Sunday letter.
- 3-5 sentences. Concise.
- DO NOT greet the reader. The renderer already prints "Hi [name]," above your note — your note picks up after that.
- Mention 1-2 specific things from this week's topics that feel especially noteworthy. End with a soft invitation.
- Reference the reader's location, role, or current project ONLY if it's natural — never force it.
- No "Hope you're well!" filler. No "In a world where..." cliché openers. No "Dear Reader,". No "Good morning,".
- Sign-off comes later — don't include "— Alpha" or anything like that, just the prose of the editor's note itself.`;

export async function generateEditorNote(
  user: UserProfile,
  blurbs: TopicBlurb[]
): Promise<string> {
  const blurbSummaries = blurbs
    .map((b) => `• ${b.topicLabel} — ${b.intro}`)
    .join("\n");

  const profileLines = [
    user.firstName && `Name: ${user.firstName}`,
    user.city && `City: ${user.city}`,
    user.jobBlurb && `Does: ${user.jobBlurb}`,
    user.projectBlurb && `Currently working on: ${user.projectBlurb}`,
    user.funBlurb && `Outside work, into: ${user.funBlurb}`,
  ].filter(Boolean).join("\n");

  const userPrompt = `Reader:
${profileLines}

This week's 5 topic sections, with their intros:
${blurbSummaries}

Write the editor's note for this reader's letter this week.`;

  const response = await anthropicClient().messages.create({
    model: MODEL,
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n")
    .trim();
}
