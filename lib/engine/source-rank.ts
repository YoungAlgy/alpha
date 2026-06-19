import type { BraveResult } from "@/lib/brave";
import { hostTier, tierRank, type SourceTier } from "./source-authority";

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

// Host + path + query, fragment dropped — matches url-guard's normalizeUrl
// identity (query distinguishes ?v= / ?p= / ?id=), so a query-distinguished
// real source isn't collapsed away here while the guard treats it as distinct.
function urlKey(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${hostOf(url)}${path}${u.search}`;
  } catch {
    return url;
  }
}

export function rankAndDedup(results: BraveResult[], maxPerHost = 2): RankedSource[] {
  const enriched = results
    .map((r, i) => {
      const host = hostOf(r.url);
      return { r, i, host, key: urlKey(r.url), tier: hostTier(host, r.url) };
    })
    .filter((e) => e.host && e.key && e.tier !== "denied");

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
