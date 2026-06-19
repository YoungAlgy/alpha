// Best-effort full-text fetch for a source URL, so a letter section is written
// from the ACTUAL article instead of a one-line search snippet. Uses Jina
// Reader (r.jina.ai), which returns clean reader-mode text for any URL with no
// API key required. Every call is timeout-bounded and failure-tolerant: a fetch
// that errors, times out, or extracts too little returns null and the caller
// falls back to the Brave snippet — so deep-reading only ever ADDS depth, it
// never breaks or blocks a letter.

const JINA_PREFIX = "https://r.jina.ai/";
const DEFAULT_TIMEOUT_MS = 7000;
const MAX_CHARS = 2400; // per source — keeps the combined signal token-bounded
const MIN_USABLE_CHARS = 220; // below this, treat extraction as failed

// Kill switch: flip ALPHA_DISABLE_DEEPREAD=1 in the Vercel env (no deploy) to
// fall straight back to snippet-only signal if Jina ever degrades.
export function deepReadEnabled(): boolean {
  return process.env.ALPHA_DISABLE_DEEPREAD !== "1";
}

// Fetch + clean the main text of one URL. Returns null on any failure so the
// caller degrades to the snippet for that source.
export async function fetchArticleText(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      Accept: "text/plain",
      // Ask Jina for the main content as plain text (drops nav/boilerplate).
      "X-Return-Format": "text",
    };
    const jinaKey = process.env.JINA_API_KEY?.trim();
    if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;

    const res = await fetch(`${JINA_PREFIX}${url}`, { headers, signal: ctrl.signal });
    if (!res.ok) return null;
    const raw = await res.text();
    const cleaned = sanitizeContent(raw);
    if (cleaned.length < MIN_USABLE_CHARS || !looksLikeProse(cleaned)) return null;
    return cleaned;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Reject extractions that are app/nav CHROME rather than an article (e.g. a
// page-builder canvas returning "Pages / Layers / Assets" menu labels). Real
// prose has sentences and lines of meaningful length; chrome is many ultra-short
// label lines with almost no sentence punctuation. Garbage here would otherwise
// give the model convincing-looking material to write a confidently-wrong item.
function looksLikeProse(s: string): boolean {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 70) return false; // too short to be a real article
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  const avgWordsPerLine = words.length / Math.max(1, lines.length);
  if (avgWordsPerLine < 4) return false; // mostly short label lines => chrome
  const sentences = (s.match(/[.!?]["')\]]?(?:\s|$)/g) || []).length;
  // Real prose has sentences. Also accept a long, structured body (a changelog
  // or bulleted primary source) that's light on periods but still has real line
  // length — those are valuable primary sources, not nav chrome.
  return sentences >= 4 || (words.length >= 120 && avgWordsPerLine >= 6);
}

// Strip every URL out of the fetched body. CRITICAL: the url-guard builds its
// citable allow-set by regex-scanning the WHOLE signal string, so any link left
// inside article text (ads, nav, random outbound links) would become citable.
// We keep only the curated SOURCE urls citable (the resolver adds those
// explicitly), so here we remove all URLs from the body while keeping the link
// TEXT, leaving plain prose for the model to actually read.
export function sanitizeContent(raw: string): string {
  let s = raw;
  // Jina prepends "Title: / URL Source: / Markdown Content:" metadata — drop it.
  s = s.replace(/^\s*Title:.*$/im, "");
  s = s.replace(/^\s*URL Source:.*$/im, "");
  s = s.replace(/^\s*Markdown Content:\s*$/im, "");
  // Markdown image then link syntax → keep alt/link text only. The scheme match
  // is case-INSENSITIVE: the url-guard's extractor is case-insensitive, so if
  // sanitize were case-sensitive an uppercase HTTPS:// body link would survive
  // here and leak into the citable allow-set — exactly the failure the guard
  // exists to prevent.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/gi, "$1");
  // Any remaining bare URLs → remove (so they can't enter the citable set).
  s = s.replace(/https?:\/\/[^\s)\]]+/gi, "");
  // Tidy whitespace.
  s = s.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > MAX_CHARS) {
    // Cut on a sentence boundary near the limit so we don't end mid-word.
    const slice = s.slice(0, MAX_CHARS);
    const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
    s = (lastStop > MAX_CHARS * 0.6 ? slice.slice(0, lastStop + 1) : slice).trim() + " […]";
  }
  return s;
}
