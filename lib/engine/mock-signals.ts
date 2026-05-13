import type { TopicSignal } from "./types";

// V0 mock sources. Each entry carries the raw weekly signal for one topic,
// INCLUDING real URLs we know exist. Claude may only cite URLs that appear
// in the signal — it must not invent new ones. In V1 these get replaced by
// Brave Search + curated RSS.

const WEEK_OF = "2026-05-17";

export const MOCK_SIGNALS: TopicSignal[] = [
  {
    topicId: "healthcare-recruiting",
    weekOf: WEEK_OF,
    context: `
This week in US healthcare recruiting (week of May 17, 2026):

NEWS:
- HCA Florida Gainesville Hospital opened May 5; orbital practices on the SW 41st Boulevard campus filed three FL-licensed PA postings this week. Historical pattern: orbital hires lag the main facility by 14-30 days. (https://www.fiercehealthcare.com)
- CMS's new Conditions of Participation for obstetric care (effective Jan 1, 2026, 42 CFR 482.60) require L&D supervision by an RN/CNM/NP/PA/physician. FL hospitals are filing L&D supervisor postings at ~3x last year's volume. (https://www.cms.gov/regulations-and-guidance)
- AdventHealth Tampa's Glazer Center is targeting 100+ physicians trained by 2028, with the Fletcher Avenue cancer center MOB now slated for fall 2026.

APPS / TOOLS WORTH TRYING:
- Gem — sourcing CRM with "silver medalist" rediscovery workflow that surfaces past applicants. (https://www.gem.com)
- Pin — newer entrant, 850M-profile passive database, free tier available. (https://www.pin.com)
- Loxo Healthcare — 11M-provider database, raised pricing 12% this week. (https://loxo.co)
- Hireology — purpose-built ATS for high-turnover healthcare hiring. (https://www.hireology.com)

WORTH READING / WATCHING:
- "The Silver Medalist Thesis" — Affolter advisory piece on rediscovery economics. (https://www.affolter.io)
- Becker's Hospital Review weekly digest. (https://www.beckershospitalreview.com)
`,
  },
  {
    topicId: "sales-persuasion",
    weekOf: WEEK_OF,
    context: `
This week in sales psychology (week of May 17, 2026):

WORTH WATCHING:
- Codie Sanchez + Daniel Priestley + Sahil Bloom roundtable on Diary of a CEO — her "1% / 9% / 90% pricing pyramid" framework went viral. (https://www.youtube.com/@TheDiaryOfACEO)
- Alex Hormozi's "The Offer That Closes Itself" essay (Acquisition.com, video form). (https://www.acquisition.com)

WORTH READING:
- Jeb Blount's "Fanatical Prospecting" — "pipeline anemia" is becoming the canonical operator diagnosis. (https://salesgravy.com)
- Naval's specific-knowledge thread, re-surfaced this week. (https://x.com/naval/status/1002103360646823936)
- Priestley's "Key Person of Influence" framework (book at https://www.dent.global)
- Daniel Pink's "When" — sales calls before 11am outperform afternoon by 22% per published data. (https://www.danpink.com)

POSTS / THREADS:
- Sanchez's 1/9/90 tweet thread on X. (https://x.com/codie_sanchez)
- Bloom's audience-as-moat take on X. (https://x.com/sahilbloom)
`,
  },
  {
    topicId: "founder-operator",
    weekOf: WEEK_OF,
    context: `
This week in founder / operator wisdom (week of May 17, 2026):

LISTEN:
- My First Million on the systematic undervaluation of $1-3M one-person businesses. (https://www.mfmpod.com)
- Modern Wisdom interview with Justin Welsh, including a time-allocation teardown of his solo $2M operation. (https://chriswillx.com)

WATCH / READ:
- Alex Hormozi's long-form essay on offer design — argues 90% of sales failures are bad offer design. (https://www.acquisition.com)
- Pomp's letter this week on the "founder mode" discourse. (https://pomp.substack.com)
- Codie Sanchez on owned-audience economics. (https://contrarianthinking.co)

APPS TO TRY:
- Hampton — Sam Parr's $1M+ founder peer community. (https://www.joinhampton.com)
- Beehiiv — Justin Welsh's preferred newsletter stack. (https://www.beehiiv.com)
- Lemon List — solo founder networking. (https://www.lemonlist.co)

POSTS:
- Welsh's solo $2M time-allocation tweet. (https://x.com/thejustinwelsh)
`,
  },
  {
    topicId: "ai-news",
    weekOf: WEEK_OF,
    context: `
This week in AI news (week of May 17, 2026):

NEWS:
- Anthropic released a new Claude model variant with extended context. (https://www.anthropic.com/news)
- OpenAI shipped GPT-5.5 with a new background "agentic mode." (https://openai.com/blog)
- Mistral announced an EU-sovereign cloud offering with European data residency by default. (https://mistral.ai/news)
- Cursor (the IDE) crossed $300M ARR per The Information. (https://www.cursor.com)
- HuggingFace launched a new evaluation harness focused on tool-use quality. (https://huggingface.co/blog)

APPS TO TRY:
- Claude (Anthropic) — https://claude.ai
- Cursor — the AI-first IDE. (https://www.cursor.com)
- v0 by Vercel — AI UI generation. (https://v0.dev)
- Granola — AI meeting notes. (https://www.granola.ai)

READ:
- Latent Space newsletter for AI engineering. (https://www.latent.space)
- TLDR AI daily digest. (https://tldr.tech/ai)
- Simon Willison's blog — pragmatic AI commentary. (https://simonwillison.net)

POSTS:
- Sam Altman's GPT-5.5 release thread. (https://x.com/sama)
`,
  },
  {
    topicId: "fl-gardening",
    weekOf: WEEK_OF,
    context: `
This week in Florida gardening (week of May 17, 2026):

THIS WEEK'S WEATHER WINDOW:
- NOAA Tampa Bay forecast: Tuesday-Wednesday dry, Thursday-Sunday sustained afternoon rain. Best transplant window for native milkweed (Asclepias tuberosa, A. incarnata) since March. (https://www.weather.gov/tbw)

WORTH READING:
- UF/IFAS Extension Pinellas updated planting calendar. (https://sfyl.ifas.ufl.edu/pinellas)
- Florida-Friendly Landscaping cost-share program — May intake, up to $500 per converted area. (https://ffl.ifas.ufl.edu)
- Pine straw vs. eucalyptus mulch study from UF/IFAS: eucalyptus wins for moisture in zone 10a, pine straw for soil pH in citrus areas.

APPS TO TRY:
- iNaturalist — identify any plant or pollinator with a photo. (https://www.inaturalist.org)
- PictureThis — plant ID with care guidance. (https://www.picturethisai.com)
- Florida Wildflowers app (state DOT). (https://www.fdacs.gov)

EVENTS:
- 12th annual Tampa Native Plant Society plant sale, May 24. Hard-to-find: pawpaw, FL privet, beach sunflower. (https://tampa.fnpschapters.org)

POSTS:
- Monarch Joint Venture update on FL milkweed timing. (https://monarchjointventure.org)
`,
  },
  {
    topicId: "inspiring-people",
    weekOf: WEEK_OF,
    context: `
This week in inspiring profiles (week of May 17, 2026):

WORTH READING:
- New Yorker profile of Sahil Bloom — deeper than the book tour version, on building audience before product. (https://www.newyorker.com)
- The Atlantic on a Brooklyn micro-bakery owner turning down a $4M acquisition. (https://www.theatlantic.com)
- Wired profile of a solo female indie tax-software developer running $8M ARR with one employee. (https://www.wired.com)

WORTH WATCHING:
- 60 Minutes profile of Dr. Peter Attia — "no shortcuts" clinical practice philosophy. (https://www.cbsnews.com/60-minutes)
- Diary of a CEO with Naval Ravikant — 2026 re-cut with new material on his longevity research funding. (https://www.youtube.com/@TheDiaryOfACEO)

POSTS:
- Sahil Bloom's "5 Types of Wealth" thread, viral again this week. (https://x.com/sahilbloom)
- Peter Attia's longevity training framework recap. (https://x.com/PeterAttiaMD)
`,
  },
  {
    topicId: "longevity-wellness",
    weekOf: WEEK_OF,
    context: `
This week in longevity & wellness (week of May 17, 2026):

LISTEN:
- Peter Attia podcast on heat exposure (sauna) — recommends 20 min, 4x/week at 180°F based on long-term cohort data. (https://peterattiamd.com)
- Tim Ferriss + Matthew Walker on alcohol vs. caffeine's effect on sleep architecture. (https://tim.blog)

WORTH READING:
- New JAMA meta-analysis: 7,000 steps/day captures 95% of the longevity benefit of 10,000. (https://jamanetwork.com)
- Bryan Johnson's "Don't Die" protocol updates — morning sunlight intensity within 30 min of waking. (https://www.blueprint.bryanjohnson.com)
- Andrew Huberman's hydration guide. (https://www.hubermanlab.com)

APPS TO TRY:
- AutoSleep — passive Apple Watch sleep tracking. (https://autosleep.tantsissa.com)
- Whoop — recovery-focused wearable. (https://www.whoop.com)
- Oura — sleep + readiness ring. (https://ouraring.com)
- Levels — continuous glucose monitor + app. (https://www.levels.com)

POSTS:
- Attia's heat-exposure cardiovascular thread. (https://x.com/PeterAttiaMD)
`,
  },
  {
    topicId: "nutrition-food",
    weekOf: WEEK_OF,
    context: `
This week in nutrition (week of May 17, 2026):

WORTH READING:
- NEJM RCT: olive oil ≥4 tbsp/day reduced cardiovascular events by 19% over 5 years across baseline diets. (https://www.nejm.org)
- Examine.com summary of the week: creatine monohydrate's modest cognitive benefit alongside muscle effects. 5g/day. (https://examine.com)
- Layne Norton — protein distribution myth, "30g per meal" not supported by recent meta-analyses. (https://www.biolayne.com)
- TRE meta-analysis: 8-hr window beats 12-hr for visceral fat reduction in pre-diabetic populations. (https://www.cell.com)
- Wirecutter grocery meal-kit test — Sweetgreen at home and Sakara ranked above HelloFresh for nutritional density per dollar. (https://www.nytimes.com/wirecutter)

APPS TO TRY:
- Cronometer — micronutrient-level food tracking. (https://cronometer.com)
- MacroFactor — adaptive nutrition coaching, Norton-affiliated. (https://macrofactorapp.com)
- Levels CGM — see how foods spike your blood sugar. (https://www.levels.com)

LISTEN:
- Layne Norton's podcast, "Physique Science Radio." (https://www.biolayne.com)
`,
  },
  {
    topicId: "web3-updates",
    weekOf: WEEK_OF,
    context: `
This week in web3 (week of May 17, 2026):

NEWS:
- Ethereum's Pectra upgrade went live on mainnet; L2 gas fees dropped ~30% week-over-week. (https://ethereum.org/en/upgrades/)
- Coinbase Institutional's weekly note: spot BTC ETFs at $1.2B net inflow this week, breaking a 3-week outflow streak. (https://www.coinbase.com/institutional)
- a16z crypto published research on "intent-based architectures" — UX layer for onchain transactions feeling like web2. (https://a16zcrypto.com)
- OpenSea announced full deprecation of OpenSea Pro UI by July 1, consolidating onto a single product. (https://opensea.io)

APPS / PROTOCOLS TO TRY:
- Farcaster — decentralized social, crossed 500K DAU this week. (https://www.farcaster.xyz)
- Coinbase Wallet — non-custodial wallet. (https://www.coinbase.com/wallet)
- Rainbow — friendly wallet, good for newcomers. (https://rainbow.me)
- Token Terminal — onchain fundamentals dashboard. (https://tokenterminal.com)
- Dune — onchain analytics. (https://dune.com)

READ:
- Vitalik's essay on decentralized social differentiation. (https://vitalik.eth.limo)
- Bankless weekly. (https://www.bankless.com)

POSTS:
- Vitalik's Farcaster cast on social protocol UX. (https://warpcast.com/v)
- Coinbase Institutional weekly thread on X.
`,
  },
  {
    topicId: "books-worth-your-time",
    weekOf: WEEK_OF,
    context: `
This week in books (week of May 17, 2026):

NEW RELEASES:
- Naval published "The Almanack II" — collected wisdom from the last 5 years. Reportedly better-edited than the first. (https://www.navalmanack.com)
- New Charlie Munger biography, called "the best business biography since Hard Drive" by Tyler Cowen. (https://marginalrevolution.com)

REVIEWS / RECOMMENDATIONS:
- New Yorker review of David Brooks's "How to Know a Person" — "the relationship book operators didn't know they needed." (https://www.newyorker.com)
- Sahil Bloom's "5 Types of Wealth" — week 14 on the NYT bestseller list. (https://www.sahilbloom.com)
- LitHub's underrated 2026 list features Marina Benjamin's "On Sleep" — a quiet meditation becoming a cult favorite. (https://lithub.com)

WHERE TO READ THEM:
- Bookshop.org — supports indie bookstores. (https://bookshop.org)
- Audible / Spotify Audiobooks for audio versions.
- Anna's Archive for harder-to-find titles (https://annas-archive.org).
`,
  },
  {
    topicId: "music",
    weekOf: WEEK_OF,
    context: `
This week in music (week of May 17, 2026):

NEWS:
- Spotify Q1: 685M MAU, 268M paying. AI-generated music share of streams: industry estimates 8-12%. (https://newsroom.spotify.com)
- Universal Music launched a direct-to-superfan platform competing with Bandcamp/Patreon, rumored 90% artist revenue share. (https://www.universalmusic.com)
- Bandlab crossed 100M registered users — world's largest music creation platform. (https://www.bandlab.com)
- Frank Ocean returned to live performing (unannounced LA set) — first in 18 months.
- The 1975 announced Las Vegas Sphere residency — only third act after U2 and Phish. (https://www.thespherevegas.com)
- Hype Machine sold to a group of indie label owners. (https://hypem.com)

APPS TO TRY:
- Bandcamp — direct artist support. (https://bandcamp.com)
- Tidal — high-fidelity streaming, songwriter-friendly payouts. (https://tidal.com)
- BeatStars — beat marketplace. (https://www.beatstars.com)

LISTEN:
- Frank Ocean's Blonded Radio archive (Apple Music). (https://music.apple.com)
- Rick Beato's YouTube. (https://www.youtube.com/@RickBeato)
`,
  },
  {
    topicId: "movies-tv",
    weekOf: WEEK_OF,
    context: `
This week in movies & TV (week of May 17, 2026):

WORTH WATCHING:
- Severance Season 3 premiered on Apple TV+, near-universal praise. (https://tv.apple.com)
- The Studio (Seth Rogen) renewed for season 3 ahead of S2 release. (https://tv.apple.com)
- The Diplomat S3 on Netflix — political turn, becoming required viewing in DC per Politico. (https://www.netflix.com)
- A24's 2026 awards slate: 8 films, four led by first-time directors. (https://a24films.com)
- HBO confirmed TRUE DETECTIVE prequel directed by Issa López, filming this summer. (https://www.hbo.com)

WHERE TO WATCH:
- Apple TV+ — https://tv.apple.com
- Letterboxd for keeping a watchlist. (https://letterboxd.com)
- Mubi — curated indie streaming. (https://mubi.com)

READ:
- Letterboxd Journal reviews. (https://letterboxd.com/journal)
- IndieWire's daily. (https://www.indiewire.com)
`,
  },
  {
    topicId: "style-fashion",
    weekOf: WEEK_OF,
    context: `
This week in style (week of May 17, 2026):

NEWS / TRENDS:
- Highsnobiety: workwear silhouettes (Carhartt, Dickies, MakerHaus) at the high end of menswear. Loro Piana referenced "thoughtful worker" in spring lookbook. (https://www.highsnobiety.com)
- The Row dropped a new fragrance — Esquire called it "the smell of an empty Aesop store." (https://www.therow.com)
- Aimé Leon Dore opened a small Tampa pop-up — first time south of NYC. (https://www.aimeleondore.com)
- BoF Voices: linen returns as the dominant summer menswear fabric. (https://www.businessoffashion.com)

APPS / TOOLS:
- Wirecutter's annual t-shirt test — Buck Mason heavyweight crewneck top pick for 2nd year. (https://www.nytimes.com/wirecutter)
- GQ Style — style guide app. (https://www.gq.com)
- Grailed — secondhand designer marketplace. (https://www.grailed.com)
- Throne — small-business made-in-USA t-shirt subscription. (https://www.thronewear.com)
`,
  },
];

export function getSignal(topicId: string, weekOf?: string): TopicSignal | undefined {
  return MOCK_SIGNALS.find(
    (s) => s.topicId === topicId && (!weekOf || s.weekOf === weekOf)
  );
}
