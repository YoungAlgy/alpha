// Thin client over the Brave Search API.
// Free credit covers ~1,000 queries/mo. We use ~300 with shared-topic content.

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export interface BraveResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  meta_url?: { hostname?: string };
}

export interface BraveSearchOptions {
  count?: number;
  freshness?: "pd" | "pw" | "pm" | "py"; // past day/week/month/year
  country?: string;
  safesearch?: "off" | "moderate" | "strict";
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

  const res = await fetch(`${ENDPOINT}?${params}`, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": key,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Brave Search ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { web?: { results?: BraveResult[] } };
  return data.web?.results ?? [];
}

// Format Brave results into a signal-context string that the topic-blurb
// prompt can read. Same shape as our existing mock signals so the engine
// doesn't need to change.
export function formatAsSignal(query: string, results: BraveResult[]): string {
  if (results.length === 0) {
    return `No fresh search results for "${query}" this week.`;
  }
  const lines = results.slice(0, 10).map((r, i) => {
    const host = r.meta_url?.hostname || tryHost(r.url);
    const age = r.age ? ` · ${r.age}` : "";
    return `${i + 1}. ${r.title}${age}\n   ${stripTags(r.description)}\n   ${r.url} (${host})`;
  });
  return lines.join("\n\n");
}

function tryHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}
