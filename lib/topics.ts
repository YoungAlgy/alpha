import type { TopicId, FixedTopicId } from "./types";

export interface TopicMeta {
  id: FixedTopicId;
  label: string;
  bucket: TopicBucket;
  tier: "A" | "B";
  blurb: string;
  emoji: string;
}

export type TopicBucket =
  | "Work"
  | "Money"
  | "Body"
  | "Mind"
  | "Culture"
  | "Tech"
  | "Home";

export const TOPICS: TopicMeta[] = [
  // Work
  { id: "healthcare-recruiting", label: "Healthcare recruiting", bucket: "Work", tier: "A", blurb: "US healthcare hiring market, recruiter tools, scope-of-practice shifts.", emoji: "🩺" },
  { id: "sales-persuasion", label: "Sales & persuasion", bucket: "Work", tier: "A", blurb: "Cold calls, closing, objection handling, behavioral econ for sellers.", emoji: "🗣️" },
  { id: "founder-operator", label: "Founder & operator wisdom", bucket: "Work", tier: "A", blurb: "Hormozi-tier playbooks, operator stories, scaling tactics.", emoji: "🛠️" },
  { id: "marketing-growth", label: "Marketing & growth", bucket: "Work", tier: "A", blurb: "Channels, positioning, growth loops, what's actually working.", emoji: "📈" },
  // Money
  { id: "personal-finance", label: "Personal finance, investing & side income", bucket: "Money", tier: "A", blurb: "Index funds, tax moves, balance-sheet wisdom, plus one-person businesses and side-income plays.", emoji: "💰" },
  { id: "real-estate", label: "Real estate", bucket: "Money", tier: "A", blurb: "Markets, mortgages, investing, the housing cycle.", emoji: "🏠" },
  { id: "macro-markets", label: "Macro & markets", bucket: "Money", tier: "A", blurb: "Fed, rates, recession indicators, what the smart money sees.", emoji: "📊" },
  // Body
  { id: "longevity-wellness", label: "Longevity & wellness", bucket: "Body", tier: "A", blurb: "Sleep, hydration, supplements, Attia/Huberman-tier protocols.", emoji: "🧬" },
  { id: "nutrition-food", label: "Nutrition & food", bucket: "Body", tier: "A", blurb: "Diet research, what to eat, what to skip, real evidence.", emoji: "🥗" },
  { id: "mental-health", label: "Mental health", bucket: "Body", tier: "A", blurb: "Therapy modalities, anxiety, depression, what's working.", emoji: "🧠" },
  { id: "womens-health", label: "Women's health", bucket: "Body", tier: "A", blurb: "Hormones, cycle, fertility, perimenopause, the under-studied stuff.", emoji: "🌸" },
  // Mind
  { id: "books-worth-your-time", label: "Books worth your time", bucket: "Mind", tier: "A", blurb: "What's actually worth reading this month, with reasoning.", emoji: "📚" },
  { id: "psychology-behavior", label: "Psychology & behavior", bucket: "Mind", tier: "A", blurb: "Why people do what they do. The research that travels.", emoji: "🔍" },
  { id: "parenting", label: "Parenting", bucket: "Mind", tier: "A", blurb: "Gentle, science-backed, age-appropriate. No fearmongering.", emoji: "👶" },
  // Culture
  { id: "inspiring-people", label: "Inspiring people", bucket: "Culture", tier: "A", blurb: "Profiles of operators, artists, founders doing the work.", emoji: "✨" },
  { id: "movies-tv", label: "Movies & TV", bucket: "Culture", tier: "A", blurb: "What's worth watching, who's making it, where it's going.", emoji: "🎬" },
  { id: "music", label: "Music", bucket: "Culture", tier: "A", blurb: "Releases that matter, industry shifts, who to know.", emoji: "🎵" },
  { id: "style-fashion", label: "Style & fashion", bucket: "Culture", tier: "A", blurb: "What's good, what's coming, what the cool kids actually wear.", emoji: "👔" },
  { id: "sports-betting", label: "Sports & betting markets", bucket: "Culture", tier: "A", blurb: "Edges, line movement, model-vs-market gaps, plus the games and stories shaping the week.", emoji: "🏈" },
  { id: "trading-cards", label: "Trading cards", bucket: "Culture", tier: "A", blurb: "Sports cards and TCGs: market moves, grading, releases, what collectors are chasing.", emoji: "🃏" },
  // Tech
  { id: "ai-news", label: "AI: news, releases & tools for work", bucket: "Tech", tier: "A", blurb: "Model releases, frontier moves, plus the tools and workflows actually shipping productivity wins.", emoji: "🤖" },
  { id: "web3-updates", label: "Web3 updates", bucket: "Tech", tier: "A", blurb: "Protocol moves, on-chain data, institutional flows. No shilling." , emoji: "⛓️" },
  // B-tier
  { id: "fl-gardening", label: "Florida gardening & pollinators", bucket: "Home", tier: "B", blurb: "FL-Friendly Landscaping, native plants, pollinators, seasonal.", emoji: "🌻" },
  { id: "gardening-plants", label: "Gardening & houseplants", bucket: "Home", tier: "A", blurb: "Houseplants, veg gardens, pollinator gardens — what to plant, grow, and fix, anywhere.", emoji: "🪴" },
  { id: "sustainable-living", label: "Sustainable living", bucket: "Home", tier: "A", blurb: "Low-waste home, energy, repair-not-replace, climate-smart everyday choices.", emoji: "♻️" },
  { id: "startups-vc", label: "Startups & VC", bucket: "Work", tier: "B", blurb: "Fundraises that matter, GTM playbooks, deal flow signal.", emoji: "🚀" },
  { id: "faith-meaning", label: "Faith & meaning", bucket: "Mind", tier: "B", blurb: "Christianity, theology, practice. Thoughtful, not preachy.", emoji: "🕊️" },
];

