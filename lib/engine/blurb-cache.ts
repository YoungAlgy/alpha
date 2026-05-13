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

export async function getCachedBlurb(
  topicId: TopicId,
  weekOf: string
): Promise<TopicBlurb | null> {
  if (!blurbCacheEnabled()) return null;
  try {
    const sb = await supabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("topic_id, week_of, intro, items")
      .eq("topic_id", topicId)
      .eq("week_of", weekOf)
      .maybeSingle();
    if (error) {
      console.warn(`[blurb-cache] read failed for ${topicId} ${weekOf}:`, error.message);
      return null;
    }
    if (!data) return null;
    const row = data as DbBlurb;
    return {
      topicId: row.topic_id,
      topicLabel: "", // filled by caller from TOPIC_BY_ID
      weekOf: row.week_of,
      intro: row.intro,
      items: row.items,
    };
  } catch (e) {
    console.warn(`[blurb-cache] read exception:`, e);
    return null;
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
