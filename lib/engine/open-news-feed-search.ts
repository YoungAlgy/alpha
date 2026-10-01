import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { validatedGlobalVoicesAttribution } from "@/lib/source-attribution";
import { decodeTextEntities } from "@/lib/text-entities";
import { cleanField } from "./text-clean";
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
const MAX_ITEMS = 100;
const ACCEPT = "application/rss+xml, application/xml, text/xml";

const CUSTOM_STOP_WORDS = new Set([
  "about", "after", "best", "current", "daily", "for", "from", "latest", "news",
  "the", "this", "today", "updates", "week", "weekly", "with",
]);

type FeedKind = keyof typeof FEEDS;
type FeedItem = BraveResult & { categories: string[] };

type XmlToken = {
  start: number;
  end: number;
  name?: string;
  closing?: boolean;
  selfClosing?: boolean;
};

// Small tokenizer, not a general XML implementation. It treats CDATA,
// comments, processing instructions, and declarations as opaque so markup
// inside article bodies cannot create fake RSS items or metadata children.
function nextXmlToken(xml: string, from: number): XmlToken | undefined {
  const start = xml.indexOf("<", from);
  if (start < 0) return;
  if (xml.startsWith("<![CDATA[", start)) {
    const close = xml.indexOf("]]>", start + 9);
    return close < 0 ? undefined : { start, end: close + 3 };
  }
  if (xml.startsWith("<!--", start)) {
    const close = xml.indexOf("-->", start + 4);
    return close < 0 ? undefined : { start, end: close + 3 };
  }
  if (xml.startsWith("<?", start)) {
    const close = xml.indexOf("?>", start + 2);
    return close < 0 ? undefined : { start, end: close + 2 };
  }
  if (xml.startsWith("<!", start)) {
    const close = xml.indexOf(">", start + 2);
    return close < 0 ? undefined : { start, end: close + 1 };
  }

  let quote = "";
  let end = start + 1;
  for (; end < xml.length; end++) {
    const char = xml[end]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ">") {
      break;
    }
  }
  if (end >= xml.length || quote) return;
  const raw = xml.slice(start, end + 1);
  const parsed = raw.match(/^<\s*(\/?)\s*([A-Za-z_][\w:.-]*)/);
  if (!parsed) return { start, end: end + 1 };
  return {
    start,
    end: end + 1,
    name: parsed[2]!.toLowerCase(),
    closing: parsed[1] === "/",
    selfClosing: /\/\s*>$/.test(raw),
  };
}

function rssItemBlocks(xml: string): string[] {
  const stack: string[] = [];
  const blocks: string[] = [];
  let itemStart: number | undefined;
  let rssRootCount = 0;
  let channelCount = 0;
  let rssClosed = false;
  let offset = 0;
  while (offset < xml.length) {
    const token = nextXmlToken(xml, offset);
    if (!token) {
      if (xml.slice(offset).trim()) throw new Error("Global Voices RSS invalid feed");
      break;
    }
    if (stack.length === 0 && xml.slice(offset, token.start).trim()) {
      throw new Error("Global Voices RSS invalid feed");
    }
    if (xml.startsWith("<!", token.start) &&
        !xml.startsWith("<!--", token.start) && !xml.startsWith("<![CDATA[", token.start)) {
      throw new Error("Global Voices RSS unsupported declaration");
    }
    offset = token.end;
    if (!token.name) {
      if (stack.length === 0 && !xml.startsWith("<!--", token.start) && !xml.startsWith("<?", token.start)) {
        throw new Error("Global Voices RSS invalid feed");
      }
      continue;
    }

    const name = token.name;
    if (token.closing) {
      if (stack.at(-1) !== name) throw new Error("Global Voices RSS invalid feed");
      if (name === "rss" && stack.length === 1) rssClosed = true;
      if (name === "item" && itemStart !== undefined && stack.length === 3) {
        if (blocks.length < MAX_ITEMS) blocks.push(xml.slice(itemStart, token.end));
        itemStart = undefined;
      }
      stack.pop();
      continue;
    }

    if (stack.length === 0) {
      if (name !== "rss" || rssRootCount !== 0 || rssClosed) throw new Error("Global Voices RSS invalid feed");
      rssRootCount++;
    }
    if (name === "channel" && stack.length === 1 && stack[0] === "rss") {
      channelCount++;
      if (channelCount > 1) throw new Error("Global Voices RSS invalid feed");
    }
    if (name === "item" && stack.length === 2 && stack[0] === "rss" && stack[1] === "channel") {
      itemStart = token.start;
    }
    if (!token.selfClosing) stack.push(name);
    else if (name === "rss" || (name === "channel" && stack.length === 1)) {
      throw new Error("Global Voices RSS invalid feed");
    }
  }
  if (rssRootCount !== 1 || channelCount !== 1 || !rssClosed || stack.length !== 0 || itemStart !== undefined) {
    throw new Error("Global Voices RSS invalid feed");
  }
  return blocks;
}

function directChildValues(block: string, wantedTag: string): string[] {
  const stack: { name: string; valueStart: number }[] = [];
  const values: string[] = [];
  let offset = 0;
  while (offset < block.length) {
    const token = nextXmlToken(block, offset);
    if (!token) throw new Error("Global Voices RSS invalid item");
    offset = token.end;
    if (!token.name) continue;
    if (token.closing) {
      const open = stack.pop();
      if (!open || open.name !== token.name) throw new Error("Global Voices RSS invalid item");
      if (open.name === wantedTag && stack.length === 1 && stack[0]?.name === "item") {
        const raw = block.slice(open.valueStart, token.start).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");
        // cleanField removes bare URLs. Preserve only the link field as a URL.
        const clean = wantedTag === "link" ? decodeTextEntities(raw).trim() : cleanField(raw);
        if (clean) values.push(clean);
      }
      continue;
    }
    if (token.name === wantedTag && stack.length === 1 && stack[0]?.name === "item" && !token.selfClosing) {
      stack.push({ name: token.name, valueStart: token.end });
    } else if (!token.selfClosing) {
      stack.push({ name: token.name, valueStart: token.end });
    }
  }
  if (stack.length !== 0) throw new Error("Global Voices RSS invalid item");
  return values;
}

function parseGlobalVoicesXml(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const block of rssItemBlocks(xml)) {
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