export const TOPIC_BY_ID: Record<FixedTopicId, TopicMeta> = Object.fromEntries(
  TOPICS.map((t) => [t.id, t])
) as Record<FixedTopicId, TopicMeta>;

// ─── Custom ("your own thing") topics ───────────────────────────────────────
// Encoded in the existing topics text[] as `custom:<text>` — no schema change.
// Always resolve a topic's display label/emoji through these helpers; custom
// ids are not keys in TOPIC_BY_ID.

export const CUSTOM_PREFIX = "custom:";
export const MAX_CUSTOM_TOPIC_LEN = 80;

export function isCustomTopic(id: string): boolean {
  return id.startsWith(CUSTOM_PREFIX);
}

/** The raw free text a user typed for a custom topic (no prefix). */
export function customTopicText(id: string): string {
  return id.slice(CUSTOM_PREFIX.length).trim();
}

/** Build a custom topic id from free text. Returns null if it's empty/too long
 *  or collides with a catalog id. Normalizes whitespace; preserves the words. */
export function makeCustomTopic(text: string): `custom:${string}` | null {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_CUSTOM_TOPIC_LEN).trim();
  if (clean.length < 2) return null;
  return `${CUSTOM_PREFIX}${clean}`;
}

/** Display label for any topic id (catalog or custom). */
export function topicLabel(id: string): string {
  if (isCustomTopic(id)) {
    const t = customTopicText(id);
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Your topic";
  }
  return TOPIC_BY_ID[id as FixedTopicId]?.label ?? id;
}

/** Display emoji for any topic id. Custom topics get a "personalized" sparkle. */
export function topicEmoji(id: string): string {
  if (isCustomTopic(id)) return "✨";
  return TOPIC_BY_ID[id as FixedTopicId]?.emoji ?? "•";
}

/** A valid, stable HTML id / scroll anchor for a topic's letter section.
 *  Custom ids carry spaces and a colon ("custom:crypto trends in asia") — an
 *  id with whitespace is invalid HTML and breaks CSS/`#fragment` paths — so
 *  slugify. Catalog ids (already kebab-case) are unchanged. Use this in BOTH
 *  the section element and the TOC jump so they always match. */
export function topicAnchor(id: string): string {
  const slug = id.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `s-${slug}`;
}
