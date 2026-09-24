import { hasReaderAccess } from "@/lib/access";
import { isProfileComplete, type CheckoutProfileInput } from "@/lib/checkout-guards";
import { isValidTopicId } from "@/lib/topics";
import { MIN_TOPIC_QUOTA, type TopicId } from "@/lib/types";

export type SignupAccountState = "reader" | "pending" | "ended" | "incomplete";

export interface SignupAccountRow {
  subscribed_at?: string | null;
  cancelled_at?: string | null;
  access_requested_at?: string | null;
  access_granted_at?: string | null;
}

// Presentation only. Database policies and server routes still enforce access.
export function getSignupAccountState(row: SignupAccountRow | null): SignupAccountState {
  if (!row) return "incomplete";
  if (hasReaderAccess(row.subscribed_at, row.cancelled_at, row.access_granted_at)) return "reader";
  if (row.access_requested_at && !row.access_granted_at) return "pending";
  if (row.subscribed_at || row.cancelled_at || row.access_granted_at) return "ended";
  return "incomplete";
}

// Repair only the missing required step. The draft's other answers stay intact.
export function incompleteSignupPath(profile: CheckoutProfileInput): "/name" | "/topics" | "/email" | null {
  if (!profile.firstName?.trim()) return "/name";
  const topics = profile.topics;
  if (!Array.isArray(topics) || topics.length !== MIN_TOPIC_QUOTA ||
      new Set(topics).size !== topics.length ||
      !topics.every((topic) => typeof topic === "string" && isValidTopicId(topic as TopicId))) return "/topics";
  return isProfileComplete(profile) ? null : "/email";
}
