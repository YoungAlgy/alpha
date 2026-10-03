import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { validatedGlobalVoicesAttribution } from "@/lib/source-attribution";
import { directChildValues, rssItemBlocks } from "./rss-xml";
import { isCustomTopic } from "@/lib/topics";
import { noModelModeEnabled } from "./provider-policy";
import { publicTopicPhrase } from "./topic-queries";
import { readPublicSourceText } from "./public-source-response";
import { createPublicSourceCache } from "./public-source-cache";
import { freshPublicResults, publicSourceWindow } from "./public-source-freshness";
import { reservePublicSourceRequest } from "./public-source-budget";
import { runPublicSourceAttempt, type PublicSourceAttempt } from "./public-source-circuit";

const FEEDS = {
  music: "https://globalvoices.org/-/topics/music/feed/",
  general: "https://globalvoices.org/feed/",
} as const;
const ACCEPT = "application/rss+xml, application/xml, text/xml";

const CUSTOM_STOP_WORDS = new Set([
  "about", "after", "best", "current", "daily", "for", "from", "latest", "news",
  "the", "this", "today", "updates", "week", "weekly", "with",
]);

type FeedKind = keyof typeof FEEDS;
type FeedItem = BraveResult & { categories: string[] };

function parseGlobalVoicesXml(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const block of rssItemBlocks(xml, 100, "Global Voices RSS")) {
    const title = directChildValues(block, "title")[0] ?? "";
    const rawUrl = directChildValues(block, "link")[0] ?? "";
    const publishedAt = directChildValues(block, "pubdate")[0] ?? "";
    const author = directChildValues(block, "dc:creator")[0] ?? "";
    const attribution = validatedGlobalVoicesAttribution(rawUrl, author, publishedAt);
    if (!title || !attribution) continue;

    const categories = directChildValues(block, "category").slice(0, 20);
    items.push({
      title: `Global Voices: ${title.slice(0, 300)}`,
      url: new URL(rawUrl).href,
      description: `Global Voices story. Source date: ${attribution.publishedAt.slice(0, 10)}.`,
      age: publishedAt,
      attribution,
      categories,
    });
  }
  return items;
}

