import { zodiacSign } from "./demographics";
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
  { id: "zodiac", label: "Zodiac & astrology", bucket: "Mind", tier: "A", blurb: "Your weekly horoscope and what your sign is moving through. Add your birthday to switch it on.", emoji: "🔮" },
  // Culture
  { id: "inspiring-people", label: "Inspiring people", bucket: "Culture", tier: "A", blurb: "Profiles of operators, artists, founders doing the work.", emoji: "✨" },
  { id: "movies-tv", label: "Movies & TV", bucket: "Culture", tier: "A", blurb: "What's worth watching, who's making it, where it's going.", emoji: "🎬" },
  { id: "music", label: "Music", bucket: "Culture", tier: "A", blurb: "Releases that matter, industry shifts, who to know.", emoji: "🎵" },
  { id: "music-edm", label: "EDM & electronic", bucket: "Culture", tier: "A", blurb: "New EDM and electronic releases, festival news, the producers and labels worth following.", emoji: "🎧" },
  { id: "music-hiphop", label: "Hip-hop & rap", bucket: "Culture", tier: "A", blurb: "New hip-hop and rap drops, the verses people are talking about, who's rising.", emoji: "🎤" },
  { id: "music-indie", label: "Indie & alternative", bucket: "Culture", tier: "A", blurb: "Indie and alternative releases worth your ears, the bands breaking out, the scene.", emoji: "🎸" },
  { id: "music-country", label: "Country", bucket: "Culture", tier: "A", blurb: "New country releases, the songwriters and artists shaping it, what's climbing.", emoji: "🤠" },
  { id: "style-fashion", label: "Style & fashion", bucket: "Culture", tier: "A", blurb: "What's good, what's coming, what the cool kids actually wear.", emoji: "👔" },
  { id: "sports-betting", label: "Sports & betting markets", bucket: "Culture", tier: "A", blurb: "Edges, line movement, model-vs-market gaps, plus the games and stories shaping the week.", emoji: "🏈" },
  { id: "trading-cards", label: "Trading cards", bucket: "Culture", tier: "A", blurb: "Sports cards and TCGs: market moves, grading, releases, what collectors are chasing.", emoji: "🃏" },
  // Tech
  { id: "ai-news", label: "AI: news, releases & tools for work", bucket: "Tech", tier: "A", blurb: "Model releases, frontier moves, plus the tools and workflows actually shipping productivity wins.", emoji: "🤖" },
  { id: "web3-updates", label: "Web3 updates", bucket: "Tech", tier: "A", blurb: "Protocol moves, on-chain data, institutional flows. No shilling." , emoji: "⛓️" },
  // B-tier
  { id: "fl-gardening", label: "Florida gardening & pollinators", bucket: "Home", tier: "B", blurb: "FL-Friendly Landscaping, native plants, pollinators, seasonal.", emoji: "🌻" },
  { id: "gardening-plants", label: "Gardening & houseplants", bucket: "Home", tier: "A", blurb: "Houseplants, veg gardens, pollinator gardens. What to plant, grow, and fix, anywhere.", emoji: "🪴" },
  { id: "sustainable-living", label: "Sustainable living", bucket: "Home", tier: "A", blurb: "Low-waste home, energy, repair-not-replace, climate-smart everyday choices.", emoji: "♻️" },
  { id: "startups-vc", label: "Startups & VC", bucket: "Work", tier: "B", blurb: "Fundraises that matter, GTM playbooks, deal flow signal.", emoji: "🚀" },
  { id: "faith-meaning", label: "Faith & religion", bucket: "Mind", tier: "A", blurb: "The big questions, your tradition or broadly. Thoughtful, not preachy.", emoji: "🕊️" },
  { id: "faith-christianity", label: "Christianity", bucket: "Mind", tier: "A", blurb: "Scripture, theology, and practice across the Christian traditions.", emoji: "✝️" },
  { id: "faith-islam", label: "Islam", bucket: "Mind", tier: "A", blurb: "Quran, hadith, scholarship, and Muslim life today.", emoji: "☪️" },
  { id: "faith-judaism", label: "Judaism", bucket: "Mind", tier: "A", blurb: "Torah, commentary, and Jewish thought and practice.", emoji: "✡️" },
  { id: "faith-hinduism", label: "Hinduism", bucket: "Mind", tier: "A", blurb: "Vedanta, the epics, philosophy, and daily practice.", emoji: "🕉️" },
  { id: "faith-buddhism", label: "Buddhism", bucket: "Mind", tier: "A", blurb: "Meditation, dharma, and the schools of Buddhist thought.", emoji: "☸️" },
  { id: "faith-spiritual", label: "Spiritual & seeking", bucket: "Mind", tier: "A", blurb: "Meaning, contemplative practice, spiritual but not religious.", emoji: "🌀" },
];

