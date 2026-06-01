import type { Issue } from "@/lib/types";

// A hand-authored showcase issue for the public /sample page and marketing.
// It exists to show a cold visitor the FORMAT and the CALIBER of sources —
// the single biggest trust unlock for a pay-before-you-see-it product.
//
// Rules this file must keep:
//   - REAL URLs only. Every link is a canonical, long-stable homepage / known
//     page (no fabricated article slugs). If you add an item, link the source's
//     main site, not a guessed deep link.
//   - Evergreen framing. A sample is a "greatest hits," not "this week" — keep
//     claims attributable and timeless so it never goes stale or wrong.
//   - No fabricated stats. Describe what a source does and why it's worth your
//     time; don't invent numbers.
//
// The real letters are fresh every Sunday and built around the reader's five
// chosen topics; the /sample page says so explicitly.

export const SAMPLE_ISSUE: Issue = {
  id: "sample",
  volume: 1,
  number: 0,
  weekOf: "A SAMPLE ISSUE",
  recipientFirstName: "there",
  recipientCity: "",
  editorIntro:
    "This is a taste — the shape of a Sunday letter and the kind of sources it pulls from. Your real letters are fresh each week and built around the five topics you pick, so they'll read like they were written for you, because they were. Here are five I'd hand someone curious about what lands in their inbox.",
  sections: [
    {
      topicId: "ai-news",
      topicLabel: "AI — news, releases & tools for work",
      intro:
        "The frontier moves weekly; what's hard is knowing which moves actually change how you work. Three sources that translate the noise into something usable.",
      items: [
        {
          kind: "read",
          headline: "Go straight to the source on model releases",
          body:
            "When a new model ships, the lab's own announcement tells you what genuinely changed before the hot takes pile on. Anthropic's news page is a clean primary source for capability and safety updates — worth a glance whenever you hear a model name you don't recognize.",
          primaryRef: {
            label: "Anthropic — News",
            url: "https://www.anthropic.com/news",
          },
        },
        {
          kind: "try",
          headline: "An AI code editor people actually keep using",
          body:
            "Cursor is the tool that turned 'AI writes code' from a demo into a daily habit for a lot of builders. Even if you don't write software, it's the clearest example of what AI-in-the-loop work feels like when it's done well.",
          primaryRef: {
            label: "Cursor",
            url: "https://www.cursor.com",
          },
        },
        {
          kind: "read",
          headline: "The most reliable plain-language translator of AI research",
          body:
            "Simon Willison writes up what's new in language models in a way a smart non-specialist can follow — no hype, lots of hands-on detail. If you read one AI writer, this is a defensible pick.",
          primaryRef: {
            label: "Simon Willison's Weblog",
            url: "https://simonwillison.net",
          },
        },
      ],
    },
    {
      topicId: "personal-finance",
      topicLabel: "Personal finance, investing & side income",
      intro:
        "The good stuff in money writing isn't tips — it's the handful of ideas that change how you behave. These three earn their slot for that reason.",
      items: [
        {
          kind: "read",
          headline: "Data-driven writing that fixes how you think about saving",
          body:
            "Nick Maggiulli's Of Dollars And Data is unusually good at replacing money-anxiety with evidence — when to buy, why time-in-market beats timing, how wealth actually compounds. Quietly one of the best financial blogs going.",
          primaryRef: {
            label: "Of Dollars And Data",
            url: "https://ofdollarsanddata.com",
          },
        },
        {
          kind: "listen",
          headline: "Money conversations that are really about behavior",
          body:
            "Ramit Sethi's work lands because it treats money as a psychology problem, not a math one — spend extravagantly on what you love, cut costs mercilessly on what you don't. Useful whether you're broke or comfortable.",
          primaryRef: {
            label: "I Will Teach You To Be Rich",
            url: "https://www.iwillteachyoutoberich.com",
          },
        },
        {
          kind: "read",
          headline: "Short essays on money, risk, and human behavior",
          body:
            "The Collaborative Fund blog — Morgan Housel's old home — is a deep archive of short pieces on why people make the financial decisions they do. Evergreen, re-readable, and rarely about a specific stock.",
          primaryRef: {
            label: "Collaborative Fund — Blog",
            url: "https://collabfund.com/blog/",
          },
        },
      ],
    },
    {
      topicId: "longevity-wellness",
      topicLabel: "Longevity & wellness",
      intro:
        "Health content is a minefield of supplements and certainty. The antidote is sources that show their work and admit what isn't known yet.",
      items: [
        {
          kind: "listen",
          headline: "The deepest mainstream show on living longer and better",
          body:
            "Peter Attia goes long and technical on sleep, exercise, metabolic health, and the actual evidence behind longevity claims. It's the show to reach for when you want depth instead of a 60-second 'do this' clip.",
          primaryRef: {
            label: "Peter Attia, MD",
            url: "https://peterattiamd.com",
          },
        },
        {
          kind: "listen",
          headline: "Protocols you can actually act on, with the why attached",
          body:
            "Huberman Lab translates neuroscience into concrete routines — light in the morning, when to caffeinate, how to wind down. Pair it with a skeptic's eye and it's a strong practical input.",
          primaryRef: {
            label: "Huberman Lab",
            url: "https://www.hubermanlab.com",
          },
        },
        {
          kind: "read",
          headline: "Before you buy a supplement, check this",
          body:
            "Examine is an independent, citation-heavy database on what supplements and interventions actually do (and mostly don't). The fastest way to save money and skip the hype.",
          primaryRef: {
            label: "Examine",
            url: "https://examine.com",
          },
        },
      ],
    },
    {
      topicId: "founder-operator",
      topicLabel: "Founder & operator wisdom",
      intro:
        "For anyone building something — a company, a side project, a career. Tactics that travel, from people doing the work.",
      items: [
        {
          kind: "listen",
          headline: "Business ideas and operator stories, weekly",
          body:
            "My First Million is a loose, idea-dense conversation about businesses people are quietly making real money on. Good for the 'wait, that's a business?' spark and the occasional genuinely useful playbook.",
          primaryRef: {
            label: "My First Million",
            url: "https://www.mfmpod.com",
          },
        },
        {
          kind: "read",
          headline: "The clearest strategic thinker on tech and business",
          body:
            "Ben Thompson's Stratechery is the reference for understanding why tech companies do what they do — platforms, aggregation, leverage. Dense, but it changes how you see the whole board.",
          primaryRef: {
            label: "Stratechery",
            url: "https://stratechery.com",
          },
        },
        {
          kind: "read",
          headline: "Product and growth, from someone who ran it",
          body:
            "Lenny Rachitsky's newsletter is the operator's handbook for product, growth, and go-to-market — concrete frameworks pressure-tested by practitioners, not theory.",
          primaryRef: {
            label: "Lenny's Newsletter",
            url: "https://www.lennysnewsletter.com",
          },
        },
      ],
    },
    {
      topicId: "books-worth-your-time",
      topicLabel: "Books worth your time",
      intro:
        "Not a bestseller list — a couple of curators worth trusting, so the next thing you read is worth the hours.",
      items: [
        {
          kind: "read",
          headline: "An economist's relentless reading list",
          body:
            "Tyler Cowen reads more than anyone and shares what's worth it on Marginal Revolution. His book recommendations skew curious and wide-ranging — history, fiction, the genuinely obscure.",
          primaryRef: {
            label: "Marginal Revolution",
            url: "https://marginalrevolution.com",
          },
        },
        {
          kind: "read",
          headline: "Beautiful writing on books and big ideas",
          body:
            "Maria Popova's The Marginalian is a long-running archive of thoughtful essays on books, art, and how to live. The kind of reading that makes you want to read more.",
          primaryRef: {
            label: "The Marginalian",
            url: "https://www.themarginalian.org",
          },
        },
        {
          kind: "note",
          headline: "A shortcut to other people's best books",
          body:
            "Derek Sivers keeps public notes on every book he reads, with a one-line 'is it worth your time' verdict up top. A great way to triage before you commit.",
          primaryRef: {
            label: "Derek Sivers — Book Notes",
            url: "https://sive.rs/book",
          },
        },
      ],
    },
  ],
};
