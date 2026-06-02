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
This week in AI — news, releases & tools for work (week of May 17, 2026):

NEWS / RELEASES:
- Anthropic released a new Claude model variant with extended context. (https://www.anthropic.com/news)
- OpenAI shipped GPT-5.5 with a new background "agentic mode." (https://openai.com/blog)
- Mistral announced an EU-sovereign cloud offering with European data residency by default. (https://mistral.ai/news)
- Cursor (the IDE) crossed $300M ARR per The Information. (https://www.cursor.com)
- HuggingFace launched a new evaluation harness focused on tool-use quality. (https://huggingface.co/blog)
- a16z's "Big Ideas in Tech 2026" — half the list is AI-for-work. (https://a16z.com)

APPS TO TRY (frontier + for-work):
- Claude (Anthropic) — https://claude.ai
- Cursor — AI-first IDE, crossed $300M ARR. (https://www.cursor.com)
- Granola — AI meeting notes that show up next to your transcript. (https://www.granola.ai)
- v0 by Vercel — generate React UIs from prompts. (https://v0.dev)
- Perplexity — AI search with citations. (https://www.perplexity.ai)
- Notion AI — embedded inside docs, finally good. (https://www.notion.so)

READ:
- Latent Space newsletter for AI engineering. (https://www.latent.space)
- TLDR AI daily digest. (https://tldr.tech/ai)
- Simon Willison's blog — pragmatic AI commentary. (https://simonwillison.net)
- Ethan Mollick's One Useful Thing on agent workflows. (https://www.oneusefulthing.org)
- Anthropic's Claude best-practices guide for engineering. (https://www.anthropic.com/news)

LISTEN:
- Latent Space podcast on tool-use evaluation. (https://www.latent.space)
- AI Daily Brief — short morning digest. (https://www.nlw.media)

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
  {
    topicId: "sports-betting",
    weekOf: WEEK_OF,
    context: `
This week in sports & betting markets (week of May 17, 2026):

EDGES / SHARP ACTION:
- Unabated.com weekly sharp report: NBA totals showing systematic under-bias at books that haven't adjusted to slower pace post-rules change. (https://unabated.com)
- Action Network's PRO line-shop tool now covers 12 books with real-time CLV tracking. (https://www.actionnetwork.com)
- Closing line value still the only public-bettor stat that correlates with long-run ROI per Wharton Sports Analytics. (https://wsb.wharton.upenn.edu)
- Pinnacle (Bovada cash-out alternative) re-listed for serious bettors — sharpest book on the market by closing odds. (https://www.pinnacle.com)

NEWS / GAMES:
- NBA Conference Finals matchups set; Vegas opened Boston -3.5 vs Indiana, dropped to -2 on heavy public Indiana money. (https://www.espn.com)
- NFL Schedule release Thursday; Vegas posted O/U season win totals — Chiefs 11.5 highest, Patriots 5.5 lowest. (https://www.nfl.com)
- MLB midseason: Dodgers +180 World Series favorites, Yankees +500, sharps reportedly hammering Tigers +2500. (https://www.mlb.com)
- New jurisdictions: Missouri and Minnesota mobile sports betting bills cleared committee this week. (https://www.legalsportsreport.com)

APPS / TOOLS TO TRY:
- Unabated — line shopping + alert system for value plays. (https://unabated.com)
- OddsJam — odds screen + arb finder. (https://oddsjam.com)
- Action Network PRO — sharp-money signals + CLV tracker. (https://www.actionnetwork.com)
- BetStamp — bet tracking with auto-grading. (https://betstamp.app)
- DraftKings + FanDuel for promos; Pinnacle + Circa Sports for serious wagering.

READ / LISTEN:
- Ed Miller's "Logic of Sports Betting" — still the canonical primer. (https://www.amazon.com)
- The Action Network podcast on injuries that move lines. (https://www.actionnetwork.com)
- Wharton Sports Analytics journal on CLV as the only metric that matters. (https://wsb.wharton.upenn.edu)
- The Ringer NBA Show + Bill Simmons Podcast for narrative + numbers. (https://www.theringer.com)

POSTS:
- Spanky's threads on sharp behavior. (https://x.com/Spanky)
- Captain Jack Andrews on bet sizing. (https://x.com/capjack2018)
- Rufus Peabody on model-vs-market gaps. (https://x.com/rufuspeabody)
`,
  },
  {
    topicId: "marketing-growth",
    weekOf: WEEK_OF,
    context: `
This week in marketing & growth (week of May 17, 2026):

WORTH READING:
- Lenny's Newsletter weekly: "PMF metrics — what to actually measure." (https://www.lennysnewsletter.com)
- Marketing Brew on Liquid Death's $1B valuation and the "absurd packaging > absurd product" thesis. (https://www.marketingbrew.com)
- Reforge guide on cold-start growth loops. (https://www.reforge.com)

WORTH LISTENING:
- The Marketing Millennials with Mark Ritson on positioning vs. messaging. (https://themarketingmillennials.com)
- Modern Wisdom interview with Rory Sutherland on alchemy of nonsense marketing. (https://chriswillx.com)

APPS TO TRY:
- Beehiiv — newsletter platform challenging Substack. (https://www.beehiiv.com)
- Mutiny — landing page personalization. (https://www.mutinyhq.com)
- Posthog — open-source product analytics. (https://posthog.com)
- Linear's marketing site is the most-imitated landing page of 2026. (https://linear.app)

POSTS:
- April Dunford's positioning thread. (https://x.com/aprildunford)
- Andrew Chen on cold-start. (https://x.com/andrewchen)
`,
  },
  {
    topicId: "personal-finance",
    weekOf: WEEK_OF,
    context: `
This week in personal finance, investing & side income (week of May 17, 2026):

WORTH READING:
- The Money Guy Show's 2026 Financial Order of Operations update. (https://moneyguy.com)
- Ramit Sethi on negotiating salary in a flat market. (https://www.iwillteachyoutoberich.com)
- Nick Maggiulli's Of Dollars and Data weekly on rebalancing in choppy markets. (https://ofdollarsanddata.com)
- NerdWallet 2026 best high-yield savings accounts ranking. (https://www.nerdwallet.com)
- Justin Welsh's weekly LinkedIn OS edition on building a one-person operation. (https://www.justinwelsh.me)
- Codie Sanchez on buying small businesses as side income. (https://contrarianthinking.co)
- Pieter Levels (Nomad List founder) tweet thread on indie hacker stack 2026. (https://x.com/levelsio)

APPS TO TRY (manage money + earn on the side):
- Monarch Money — replaces Mint, fast-growing budgeting app. (https://www.monarchmoney.com)
- Copilot — best-designed budgeting app for iOS. (https://www.copilot.money)
- Empower (formerly Personal Capital) — net worth tracker. (https://www.empower.com)
- Wealthfront — robo-advisor with cash management. (https://www.wealthfront.com)
- Gumroad — sell digital products in 5 minutes. (https://gumroad.com)
- Stan Store — bio-link plus mini storefront. (https://www.stan.store)
- Beehiiv — newsletter monetization. (https://www.beehiiv.com)
- Whop — sell digital subscriptions. (https://whop.com)
- Cal.com — paid consultations. (https://cal.com)

LISTEN:
- The Money Guy Show. (https://moneyguy.com)
- ChooseFI on financial independence. (https://www.choosefi.com)
- My First Million on $1-3M solo businesses being systematically undervalued. (https://www.mfmpod.com)
- The Solopreneur Hour with Michael O'Neal. (https://solohour.com)

POSTS:
- Ramit's negotiation thread. (https://x.com/ramit)
- Pieter Levels income transparency tweet. (https://x.com/levelsio)
- Justin Welsh's solo-business teardown. (https://x.com/thejustinwelsh)
`,
  },
  {
    topicId: "real-estate",
    weekOf: WEEK_OF,
    context: `
This week in real estate (week of May 17, 2026):

NEWS:
- 30-year mortgage rates settled at 6.4% this week — first sub-6.5% close of 2026. (https://www.bankrate.com)
- Redfin Q2 report: median home prices flat YoY nationally; Sun Belt cities cooling. (https://www.redfin.com)
- Florida insurance crisis update — Citizens Property Insurance raising rates 12%. (https://www.tampabay.com)

WORTH LISTENING:
- BiggerPockets podcast on small multifamily in 2026. (https://www.biggerpockets.com)
- Real Estate Rookie — first-deal stories. (https://www.biggerpockets.com)
- The Money Guy on house-hacking math. (https://moneyguy.com)

APPS TO TRY:
- Stessa — free rental property accounting. (https://www.stessa.com)
- Redfin — best-designed home search. (https://www.redfin.com)
- DealCheck — quickly underwrite rentals. (https://dealcheck.io)
- RentMeter — rent comps. (https://www.rentmeter.com)

POSTS:
- Lance Lambert's housing data threads. (https://x.com/NewsLambert)
`,
  },
  {
    topicId: "macro-markets",
    weekOf: WEEK_OF,
    context: `
This week in macro & markets (week of May 17, 2026):

NEWS:
- Fed minutes show committee split on June cut — most members favor holding. (https://www.federalreserve.gov)
- April CPI print 2.6% YoY, third consecutive cooling month. (https://www.bls.gov)
- 10-year Treasury yield closed at 4.18%, 8bp lower week-over-week. (https://www.treasury.gov)

WORTH READING:
- Apricitas Economics weekly on labor-market crosscurrents. (https://www.apricitas.io)
- Joey Politano on cooling inflation prints. (https://www.apricitas.io)
- Calculated Risk on housing leading indicators. (https://www.calculatedriskblog.com)
- Sam Ro's TKer weekly. (https://www.tker.co)

WORTH LISTENING:
- Macro Voices weekly. (https://www.macrovoices.com)
- Odd Lots with Joe Weisenthal + Tracy Alloway. (https://www.bloomberg.com/oddlots)

POSTS:
- Claudia Sahm on the Sahm Rule. (https://x.com/Claudia_Sahm)
- Mike Cembalest's Eye on the Market notes. (https://www.jpmorgan.com)
`,
  },
  {
    topicId: "mental-health",
    weekOf: WEEK_OF,
    context: `
This week in mental health (week of May 17, 2026):

WORTH READING:
- New JAMA Psychiatry paper on SSRIs vs. talk therapy long-term outcomes. (https://jamanetwork.com)
- Atlantic profile of Bessel van der Kolk on trauma research evolution. (https://www.theatlantic.com)
- NYT Well section on the "languishing" phenomenon updated for 2026. (https://www.nytimes.com/well)

APPS TO TRY:
- BetterHelp — online therapy. (https://www.betterhelp.com)
- Headspace — guided meditation. (https://www.headspace.com)
- How We Feel — emotion-tracking app from Dr. Marc Brackett. (https://howwefeel.org)
- Finch — gamified self-care companion. (https://finchcare.com)
- Insight Timer — free meditation library. (https://insighttimer.com)

LISTEN:
- The Happiness Lab with Dr. Laurie Santos. (https://www.happinesslab.fm)
- Hidden Brain. (https://hiddenbrain.org)
- 10 Percent Happier with Dan Harris. (https://www.tenpercent.com)

POSTS:
- Adam Grant on the case for "languishing." (https://x.com/AdamMGrant)
`,
  },
  {
    topicId: "womens-health",
    weekOf: WEEK_OF,
    context: `
This week in women's health (week of May 17, 2026):

WORTH READING:
- Dr. Stacy Sims's substack on training around the menstrual cycle. (https://www.drstacysims.com)
- Dr. Mary Claire Haver on perimenopause hormone protocols. (https://thepauselife.com)
- Modern Fertility blog on AMH testing. (https://modernfertility.com)
- New NEJM paper on HRT cardiovascular risk reanalysis. (https://www.nejm.org)

APPS TO TRY:
- Oura ring — cycle + temperature tracking. (https://ouraring.com)
- Natural Cycles — FDA-cleared cycle tracking. (https://www.naturalcycles.com)
- Maven Clinic — virtual women's-health platform. (https://www.mavenclinic.com)
- Tia — women's primary care + therapy. (https://www.asktia.com)
- Flo — cycle and pregnancy tracking, 200M users. (https://flo.health)

LISTEN:
- Dr. Mary Claire Haver on Diary of a CEO. (https://www.youtube.com/@TheDiaryOfACEO)
- The Period Whisperer podcast. (https://nicolejardim.com)

POSTS:
- Dr. Stacy Sims's threads on perimenopause training. (https://x.com/drstacysims)
`,
  },
  {
    topicId: "psychology-behavior",
    weekOf: WEEK_OF,
    context: `
This week in psychology & behavior (week of May 17, 2026):

WORTH READING:
- Adam Grant on the "ideal self" trap in goal-setting. (https://adamgrant.net)
- Behavioral Scientist on default-effect updates in retirement plans. (https://behavioralscientist.org)
- Brain Pickings (now The Marginalian) on solitude as a cognitive resource. (https://www.themarginalian.org)
- Psyche essay on emotional granularity. (https://psyche.co)

WORTH LISTENING:
- Hidden Brain on confirmation bias. (https://hiddenbrain.org)
- The Happiness Lab on positive psychology myths. (https://www.happinesslab.fm)
- Choiceology with Katy Milkman. (https://www.schwab.com/podcast)

APPS TO TRY:
- Reflectly — guided journaling. (https://reflectly.app)
- Daylio — mood + habit tracker. (https://daylio.net)

POSTS:
- Adam Grant's thread on the "ideal self" trap. (https://x.com/AdamMGrant)
- Katy Milkman on fresh-start effect. (https://x.com/katy_milkman)
`,
  },
  {
    topicId: "parenting",
    weekOf: WEEK_OF,
    context: `
This week in parenting (week of May 17, 2026):

WORTH READING:
- Emily Oster's ParentData weekly on screen time research. (https://www.parentdata.org)
- Big Little Feelings on tantrum coaching scripts. (https://www.biglittlefeelings.com)
- NYT Parenting on managing chore expectations by age. (https://www.nytimes.com)
- Jessica Lahey on the "Gift of Failure" being more relevant than ever. (https://www.jessicalahey.com)

WORTH LISTENING:
- Dr. Becky's Good Inside podcast on sibling rivalry. (https://www.goodinside.com)
- Janet Lansbury — Unruffled podcast. (https://www.janetlansbury.com)
- We Can Do Hard Things with Glennon Doyle on co-parenting. (https://wecandohardthingspodcast.com)

APPS TO TRY:
- Cozi — family calendar. (https://www.cozi.com)
- Tinybeans — private photo journal for grandparents. (https://tinybeans.com)
- BabyCenter — milestone tracker. (https://www.babycenter.com)
- Khan Academy Kids — free, no ads. (https://learn.khanacademy.org/khan-academy-kids/)

POSTS:
- Dr. Becky on naming feelings before solving them. (https://x.com/drbeckyatgoodinside)
- Emily Oster threads on parenting data. (https://x.com/profemilyoster)
`,
  },
  {
    topicId: "startups-vc",
    weekOf: WEEK_OF,
    context: `
This week in startups & VC (week of May 17, 2026):

NEWS:
- a16z launches new $7B fund focused on AI applications layer. (https://a16z.com)
- Stripe valuation rumored at $95B in tender offer. (https://www.theinformation.com)
- Y Combinator W26 batch is 38% AI-focused. (https://www.ycombinator.com/blog)

WORTH READING:
- The Information's weekly. (https://www.theinformation.com)
- Stratechery by Ben Thompson on hyperscaler vs. application startup margins. (https://stratechery.com)
- Lenny's Newsletter on PMF in AI-first products. (https://www.lennysnewsletter.com)

WORTH LISTENING:
- 20VC with Harry Stebbings. (https://www.thetwentyminutevc.com)
- Invest Like the Best with Patrick O'Shaughnessy. (https://joincolossus.com)
- The All-In podcast. (https://www.allinpodcast.co)

APPS TO TRY:
- Affinity — relationship intelligence for investors. (https://www.affinity.co)
- Carta — cap table + equity management. (https://carta.com)
- Mercury — bank built for startups. (https://mercury.com)
- Vanta — SOC 2 automation. (https://www.vanta.com)

POSTS:
- Marc Andreessen on application-layer disruption. (https://x.com/pmarca)
- Garry Tan's weekly YC notes. (https://x.com/garrytan)
`,
  },
  {
    topicId: "faith-meaning",
    weekOf: WEEK_OF,
    context: `
This week in faith & meaning (week of May 17, 2026):

WORTH READING:
- Christianity Today weekly on biblical literacy decline. (https://www.christianitytoday.com)
- The Gospel Coalition on practical theology. (https://www.thegospelcoalition.org)
- Richard Rohr's Daily Meditation on contemplative practice. (https://cac.org)
- Plough Quarterly long-form essays. (https://www.plough.com)
- Comment Magazine on faith and public life. (https://comment.org)

WORTH LISTENING:
- The Bible Project podcast — Old Testament thematic series. (https://bibleproject.com)
- Tim Keller's archived sermons (Redeemer Presbyterian). (https://gospelinlife.com)
- On Being with Krista Tippett — meaning, faith, ethics. (https://onbeing.org)
- Holy Post podcast. (https://www.holypost.com)

WORTH READING (books):
- N.T. Wright's "Surprised by Hope." (https://bookshop.org)
- Marilynne Robinson's "Gilead." (https://bookshop.org)
- "Practicing the Way" by John Mark Comer. (https://practicingtheway.org)

POSTS:
- Tim Keller's archived threads. (https://x.com/timkellernyc)
- The Bible Project visual essays. (https://bibleproject.com)
`,
  },
  {
    topicId: "web3-updates",
    weekOf: WEEK_OF,
    context: `
This week in Web3 (week of May 17, 2026). URLs below are real — cite them, never invent:

PROTOCOL / NEWS:
- Ethereum Foundation blog — protocol roadmap, upgrade notes, research posts. (https://blog.ethereum.org)
- ethereum.org — canonical docs on the network, staking, and L2s. (https://ethereum.org)
- Vitalik Buterin's site — long-form essays on privacy, scaling, and governance. (https://vitalik.eth.limo)
- L2BEAT — the reference dashboard for Layer-2 TVL, risk, and stage classifications. (https://l2beat.com)
- a16z crypto — research and policy writing from the largest crypto fund. (https://a16zcrypto.com)
- Paradigm — technical research (MEV, AMMs, rollups) from the research-led fund. (https://www.paradigm.xyz)

DATA / TOOLS TO TRY:
- DeFiLlama — TVL across chains and protocols, no login. (https://defillama.com)
- Dune — community SQL dashboards on on-chain data. (https://dune.com)
- Etherscan — the canonical Ethereum block explorer. (https://etherscan.io)
- Messari — research, screeners, and asset profiles. (https://messari.io)
- Electric Capital — the annual Developer Report on who's actually building. (https://www.electriccapital.com)

DECENTRALIZED SOCIAL:
- Farcaster — the sufficiently-decentralized social protocol. (https://www.farcaster.xyz)
- Warpcast — the flagship Farcaster client. (https://warpcast.com)

READ / LISTEN:
- Bankless — newsletter + podcast on the open-finance thesis. (https://www.bankless.com)
- The Defiant — DeFi news and analysis. (https://thedefiant.io)
- Decrypt — accessible daily web3 + crypto news. (https://decrypt.co)
- Coinbase blog — institutional flows, product, and policy. (https://www.coinbase.com/blog)

POSTS:
- Vitalik on Warpcast — roadmap and research threads. (https://warpcast.com/vitalik.eth)
`,
  },
];

export function getSignal(topicId: string, weekOf?: string): TopicSignal | undefined {
  return MOCK_SIGNALS.find(
    (s) => s.topicId === topicId && (!weekOf || s.weekOf === weekOf)
  );
}