export const TOPIC_BY_ID: Record<FixedTopicId, TopicMeta> = Object.fromEntries(
  TOPICS.map((t) => [t.id, t])
) as Record<FixedTopicId, TopicMeta>;

/** Broad parent topics that expand into specific sub-topic chips in the picker.
 *  Each child is a real catalog id (hand-written queries + curated mock), so
 *  everyone who taps "EDM" lands on the SAME shared id and shares one cached
 *  section. This is how "more personal" stays cheap: specific-but-shared, not
 *  per-user. The broad parent stays a valid one-tap pick for people who want
 *  the whole category. */
export const SUBTOPICS: Partial<Record<FixedTopicId, FixedTopicId[]>> = {
  music: ["music-edm", "music-hiphop", "music-indie", "music-country"],
  "faith-meaning": [
    "faith-christianity",
    "faith-islam",
    "faith-judaism",
    "faith-hinduism",
    "faith-buddhism",
    "faith-spiritual",
  ],
};

/** The parent broad topic for a sub-topic chip, if any (e.g. music-edm -> music). */
export const PARENT_TOPIC: Partial<Record<FixedTopicId, FixedTopicId>> = Object.fromEntries(
  Object.entries(SUBTOPICS).flatMap(([parent, kids]) =>
    (kids ?? []).map((k) => [k, parent as FixedTopicId])
  )
) as Partial<Record<FixedTopicId, FixedTopicId>>;

// ─── Custom ("your own thing") topics ───────────────────────────────────────
// Encoded in the existing topics text[] as `custom:<text>` — no schema change.
// Always resolve a topic's display label/emoji through these helpers; custom
// ids are not keys in TOPIC_BY_ID.

export const CUSTOM_PREFIX = "custom:";
export const MAX_CUSTOM_TOPIC_LEN = 80;

export function isCustomTopic(id: string): boolean {
  return id.startsWith(CUSTOM_PREFIX);
}

// The picker stores the parent "zodiac"; at generation it's mapped to a per-sign
// id ("zodiac-leo") so all readers of a sign share one cached section. Both forms
// are "zodiac topics."
export function isZodiacTopicId(id: string): boolean {
  return id === "zodiac" || id.startsWith("zodiac-");
}

// Map a reader's stored topics to their EFFECTIVE generation pool: the pickable
// "zodiac" becomes their per-sign id ("zodiac-leo"), and DROPS when there's no
// birthday to derive a sign from. Shared by the generator (assemble) AND the
// cron's skip-check, so a reader whose whole pool maps to empty (only reachable
// by a raw DB write — the product gates zodiac on a birthday) is treated as a
// loud "got nothing" blank skip, not a hard generation failure.
export function mapTopicsForUser(topics: TopicId[], birthday: string | undefined): TopicId[] {
  const sign = zodiacSign(birthday);
  return topics.flatMap((t) =>
    t === "zodiac" ? (sign ? [`zodiac-${sign}` as TopicId] : []) : [t]
  );
}

// When a reader types a custom ("your own thing") topic, suggest a curated
// catalog topic that would give better, sourced content (e.g. "Islam and Quran"
// or "Inspiring Hadiths" -> the curated Islam topic). HIGH-PRECISION on purpose:
// single-word keys must match a whole token (so "rap" never fires inside
// "therapy"), multi-word keys match as a substring. Only a small, low-ambiguity
// set is mapped, so we never nag on a vague overlap. Returns a catalog id or null.
// Specific subtopic keys come BEFORE the generic faith/religion umbrella keys,
// so "islamic faith" resolves to the Islam topic (first hit wins), not the
// umbrella. Common adjective/plural surface forms (islamic, muslims, christians)
// are listed because single-word keys match a whole token, not a prefix.
const CURATED_KEYWORDS: Record<string, FixedTopicId> = {
  islam: "faith-islam", islamic: "faith-islam", muslim: "faith-islam", muslims: "faith-islam", quran: "faith-islam", koran: "faith-islam", hadith: "faith-islam", hadiths: "faith-islam",
  christianity: "faith-christianity", christian: "faith-christianity", christians: "faith-christianity", jesus: "faith-christianity", gospel: "faith-christianity", bible: "faith-christianity",
  judaism: "faith-judaism", jewish: "faith-judaism", jews: "faith-judaism", torah: "faith-judaism",
  hinduism: "faith-hinduism", hindu: "faith-hinduism", hindus: "faith-hinduism",
  buddhism: "faith-buddhism", buddhist: "faith-buddhism", buddhists: "faith-buddhism", buddha: "faith-buddhism",
  spiritual: "faith-spiritual", spirituality: "faith-spiritual", mindfulness: "faith-spiritual",
  religion: "faith-meaning", faith: "faith-meaning",
  edm: "music-edm", techno: "music-edm",
  rap: "music-hiphop", hiphop: "music-hiphop", "hip-hop": "music-hiphop", "hip hop": "music-hiphop",
  crypto: "web3-updates", cryptocurrency: "web3-updates", bitcoin: "web3-updates", ethereum: "web3-updates", web3: "web3-updates", nft: "web3-updates", blockchain: "web3-updates", defi: "web3-updates",
  astrology: "zodiac", horoscope: "zodiac", horoscopes: "zodiac", zodiac: "zodiac",
};

