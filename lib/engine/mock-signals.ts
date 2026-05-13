import type { TopicSignal } from "./types";

// V0 mock sources. Each entry is the "raw signal" the editor sees for a topic
// in a given week. In V1 this gets replaced by Brave Search + RSS pulls.
// These are written to be representative of real weekly news/signal density.

const WEEK_OF = "2026-05-17";

export const MOCK_SIGNALS: TopicSignal[] = [
  {
    topicId: "healthcare-recruiting",
    weekOf: WEEK_OF,
    context: `
This week in US healthcare recruiting (week of May 17, 2026):

- HCA Florida Gainesville Hospital opened May 5; orbital practices (the medical office buildings on the same SW 41st Boulevard campus) have started filing PA and NP postings. Three FL-licensed PA postings appeared this week. Historical pattern from prior HCA openings: orbital hires lag the main facility by 14-30 days.
- CMS's new Conditions of Participation for obstetric care (effective Jan 1, 2026, 42 CFR 482.60) require labor and delivery supervised by an RN, CNM, NP, PA, or physician. Florida hospitals are now filing L&D supervisor postings at ~3x the same week last year. Most agencies haven't started sourcing this category.
- Gem (sourcing CRM) shipped an updated "silver medalist" rediscovery workflow that surfaces candidates who applied for a prior role and ghosted. Hireology has a similar feature now too. For staffing agencies, automated re-touch on cold-rejected candidates from the last 6 months tends to outperform paid sourcing tools.
- Becker's reported this week that AdventHealth's Tampa Glazer Center is targeting 100+ physicians trained by 2028, with the Fletcher Avenue medical office building cancer center now slated for fall 2026 — oncology recruitment pipeline through 2027.
- Loxo Healthcare (11M-record provider database) raised pricing 12% this week, citing dataset expansion. Reaction in the recruiter forums is mixed — many are testing Pin (the 850M-profile newer entrant) as a side-by-side.
`,
  },
  {
    topicId: "sales-persuasion",
    weekOf: WEEK_OF,
    context: `
This week in sales psychology (week of May 17, 2026):

- Codie Sanchez appeared on Diary of a CEO in a roundtable with Daniel Priestley and Sahil Bloom. Her "1% / 9% / 90% pricing pyramid" framework went viral on X: top 1% of buyers shop on pedigree, next 9% on passion (will pay premium for compelling story), bottom 90% on price. The sweet spot for new operators is the 9%.
- Jeb Blount's "Fanatical Prospecting" is having a renaissance. Three different operator podcasts cited "pipeline anemia" as the canonical diagnosis for underperforming sales orgs this month.
- Priestley pushed his "Key Person of Influence" framework hard — argues that in services businesses, ONE recognizable founder becomes the trust anchor and pricing power compounds once they're "oversubscribed."
- Daniel Pink's "When" continues to surface in operator threads as the underrated read on timing — sales calls before 11am consistently outperform afternoon by 22% (Pink's published data).
- Naval's old "specific knowledge" thread is being re-discovered by sales operators — "you can't be trained for specific knowledge; you can only be encountered with it." Currently the most-bookmarked sales thread of the week.
`,
  },
  {
    topicId: "founder-operator",
    weekOf: WEEK_OF,
    context: `
This week in founder/operator wisdom (week of May 17, 2026):

- Sam Parr on My First Million: small one-person businesses doing $1-3M ARR are systematically undervalued — most don't know how to package themselves for acquisition.
- Justin Welsh posted a teardown of his solo $2M operation, breaking down the time-allocation: 4 hours/day on content, 2 hours on customer DMs, 2 hours on product. No team, 95% margins.
- Codie Sanchez on her roundtable: most operators waste their best content on social media when it should be inside their email list. "Your owned audience is the moat. Twitter is rented land."
- Alex Hormozi released a long-form essay on "the offer that closes itself" — the operator argument is that 90% of sales fails are bad offer design, not bad selling.
- Pomp's letter this week dug into the "founder mode" debate: post-Brian-Chesky discourse on whether founders should stay involved in product details at scale or delegate. Hot take from Daniel Pink: founder mode is just "competence visible from the top."
`,
  },
  {
    topicId: "ai-news",
    weekOf: WEEK_OF,
    context: `
This week in AI news (week of May 17, 2026):

- Anthropic released a new Claude model variant with extended context. Industry reception: benchmark-meaningful but real-world latency tradeoffs.
- OpenAI shipped GPT-5.5 with a new "agentic mode" that runs in the background. Mixed reviews — operators say it's powerful but the cost-per-task is unpredictable.
- Mistral announced their EU-sovereign cloud offering with European data residency by default. Major signal for enterprise compliance buyers.
- Cursor (the IDE) crossed $300M ARR according to The Information. Andersson tweeted that "AI coding tools are now infrastructure, not feature."
- HuggingFace launched a new evaluation harness focused on tool-use quality (function calling, JSON output, agentic loops). Smaller open-source models are catching up faster than benchmark scores suggest.
`,
  },
  {
    topicId: "fl-gardening",
    weekOf: WEEK_OF,
    context: `
This week in Florida gardening (week of May 17, 2026):

- NOAA Tampa Bay 7-day forecast: Tuesday-Wednesday dry, Thursday-Sunday sustained afternoon rain. Best transplant window for native milkweed (Asclepias tuberosa and A. incarnata) since March — plants set this week will be established before the summer heat.
- Monarch butterflies are mid-season in west-central FL; plants installed now feed the October migration. UF/IFAS Extension Pinellas posted an updated planting calendar.
- Pinellas County FFL (Florida-Friendly Landscaping) cost-share program has a quiet May intake window — reimburses up to $500 per converted area (turf to native pollinator garden). Application is one page.
- Pine straw vs. eucalyptus mulch is the debate of the week on r/FloridaGardening — recent study from UF/IFAS showed eucalyptus wins for moisture retention in zone 10a but pine straw wins for soil pH balance in citrus areas.
- The 12th annual Tampa Native Plant Society plant sale is May 24. Notable for hard-to-find species: pawpaw, Florida privet, and beach sunflower stock.
`,
  },
  {
    topicId: "inspiring-people",
    weekOf: WEEK_OF,
    context: `
This week in inspiring profiles (week of May 17, 2026):

- New Yorker profile of Sahil Bloom — went deeper than the book tour version. The under-discussed angle: he built his audience BEFORE he had anything to sell, then chose what to build based on what his readers asked for. Reverse-engineered product-market fit.
- The Atlantic ran a long profile of a Brooklyn micro-bakery owner who turned down a $4M acquisition offer because "I'd have to bake other people's bread." A meditation on smallness as a choice, not a constraint.
- 60 Minutes did a profile of Dr. Peter Attia. Key takeaway: he attributes his clinical practice's effectiveness to "no shortcuts" — he sees every patient for 90+ minutes on the first visit, refuses to scale beyond what he can personally read.
- Diary of a CEO interview with Naval Ravikant — re-cut for 2026 with fresh material. The new bit: he's been quietly funding longevity research startups, not just AI.
- Wired profile of a young female solo developer running an indie tax-software company at $8M ARR with one employee. The whole interview is about boundaries, calm, and not optimizing for growth.
`,
  },
  {
    topicId: "longevity-wellness",
    weekOf: WEEK_OF,
    context: `
This week in longevity & wellness (week of May 17, 2026):

- Peter Attia podcast: new episode on heat exposure (sauna) showing strong cardiovascular protection signal in long-term cohort data. Recommends 20 min, 4x/week at 180°F.
- Andrew Huberman released a guide on hydration — the under-discussed point: most "tired in afternoon" complaints map to 2-3% dehydration, not blood sugar.
- A meta-analysis in JAMA this week: walking 7000 steps/day captures 95% of the longevity benefit of 10000. The marginal returns past 7000 are negligible. Time to retire the magic number.
- Sleep researcher Matthew Walker on the Tim Ferriss podcast: alcohol's effect on sleep architecture is worse than caffeine's, by a wide margin. Even one drink within 4 hours of bed measurably reduces REM.
- Bryan Johnson's "Don't Die" protocol updates published — the most actionable new item is morning sunlight exposure within 30 min of waking; light intensity is the variable that matters, not duration.
`,
  },
  {
    topicId: "nutrition-food",
    weekOf: WEEK_OF,
    context: `
This week in nutrition (week of May 17, 2026):

- New RCT in NEJM: olive oil consumption (≥4 tbsp/day) reduced cardiovascular events by 19% over 5 years. Effect held across baseline diets — even non-Mediterranean.
- Examine.com summary of the week: creatine monohydrate continues to show modest cognitive benefit alongside well-established muscle effects. Recommended dose stable at 5g/day.
- Layne Norton on his podcast: protein intake distribution matters less than total — myth of "30g per meal" not supported by recent meta-analyses.
- New paper on time-restricted eating: 8-hour eating window beats 12-hour for visceral fat reduction in pre-diabetic populations, but no advantage for healthy-weight individuals.
- The Wirecutter ran a real-world test of grocery-delivery meal kits — Sweetgreen at home and Sakara both ranked above standalone kits like HelloFresh on nutritional density per dollar.
`,
  },
  {
    topicId: "web3-updates",
    weekOf: WEEK_OF,
    context: `
This week in web3 (week of May 17, 2026):

- Ethereum's Pectra upgrade went live on mainnet earlier this month; gas fees on L2s dropped ~30% week-over-week as a result.
- Coinbase Institutional's weekly note: institutional flows into spot Bitcoin ETFs hit $1.2B net inflow this week, breaking a 3-week outflow streak.
- a16z crypto published research on "intent-based architectures" — they're betting this is the UX layer that finally makes onchain transactions feel like web2.
- Farcaster crossed 500K daily active users this week. Vitalik posted a thoughtful essay on what differentiated social protocols (vs. centralized Twitter/X) look like in practice.
- OpenSea announced full deprecation of the OpenSea Pro UI by July 1 — consolidating onto a single product. Reception in NFT communities: mixed; collectors prefer Pro's denser UX.
- Token Terminal: real fees generated by L1s + L2s up 14% MoM, the highest growth since Q3 2025. Concentration: 60% of fees from Ethereum + Solana + Base.
`,
  },
  {
    topicId: "books-worth-your-time",
    weekOf: WEEK_OF,
    context: `
This week in books worth reading (week of May 17, 2026):

- Naval published his long-rumored book "The Almanack II" — collected wisdom from the last 5 years of his writing. Reception: better edited than the first.
- New Yorker review of David Brooks's "How to Know a Person" — calls it "the relationship book operators didn't know they needed."
- Sahil Bloom's "5 Types of Wealth" is back on the NYT bestseller list, week 14. The new chapter on social wealth is the most-quoted on socials.
- Reading list of the week from Tyler Cowen: "The Power Broker" by Robert Caro (re-read for him), and a new biography of Charlie Munger that he calls "the best business biography since Hard Drive."
- LitHub's underrated 2026 list features "On Sleep" by Marina Benjamin — a quiet meditation that's becoming a cult favorite.
`,
  },
  {
    topicId: "music",
    weekOf: WEEK_OF,
    context: `
This week in music industry (week of May 17, 2026):

- Spotify's Q1 numbers: 685M MAU, 268M paying. AI-generated music remains a growing share of streams (industry estimates 8-12%).
- Universal Music announced a new direct-to-superfan platform aimed at competing with Bandcamp and Patreon — artist-side revenue share rumored at 90%.
- Bandlab crossed 100M registered users this week — the world's largest music creation platform, though monetization remains thin.
- Frank Ocean returned to performing this week (a small unannounced set in LA). First public performance in 18 months.
- The 1975 announced a residency at the Las Vegas Sphere — only the third act to do so after U2 and Phish.
- Hype Machine, the legacy music discovery aggregator, sold to a small group of indie label owners for an undisclosed sum. A symbolic moment for the blog-era music web.
`,
  },
  {
    topicId: "movies-tv",
    weekOf: WEEK_OF,
    context: `
This week in movies & TV (week of May 17, 2026):

- Severance Season 3 premiered on Apple TV+ this week. Critics calling it "the show finally answering questions instead of stacking them." Episode 1 review embargo lifted to near-universal praise.
- The Studio (Seth Rogen's industry satire) was renewed for a third season at Apple, ahead of its second season's release.
- Netflix's "The Diplomat" Season 3 is showrunning a tighter, more political turn — Politico magazine ran a piece on how it's become required viewing in DC.
- A24 announced its 2026 awards-season slate: 8 films, four led by first-time directors. The studio is doubling down on debut-feature distribution.
- HBO confirmed a TRUE DETECTIVE prequel set in Texas in the 1970s, directed by Issa López. Filming starts this summer.
`,
  },
  {
    topicId: "style-fashion",
    weekOf: WEEK_OF,
    context: `
This week in style (week of May 17, 2026):

- Highsnobiety: workwear-leaning silhouettes (Carhartt, Dickies, MakerHaus) are now showing up at the high end of menswear collections. Loro Piana referenced "thoughtful worker" in their spring lookbook copy.
- The Row dropped a new fragrance — Esquire reviewer called it "the smell of an empty Aesop store" (intended as praise).
- Wirecutter ran their annual t-shirt test: Buck Mason heavyweight crewneck was the top pick for the second year running.
- Aimé Leon Dore opened a small Tampa pop-up — first time the brand has been south of New York.
- BoF Voices: linen is back as the dominant summer fabric across high-end menswear, displacing the cotton-poly blends that ruled 2022-2024.
`,
  },
];

export function getSignal(topicId: string, weekOf?: string): TopicSignal | undefined {
  return MOCK_SIGNALS.find(
    (s) => s.topicId === topicId && (!weekOf || s.weekOf === weekOf)
  );
}
