import { isValidTopicId } from "@/lib/topics";

// Pulled out of app/api/account/topics/route.ts as a pure function so a
// deterministic verify script (scripts/verify-account-topics-guards.mts) can
// exercise the whole validation chain with stubbed inputs -- this is the
// only write path into public.users.topics that enforces the empty-pool
// floor (the DB's own CHECK constraint doesn't catch it: array_length of an
// empty array is NULL, which satisfies `topics is null or array_length(...)
// <= 25`), and a broken cap/dup/isValidTopicId check here would either
// silently drop a subscriber from every send (empty pool reaches the DB) or
// let a crafted request smuggle an unrecognized value into the generation
// prompt. Order matters and mirrors the route exactly: cheap shape checks
// first (array, length ceiling, empty floor, string-type scan), then the
// checks that need the caller's actual per-user cap.

export interface TopicsValidationOk {
  ok: true;
  topics: string[];
}
export interface TopicsValidationErr {
  ok: false;
  error: string;
}
export type TopicsValidationResult = TopicsValidationOk | TopicsValidationErr;

export function validateTopicsSubmission(rawTopics: unknown, cap: number): TopicsValidationResult {
  // Generous absolute bound (100) rejects a garbage oversized array in O(1)
  // before the real per-user cap (which needs topics.length > cap below) is
  // even considered -- see the route's own comment for why 100.
  if (!Array.isArray(rawTopics) || rawTopics.length > 100) {
    return { ok: false, error: "Topics must be a list." };
  }
  if (rawTopics.length === 0) {
    return { ok: false, error: "Pick at least one topic." };
  }
  if (rawTopics.some((t) => typeof t !== "string")) {
    return { ok: false, error: "Topics must be a list." };
  }
  const topics = rawTopics as string[];

  if (topics.length > cap) {
    return { ok: false, error: `You can pick up to ${cap} topics on your plan.` };
  }
  if (new Set(topics).size !== topics.length) {
    return { ok: false, error: "That list has a duplicate topic in it." };
  }
  if (topics.some((t) => !isValidTopicId(t))) {
    return { ok: false, error: "One of those topics isn't recognized." };
  }

  return { ok: true, topics };
}
