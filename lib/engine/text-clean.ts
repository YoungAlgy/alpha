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
// two keep doing their own jobs: stripTags removes a REAL tag's inner
// content along with it (e.g. "<script>alert(1)</script>" -> "" not
// "alert(1)"), stripPromptFenceChars only strips the bracket characters
// themselves -- running both catches everything either one alone would miss.
export function cleanField(s: string): string {
  return stripPromptFenceChars(stripTags(s))
    .replace(/https?:\/\/[^\s)\]]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
