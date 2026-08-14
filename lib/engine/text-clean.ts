// Shared sanitizer for third-party-controlled text (a search result's title,
// description, or a grounded-search answer) before it's spliced into a
// generation prompt. Strips HTML/XML-style tags so smuggled markup can't
// break a prompt's own <tag>-delimited fences downstream, and strips bare
// URLs so a citable-link allow-set (built separately from each resolver's
// own chosen SOURCE urls) stays the only way a URL reaches the model as
// something to cite. Split out of source-resolver.ts (rather than imported
// from it) so gemini-search.ts can reuse it too: source-resolver.ts itself
// imports gemini-search.ts, so the reverse import would be circular.
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

export function cleanField(s: string): string {
  return stripTags(s)
    .replace(/https?:\/\/[^\s)\]]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
