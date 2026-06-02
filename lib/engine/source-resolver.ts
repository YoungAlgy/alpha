import { braveConfigured, braveSearch, formatAsSignal } from "@/lib/brave";
import { TOPIC_QUERIES } from "./topic-queries";
import { getSignal } from "./mock-signals";
import { extractSignalUrls } from "./url-guard";
import type { TopicId } from "@/lib/types";
import type { TopicSignal } from "./types";

// Resolves a TopicSignal for (topicId, weekOf). Tries Brave Search first
// when configured, falls back to hand-written mock signals otherwise.
// Cache-friendly: in V1 these get persisted to topic_blurbs in Supabase so
// every subscriber to a topic shares the same generation cost.

export async function resolveTopicSignal(
  topicId: TopicId,
  weekOf: string
): Promise<TopicSignal | undefined> {
  if (braveConfigured()) {
    try {
      const live = await fetchLiveSignal(topicId, weekOf);
      if (live) return live;
    } catch (e) {
      console.warn(`[source-resolver] Brave failed for ${topicId}:`, e);
      // fall through to mock
    }
  }
  return getSignal(topicId, weekOf) || getSignal(topicId);
}

async function fetchLiveSignal(
  topicId: TopicId,
  weekOf: string
): Promise<TopicSignal | undefined> {
  const queries = TOPIC_QUERIES[topicId];
  if (!queries || queries.length === 0) return undefined;

  // Run queries in parallel — Brave handles 1 req/sec per key but bursts are fine.
  const blocks = await Promise.all(
    queries.map(async (q) => {
      try {
        const results = await braveSearch(q, { count: 6, freshness: "pw" });
        return `QUERY: ${q}\n${formatAsSignal(q, results)}`;
      } catch (e) {
        return `QUERY: ${q}\n(no results — ${e instanceof Error ? e.message : "error"})`;
      }
    })
  );

  const context = `This week's signal for ${topicId} (week of ${weekOf}), gathered live from Brave Search:\n\n${blocks.join("\n\n———\n\n")}\n\nURLs above are real. You may cite them. Do not invent URLs.`;

  // If the live signal carries NO real URLs (every Brave query came back empty
  // this week), treat it as "no live signal" so the caller falls back to the
  // curated mock — which always has real URLs. Without this, the strict URL
  // guard would drop every link the model cites and ship a link-less section.
  if (extractSignalUrls(context).size === 0) {
    console.warn(`[source-resolver] live signal for ${topicId} had 0 URLs — falling back to mock`);
    return undefined;
  }

  return { topicId, weekOf, context };
}
