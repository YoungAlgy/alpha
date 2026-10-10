// Per-(topic, week_of) cache for shared topic blurbs.
// Generate once per topic per send period, serve to all subscribers to it.
// This is the cost unlock — drops AI usage from O(users × topics × weeks)
// to O(topics × periods) regardless of subscriber count.

import { supabaseServiceClient } from "@/lib/supabase/server";
import { validatedAttributedItem } from "@/lib/source-attribution";
import { normalizeUrl } from "./url-guard";
import { readIssueCitationHistory } from "./issue-citation-history";
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
  if (value.source !== undefined && typeof value.source !== "string") return false;
  if (value.sourceUrl !== undefined && (typeof value.sourceUrl !== "string" || !normalizeUrl(value.sourceUrl))) return false;
  if (value.supplementaryRefs !== undefined && (!Array.isArray(value.supplementaryRefs)
      || !value.supplementaryRefs.every(isReference))) return false;
  return validatedAttributedItem(value);
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
      console.warn("[blurb-cache] batch read failed");
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
  } catch {
    console.warn("[blurb-cache] batch read exception");
    return result;
  }
}

export interface CitationHistory {
  state: "available" | "disabled" | "unavailable";
  urlsByTopic: Map<TopicId, Set<string>>;
  unavailableTopicIds: Set<TopicId>;
}

// A successful empty history is different from an unreadable history. Keep
// known citations from partial rows, but do not reopen fresh sourcing for a
// topic whose saved history could not be checked. Current-period finished
// sections can still be served independently of this prior-period read.
export async function getCitationHistory(
  topicIds: TopicId[],
  sinceIso: string,
  beforePeriodIso: string
): Promise<CitationHistory> {
  const result = new Map<TopicId, Set<string>>();
  const unavailableTopicIds = new Set<TopicId>();
  const history = (state: CitationHistory["state"]): CitationHistory => ({
    state, urlsByTopic: result, unavailableTopicIds,
  });
  const unavailable = (): CitationHistory => {
    topicIds.forEach((id) => unavailableTopicIds.add(id));
    return history("unavailable");
  };
  if (!blurbCacheEnabled()) return history("disabled");
  if (topicIds.length === 0) return history("available");
  if (!isPeriod(sinceIso) || !isPeriod(beforePeriodIso) || sinceIso >= beforePeriodIso) {
    return unavailable();
  }
  try {
    const sb = await supabaseServiceClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("topic_id, week_of, items")
      .gte("week_of", sinceIso)
      .lt("week_of", beforePeriodIso)
      .in("topic_id", topicIds);
    if (error) {
      console.warn("[blurb-cache] cited-urls read failed");
      return unavailable();
    }
    if (!Array.isArray(data)) {
      console.warn("[blurb-cache] cited-urls response malformed");
      return unavailable();
    }
    const requestedTopics = new Set<string>(topicIds);
    let unboundRow = false;
    for (const row of data) {
      if (!isRecord(row) || typeof row.topic_id !== "string") {
        unboundRow = true;
        continue;
      }
      if (!requestedTopics.has(row.topic_id)) continue;
      const topicId = row.topic_id as TopicId;
      if (!isPeriod(row.week_of)) {
        unavailableTopicIds.add(topicId);
        continue;
      }
      if (row.week_of < sinceIso || row.week_of >= beforePeriodIso) continue;
      if (!Array.isArray(row.items)) {
        unavailableTopicIds.add(topicId);
        continue;
      }
      let set = result.get(topicId);
      if (!set) {
        set = new Set<string>();
        result.set(topicId, set);
      }
      const collect = (ref: unknown): void => {
        if (!isRecord(ref) || typeof ref.url !== "string" || !normalizeUrl(ref.url)) {
          unavailableTopicIds.add(topicId);
          return;
        }
        set.add(ref.url);
      };
      for (const item of row.items) {
        if (!isRecord(item)) {
          unavailableTopicIds.add(topicId);
          continue;
        }
        if (!isCachedItem(item)) unavailableTopicIds.add(topicId);
        if (item.primaryRef !== undefined) collect(item.primaryRef);
        if (item.sourceUrl !== undefined) collect({ url: item.sourceUrl });
        if (item.supplementaryRefs !== undefined) {
          if (!Array.isArray(item.supplementaryRefs)) unavailableTopicIds.add(topicId);
          else item.supplementaryRefs.forEach(collect);
        }
      }
    }
    if (unboundRow) {
      console.warn("[blurb-cache] cited-urls response has unbound rows");
      return unavailable();
    }
    // Optional persisted-issue history closes a lost cache-write gap. Saved
    // pending issues count too because provider acceptance can be uncertain.
    // This is off until its service-only aggregate is separately installed.
    // Neither source can erase uncertainty reported by the other source.
    const issueHistory = await readIssueCitationHistory(sb, topicIds, sinceIso, beforePeriodIso);
    for (const [topicId, urls] of issueHistory.urlsByTopic) {
      let set = result.get(topicId);
      if (!set) { set = new Set<string>(); result.set(topicId, set); }
      urls.forEach((url) => set.add(url));
    }
    issueHistory.unavailableTopicIds.forEach((id) => unavailableTopicIds.add(id));
    if (issueHistory.state === "unavailable") return unavailable();
    if (unavailableTopicIds.size > 0) console.warn("[blurb-cache] cited-urls contains incomplete topic history");
    return history("available");
  } catch {
    console.warn("[blurb-cache] cited-urls read exception");
    return unavailable();
  }
}

// Compatibility for optional-cache callers. Production generation uses the
// strict result above so unknown history cannot be treated as an empty set.
export async function getRecentlyCitedUrls(
  topicIds: TopicId[],
  sinceIso: string,
  beforePeriodIso: string
): Promise<Map<TopicId, Set<string>>> {
  return (await getCitationHistory(topicIds, sinceIso, beforePeriodIso)).urlsByTopic;
}

export async function setCachedBlurb(blurb: TopicBlurb): Promise<void> {
  if (!Array.isArray(blurb.items) || !blurb.items.every(isCachedItem)) return;
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
      // Custom topic IDs and database errors can contain reader-supplied text.
      // Keep optional-cache diagnostics fixed and free of request data.
      console.warn("[blurb-cache] write failed");
    }
  } catch {
    console.warn("[blurb-cache] write exception");
  }
}
