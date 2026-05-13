import type { TopicId } from "@/lib/types";

export interface TopicBlurb {
  topicId: TopicId;
  topicLabel: string;
  weekOf: string;
  intro: string;
  items: BlurbItem[];
}

export type BlurbItemKind =
  | "read" | "watch" | "listen" | "try" | "post" | "book" | "event" | "note";

export interface BlurbRef {
  label: string;
  url: string;
  note?: string;
}

export interface BlurbItem {
  kind: BlurbItemKind;
  headline: string;
  body: string;
  primaryRef?: BlurbRef;
  supplementaryRefs?: BlurbRef[];
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
