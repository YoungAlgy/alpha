import { anthropicClient, MODEL } from "./client";
import { TOPIC_BY_ID } from "@/lib/topics";
import type { TopicId } from "@/lib/types";
import type { TopicBlurb, TopicSignal, BlurbItemKind } from "./types";

const VALID_KINDS: BlurbItemKind[] = ["read", "watch", "listen", "try", "post", "book", "event", "note"];
function narrowKind(k: string | undefined): BlurbItemKind {
  return VALID_KINDS.includes(k as BlurbItemKind) ? (k as BlurbItemKind) : "note";
}

const SYSTEM_PROMPT = `You are the editor of Alpha — a personal weekly letter that helps a curious, intelligent reader learn and stay sharp on the topics they care about.

Your job: write a weekly section for ONE topic, made of 3 items.

The voice:
- Intellectual and educational, but never academic or jargon-y
- Warm, friendly, Sunday-letter energy — like a thoughtful friend who reads widely sending you what they found
- Specific. Grounded in real things. Anti-cliché.
- Sentence-case headlines — never Title Case, never clickbait
- Body paragraphs read as prose, 120-180 words. Educational depth — explain WHY it matters and what to do with it. Define unfamiliar terms briefly. Cite stats only when they appear in the source signal.

Item composition — VARY the kinds across the 3 items so the section has texture:
- "read" — an article, essay, newsletter, blog post the reader should read
- "watch" — a video, talk, film, documentary
- "listen" — a podcast, interview, audio piece
- "try" — an app, tool, product, service to actually use
- "post" — a social-media post or thread worth reading (X, Threads, Bluesky, Farcaster, LinkedIn)
- "book" — a book recommendation
- "event" — a real event (date specific)
- "note" — a plain editorial note with no primary link (use sparingly)

Per item:
- ONE primary reference if applicable — a single URL the reader should click. Pulled from the signal only. NEVER invent URLs.
- Optional supplementary references — 1-3 additional URLs to go deeper, or related apps/posts/reads. These too must come from the signal.
- Pick the URL that's MOST useful (the actual thing to click, not a homepage)
- Each item should make the reader feel they got something useful — a link to click, a thing to try, a thread to read, an app to install, an event to attend

Hard rules:
- Never invent URLs. If a URL isn't in the signal, leave the ref out.
- Never invent statistics. Stats must come from the signal.
- No words: "leverage," "synergy," "game-changer," "unprecedented," "in a world where," "Hope this helps!"
- Don't start headlines with "How," "Why," "The X You Need To Know," "X Reasons."

Output is JSON only — no prose before or after.`;

export async function generateTopicBlurb(
  topicId: TopicId,
  weekOf: string,
  signal: TopicSignal
): Promise<TopicBlurb> {
  const topic = TOPIC_BY_ID[topicId];
  if (!topic) throw new Error(`Unknown topic: ${topicId}`);

  const userPrompt = `Topic: ${topic.label}
Week: ${weekOf}

Raw signal for this week (URLs here are real — you may use them; do NOT invent new ones):

${signal.context.trim()}

Write this week's ${topic.label} section. Return JSON in this exact shape:

{
  "intro": "1-2 sentence intro that sets up the section's theme this week",
  "items": [
    {
      "kind": "read" | "watch" | "listen" | "try" | "post" | "book" | "event" | "note",
      "headline": "sentence-case headline, specific",
      "body": "120-180 word educational prose paragraph",
      "primaryRef": { "label": "what the user is clicking", "url": "https://..." } OR null,
      "supplementaryRefs": [
        { "label": "...", "url": "https://...", "note": "optional why-this" },
        ...
      ] OR []
    },
    { ... },
    { ... }
  ]
}

Three items exactly. VARY the kinds across them. Include URLs only from the signal above. Make each item feel like a small piece of education with something concrete to click or try.`;

  const response = await anthropicClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
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
    items: parsed.items.map((it) => ({
      kind: narrowKind(it.kind),
      headline: it.headline,
      body: it.body,
      primaryRef: it.primaryRef || undefined,
      supplementaryRefs: Array.isArray(it.supplementaryRefs) && it.supplementaryRefs.length > 0
        ? it.supplementaryRefs
        : undefined,
    })),
  };
}

interface ParsedItem {
  kind?: string;
  headline: string;
  body: string;
  primaryRef?: { label: string; url: string; note?: string };
  supplementaryRefs?: { label: string; url: string; note?: string }[];
}

interface ParsedBlurb {
  intro: string;
  items: ParsedItem[];
}

function extractJson(text: string): ParsedBlurb {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in model output:\n" + text.slice(0, 400));
  }
  const json = text.slice(start, end + 1);
  return JSON.parse(json);
}
