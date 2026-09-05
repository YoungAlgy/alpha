import type { TopicBlurb } from "./types";
import { cleanField } from "./text-clean";
import { sanitizeVoice } from "./voice-guard";
import { codePointSafeTruncate } from "@/lib/text-truncate";

/**
 * Builds a short editor note without a model call.
 *
 * This is deliberately a formatter. It only reuses already-guarded blurb
 * text, and it never adds a claim about a reader, a source, or the news.
 * The note is intentionally plain because strict no-model mode values a
 * dependable send over a more personal but quota-bound introduction.
 */

const MAX_LEAD_CHARS = 240;

function safeText(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return sanitizeVoice(cleanField(value.replace(/\s+/g, " ")));
}

function firstSentence(value: string | undefined): string {
  const cleaned = safeText(value);
  if (!cleaned) return "";
  const sentence = cleaned.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? cleaned;
  const truncated = codePointSafeTruncate(sentence, MAX_LEAD_CHARS);
  return truncated.text.trim().replace(/[,:]$/, "");
}

function withPeriod(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

export function buildDeterministicEditorNote(blurbs: TopicBlurb[]): string {
  const usable = blurbs.filter((blurb) => blurb && (safeText(blurb.topicLabel) || safeText(blurb.intro)));
  if (usable.length === 0) return "Today's letter is ready when you are.";

  const first = usable[0];
  const firstItem = Array.isArray(first.items) ? first.items[0] : undefined;
  const lead = firstSentence(firstItem?.body) || firstSentence(first.intro);
  const headline = safeText(firstItem?.headline);
  const firstLine = lead || (headline ? withPeriod(headline) : `There is a useful read in ${safeText(first.topicLabel).toLowerCase()}`);

  const lines = [withPeriod(firstLine), "Worth sitting with that one."];
  const second = usable[1];
  if (second) {
    const secondItem = Array.isArray(second.items) ? second.items[0] : undefined;
    const secondLead = firstSentence(secondItem?.body) || firstSentence(second.intro);
    const secondLabel = safeText(second.topicLabel).toLowerCase();
    lines.push(secondLead || (secondLabel ? `There is more in ${secondLabel} after that.` : "There is more in today's letter after that."));
  } else {
    const label = safeText(first.topicLabel).toLowerCase();
    lines.push(label ? `The rest of today's letter stays with ${label}.` : "The rest of today's letter is ready when you are.");
  }

  return sanitizeVoice(lines.map(withPeriod).join(" "));
}
