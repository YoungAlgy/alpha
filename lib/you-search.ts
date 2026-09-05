// Thin client over the You.com Search API — a genuinely independent search
// index (its own crawl/ranking, not a Google/Bing SERP reseller like the
// candidates ruled out during 2026-07-29 research: Serper, SerpApi,
// SearchApi.io, Serpstack, Startpage all proxy Google; Kagi explicitly blends
// in anonymized Google + Brave calls). Added as a THIRD search tier alongside
// Brave and Gemini's grounded search, tried only when Brave's own quota is
// exhausted (see source-resolver.ts) — Brave AND Gemini being down on the
// same day is a real observed condition, not hypothetical (2026-07-29
// incident: Brave $5/mo-capped, Gemini free tier exhausted, one topic went
// fully dry that day).
//
// Returns results in the SAME BraveResult shape as lib/brave.ts on purpose:
// You.com, like Brave, returns real discrete per-result URLs (unlike Gemini's
// grounded search, which returns one synthesized answer + citations) — so it
// can share source-resolver's existing per-query fan-out, ranking, dedup, and
// deep-read pipeline instead of duplicating it.

import type { BraveResult, BraveSearchOptions } from "@/lib/brave";

const ENDPOINT = "https://ydc-index.io/v1/search";

// Mirrors braveRateLimitedCount's monotonic-counter reasoning (lib/brave.ts,
// see its comment) — never reset per-invocation so one concurrently-running
// topic's code can't zero out a different topic's in-flight count.
let rateLimitedCount = 0;
export function youRateLimitedCount(): number {
  return rateLimitedCount;
}

export function youConfigured(): boolean {
  return !!process.env.YOU_API_KEY;
}

// Brave's freshness codes (pd/pw/pm/py) map to You.com's day/week/month/year.
// A "YYYY-MM-DDtoYYYY-MM-DD" range passes through unchanged — both APIs use
// the identical format (verified against You.com's own docs).
function toYouFreshness(freshness?: BraveSearchOptions["freshness"]): string | undefined {
  if (!freshness) return undefined;
  const map: Record<string, string> = { pd: "day", pw: "week", pm: "month", py: "year" };
  return map[freshness] ?? freshness;
}

interface YouWebResult {
  url: string;
  title: string;
  description?: string;
  page_age?: string;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export async function youSearch(
  query: string,
  opts: BraveSearchOptions = {}
): Promise<BraveResult[]> {
  const key = process.env.YOU_API_KEY;
  if (!key) throw new Error("YOU_API_KEY missing");

  const params = new URLSearchParams({
    query,
    count: String(opts.count ?? 10),
    safesearch: opts.safesearch ?? "moderate",
  });
  const freshness = toYouFreshness(opts.freshness);
  if (freshness) params.set("freshness", freshness);

  // Bound headers and body together, using the same five-second budget as
  // Brave. A provider that stalls its body must still release this query.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${ENDPOINT}?${params}`, {
      headers: { Accept: "application/json", "X-API-Key": key },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Keep the existing 429/402 quota signal if the error body also stalls.
      if (res.status === 429 || res.status === 402) {
        rateLimitedCount += 1;
        opts.onRateLimited?.();
      }
      const text = await res.text().catch(() => "");
      throw new Error(`You.com Search ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as { results?: { web?: YouWebResult[] } };
    const web = data.results?.web ?? [];
    return web.map((r) => ({
      // A missing title must never reach cleanField() as undefined — that's a
      // TypeError inside fetchLiveSignal's block-building, caught by the
      // per-provider try/catch at the call site, but that silently kills the
      // one attempt this fallback tier exists to make succeed.
      title: r.title || safeHost(r.url) || r.url,
      url: r.url,
      description: r.description ?? "",
      age: r.page_age,
      // No meta_url here (unlike Brave's own results, which carry one) — every
      // caller of this shared BraveResult shape reads a host via
      // `s.host || s.meta_url?.hostname` (source-resolver.ts), and s.host is
      // ALWAYS already set by the time either of those two read sites runs:
      // rankAndDedup (source-rank.ts) requires a truthy host to survive its own
      // filter and stamps its own normalized one on every result it emits, and
      // every result those two sites see has already passed through
      // rankAndDedup. So a you.com-specific meta_url would never actually be
      // read — round-2 review found an earlier version of this file computed
      // one anyway (dead weight, and inconsistently normalized vs rankAndDedup's
      // own hostOf() — no lowercase/www-strip — a latent trap if that fallback
      // read order ever changed). Removed rather than left unread.
    }));
  } finally {
    clearTimeout(timer);
  }
}
