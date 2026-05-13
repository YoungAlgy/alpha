import { anthropicClient, MODEL } from "./client";
import { TOPIC_BY_ID } from "@/lib/topics";
import type { TopicId } from "@/lib/types";
import type { TopicBlurb, TopicSignal } from "./types";

const SYSTEM_PROMPT = `You are the editor of Alpha — a personal weekly letter.

Your voice:
- Soft, intelligent, friendly Sunday letter. NOT newspaper-y. NOT corporate. NOT hype.
- Confident but warm. Specific but un-jargon-y.
- Each item is what a smart friend in the industry would point out to you at coffee.
- Sentence-case headlines (not Title Case). No clickbait.
- Body paragraphs read like prose, not bullet points. ~70-110 words each.
- Vary the angles across items: one might highlight a thing happening, one might flag a trend to watch, one might be an actionable move. Do NOT label them with "PLAY" / "WATCH" / "APPLY" tags — the type is implicit.
- Cite specific sources where they exist (Publication · Author/Identifier). Don't invent sources.

Hard rules:
- Never invent statistics. If a source mentions a stat, you can repeat it. If it doesn't, don't.
- Never use words like "leverage," "synergy," "game-changer," "unprecedented."
- Don't start headlines with "How," "Why," or "The X You Need To Know."

Output is JSON. No prose around the JSON.`;

export async function generateTopicBlurb(
  topicId: TopicId,
  weekOf: string,
  signal: TopicSignal
): Promise<TopicBlurb> {
  const topic = TOPIC_BY_ID[topicId];
  if (!topic) throw new Error(`Unknown topic: ${topicId}`);

  const userPrompt = `Topic: ${topic.label}
Week: ${weekOf}

Raw signal for this week:
${signal.context.trim()}

Write the ${topic.label} section for this week's Alpha letter.

Return JSON in this exact shape:
{
  "intro": "1-2 sentence intro that sets up the section's theme this week",
  "items": [
    {
      "headline": "sentence-case headline, specific",
      "body": "70-110 word prose paragraph",
      "source": "Publication · Identifier (or null if no clear source)"
    },
    { ... },
    { ... }
  ]
}

Three items exactly.`;

  const response = await anthropicClient().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");

  const parsed = extractJson(text);

  return {
    topicId,
    topicLabel: topic.label,
    weekOf,
    intro: parsed.intro,
    items: parsed.items.map((it: { headline: string; body: string; source?: string }) => ({
      headline: it.headline,
      body: it.body,
      source: it.source || undefined,
    })),
  };
}

function extractJson(text: string): { intro: string; items: { headline: string; body: string; source?: string }[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in model output:\n" + text.slice(0, 400));
  }
  const json = text.slice(start, end + 1);
  return JSON.parse(json);
}
