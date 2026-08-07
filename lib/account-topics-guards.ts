import { isValidTopicId } from "@/lib/topics";

// Pulled out of app/api/account/topics/route.ts as pure functions so a
// deterministic verify script (scripts/verify-account-topics-guards.mts) can
// exercise the whole validation chain with stubbed inputs -- this is the
// only write path into public.users.topics that enforces the empty-pool
// floor (the DB's own CHECK constraint doesn't catch it: array_length of an
// empty array is NULL, which satisfies `topics is null or array_length(...)
// <= 25`), and a broken cap/dup/isValidTopicId check here would either
// silently drop a subscriber from every send (empty pool reaches the DB) or
// let a crafted request smuggle an unrecognized value into the generation
// prompt.
//
// Split into two phases (alpha-drift-r14-02, found in review 2026-08-06):
// the route needs a DB read to compute the caller's actual per-user `cap`
// before the cap/dup/id checks can run, but a malformed body (non-array,
// oversized, non-string entries) should still be rejected in O(1) WITHOUT
// ever reaching the DB -- both for cost (skip the query on garbage input)
// and correctness (a malformed request during a transient DB read failure
// must still 400, not 500). An earlier single-function version of this file
// accidentally combined both phases and reordered the route to always read
// the DB first, silently turning that 400 into a 500 on this one narrow
// path -- restored here as two composable phases.

export interface TopicsShapeOk {
  ok: true;
  topics: string[];
}
export interface TopicsShapeErr {
  ok: false;
  error: string;
}
export type TopicsShapeResult = TopicsShapeOk | TopicsShapeErr;

/** Cheap, DB-free shape validation: array, length ceiling, empty floor,
 *  string-type scan. Safe to run before any DB call. */
export function validateTopicsShape(rawTopics: unknown): TopicsShapeResult {
  // Generous absolute bound (100) rejects a garbage oversized array in O(1)
  // before the real per-user cap (which needs a DB read to compute) is even
  // considered -- see the route's own comment for why 100.
  if (!Array.isArray(rawTopics) || rawTopics.length > 100) {
    return { ok: false, error: "Topics must be a list." };
  }
  if (rawTopics.length === 0) {
    return { ok: false, error: "Pick at least one topic." };
  }
  if (rawTopics.some((t) => typeof t !== "string")) {
    return { ok: false, error: "Topics must be a list." };
  }
  return { ok: true, topics: rawTopics as string[] };
}

export interface TopicsValidationOk {
  ok: true;
  topics: string[];
}
export interface TopicsValidationErr {
  ok: false;
  error: string;
}
export type TopicsValidationResult = TopicsValidationOk | TopicsValidationErr;

/** Cap/dup/catalog checks against an already shape-validated list. Needs the
 *  caller's real per-user cap (poolCap(topic_quota)), which requires a DB
 *  read the route does between the two phases. */
export function validateTopicsAgainstCap(topics: string[], cap: number): TopicsValidationResult {
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

/** Full chain in one call (shape then cap), for callers that already have
 *  the cap up front and don't need the two phases split around a DB read. */
export function validateTopicsSubmission(rawTopics: unknown, cap: number): TopicsValidationResult {
  const shape = validateTopicsShape(rawTopics);
  if (!shape.ok) return shape;
  return validateTopicsAgainstCap(shape.topics, cap);
}
