// The resolver used to include this process note in a source block. Older
// issues can have copied it into reader text. Keep the check narrow so a
// weak section or a failed optional rewrite does not hide a usable letter:
// it needs both "full text unavailable" and the internal "snippet:" label.
// Any punctuation between the words is tolerated ("Full-text", "(snippet:",
// ";", Unicode dashes, a non-breaking space), since the model rewrites it.
// With the i flag, [^a-z0-9] also excludes uppercase letters.
const NOTE = String.raw`\bfull[^a-z0-9]{0,3}text(?:[^a-z0-9]{1,3}(?:is|was))?[^a-z0-9]{1,3}(?:unavailable|not\s+available)[^a-z0-9]{0,32}snippet\s*:`;
export const LEAKED_SOURCE_NOTE = new RegExp(NOTE, "i");
// The resolver's whole wrapper, "(full text unavailable — snippet: X)",
// unwrapped to X by the legacy source-context parser.
export const WRAPPED_SOURCE_NOTE = new RegExp(String.raw`^\(${NOTE}\s*([\s\S]*)\)$`, "i");

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
