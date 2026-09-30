import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { parsePublicFeedXml } from "./public-feed-search";
import { readPublicSourceText } from "./public-source-response";
import { createPublicSourceCache } from "./public-source-cache";
import { freshPublicResults, publicSourceWindow } from "./public-source-freshness";
import { reservePublicSourceRequest } from "./public-source-budget";

// Fixed first-party endpoints. No subscriber topic, profile, identity or search
// expression leaves the app. Match topic suitability locally on source titles.
const FEEDS = {
  nist: { url: "https://www.nist.gov/news-events/news/rss.xml", host: "www.nist.gov", label: "NIST", kind: "Research and standards update" },
  fda: { url: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/medwatch/rss.xml", host: "www.fda.gov", label: "FDA MedWatch", kind: "Product safety notice" },
} as const;
type Feed = keyof typeof FEEDS;
const TOPICS: Partial<Record<string, { feed: Feed; matches: RegExp }>> = {
  "ai-news": { feed: "nist", matches: /\b(?:artificial intelligence|machine learning|AI|LLMs?)\b/i },
  "real-estate": { feed: "nist", matches: /\b(?:building|buildings|construction|housing)\b/i },
  "sustainable-living": { feed: "nist", matches: /\b(?:climate|energy|solar|environment|carbon|recycling)\b/i },
  "founder-operator": { feed: "nist", matches: /\b(?:small business|manufacturing|entrepreneur)\b/i },
  "longevity-wellness": { feed: "fda", matches: /\b(?:safety|recall|drug|medicine|medical|device|treatment|health|removes|warns)\b/i },
  "nutrition-food": { feed: "fda", matches: /\b(?:dietary|supplement|nutrition|nutritional|vitamin|food)\b/i },
  "mental-health": { feed: "fda", matches: /\b(?:mental|psychiatric|depression|antidepressant|anxiety|ADHD)\b/i },
  "womens-health": { feed: "fda", matches: /\b(?:women|pregnancy|pregnant|breast|contracept|menopause|uterine)\b/i },
  parenting: { feed: "fda", matches: /\b(?:infant|child|children|pediatric|baby|babies)\b/i },
};

export function publisherFeedFallbackEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ALPHA_PUBLISHER_FEED_FALLBACK?.trim() ?? "");
}

export function createPublisherFeedSearch(deps: { fetcher?: typeof fetch; now?: () => number; reserve?: typeof reservePublicSourceRequest } = {}) {
  const fetcher = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const reserve = deps.reserve ?? reservePublicSourceRequest;
  const cached = createPublicSourceCache(now);
  return async (topicId: string, opts: BraveSearchOptions = {}): Promise<BraveResult[]> => {
    const selection = Object.hasOwn(TOPICS, topicId) ? TOPICS[topicId] : undefined;
    if (!selection || !publicSourceWindow(opts.freshness, now())) return [];
    const feed = FEEDS[selection.feed];
    const raw = await cached(`publisher-${selection.feed}`, "feed-v1", async () => {
      await reserve("publisher-rss");
      const signal = AbortSignal.timeout(5000);
      const response = await fetcher(feed.url, { signal, redirect: "error", credentials: "omit", cache: "no-store", headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`Publisher RSS ${response.status}`);
      }
      const xml = await readPublicSourceText(response, signal);
      if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml) || !/<\/rss\s*>/i.test(xml)) throw new Error("Publisher RSS invalid feed");
      return parsePublicFeedXml(xml, 100).flatMap((item) => {
        try {
          const url = new URL(item.url);
          if (url.hostname !== feed.host || url.username || url.password || url.port) return [];
          // FDA's HTTPS MedWatch feed publishes legacy HTTP article links.
          // Its canonical HTTPS article endpoint was verified separately. Only
          // this fixed first-party host gets upgraded; no HTTP request is made.
          if (selection.feed === "fda" && url.protocol === "http:") url.protocol = "https:";
          if (url.protocol !== "https:") return [];
          return [{ ...item, url: url.href, description: "" }];
        } catch { return []; }
      });
    });
    return freshPublicResults(raw, opts.freshness, now())
      .filter((item) => selection.matches.test(item.title))
      .slice(0, 10)
      .map((item) => ({ ...item, title: `${feed.label}: ${item.title}`, description: `${feed.kind}. Source date: ${new Date(Date.parse(item.age!)).toISOString().slice(0, 10)}.` }));
  };
}

export const publisherFeedSearch = createPublisherFeedSearch();
