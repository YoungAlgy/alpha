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

// Cosmetic subdomain prefixes that mirror the SAME content as the canonical
// host (Google AMP pages, mobile-optimized pages) — collapsed just like
// "www." so a same-story AMP/mobile URL matches its canonical counterpart
// instead of reading as a different host. Exported so any OTHER host
// normalization in the engine (e.g. source-rank.ts's hostOf(), used for its
// per-host diversity cap and the host label shown to the model) can share
// this exact definition instead of hand-rolling a narrower www-only version
// that silently drifts from this one — see source-rank.ts's own comment on
// urlKey() for the bug class a prior drift here already caused once.
export const MIRROR_SUBDOMAIN_RE = /^(?:www|amp|m|mobile)\./;

// Cross-site attribution/tracking params that never distinguish WHICH content
// a page shows, only where the visitor came from — stripped so a same-story
// URL that differs ONLY by a tracking param still matches. Deliberately a
// short, well-known set rather than dropping the query wholesale: some sites
// use a query param to identify the content itself (?v=, ?p=, ?id=), and
// those must stay so distinct pages stay distinct.
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "gclid", "fbclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid", "ito",
]);

// Normalize a URL to a comparison key. Returns null for non-http(s) or
// unparseable. Exported so a KNOWN url (e.g. a curated source link) can be keyed
// directly — building an allow-set by regex-scanning text would truncate a path
// containing ')' (URL_RE stops there), but a real URL's path can legitimately
// contain parens (e.g. /albums/x-(super-deluxe)/).
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase().replace(MIRROR_SUBDOMAIN_RE, "");
    // Path lowercased too (unlike the query string below, which stays
    // case-sensitive since a base64-ish id param could legitimately be
    // case-sensitive) — real-world CMSs commonly vary path case for the
    // identical page, and treating that as "a different URL" let a same-story
    // duplicate (e.g. from two independently-resolved redirect citations)
    // dodge the dedup/exclusion checks that rely on this identity.
    let path = u.pathname.toLowerCase().replace(/\/+$/, ""); // drop trailing slash(es)
    if (path === "") path = "/";
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    const query = u.searchParams.toString();
    // Keep any remaining query (distinguishes ?v=, ?p=, ?id=); drop fragment (cosmetic).
    return `${host}${path}${query ? `?${query}` : ""}`;
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

// A ref is only useful if it has a real label to show as the clickable text —
// a signal-verified URL with a blank/missing label would still ship as a
// visibly broken link (nothing for the reader to click). Whitespace-only
// counts as missing; non-string (including null/omitted) is guarded via
// typeof before calling .trim() so it can never throw.
function hasLabel(r: GuardableRef | undefined): r is GuardableRef {
  return !!r && typeof r.label === "string" && r.label.trim().length > 0;
}

// Strip any ref whose URL isn't in the signal, OR whose label is missing/
// blank. Mutates a shallow copy; returns the cleaned items plus a count of
// how many refs were dropped in total (for logging / monitoring the model's
// hallucination rate) and, separately, how many of those were dropped for a
// missing label specifically — kept apart so callers don't misattribute a
// label-drop to the "model hallucination blocked" URL-provenance log. The
// item itself is kept even if its primary link is dropped — the educational
// body still has value and the renderer handles link-less items; we only ever
// remove the unusable ref.
export function enforceSignalUrls<T extends GuardableItem>(
  items: T[],
  allowed: Set<string>
): { items: T[]; dropped: number; droppedForMissingLabel: number } {
  let dropped = 0;
  let droppedForMissingLabel = 0;
  const cleaned = items.map((it) => {
    let primaryRef = it.primaryRef;
    if (primaryRef && !hasLabel(primaryRef)) {
      dropped++;
      droppedForMissingLabel++;
      primaryRef = undefined;
    } else if (primaryRef && !isAllowedUrl(primaryRef.url, allowed)) {
      dropped++;
      primaryRef = undefined;
    }
    let supplementaryRefs = it.supplementaryRefs;
    if (Array.isArray(supplementaryRefs)) {
      const kept = supplementaryRefs.filter((r) => {
        if (!hasLabel(r)) {
          dropped++;
          droppedForMissingLabel++;
          return false;
        }
        const ok = isAllowedUrl(r.url, allowed);
        if (!ok) dropped++;
        return ok;
      });
      supplementaryRefs = kept.length > 0 ? kept : undefined;
    }
    return { ...it, primaryRef, supplementaryRefs };
  });
  return { items: cleaned, dropped, droppedForMissingLabel };
}
