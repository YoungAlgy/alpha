// Thin client over the Brave Search API.
// VOLUME (daily cadence, 2026-07-03): ~60-100 queries/day ≈ 1,800-3,000/mo —
// pressing against the free tier's 2,000/mo cap. If letters start degrading
// (rateLimited429 below trips, sections go filler-heavy), the fix is Brave's
// paid tier (~$5-10/mo at this volume), not code.

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

// Degradation signal for the cron's end-of-run ops summary: how many queries
// came back 429 (quota/rate exhaustion) this invocation. Without this, an
// exhausted Brave quota silently turns every letter into stale filler with no
// operator-visible trace — generation "succeeds" all the way down.
//
// This counter is MONOTONIC (never reset) rather than reset-per-invocation on
// purpose: two overlapping cron invocations on the same warm lambda (a Vercel
// retry racing the scheduled run, a manual re-trigger) would otherwise race —
// whichever resets last zeroes out the other's in-flight count, corrupting
// the ops-alert signal. A caller that wants "how many 429s during MY run"
// should snapshot braveRateLimitedCount() at the start and end and diff the
// two — a rare overlap then just double-counts shared load into both
// invocations' deltas (a harmless, conservative-direction inaccuracy) rather
// than silently losing one invocation's count entirely.
let rateLimited429 = 0;
export function braveRateLimitedCount(): number {
  return rateLimited429;
}

export interface BraveResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  meta_url?: { hostname?: string };
}

export interface BraveSearchOptions {
  count?: number;
  // past day/week/month/year, OR a discovery date range "YYYY-MM-DDtoYYYY-MM-DD"
  // (Brave accepts both). The range is how the multi-send cadence asks for
  // "only what's new since the last letter" so stale topics read as empty.
  freshness?: "pd" | "pw" | "pm" | "py" | `${string}to${string}`;
  country?: string;
  safesearch?: "off" | "moderate" | "strict";
  // Fires in ADDITION to the global rateLimited429 counter above, scoped to
  // just THIS call. The global counter is shared across every topic running
  // concurrently in a generation wave (assemble.ts batches several topics via
  // Promise.all) — a caller that needs "did MY OWN queries get rate-limited"
  // (the Gemini search-fallback trigger in source-resolver.ts) can't use the
  // global counter's before/after delta for that, since a DIFFERENT topic's
  // 429 in the same wave would show up in the delta too. This callback lets a
  // caller track its own attempts in its own closure instead.
  onRateLimited?: () => void;
}

export function braveConfigured(): boolean {
  return !!process.env.BRAVE_SEARCH_API_KEY;
}

export async function braveSearch(
  query: string,
  opts: BraveSearchOptions = {}
): Promise<BraveResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) throw new Error("BRAVE_SEARCH_API_KEY missing");

  const params = new URLSearchParams({
    q: query,
    count: String(opts.count ?? 10),
    safesearch: opts.safesearch ?? "moderate",
  });
  if (opts.freshness) params.set("freshness", opts.freshness);
  if (opts.country) params.set("country", opts.country);

  // Bound the request (no AbortController = a hung Brave call could stall the
  // whole letter). On abort the throw is caught per-query in the source-resolver
  // and degrades to an empty result set for that query.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}?${params}`, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": key,
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 429) {
      rateLimited429 += 1;
      opts.onRateLimited?.();
    }
    const text = await res.text().catch(() => "");
    throw new Error(`Brave Search ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { web?: { results?: BraveResult[] } };
  return data.web?.results ?? [];
}
