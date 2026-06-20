import type { TopicId } from "@/lib/types";

// Per-topic Brave Search queries. We run 3 per topic and Claude synthesizes
// from the joined results. Two design principles tuned 2026-05-14:
//
//   1. Anchor on named publishers / authors / operators the audience recognizes.
//      Generic "this week" queries pull SEO listicles; named-subject queries
//      pull primary sources.
//   2. Keep one of the three intentionally specific (a name, a subtopic, a
//      release / outlet) so the section has texture instead of three near-
//      duplicate result sets.
//
// Brave's `freshness: "pw"` (past-week) is already applied at call site, so
// queries don't need their own "this week" anchor.

export const TOPIC_QUERIES: Record<TopicId, string[]> = {
  "healthcare-recruiting": [
    "US healthcare hiring market news",
    "Becker's hospital review nurse staffing 2026",
    "scope of practice CRNA NP physician assistant",
  ],
  "sales-persuasion": [
    "sales psychology Cialdini Voss Hormozi",
    "B2B cold outreach reply rates Jeb Blount",
    "sales call recording analysis Gong Chorus",
  ],
  "founder-operator": [
    "My First Million Sam Parr Shaan Puri",
    "Alex Hormozi Justin Welsh solo operator playbook",
    "Stratechery Ben Thompson business strategy",
  ],
  "marketing-growth": [
    "Lenny Rachitsky newsletter PMF growth",
    "April Dunford positioning B2B",
    "marketing brew growth loops cold start",
  ],
  "personal-finance": [
    "Money Guy Show Ramit Sethi financial planning",
    "Nick Maggiulli Of Dollars and Data investing",
    "Justin Welsh Pieter Levels solopreneur income",
  ],
  "real-estate": [
    "BiggerPockets housing market mortgage rates",
    "Lance Lambert housing data inventory",
    "Florida insurance crisis property values",
  ],
  "macro-markets": [
    "Joey Politano Apricitas inflation labor",
    "Sam Ro TKer Mike Cembalest markets",
    "Federal Reserve FOMC rate decision yield curve",
  ],
  "longevity-wellness": [
    "Peter Attia podcast longevity protocol",
    "Andrew Huberman sleep hydration training",
    "Bryan Johnson Don't Die Blueprint study",
  ],
  "nutrition-food": [
    "Layne Norton Examine nutrition meta-analysis",
    "protein creatine olive oil cardiovascular",
    "time restricted eating GLP-1 obesity",
  ],
  "mental-health": [
    "JAMA Psychiatry therapy SSRI meta-analysis",
    "Bessel van der Kolk trauma research",
    "Hidden Brain Happiness Lab podcast research",
  ],
  "womens-health": [
    "Dr Stacy Sims women training menstrual cycle",
    "Mary Claire Haver perimenopause HRT",
    "NEJM women's health hormone replacement trial",
  ],
  "books-worth-your-time": [
    "Tyler Cowen Marginal Revolution book recommendations",
    "Sahil Bloom David Brooks Naval new release",
    "NYT bestseller non-fiction this month",
  ],
  "psychology-behavior": [
    "Adam Grant Katy Milkman behavioral science",
    "Marginalian Maria Popova Brain Pickings essay",
    "JAMA Psychology Today new research findings",
  ],
  "parenting": [
    "Emily Oster ParentData research",
    "Dr Becky Kennedy Good Inside parenting",
    "Big Little Feelings Janet Lansbury tantrum",
  ],
  "inspiring-people": [
    "New Yorker profile founder operator",
    "The Atlantic Wired long-form profile",
    "Diary of a CEO Modern Wisdom interview",
  ],
  "movies-tv": [
    "Letterboxd Journal A24 Apple TV+ premiere",
    "IndieWire The Ringer film criticism",
    "Severance The Studio Diplomat HBO Netflix",
  ],
  "music": [
    "Rick Beato Anthony Fantano music industry",
    "Pitchfork Stereogum new album release",
    "Spotify Bandcamp Tidal artist economics",
  ],
  "music-edm": [
    "Dancing Astronaut EDM.com new release",
    "Beatport Mixmag electronic music chart",
    "Resident Advisor festival lineup news",
  ],
  "music-hiphop": [
    "Complex HotNewHipHop new release",
    "Pitchfork XXL rap album review",
    "Genius Billboard hip hop chart",
  ],
  "music-indie": [
    "Pitchfork Stereogum indie album release",
    "Paste Brooklyn Vegan new band",
    "Gorilla vs Bear indie rock",
  ],
  "music-country": [
    "Saving Country Music new release",
    "Billboard country chart",
    "Whiskey Riff Rolling Stone Country",
  ],
  "style-fashion": [
    "Highsnobiety Business of Fashion style trends",
    "Vogue Who What Wear womenswear trends",
    "GQ Aimé Leon Dore menswear drop",
  ],
  "sports-betting": [
    "Unabated sharp action closing line value",
    "Action Network PRO sportsbook line movement",
    "NFL NBA MLB injury report Vegas odds",
  ],
  "trading-cards": [
    "sports card market Card Ladder PSA grading",
    "Pokemon TCG set release TCGplayer prices",
    "Fanatics Topps sports cards hobby news",
  ],
  "ai-news": [
    "Anthropic OpenAI Mistral model release",
    "Latent Space Simon Willison AI engineering",
    "Cursor Granola v0 Perplexity Notion AI tool",
  ],
  "web3-updates": [
    "Vitalik Ethereum upgrade Layer 2",
    "Bankless Coinbase Institutional crypto ETF flows",
    "Farcaster Warpcast decentralized social",
  ],
  // Generic parent fallback. The picker stores "zodiac"; at generation it maps
  // to a per-sign id ("zodiac-leo") via the reader's birthday, and zodiacQueries
  // below builds the sign-specific search. This entry just satisfies the typed
  // Record and is only used if a sign somehow can't be derived (it's dropped
  // first, so effectively never).
  zodiac: [
    "weekly horoscope this week astrology",
    "zodiac signs forecast",
    "astrology news this week",
  ],
  "fl-gardening": [
    "UF IFAS Florida-Friendly Landscaping native plants",
    "Tampa Bay native plant society event sale",
    "Florida pollinator milkweed monarch garden",
  ],
  "gardening-plants": [
    "Epic Gardening houseplant vegetable garden tips",
    "The Spruce indoor plant care propagation",
    "Xerces Society pollinator garden native plants",
  ],
  "sustainable-living": [
    "Treehugger low waste sustainable home",
    "Grist climate solutions everyday",
    "Wirecutter sustainable swaps energy efficiency",
  ],
  "startups-vc": [
    "The Information Y Combinator a16z fundraise",
    "Stratechery Lenny startup operator essay",
    "20VC All-In podcast venture deal flow",
  ],
  "faith-meaning": [
    "Christianity Today Gospel Coalition essay",
    "Bible Project Tim Keller theology podcast",
    "Plough Comment Magazine Richard Rohr contemplative",
  ],
  "faith-christianity": [
    "Christianity Today Gospel Coalition essay",
    "Bible Project Tim Keller theology",
    "Christian practice prayer church",
  ],
  "faith-islam": [
    "Yaqeen Institute Islamic scholarship",
    "Quran hadith contemporary Muslim thought",
    "Islam practice Ramadan prayer community",
  ],
  "faith-judaism": [
    "Tablet Magazine My Jewish Learning essay",
    "Torah Talmud commentary Sefaria",
    "Jewish practice Shabbat holidays thought",
  ],
  "faith-hinduism": [
    "Hinduism Vedanta Bhagavad Gita teaching",
    "Hindu philosophy dharma practice",
    "Hindu festivals temple community",
  ],
  "faith-buddhism": [
    "Tricycle Lion's Roar Buddhist teaching",
    "Buddhism meditation dharma mindfulness",
    "Thich Nhat Hanh Pema Chodron practice",
  ],
  "faith-spiritual": [
    "Richard Rohr Krista Tippett On Being contemplative",
    "spirituality meaning contemplative practice essay",
    "spiritual but not religious seeking meaning",
  ],
};

// Sign-specific Brave queries for a per-sign zodiac id ("zodiac-leo"). The
// reader's section is keyed + cached by this id, so all Leos share one Leo
// generation. Returns [] for a non-zodiac id.
export function zodiacQueries(zodiacTopicId: string): string[] {
  const m = zodiacTopicId.match(/^zodiac-([a-z]+)$/);
  if (!m) return [];
  const sign = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return [
    `${sign} horoscope this week`,
    `${sign} weekly astrology forecast`,
    `${sign} zodiac what to know this week`,
  ];
}
