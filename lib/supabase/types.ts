// Hand-written types — replace with `supabase gen types typescript` output later.

import type { TopicId, ThemeId, DigestSection } from "@/lib/types";

export interface DbUser {
  id: string;
  email: string;
  first_name: string | null;
  city: string | null;
  job_blurb: string | null;
  project_blurb: string | null;
  fun_blurb: string | null;
  theme: ThemeId | null;
  topics: TopicId[];
  stripe_customer_id: string | null;
  subscribed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbTopicBlurb {
  id: number;
  topic_id: TopicId;
  week_of: string;
  intro: string;
  items: Array<{
    kind: string;
    headline: string;
    body: string;
    primaryRef?: { label: string; url: string };
    supplementaryRefs?: { label: string; url: string; note?: string }[];
  }>;
  generated_at: string;
}

export interface DbIssue {
  id: string;
  user_id: string;
  week_of: string;
  volume: number;
  number: number;
  editor_intro: string;
  sections: DigestSection[];
  delivered_at: string | null;
  opened_at: string | null;
  created_at: string;
}
