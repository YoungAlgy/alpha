import type { BraveResult } from "@/lib/brave";
import { hostTier, tierRank, type SourceTier } from "./source-authority";
import { normalizeUrl } from "./url-guard";

// Dedup + authority-rank raw Brave results into a shortlist. Pure (no I/O) so
// it's unit-testable. The expensive part (reading the article) happens after —
// this just (a) drops known-junk hosts, (b) floats trusted/primary sources to
// the top, and (c) caps per-host so the shortlist stays varied.
//
// We deliberately do NOT re-sort by date. Brave already returns results in
// relevance order (a decent quality proxy) and the freshness window already
// constrains recency. An earlier version sorted purely by recency and that
// promoted fresh-but-junk SEO pages over authoritative reporting — so here
// authority leads, Brave's relevance breaks ties.

export interface RankedSource extends BraveResult {
  host: string;
  tier: SourceTier;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Delegates to url-guard's normalizeUrl so this is the EXACT SAME identity
// excludeUrls (built via normalizeUrl in assemble.ts/blurb-cache.ts) compares
// against — falls back to the raw url on a parse failure normalizeUrl can't
// key (matches this function's old always-a-string contract, used by seen.has
// below). A hand-rolled parallel implementation lived here before and had
// drifted from normalizeUrl: it didn't strip amp./m./mobile. mirror
// subdomains or tracking params, so an already-cited article re-surfacing
// with a utm_ param or from an AMP mirror silently failed to match the
// exclusion set below and could ship again — the exact repeat this file's
// excludeUrls support exists to prevent.
function urlKey(url: string): string {
  return normalizeUrl(url) ?? url;
}

// A bare site root (path "/" and no query) is a portal, not an article. Brave
// returns them for broad queries and they always look "fresh", so they were
// getting cited over and over (a subscriber saw the same homepage linked in
// three letters). A search for what's NEW should cite pieces, not portals —
// the curated mock signals still recommend whole sites by design.
function isBareRoot(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.pathname === "/" || u.pathname === "") && !u.search;
  } catch {
    return false;
  }
}

export function rankAndDedup(
  results: BraveResult[],
  maxPerHost = 2,
  // Already-cited urlKeys (same identity as url-guard's normalizeUrl) to drop
  // BEFORE the per-host cap is accounted. Filtering these out after capping
  // would let an excluded article consume a host's cap slot and starve out a
  // legitimate new one from the same host — the whole point of the cap is to
  // keep the shortlist varied, so it must only count candidates that can
  // actually survive to the letter.
  excludeUrls?: Set<string>
): RankedSource[] {
  const enriched = results
    .map((r, i) => {
      const host = hostOf(r.url);
      return { r, i, host, key: urlKey(r.url), tier: hostTier(host, r.url) };
    })
    .filter(
      (e) =>
        e.host &&
        e.key &&
        e.tier !== "denied" &&
        !isBareRoot(e.r.url) &&
        !(excludeUrls && excludeUrls.has(e.key))
    );

  // Authority first, then Brave's own relevance order.
  enriched.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.i - b.i);

  const seen = new Set<string>();
  const perHost = new Map<string, number>();
  const out: RankedSource[] = [];
  for (const e of enriched) {
    if (seen.has(e.key)) continue;
    const count = perHost.get(e.host) ?? 0;
    if (count >= maxPerHost) continue;
    seen.add(e.key);
    perHost.set(e.host, count + 1);
    out.push({ ...e.r, host: e.host, tier: e.tier });
  }
  return out;
}
