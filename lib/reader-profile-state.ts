import { customTopicText, isCustomTopic, isValidTopicId, mapTopicsForUser } from "@/lib/topics";
import type { TopicId } from "@/lib/types";

// Matches what the send cron can generate from. It also accepts older custom
// ids saved before custom text was lowercased ("custom:Islam and Quran"),
// which isValidTopicId rejects but the generator still uses as-is.
function isUsableTopic(topic: unknown): topic is TopicId {
  return typeof topic === "string" &&
    (isValidTopicId(topic) || (isCustomTopic(topic) && customTopicText(topic).length > 0));
}

export function hasUsableReaderProfile(profile: {
  first_name?: string | null;
  topics?: unknown;
  birthday?: string | null;
}): boolean {
  if (!profile.first_name?.trim() || !Array.isArray(profile.topics)) return false;
  return mapTopicsForUser(profile.topics.filter(isUsableTopic), profile.birthday ?? undefined).length > 0;
}
