import type { TopicId } from "@/lib/types";

export interface TopicBlurb {
  topicId: TopicId;
  topicLabel: string;
  weekOf: string;
  intro: string;
  items: {
    headline: string;
    body: string;
    source?: string;
    sourceUrl?: string;
  }[];
}

export interface TopicSignal {
  topicId: TopicId;
  weekOf: string;
  context: string;
}

export interface GenerationLog {
  step: string;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
}
