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
  | "sunset"
  | "mitch";

// The fixed catalog ids. TopicId additionally allows `custom:<text>` so a
// subscriber can add their own hyper-specific topic ("custom:crypto trends in
// Asia"). Custom ids are NOT keys in TOPIC_BY_ID — always resolve labels via
// the topicLabel()/topicEmoji() helpers in lib/topics, never by indexing.
export type FixedTopicId =
  | "healthcare-recruiting"
  | "sales-persuasion"
  | "founder-operator"
  | "marketing-growth"
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
  | "music-edm"
  | "music-hiphop"
  | "music-indie"
  | "music-country"
  | "style-fashion"
  | "sports-betting"
  | "trading-cards"
  | "ai-news"
  | "web3-updates"
  | "fl-gardening"
  | "gardening-plants"
  | "sustainable-living"
  | "startups-vc"
  | "faith-meaning";

/** A catalog topic, or a user's own free-text topic encoded as `custom:<text>`. */
export type TopicId = FixedTopicId | `custom:${string}`;

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
  // Legacy field kept for backward-compat with older renderer outputs
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
  email?: string;
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
