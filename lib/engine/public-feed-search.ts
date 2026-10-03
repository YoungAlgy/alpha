import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { cleanField } from "./text-clean";
import { directChildValues, rssItemBlocks } from "./rss-xml";
import { noKeySourcesEnabled } from "./provider-policy";
import { readPublicSourceText } from "./public-source-response";
import { freshPublicResults, publicSourceWindow } from "./public-source-freshness";
import { createPublicSourceCache } from "./public-source-cache";
import { reservePublicSourceRequest } from "./public-source-budget";
import { runPublicSourceAttempt, type PublicSourceAttempt } from "./public-source-circuit";

/**
 * Optional no-key search fallback. It uses the public Google News RSS search
 * feed only after the configured search providers fail. The result is a
 * deliberately small, snippet-only feed. It is a resilience tier, not a
 * promise of unlimited search capacity.
 */

const ENDPOINT = "https://news.google.com/rss/search";
const MAX_RESULTS = 10;

export function publicFeedFallbackEnabled(): boolean {
  if (noKeySourcesEnabled()) return true;
  const raw = process.env.ALPHA_PUBLIC_FEED_FALLBACK?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Pure XML parsing helper so the fallback can be checked without a network. */
export function parsePublicFeedXml(xml: string, maxResults = MAX_RESULTS): BraveResult[] {
  const items: BraveResult[] = [];
  // The response reader bounds bytes. Retain raw blocks until valid results
  // reach the existing cap, so rejected items cannot hide later usable links.
  for (const block of rssItemBlocks(xml, Number.MAX_SAFE_INTEGER, "Public RSS")) {
    const value = (tag: string) => directChildValues(block, tag, true, "Public RSS")[0] ?? "";
    const url = value("link");
    const title = cleanField(value("title"));
    const description = cleanField(value("description"));
    if (!/^https?:\/\//i.test(url) || !title) continue;
    const published = value("pubdate");
    items.push({
      title,
      url,
      description,
      age: published || undefined,
    });
    if (items.length >= Math.min(100, Math.max(1, maxResults))) break;
  }
  return items;
}

function freshnessSuffix(freshness?: BraveSearchOptions["freshness"]): string {
  if (freshness === "pd") return " when:1d";
  if (freshness === "pw") return " when:7d";
  if (freshness === "pm") return " when:30d";
  if (freshness === "py") return " when:365d";
  const range = freshness?.match(/^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/);
  return range ? ` after:${range[1]} before:${range[2]}` : "";
}

export function createPublicFeedSearch(now: () => number = Date.now, deps: {
  attempt?: PublicSourceAttempt;
  reserve?: typeof reservePublicSourceRequest;
  fetcher?: typeof fetch;
} = {}) {
  const cached = createPublicSourceCache(now);
  const attempt = deps.attempt ?? runPublicSourceAttempt;
  const reserve = deps.reserve ?? reservePublicSourceRequest;
  const fetcher = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  return async function publicFeedSearch(
    query: string,
    opts: BraveSearchOptions = {}
  ): Promise<BraveResult[]> {
    if (!publicSourceWindow(opts.freshness, now())) return [];
    const params = new URLSearchParams({
      q: `${query}${freshnessSuffix(opts.freshness)}`,
      hl: "en-US", gl: "US", ceid: "US:en",
    });
    const results = await cached("google-rss", params.toString(), () => attempt("google-rss",
      () => reserve("google-rss"), async () => {
        const signal = AbortSignal.timeout(5000);
        const res = await fetcher(`${ENDPOINT}?${params}`, {
          headers: { Accept: "application/rss+xml, application/xml, text/xml" },
          signal, redirect: "error", credentials: "omit", cache: "no-store",
        });
        if (!res.ok) {
          void res.body?.cancel().catch(() => {});
          throw new Error(`Public RSS search ${res.status}`);
        }
        const xml = await readPublicSourceText(res, signal);
        if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml) || !/<\/rss\s*>/i.test(xml)) throw new Error("Public RSS invalid feed");
        return parsePublicFeedXml(xml, 100);
      }));
    // Keep the bounded raw pool until the resolver removes already-cited links.
    // Cutting to ten here can hide an unseen eleventh item behind prior reads.
    return freshPublicResults(results, opts.freshness, now());
  };
}

export const publicFeedSearch = createPublicFeedSearch();