function meaningfulTokens(value: string): string[] {
  return [...new Set(value.normalize("NFKD").toLowerCase()
    .replace(/\p{Diacritic}/gu, "")
    .match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((token) => token.length >= 4 && !CUSTOM_STOP_WORDS.has(token));
}

type TopicSelection = { feed: FeedKind; mode: "all" | "genre" | "phrase"; tokens?: string[]; genre?: string };

function articlePathDate(url: string): number | undefined {
  try {
    const article = new URL(url);
    if (article.protocol !== "https:" || article.hostname !== "globalvoices.org" ||
        article.username || article.password || article.port || article.search || article.hash) return;
    const match = article.pathname.match(/^\/(\d{4})\/(\d{2})\/(\d{2})\/[^/]+\/$/);
    if (!match) return;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const timestamp = Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return;
    return timestamp;
  } catch { return; }
}

function selectTopic(topicId: string): TopicSelection | undefined {
  if (topicId === "music") return { feed: "music", mode: "all" };
  const genre = topicId.match(/^music-(edm|hiphop|country|indie)$/)?.[1];
  if (genre) return { feed: "music", mode: "genre", genre };

  const phrase = publicTopicPhrase(topicId);
  if (!phrase || phrase.length > 100 || /[\u0000-\u001f\u007f]/.test(phrase)) return;
  if (isCustomTopic(topicId)) {
    const normalizedCustomText = phrase.trim().toLowerCase().replace(/\s+/g, " ");
    if (normalizedCustomText === "country music" || normalizedCustomText === "indie music") {
      return { feed: "music", mode: "genre", genre: normalizedCustomText === "country music" ? "country" : "indie" };
    }
  }

  const tokens = meaningfulTokens(phrase);
  if (tokens.length === 0 || tokens.length > 6 || (isCustomTopic(topicId) && tokens.length < 2)) return;
  return { feed: "general", mode: "phrase", tokens };
}

function genreMatches(item: FeedItem, genre: string): boolean {
  const title = item.title.replace(/^Global Voices:\s*/i, "");
  const categories = item.categories.map((value) => value.toLowerCase());
  const categoryHas = (pattern: RegExp) => categories.some((value) => pattern.test(value));
  switch (genre) {
    case "hiphop":
      return categoryHas(/^\s*(?:hip[\s-]?hop|rap)(?:\s+music)?\s*$/i) || /\b(?:hip[\s-]?hop|rap music)\b/i.test(title);
    case "edm":
      return categoryHas(/^\s*(?:edm|electronic(?: dance)? music|dance music)\s*$/i) || /\b(?:edm|electronic dance music|electronic music)\b/i.test(title);
    case "country":
      return categoryHas(/^\s*country music\s*$/i) || /\bcountry music\b/i.test(title);
    case "indie":
      return categoryHas(/^\s*(?:indie|independent)(?: music)?\s*$/i) || /\b(?:indie music|independent music)\b/i.test(title);
    default:
      return false;
  }
}

function phraseMatches(item: FeedItem, tokens: string[]): boolean {
  const searchable = meaningfulTokens([
    item.title.replace(/^Global Voices:\s*/i, ""),
    ...item.categories,
  ].join(" "));
  const available = new Set(searchable);
  return tokens.every((token) => available.has(token));
}

export function openNewsFeedFallbackEnabled(): boolean {
  const raw = process.env.ALPHA_OPEN_NEWS_FALLBACK?.trim().toLowerCase();
  const enabled = raw === "1" || raw === "true" || raw === "yes";
  return enabled && noModelModeEnabled();
}

export function createOpenNewsFeedSearch(deps: {
  fetcher?: typeof fetch;
  now?: () => number;
  reserve?: typeof reservePublicSourceRequest;
  attempt?: PublicSourceAttempt;
} = {}) {
  const fetcher = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const reserve = deps.reserve ?? reservePublicSourceRequest;
  const attempt = deps.attempt ?? runPublicSourceAttempt;
  const cached = createPublicSourceCache(now);

  return async function openNewsFeedSearch(topicId: string, opts: BraveSearchOptions = {}): Promise<BraveResult[]> {
    const selection = selectTopic(topicId);
    if (!selection || !openNewsFeedFallbackEnabled() || !publicSourceWindow(opts.freshness, now())) return [];

    const raw = await cached("open-news", `${selection.feed}-v1`, () => attempt("global-voices-rss",
      () => reserve("publisher-rss"), async () => {
      const signal = AbortSignal.timeout(5000);
      const response = await fetcher(FEEDS[selection.feed], {
        signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: { Accept: ACCEPT },
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`Global Voices RSS ${response.status}`);
      }
      return parseGlobalVoicesXml(await readPublicSourceText(response, signal));
    }));

    const window = publicSourceWindow(opts.freshness, now());
    if (!window) return [];
    const fresh = (freshPublicResults(raw, opts.freshness, now()) as FeedItem[])
      .filter((item) => {
        const pathDate = articlePathDate(item.url);
        return pathDate !== undefined && pathDate >= window.start && pathDate <= window.end;
      });
    const matched = selection.mode === "all"
      ? fresh
      : selection.mode === "genre"
        ? fresh.filter((item) => genreMatches(item, selection.genre!))
        : fresh.filter((item) => phraseMatches(item, selection.tokens!));
    // Keep the raw 100-item metadata pool intact through local filtering. The
    // shared ranker applies prior-link exclusions and the final shortlist cap.
    return matched.flatMap(({ categories: _categories, ...item }) => {
      const attribution = validatedGlobalVoicesAttribution(
        item.url,
        item.attribution?.author,
        item.attribution?.publishedAt
      );
      return attribution ? [{ ...item, attribution }] : [];
    });
  };
}

export const openNewsFeedSearch = createOpenNewsFeedSearch();
