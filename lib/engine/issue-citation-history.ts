import type { SupabaseClient } from "@supabase/supabase-js";
import type { TopicId } from "@/lib/types";
import { normalizeUrl } from "./url-guard";

type RpcClient = Pick<SupabaseClient, "rpc">;

export interface IssueCitationHistory {
  state: "disabled" | "available" | "unavailable";
  urlsByTopic: Map<TopicId, Set<string>>;
  unavailableTopicIds: Set<TopicId>;
}

export interface IssueCitationHistoryDependencies {
  enabled?: () => boolean;
  warn?: (message: string) => void;
  timeoutMs?: number;
}

const MAX_TOPICS = 64;
const MAX_URLS_PER_TOPIC = 2_000;
const MAX_URL_LENGTH = 2_048;
const DAY_MS = 86_400_000;
const DEFAULT_TIMEOUT_MS = 3_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTopicId(value: unknown): value is TopicId {
  // Generation includes custom and legacy IDs. Bound those opaque keys without
  // imposing a newer profile-write policy on already saved citation history.
  return typeof value === "string" && value.trim().length > 0 && value === value.trim()
    && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function periodTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value) {
    return timestamp;
  }
}

export function issueCitationHistoryEnabled(): boolean {
  const raw = process.env.ALPHA_ISSUE_CITATION_HISTORY?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// The caller supplies its existing service-role client. This helper never
// loads credentials, reads issue bodies or calls a source/provider. It returns
// raw usable citations, leaving comparison-key normalization to the merger.
export function createIssueCitationHistoryReader(deps: IssueCitationHistoryDependencies = {}) {
  const enabled = deps.enabled ?? issueCitationHistoryEnabled;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const requestedTimeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  return async function readIssueCitationHistory(
    sb: RpcClient,
    topicIds: readonly TopicId[],
    since: string,
    before: string
  ): Promise<IssueCitationHistory> {
    const urlsByTopic = new Map<TopicId, Set<string>>();
    const unavailableTopicIds = new Set<TopicId>();
    const history = (state: IssueCitationHistory["state"]): IssueCitationHistory => ({
      state, urlsByTopic, unavailableTopicIds,
    });
    const unavailable = (): IssueCitationHistory => {
      if (Array.isArray(topicIds)) {
        for (const id of topicIds) {
          if (typeof id === "string") unavailableTopicIds.add(id as TopicId);
        }
      }
      return history("unavailable");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!enabled()) return history("disabled");
      const sinceTimestamp = periodTimestamp(since);
      const beforeTimestamp = periodTimestamp(before);
      if (!Array.isArray(topicIds) || topicIds.length > MAX_TOPICS || !Array.from(topicIds).every(isTopicId)
          || sinceTimestamp === undefined || beforeTimestamp === undefined
          || beforeTimestamp - sinceTimestamp < DAY_MS
          || beforeTimestamp - sinceTimestamp > 14 * DAY_MS) {
        warn("[issue-citation-history] invalid read input");
        return unavailable();
      }
      const requestedTopics = new Set<TopicId>(topicIds);
      if (requestedTopics.size === 0) return history("available");
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Issue citation history deadline")), timeoutMs);
      });
      // The three-second deadline bounds the caller. The supplied client's
      // existing transport timeout bounds an RPC still finishing after it.
      const response: unknown = await Promise.race([
        sb.rpc("get_alpha_issue_citation_history", {
          p_topic_ids: [...requestedTopics], p_since: since, p_before: before,
        }),
        deadline,
      ]);
      if (!isRecord(response) || response.error !== null || !Array.isArray(response.data)) {
        warn("[issue-citation-history] read unavailable");
        return unavailable();
      }
      const seenTopics = new Set<TopicId>();
      let unboundResponse = response.data.length > MAX_TOPICS;
      for (const row of response.data.slice(0, MAX_TOPICS)) {
        if (!isRecord(row) || !isTopicId(row.topic_id) || !requestedTopics.has(row.topic_id)) {
          unboundResponse = true;
          continue;
        }
        const topicId = row.topic_id;
        if (seenTopics.has(topicId)) unboundResponse = true;
        seenTopics.add(topicId);
        let urls = urlsByTopic.get(topicId);
        if (!urls) {
          urls = new Set<string>();
          urlsByTopic.set(topicId, urls);
        }
        if (row.complete !== true) unavailableTopicIds.add(topicId);
        if (!Array.isArray(row.urls)) {
          unavailableTopicIds.add(topicId);
          continue;
        }
        if (row.urls.length > MAX_URLS_PER_TOPIC) unavailableTopicIds.add(topicId);
        for (const rawUrl of row.urls.slice(0, MAX_URLS_PER_TOPIC)) {
          if (typeof rawUrl !== "string" || rawUrl.length > MAX_URL_LENGTH || !normalizeUrl(rawUrl)) {
            unavailableTopicIds.add(topicId);
            continue;
          }
          urls.add(rawUrl);
        }
      }
      if (unboundResponse || seenTopics.size !== requestedTopics.size) {
        warn("[issue-citation-history] response correlation unavailable");
        return unavailable();
      }
      if (unavailableTopicIds.size > 0) {
        warn("[issue-citation-history] incomplete topic history");
      }
      return history("available");
    } catch {
      warn("[issue-citation-history] read failed");
      return unavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

export const readIssueCitationHistory = createIssueCitationHistoryReader();
