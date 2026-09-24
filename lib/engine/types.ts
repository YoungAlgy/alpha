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

export interface SignalSource {
  title: string;
  url: string;
  excerpt: string;
}

export interface TopicSignal {
  topicId: TopicId;
  weekOf: string;
  context: string;
  // Resolver-owned source boundaries for the no-model formatter. Never parse
  // model instructions to obtain a reader's excerpt when these are present.
  // The citable allow-set still applies to every source URL.
  sources?: SignalSource[];
  // The EXACT set of URLs the model may cite (normalized, as built by the
  // url-guard's extractSignalUrls over the curated SOURCE urls only). The live
  // path sets this so the citable allow-set comes from the resolver's chosen
  // sources, NOT from regex-scanning the free-text context — a third party
  // controls source titles/descriptions and could otherwise smuggle a citable
  // URL into the context. When absent (the curated mock path, which has no
  // attacker-controlled text), topic-blurb falls back to scanning the context.
  citableUrls?: Set<string>;
}

export interface GenerationLog {
  step: string;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
}
