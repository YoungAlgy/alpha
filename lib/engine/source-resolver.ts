import { braveConfigured, braveSearch, type BraveSearchOptions } from "@/lib/brave";
import { rankAndDedup } from "./source-rank";
import { fetchArticleText, deepReadEnabled } from "./fetch-content";
import { TOPIC_QUERIES } from "./topic-queries";
import { getSignal } from "./mock-signals";
import { extractSignalUrls } from "./url-guard";
import { isCustomTopic, customTopicText } from "@/lib/topics";
import type { TopicId, FixedTopicId } from "@/lib/types";
import type { TopicSignal } from "./types";

// How many top sources we fetch in FULL per topic (the deep read), how many
// more we include as headline+link breadth, and how many raw candidates we pull
// per query before ranking down. Deep reads run in parallel and are best-effort.
const DEEP_READ_N = 5;
const MORE_HEADLINES_N = 6;
const PER_QUERY_COUNT = 10;

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

// Resolves a TopicSignal for (topicId, weekOf). Tries Brave Search first
// when configured, falls back to hand-written mock signals otherwise.
// Cache-friendly: blurbs persist to topic_blurbs so every subscriber to a
// topic (including identical custom text) shares the generation cost.

// A custom ("your own thing") topic has no catalog query set — derive a few
// from the user's free text. freshness:"pw" at the call site handles recency.
function customQueries(topicId: string): string[] {
  const t = customTopicText(topicId);
  if (!t) return [];
  return [t, `${t} news`, `${t} latest`];
}

export async function resolveTopicSignal(
  topicId: TopicId,
  weekOf: string,
  opts?: { liveOnly?: boolean; freshness?: BraveSearchOptions["freshness"] }
): Promise<TopicSignal | undefined> {
  const custom = isCustomTopic(topicId);
  const queries = custom ? customQueries(topicId) : TOPIC_QUERIES[topicId as FixedTopicId];

  if (braveConfigured() && queries && queries.length > 0) {
    try {
      const live = await fetchLiveSignal(topicId, queries, weekOf, opts?.freshness);
      if (live) return live;
    } catch (e) {
      console.warn(`[source-resolver] Brave failed for ${topicId}:`, e);
      // fall through to mock (fixed topics only)
    }
  }
  // liveOnly: caller wants to know if this topic has FRESH signal this period
  // (the ranked-pool selector skips topics with nothing new and backfills from
  // a backup that does). Return undefined when there's no live signal.
  if (opts?.liveOnly) return undefined;
  // Custom topics have no curated mock — if Brave gave nothing, return
  // undefined so assemble drops just this section (the letter still ships).
  if (custom) return undefined;
  return getSignal(topicId, weekOf) || getSignal(topicId);
}

// Last-resort filler for a topic with no fresh live signal (catalog topics
// only — customs have no mock). Used to keep a letter full when the whole
// ranked pool was quiet that period.
export function resolveMockSignal(topicId: TopicId, weekOf: string): TopicSignal | undefined {
  if (isCustomTopic(topicId)) return undefined;
  return getSignal(topicId, weekOf) || getSignal(topicId);
}