export function suggestCuratedTopic(text: string): FixedTopicId | null {
  const lower = text.toLowerCase();
  const tokens = new Set(lower.match(/[a-z0-9]+/g) || []);
  for (const [kw, topic] of Object.entries(CURATED_KEYWORDS)) {
    const hit = kw.includes("-") || kw.includes(" ") ? lower.includes(kw) : tokens.has(kw);
    if (hit) return topic;
  }
  return null;
}

/** The raw free text a user typed for a custom topic (no prefix). */
export function customTopicText(id: string): string {
  return id.slice(CUSTOM_PREFIX.length).trim();
}

/** Build a custom topic id from free text. Returns null if it's empty/too long.
 *  Lowercases + collapses whitespace so two readers who type the same thing in
 *  different case or spacing ("EDM" / "edm" / "  edm ") land on the SAME id, and
 *  thus SHARE one cached generation instead of each paying for their own. The id
 *  is the cache key (topic_blurbs.topic_id), so a stable normalized string is
 *  what keeps custom topics cheap. */
export function makeCustomTopic(text: string): `custom:${string}` | null {
  const clean = text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_CUSTOM_TOPIC_LEN).trim();
  if (clean.length < 2) return null;
  return `${CUSTOM_PREFIX}${clean}`;
}

// Small connector words that stay lowercase in a title unless they lead.
const TITLE_SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in",
  "into", "of", "on", "or", "the", "to", "vs", "with",
]);

// Acronyms a reader is likely to type in a custom topic, kept fully upper
// regardless of position. Matches the house style already used in the fixed
// catalog labels ("AI: news...", "Startups & VC"). Intentionally a short,
// unambiguous list, not a general acronym detector.
const TITLE_ACRONYMS = new Set([
  "ai", "ml", "vc", "seo", "ceo", "cfo", "cto", "ui", "ux", "api", "nba", "nfl", "mlb", "nhl", "ufc",
]);

/** Title-case a custom topic's free text for DISPLAY only. New custom ids are
 *  stored lowercased (makeCustomTopic, for cache-key dedup), so a raw label
 *  reads "Bitcoin and ethereum". This capitalizes each significant word while
 *  PRESERVING any existing capital — so a legacy mixed-case id ("...Quran...")
 *  keeps its caps. The id itself is untouched, so dedup + the blurb cache key
 *  are unaffected. Splits on "/" and "-" too (as their own tokens, kept
 *  verbatim), so a slash- or hyphen-joined phrase like "sales/marketing/growth"
 *  capitalizes each part instead of only the very first letter of the whole
 *  chunk. Known acronyms (TITLE_ACRONYMS) are forced upper regardless of the
 *  stored case, matching the catalog's own style ("AI: news...", "...& VC"). */
function titleCaseTopic(text: string): string {
  let wordSeen = false;
  return text
    .split(/(\s+|[/-])/) // whitespace runs AND a lone "/" or "-" become their own tokens
    .map((tok) => {
      if (tok === "" || /^\s+$/.test(tok) || tok === "/" || tok === "-") return tok;
      const isFirst = !wordSeen;
      wordSeen = true;
      const lower = tok.toLowerCase();
      if (TITLE_ACRONYMS.has(lower)) return lower.toUpperCase();
      if (!isFirst && TITLE_SMALL_WORDS.has(lower)) return lower;
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    })
    .join("");
}

/** Display label for any topic id (catalog or custom). */
export function topicLabel(id: string): string {
  if (isCustomTopic(id)) {
    const t = customTopicText(id);
    return t ? titleCaseTopic(t) : "Your topic";
  }
  // A per-sign zodiac section is labeled by the sign itself ("Leo"). The parent
  // "zodiac" (the picker) falls through to its catalog label.
  if (id.startsWith("zodiac-")) {
    const s = id.slice("zodiac-".length);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Zodiac";
  }
  return TOPIC_BY_ID[id as FixedTopicId]?.label ?? id;
}

/** Display emoji for any topic id. Custom topics get a "personalized" sparkle. */
export function topicEmoji(id: string): string {
  if (isCustomTopic(id)) return "✨";
  if (id.startsWith("zodiac-")) return "🔮";
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
