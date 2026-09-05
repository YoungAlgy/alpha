import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { cleanField } from "./text-clean";

/**
 * Optional no-key search fallback. It uses the public Google News RSS search
 * feed only after the configured search providers fail. The result is a
 * deliberately small, snippet-only feed. It is a resilience tier, not a
 * promise of unlimited search capacity.
 */

const ENDPOINT = "https://news.google.com/rss/search";
const MAX_RESULTS = 10;

export function publicFeedFallbackEnabled(): boolean {
  const raw = process.env.ALPHA_PUBLIC_FEED_FALLBACK?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, digits: string) => {
      const codePoint = Number(digits);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    });
}

function tagValue(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ? decodeEntities(match[1]).trim() : "";
}

/** Pure XML parsing helper so the fallback can be checked without a network. */
export function parsePublicFeedXml(xml: string): BraveResult[] {
  const items: BraveResult[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  for (const match of xml.matchAll(itemRe)) {
    const block = match[1] ?? "";
    const url = tagValue(block, "link");
    const title = cleanField(tagValue(block, "title"));
    const description = cleanField(tagValue(block, "description"));
    if (!/^https?:\/\//i.test(url) || !title) continue;
    const published = tagValue(block, "pubDate");
    items.push({
      title,
      url,
      description,
      age: published || undefined,
    });
    if (items.length >= MAX_RESULTS) break;
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

export async function publicFeedSearch(
  query: string,
  opts: BraveSearchOptions = {}
): Promise<BraveResult[]> {
  const params = new URLSearchParams({
    q: `${query}${freshnessSuffix(opts.freshness)}`,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  const res = await fetch(`${ENDPOINT}?${params}`, {
    headers: { Accept: "application/rss+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Public RSS search ${res.status}`);
  return parsePublicFeedXml(await res.text());
}