async function fetchLiveSignal(
  topicId: string,
  queries: string[],
  weekOf: string,
  // Recency window. Defaults to past-week (the single weekly letter). The
  // multi-send cadence passes a "since the last letter" date range so a topic
  // with nothing NEW in the last few days comes back empty and the ranked-pool
  // selector backfills it from a fresher topic instead of repeating stale news.
  freshness: BraveSearchOptions["freshness"] = "pw"
): Promise<TopicSignal | undefined> {
  if (!queries || queries.length === 0) return undefined;

  // 1. Cast a wide net — every query in parallel, more candidates than we'll
  //    use, so the ranker has something to choose from. Brave allows bursts.
  const perQuery = await Promise.all(
    queries.map(async (q) => {
      try {
        return await braveSearch(q, { count: PER_QUERY_COUNT, freshness });
      } catch (e) {
        console.warn(
          `[source-resolver] brave query failed (${topicId}): "${q}": ${e instanceof Error ? e.message : e}`
        );
        return [];
      }
    })
  );

  // 2. Dedup + diversity-rank into a shortlist (freshest first, capped per host
  //    so we don't deep-read five near-duplicates from one aggregator).
  const ranked = rankAndDedup(perQuery.flat());
  if (ranked.length === 0) {
    console.warn(`[source-resolver] live signal for ${topicId} had 0 results — falling back to mock`);
    return undefined;
  }
  // Deep-read TRUSTED sources only — reading an unknown/neutral domain risks
  // amplifying junk (a confident write-up of an unreliable page is the worst
  // failure mode for a "get ahead of the curve" letter). Neutral sources still
  // appear as citable headlines below and the model writes about them from
  // snippets, which is safe. If no trusted source is fresh this period, the
  // section degrades to snippet-only — the old, safe behavior.
  const deep = ranked.filter((s) => s.tier === "trusted").slice(0, DEEP_READ_N);
  const deepUrls = new Set(deep.map((s) => s.url));
  const more = ranked.filter((s) => !deepUrls.has(s.url)).slice(0, MORE_HEADLINES_N);

  // 3. Read the top trusted sources IN FULL (parallel, best-effort). A failed /
  //    timed-out / non-article fetch falls back to that source's snippet, so the
  //    letter is written from real article text where possible and never blocks.
  const contents = deepReadEnabled()
    ? await Promise.all(deep.map((s) => fetchArticleText(s.url).catch(() => null)))
    : deep.map(() => null);
  const readCount = contents.filter(Boolean).length;

  // 4. Build the signal: full-text trusted sources + a breadth list of headlines.
  //    The url-guard scans this whole string for citable URLs, so only the
  //    explicit SOURCE / headline links (all real) are citable — fetched bodies
  //    have every URL stripped (see fetch-content).
  const deepBlocks = deep.map((s, i) => {
    const host = s.host || s.meta_url?.hostname || "";
    const age = s.age ? ` · ${s.age}` : "";
    const body = contents[i] || `(full text unavailable — snippet: ${stripTags(s.description)})`;
    return `[${i + 1}] ${s.title}\n    ${host}${age}\n    SOURCE: ${s.url}\n\n${body}`;
  });
  const moreBlocks = more.map((s) => {
    const host = s.host || s.meta_url?.hostname || "";
    const age = s.age ? `, ${s.age}` : "";
    return `- ${s.title} (${host}${age}) — ${s.url}\n  ${stripTags(s.description)}`;
  });

  const subject = isCustomTopic(topicId) ? customTopicText(topicId) : topicId;
  const parts: string[] = [];
  if (deepBlocks.length > 0) {
    parts.push(
      `=== TOP SOURCES (full text — read these and surface the real insight) ===\n\n${deepBlocks.join("\n\n----------\n\n")}`
    );
  }
  parts.push(
    `=== ${deepBlocks.length > 0 ? "MORE THIS WEEK" : "THIS WEEK"} (headlines + links) ===\n\n${moreBlocks.join("\n\n") || "(none)"}`
  );
  const header =
    deep.length > 0
      ? `Recent signal for ${subject} (as of ${weekOf}), gathered live and READ IN FULL where possible (${readCount}/${deep.length} trusted sources fetched). You have the ACTUAL article text for the top sources below — read it and surface the real insight, do not just paraphrase a headline.`
      : `Recent signal for ${subject} (as of ${weekOf}), gathered live from Brave Search. Headlines and snippets only this period.`;
  const context = `${header}\n\n${parts.join("\n\n")}\n\nAll URLs labeled SOURCE or listed above are real and citable. Do NOT invent URLs.`;

  // If the live signal carries NO real URLs, treat it as "no live signal" so
  // the caller falls back to the curated mock (which always has real URLs).
  // Without this the strict URL guard would drop every link and ship a
  // link-less section.
  if (extractSignalUrls(context).size === 0) {
    console.warn(`[source-resolver] live signal for ${topicId} had 0 URLs — falling back to mock`);
    return undefined;
  }

  return { topicId: topicId as TopicId, weekOf, context };
}
