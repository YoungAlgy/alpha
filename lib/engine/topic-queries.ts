import type { TopicId } from "@/lib/types";

// Per-topic search queries fed to Brave. We run a small number per topic
// (~3) and join the results into a signal context for Claude.
// The third query is intentionally local/specific so each section gets
// a fresh, current angle.

export const TOPIC_QUERIES: Record<TopicId, string[]> = {
  "healthcare-recruiting": [
    "US healthcare recruiting news this week",
    "hospital hiring trends 2026",
    "nurse shortage staffing agency",
  ],
  "sales-persuasion": [
    "sales psychology insights this week",
    "B2B selling tactics 2026",
    "cold outreach response rates",
  ],
  "founder-operator": [
    "founder wisdom My First Million this week",
    "operator playbook scaling SaaS",
    "Hormozi Welsh Sahil Bloom",
  ],
  "marketing-growth": [
    "marketing growth tactics this week",
    "best newsletter platforms 2026",
    "B2B PMF growth loops",
  ],
  "personal-finance": [
    "personal finance investing news this week",
    "high yield savings 401k strategy 2026",
    "solopreneur side hustle indie hacker income 2026",
  ],
  "real-estate": [
    "real estate market this week",
    "mortgage rates 2026",
    "rental property investing",
  ],
  "macro-markets": [
    "macro economy this week",
    "Fed rate decision 2026",
    "Treasury yields inflation",
  ],
  "longevity-wellness": [
    "longevity research this week",
    "Peter Attia Huberman protocols",
    "sleep recovery training",
  ],
  "nutrition-food": [
    "nutrition research this week",
    "protein creatine olive oil benefits",
    "time restricted eating studies",
  ],
  "mental-health": [
    "mental health research this week",
    "therapy modalities 2026",
    "anxiety depression treatment",
  ],
  "womens-health": [
    "women's health research this week",
    "perimenopause hormone protocols 2026",
    "menstrual cycle training fertility",
  ],
  "books-worth-your-time": [
    "best books to read 2026",
    "non-fiction recommendations this week",
    "Tyler Cowen book recommendations",
  ],
  "psychology-behavior": [
    "psychology research this week",
    "behavioral science new findings 2026",
    "Adam Grant Katy Milkman",
  ],
  "parenting": [
    "parenting research this week",
    "gentle parenting Big Little Feelings 2026",
    "Emily Oster child development",
  ],
  "inspiring-people": [
    "inspiring profile this week",
    "New Yorker Atlantic profile 2026",
    "operator profile Wired Esquire",
  ],
  "movies-tv": [
    "best new movies TV this week",
    "Severance A24 Apple TV+ 2026",
    "indie film release 2026",
  ],
  "music": [
    "music industry news this week",
    "new album release 2026",
    "Frank Ocean Spotify Bandcamp",
  ],
  "style-fashion": [
    "menswear style trends this week",
    "Highsnobiety BoF 2026",
    "Aimé Leon Dore The Row Buck Mason",
  ],
  "sports-betting": [
    "sports betting edges sharp action this week",
    "DraftKings FanDuel line movement closing line value 2026",
    "NFL NBA MLB news this week",
  ],
  "ai-news": [
    "AI model release Anthropic OpenAI Mistral this week",
    "best AI tools for work Cursor Granola v0 Notion 2026",
    "AI workflow automation productivity 2026",
  ],
  "web3-updates": [
    "web3 protocol news this week",
    "Ethereum L2 Farcaster 2026",
    "crypto ETF flows institutional",
  ],
  "fl-gardening": [
    "Florida gardening this week",
    "UF IFAS native plants pollinators",
    "Tampa Bay garden events",
  ],
  "startups-vc": [
    "startup VC news this week",
    "Y Combinator a16z 2026",
    "startup fundraise tender offer",
  ],
  "faith-meaning": [
    "Christianity faith essay this week",
    "Bible Project Tim Keller",
    "contemplative theology 2026",
  ],
};
