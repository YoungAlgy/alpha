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
  | "mitch"
  | "beacon"
  | "grown-nearby"
  | "freejob"
  | "freeresume"
  | "job-terminal"
  | "trading-terminal"
  | "downs"
  | "fishing"
  | "mitchmark"
  | "studio"
  | "pirate"
  | "miami"
  | "toggletown"
  | "casino";

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
  | "zodiac"
  | "fl-gardening"
  | "gardening-plants"
  | "sustainable-living"
  | "startups-vc"
  | "faith-meaning"
  | "faith-christianity"
  | "faith-islam"
  | "faith-judaism"
  | "faith-hinduism"
  | "faith-buddhism"
  | "faith-spiritual";

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

// Stored gender values. Absent/undefined = unspecified ("prefer not to say").
// We only ever tone the letter for these two; everyone else gets the neutral
// default voice. See lib/demographics.ts toneGuidance.
export type Gender = "male" | "female";

export interface UserProfile {
  firstName: string;
  city: string;
  jobBlurb?: string;
  projectBlurb?: string;
  funBlurb?: string;
  // Full birthday as an ISO date "YYYY-MM-DD". Optional. Unlocks the zodiac
  // sign + the reader's generation (for tone). See lib/demographics.ts.
  birthday?: string;
  gender?: Gender;
  topics: TopicId[];
  theme: ThemeId;
  email?: string;
}

// Max length of each free-text profile blurb, single-sourced so the input
// validators (the generate Zod schema, the settings profile route) and the
// prompt-assembly clamp (editor note) can't drift apart. They drifted once
// already (280/600/280 vs 400/600/400 vs 500/600/500) before being aligned.
export const BLURB_CAPS = { jobBlurb: 500, projectBlurb: 600, funBlurb: 500 } as const;

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
