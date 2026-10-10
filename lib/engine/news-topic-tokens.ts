// Pure shared matching for public news metadata. No feed or profile reads.
const CUSTOM_STOP_WORDS = new Set([
  "about", "after", "best", "current", "daily", "for", "from", "latest", "news",
  "the", "this", "today", "updates", "week", "weekly", "with",
]);
const SHORT_GRAMMAR_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for",
  "has", "he", "her", "him", "his", "i", "if", "in", "is", "it", "of",
  "on", "or", "s", "the", "to", "was", "we",
]);

export function normalizedNewsTokens(value: string): string[] {
  return [...new Set(value.normalize("NFKD").toLowerCase()
    .replace(/\p{Diacritic}/gu, "")
    .match(/[\p{L}\p{N}]+/gu) ?? [])];
}

export function meaningfulNewsTokens(value: string): string[] {
  return normalizedNewsTokens(value)
    .filter((token) => token.length >= 4 && !CUSTOM_STOP_WORDS.has(token));
}

/** Undefined means this custom phrase cannot safely select title metadata. */
export function customNewsTopicTokens(phrase: string): readonly string[] | undefined {
  if (typeof phrase !== "string" || phrase.length > 100 || /[\u0000-\u001f\u007f]/.test(phrase)) return;
  let tokens = meaningfulNewsTokens(phrase);
  if (tokens.length < 2 || tokens.length > 6) return;
  const qualifiers = normalizedNewsTokens(phrase).filter((token) =>
    token.length < 4 && !CUSTOM_STOP_WORDS.has(token) && !SHORT_GRAMMAR_WORDS.has(token));
  tokens = [...tokens, ...qualifiers];
  return tokens.length <= 6 ? tokens : undefined;
}
