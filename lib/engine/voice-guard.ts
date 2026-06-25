// Deterministic enforcement of the no-AI-tells writing voice on generated prose.
// The generation prompts already ASK the model to avoid em/en dashes, semicolons,
// and curly quotes, but Haiku (and any model) follows that imperfectly — and these
// are a HARD reader-facing rule. So we also strip the mechanical violations in
// code, the same way url-guard enforces the citable-URL rule instead of trusting
// the prompt alone. Structural tells ("X, not Y", rule-of-three) can't be safely
// regex-fixed and stay prompt-only; this handles the punctuation/glyph ones, which
// are clear-cut and the most visible.
export function sanitizeVoice(s: string): string {
  if (!s) return s;
  return s
    .replace(/\s*—\s*/g, ", ") // em dash → comma (never long dashes)
    .replace(/–/g, "-") // en dash → hyphen
    .replace(/[‘’]/g, "'") // curly single quotes → straight
    .replace(/[“”]/g, '"') // curly double quotes → straight
    .replace(/…/g, "...") // ellipsis glyph → three dots people type
    .replace(/\s*;\s*/g, ", ") // semicolon → comma (no semicolons)
    .replace(/,\s*,/g, ",") // tidy any doubled comma the swaps created
    .replace(/ {2,}/g, " ") // collapse doubled spaces
    .trim();
}
