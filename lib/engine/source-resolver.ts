import { braveConfigured, braveSearch, formatAsSignal } from "@/lib/brave";
import { TOPIC_QUERIES } from "./topic-queries";
import { getSignal } from "./mock-signals";
import { extractSignalUrls } from "./url-guard";
import { isCustomTopic, customTopicText } from "@/lib/topics";
import type { TopicId, FixedTopicId } from "@/lib/types";
import type { TopicSignal } from "./types";

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
  opts?: { liveOnly?: boolean }
): Promise<TopicSignal | undefined> {
  const custom = isCustomTopic(topicId);
  const queries = custom ? customQueries(topicId) : TOPIC_QUERIES[topicId as FixedTopicId];

  if (braveConfigured() && queries && queries.length > 0) {
    try {
      const live = await fetchLiveSignal(topicId, queries, weekOf);
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
  weekOf: string
): Promise<TopicSignal | undefined> {
  if (!queries || queries.length === 0) return undefined;

  // Run queries in parallel — Brave handles 1 req/sec per key but bursts are fine.
  const blocks = await Promise.all(
    queries.map(async (q) => {
      try {
        const results = await braveSearch(q, { count: 6, freshness: "pw" });
        return `QUERY: ${q}\n${formatAsSignal(q, results)}`;
      } catch (e) {
        return `QUERY: ${q}\n(no results: ${e instanceof Error ? e.message : "error"})`;
      }
    })
  );

  const subject = isCustomTopic(topicId) ? customTopicText(topicId) : topicId;
  const context = `This week's signal for ${subject} (week of ${weekOf}), gathered live from Brave Search:\n\n${blocks.join("\n\n---\n\n")}\n\nURLs above are real. You may cite them. Do not invent URLs.`;

  // If the live signal carries NO real URLs (every Brave query came back empty
  // this week), treat it as "no live signal" so the caller falls back to the
  // curated mock — which always has real URLs. Without this, the strict URL
  // guard would drop every link the model cites and ship a link-less section.
  if (extractSignalUrls(context).size === 0) {
    console.warn(`[source-resolver] live signal for ${topicId} had 0 URLs — falling back to mock`);
    return undefined;
  }

  return { topicId: topicId as TopicId, weekOf, context };
}
