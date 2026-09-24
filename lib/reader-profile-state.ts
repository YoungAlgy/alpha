import { isValidTopicId, mapTopicsForUser } from "@/lib/topics";
import type { TopicId } from "@/lib/types";

export function hasUsableReaderProfile(profile: {
  first_name?: string | null;
  topics?: unknown;
  birthday?: string | null;
}): boolean {
  if (!profile.first_name?.trim() || !Array.isArray(profile.topics)) return false;
  const validTopics = profile.topics.filter(
    (topic: unknown): topic is TopicId => typeof topic === "string" && isValidTopicId(topic)
  );
  return mapTopicsForUser(validTopics, profile.birthday ?? undefined).length > 0;
}
