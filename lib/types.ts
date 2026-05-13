export type ThemeId =
  | "soft"
  | "linen"
  | "ink"
  | "cottage"
  | "arcade"
  | "marina"
  | "midnight"
  | "forest"
  | "mono"
  | "sunset";

export type TopicId =
  | "healthcare-recruiting"
  | "sales-persuasion"
  | "founder-operator"
  | "marketing-growth"
  | "ai-for-work"
  | "solo-side-income"
  | "personal-finance"
  | "real-estate"
  | "macro-markets"
  | "longevity-wellness"
  | "nutrition-food"
  | "mental-health"
  | "womens-health"
  | "books-worth-your-time"
  | "psychology-behavior"
  | "parenting"
  | "inspiring-people"
  | "movies-tv"
  | "music"
  | "style-fashion"
  | "ai-news"
  | "web3-updates"
  | "fl-gardening"
  | "startups-vc"
  | "faith-meaning";

export type ItemKind =
  | "read"     // article, essay, news
  | "watch"    // video, talk, film
  | "listen"   // podcast, audio
  | "try"      // app, tool, product
  | "post"     // social post (X / Threads / Bluesky / Farcaster)
  | "book"     // book recommendation
  | "event"    // local or online event
  | "note";    // plain editorial note, no primary action

export interface Reference {
  label: string;
  url: string;
  note?: string;
}

export interface DigestItem {
  kind: ItemKind;
  headline: string;
  body: string;
  primaryRef?: Reference;
  supplementaryRefs?: Reference[];
  // Legacy field kept for backward-compat with sample-issue.ts
  source?: string;
  sourceUrl?: string;
}

export interface DigestSection {
  topicId: TopicId;
  topicLabel: string;
  intro: string;
  items: DigestItem[];
}

export interface Issue {
  id: string;
  volume: number;
  number: number;
  weekOf: string;
  recipientFirstName: string;
  recipientCity: string;
  editorIntro: string;
  sections: DigestSection[];
}

export interface UserProfile {
  firstName: string;
  city: string;
  jobBlurb?: string;
  projectBlurb?: string;
  funBlurb?: string;
  topics: TopicId[];
  theme: ThemeId;
}

export interface Theme {
  id: ThemeId;
  label: string;
  blurb: string;
  fonts: {
    display: string;
    body: string;
    ui: string;
  };
}
