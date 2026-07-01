// Per-(topic, week_of) cache for shared topic blurbs.
// Generate once per topic per week, serve to all subscribers to that topic.
// This is the cost unlock — drops AI usage from O(users × topics × weeks)
// to O(topics × weeks) regardless of subscriber count.

import { supabaseServiceClient } from "@/lib/supabase/server";
import type { TopicBlurb } from "./types";
import type { TopicId } from "@/lib/types";

const TABLE = "topic_blurbs";

interface DbBlurb {
  topic_id: TopicId;
  week_of: string;
  intro: string;
  items: TopicBlurb["items"];
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
    for (const row of (data ?? []) as DbBlurb[]) {
      result.set(row.topic_id, {
        topicId: row.topic_id,
        topicLabel: "", // filled by caller from TOPIC_BY_ID
        weekOf: row.week_of,
        intro: row.intro,
        items: row.items,
      });
    }
    return result;
  } catch (e) {
    console.warn(`[blurb-cache] batch read exception:`, e);
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
