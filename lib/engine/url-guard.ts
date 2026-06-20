// CODE-LEVEL enforcement of the "no invented links" guarantee.
//
// The system prompt asks Claude to only cite URLs that appear in the signal,
// but trusting the model is NOT a guard — a hallucinated URL would otherwise
// flow straight into a reader's letter. This module extracts the set of real
// URLs present in the signal and validates every generated URL against it.
// Any URL whose normalized form is not in the signal is dropped before it can
// reach a letter. This makes the guarantee real instead of advisory.
//
// Design: normalization is deliberately lenient on COSMETIC differences
// (http/https, leading www., trailing slash, #fragment) so we don't drop a
// genuinely-real URL the model lightly reformatted — but STRICT on host + path
// + query, which is what actually identifies the destination. An invented URL
// will not match any signal URL and is dropped. We never invent or rewrite a
// URL; we only ever keep or drop what the model returned.

const URL_RE = /https?:\/\/[^\s"'<>)\]}]+/gi;

// Normalize a URL to a comparison key. Returns null for non-http(s) or
// unparseable. Exported so a KNOWN url (e.g. a curated source link) can be keyed
// directly — building an allow-set by regex-scanning text would truncate a path
// containing ')' (URL_RE stops there), but a real URL's path can legitimately
// contain parens (e.g. /albums/x-(super-deluxe)/).
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let path = u.pathname.replace(/\/+$/, ""); // drop trailing slash(es)
    if (path === "") path = "/";
    // Keep query (distinguishes ?v=, ?p=, ?id=); drop fragment (cosmetic).
    return `${host}${path}${u.search}`;
  } catch {
    return null;
  }
}

// Pull every real URL out of a signal context blob into a normalized allow-set.
export function extractSignalUrls(context: string): Set<string> {
  const allowed = new Set<string>();
  const matches = context.match(URL_RE) || [];
  for (const m of matches) {
    // Regex can capture trailing sentence punctuation — strip it.
    const cleaned = m.replace(/[.,;:!?]+$/, "");
    const n = normalizeUrl(cleaned);
    if (n) allowed.add(n);
  }
  return allowed;
}

// Is this generated URL actually present in the signal?
export function isAllowedUrl(url: string | undefined, allowed: Set<string>): boolean {
  if (!url) return false;
  const n = normalizeUrl(url);
  if (!n) return false;
  return allowed.has(n);
}

export interface GuardableRef {
  label: string;
  url: string;
  note?: string;
}
export interface GuardableItem {
  primaryRef?: GuardableRef;
  supplementaryRefs?: GuardableRef[];
  [k: string]: unknown;
}

// Strip any ref whose URL isn't in the signal. Mutates a shallow copy; returns
// the cleaned items plus a count of how many URLs were dropped (for logging /
// monitoring the model's hallucination rate). The item itself is kept even if
// its primary link is dropped — the educational body still has value and the
// renderer handles link-less items; we only ever remove the unverifiable link.
export function enforceSignalUrls<T extends GuardableItem>(
  items: T[],
  allowed: Set<string>
): { items: T[]; dropped: number } {
  let dropped = 0;
  const cleaned = items.map((it) => {
    let primaryRef = it.primaryRef;
    if (primaryRef && !isAllowedUrl(primaryRef.url, allowed)) {
      dropped++;
      primaryRef = undefined;
    }
    let supplementaryRefs = it.supplementaryRefs;
    if (Array.isArray(supplementaryRefs)) {
      const kept = supplementaryRefs.filter((r) => {
        const ok = isAllowedUrl(r.url, allowed);
        if (!ok) dropped++;
        return ok;
      });
      supplementaryRefs = kept.length > 0 ? kept : undefined;
    }
    return { ...it, primaryRef, supplementaryRefs };
  });
  return { items: cleaned, dropped };
}
