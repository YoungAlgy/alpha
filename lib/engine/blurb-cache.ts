// Per-(topic, week_of) cache for shared topic blurbs.
// Generate once per topic per send period, serve to all subscribers to it.
// This is the cost unlock — drops AI usage from O(users × topics × weeks)
// to O(topics × periods) regardless of subscriber count.

import { supabaseServiceClient } from "@/lib/supabase/server";
import { validatedSourceAttribution } from "@/lib/source-attribution";
import { normalizeUrl } from "./url-guard";
import type { TopicBlurb } from "./types";
import type { TopicId } from "@/lib/types";

const TABLE = "topic_blurbs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPeriod(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value;
}

const ITEM_KINDS = new Set(["read", "watch", "listen", "try", "post", "book", "event", "note"]);

function isReference(value: unknown): boolean {
  return isRecord(value) && typeof value.label === "string" && value.label.trim().length > 0
    && typeof value.url === "string" && !!normalizeUrl(value.url)
    && (value.note === undefined || value.note === null || typeof value.note === "string");
}

function isCachedItem(value: unknown): value is TopicBlurb["items"][number] {
  if (!isRecord(value) || typeof value.kind !== "string" || !ITEM_KINDS.has(value.kind)
      || typeof value.headline !== "string" || !value.headline.trim()
      || typeof value.body !== "string" || !value.body.trim()) return false;
  if (value.primaryRef !== undefined && !isReference(value.primaryRef)) return false;
  if (value.supplementaryRefs !== undefined && (!Array.isArray(value.supplementaryRefs)
      || !value.supplementaryRefs.every(isReference))) return false;
  return value.attribution === undefined || !!validatedSourceAttribution(
    isRecord(value.primaryRef) ? value.primaryRef.url : undefined,
    value.attribution
  );
}

export function blurbCacheEnabled(): boolean {
  return (
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    (!!process.env.SUPABASE_SECRET_KEY || !!process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

// Batched read for a reader's whole ranked pool (up to 25 topics) in ONE round
// trip instead of one per topic. generateIssue calls this once up front, then
// each per-topic genLive() reads its result from the returned map. Was a
// per-topic getCachedBlurb() query inside the pool's parallel waves -- fine at
// today's ~4 subscribers, but scales as O(subscribers x topics) instead of
// O(subscribers) round trips.
export async function getCachedBlurbs(
  topicIds: TopicId[],
  weekOf: string
): Promise<Map<TopicId, TopicBlurb>> {
  const result = new Map<TopicId, TopicBlurb>();
  if (!blurbCacheEnabled() || topicIds.length === 0) return result;
  try {
    const sb = await supabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("topic_id, week_of, intro, items")
      .eq("week_of", weekOf)
      .in("topic_id", topicIds);
    if (error) {
      console.warn(`[blurb-cache] batch read failed for ${weekOf}:`, error.message);
      return result;
    }
    const requestedTopics = new Set<string>(topicIds);
    for (const row of Array.isArray(data) ? data : []) {
      // Saved JSONB is an input boundary. Skip bad rows/items locally so a
      // malformed cache entry cannot discard another topic's finished work.
      if (!isRecord(row) || typeof row.topic_id !== "string" || !requestedTopics.has(row.topic_id)
          || !isPeriod(row.week_of) || row.week_of !== weekOf
          || typeof row.intro !== "string" || !Array.isArray(row.items)) continue;
      const items = row.items.filter(isCachedItem);
      if (items.length === 0) continue;
      const topicId = row.topic_id as TopicId;
      result.set(topicId, {
        topicId,
        topicLabel: "", // filled by caller from TOPIC_BY_ID
        weekOf: row.week_of,
        intro: row.intro,
        items,
      });
    }
    return result;
  } catch (e) {
    console.warn(`[blurb-cache] batch read exception:`, e);
    return result;
  }
}

// URLs cited in each topic's recent blurbs, ONE batched query for a whole
// pool. Feeds the resolver's exclusion set so the same article is never
// covered twice within the lookback window — the cross-send repeat guard
// (a subscriber was seeing the same articles in back-to-back letters; at
// daily cadence the Brave freshness window alone is too leaky to rely on).
export async function getRecentlyCitedUrls(
  topicIds: TopicId[],
  sinceIso: string,
  beforePeriodIso: string
): Promise<Map<TopicId, Set<string>>> {
  const result = new Map<TopicId, Set<string>>();
  if (!blurbCacheEnabled() || topicIds.length === 0) return result;
  try {
    const sb = await supabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("topic_id, week_of, items")
      .gte("week_of", sinceIso)
      .lt("week_of", beforePeriodIso)
      .in("topic_id", topicIds);
    if (error) {
      console.warn(`[blurb-cache] cited-urls read failed:`, error.message);
      return result;
    }
    const requestedTopics = new Set<string>(topicIds);
    for (const row of Array.isArray(data) ? data : []) {
      if (!isRecord(row) || typeof row.topic_id !== "string" || !requestedTopics.has(row.topic_id)
          || !isPeriod(row.week_of) || row.week_of < sinceIso || row.week_of >= beforePeriodIso
          || !Array.isArray(row.items)) continue;
      const topicId = row.topic_id as TopicId;
      let set = result.get(topicId);
      if (!set) {
        set = new Set<string>();
        result.set(topicId, set);
      }
      for (const item of row.items) {
        if (!isRecord(item)) continue;
        if (isRecord(item.primaryRef) && typeof item.primaryRef.url === "string" && item.primaryRef.url) {
          set.add(item.primaryRef.url);
        }
        for (const ref of Array.isArray(item.supplementaryRefs) ? item.supplementaryRefs : []) {
          if (isRecord(ref) && typeof ref.url === "string" && ref.url) set.add(ref.url);
        }
      }
    }
    return result;
  } catch (e) {
    console.warn(`[blurb-cache] cited-urls read exception:`, e);
    return result;
  }
}

export async function setCachedBlurb(blurb: TopicBlurb): Promise<void> {
  if (!blurbCacheEnabled()) return;
  try {
    const sb = await supabaseServiceClient();
    const { error } = await sb.from(TABLE).upsert(
      {
        topic_id: blurb.topicId,
        week_of: blurb.weekOf,
        intro: blurb.intro,
        items: blurb.items,
      },
      { onConflict: "topic_id,week_of" }
    );
    if (error) {
      console.warn(`[blurb-cache] write failed for ${blurb.topicId} ${blurb.weekOf}:`, error.message);
    }
  } catch (e) {
    console.warn(`[blurb-cache] write exception:`, e);
  }
}
