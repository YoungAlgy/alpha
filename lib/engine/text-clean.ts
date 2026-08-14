// Shared sanitizer for third-party-controlled text (a search result's title,
// description, or a grounded-search answer) before it's spliced into a
// generation prompt. Strips HTML/XML-style tags so smuggled markup can't
// break a prompt's own <tag>-delimited fences downstream, and strips bare
// URLs so a citable-link allow-set (built separately from each resolver's
// own chosen SOURCE urls) stays the only way a URL reaches the model as
// something to cite. Split out of source-resolver.ts (rather than imported
// from it) so gemini-search.ts can reuse it too: source-resolver.ts itself
// imports gemini-search.ts, so the reverse import would be circular.
import { stripPromptFenceChars } from "@/lib/prompt-fence";

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

// alpha-drift-r21-04 (found+fixed 2026-08-14, self-audit): stripTags above
// only matches a complete ASCII <tag> construct -- it doesn't catch a
// Unicode angle-bracket homoglyph (fullwidth, single angle quotes, math,
// CJK) an LLM could still read as tag-shaped punctuation, the same gap
// lib/prompt-fence.ts's stripPromptFenceChars fixed for its own call sites
// this same round. Layered on top here (not instead of stripTags) so the
// two keep doing their own jobs: stripTags removes the ASCII tag
// DELIMITERS only, leaving any text between them in place (e.g.
// "<script>alert(1)</script>" -> "alert(1)", not ""), so it alone can't
// stop a smuggled prompt-fence-shaped tag's own inner text from surviving.
// stripPromptFenceChars strips the bracket characters themselves wherever
// they appear, tag-shaped or not -- running both catches everything either
// one alone would miss.
// alpha-drift-r22-03 (found+fixed 2026-08-14, self-audit): the paragraph
// above used to claim stripTags reduces "<script>alert(1)</script>" to ""
// -- it doesn't; the regex only eats the <...> delimiters themselves, so
// the real output is "alert(1)". Corrected so this comment can't send a
// future reader looking for content-stripping behavior that was never
// actually here.
export function cleanField(s: string): string {
  return stripPromptFenceChars(stripTags(s))
    .replace(/https?:\/\/[^\s)\]]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
