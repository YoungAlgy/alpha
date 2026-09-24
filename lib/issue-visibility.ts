// The resolver used to include this process note in a source block. Older
// issues can have copied it into reader text. Keep the check narrow so a
// weak section or a failed optional rewrite does not hide a usable letter.
const LEAKED_SOURCE_NOTE = /full text unavailable(?:\s|[—–\-.,:…]){0,32}snippet\s*:/i;

export function issueHasLeakedSourceNote(value: unknown): boolean {
  if (typeof value === "string") return LEAKED_SOURCE_NOTE.test(value);
  if (Array.isArray(value)) return value.some(issueHasLeakedSourceNote);
  if (value && typeof value === "object") {
    return Object.values(value).some(issueHasLeakedSourceNote);
  }
  return false;
}

export function issueIsReaderVisible(issue: {
  editor_intro?: unknown;
  editorIntro?: unknown;
  sections?: unknown;
}): boolean {
  return !issueHasLeakedSourceNote(issue.editor_intro)
    && !issueHasLeakedSourceNote(issue.editorIntro)
    && !issueHasLeakedSourceNote(issue.sections);
}
