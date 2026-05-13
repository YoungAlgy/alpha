import type { Issue } from "./types";

// Hardcoded sample issue so the digest renders without an API key during dev.
// Modeled on Ally's Weekly Drop format — masthead + From the Editor + numbered sections
// with PLAY/WATCH/APPLY tags.

export const SAMPLE_ISSUE: Issue = {
  id: "sample-001",
  volume: 1,
  number: 1,
  weekOf: "Sunday, May 17, 2026",
  recipientFirstName: "Ally",
  recipientCity: "St. Petersburg, FL",
  editorIntro:
    "First drop of the new format. Three topics this week — healthcare recruiting, sales psychology, and the Florida garden in May. The HCA Gainesville opening is past its 12-day mark and the credentialing wave is starting to surface in job boards. Sales-wise, the Sanchez 1/9/90 frame keeps showing up in the wild and it's worth a second read. Garden: pollinators are at peak and the rain pattern this week tells you exactly when to plant. Plays inside.",
  sections: [
    {
      topicId: "healthcare-recruiting",
      topicLabel: "Healthcare Recruiting",
      intro:
        "Two weeks into the HCA Gainesville opening, the credentialing wave is moving from the hospital itself to the orbital practices. Meanwhile, the OB rule that took effect January 1 is showing up as L&D supervisor openings across Florida — a fresh category nobody was sourcing for ninety days ago.",
      items: [
        {
          kind: "play",
          headline: "HCA Gainesville — orbital practices are now hiring",
          body:
            "The hospital opened May 5; by week 2 the medical office buildings on the same campus are filing for staff. Three FL-licensed PA postings appeared on the 41st Boulevard cluster this week. The pattern repeats every HCA opening — the orbital hires lag the main facility by 14-30 days.",
          source: "FierceHealthcare · Tampa Bay Business Journal",
        },
        {
          kind: "watch",
          headline: "OB supervisor rule — quiet demand surge",
          body:
            "CMS's new Conditions of Participation (effective Jan 1) requires labor and delivery supervised by a qualified RN, CNM, NP, PA, or physician. Florida hospitals are now filing for L&D supervisor postings at a rate ~3× the same week last year. Nobody is sourcing this category yet.",
          source: "CMS rule 42 CFR 482.60",
        },
        {
          kind: "apply",
          headline: "Silver-medalist re-engagement is your highest ROI move",
          body:
            "Gem and Hireology both ship 'rediscovery' workflows that surface candidates who applied for a prior role and ghosted. For a two-person agency, automating one re-touch on every cold-rejected candidate from the last 6 months returns more than any new sourcing tool you could buy this quarter.",
          source: "Affolter advisory",
        },
      ],
    },
    {
      topicId: "sales-persuasion",
      topicLabel: "Sales & Persuasion",
      intro:
        "Two compounding ideas this week: Sanchez's 1/9/90 pricing pyramid keeps surfacing in operator threads, and Blount's 'pipeline anemia' phrase is becoming the canonical diagnosis. The pattern underneath both: the new wedge in 2026 sales is naming the buyer's segment for them.",
      items: [
        {
          kind: "play",
          headline: "Codie Sanchez — the 1% / 9% / 90% pricing pyramid",
          body:
            "The top 1% of buyers shop on pedigree, the next 9% shop on passion, the bottom 90% shop on price. The sweet spot for a new operator isn't the 1% (you can't beat them on resume) and isn't the 90% (race to the bottom). It's the 9% — buyers who pay premium for a compelling story.",
          source: "Diary of a CEO · May 2026 roundtable",
        },
        {
          kind: "watch",
          headline: "Jeb Blount — 'pipeline anemia' as the canonical diagnosis",
          body:
            "Blount's Fanatical Prospecting framework is having a renaissance — three different operator podcasts cited 'pipeline anemia' this month. The phrase is becoming the standard diagnosis for underperforming sales orgs. Worth using on your own pipeline this Sunday.",
          source: "Fanatical Prospecting (2015) · Sales Gravy",
        },
        {
          kind: "apply",
          headline: "Name your buyer's segment before they do",
          body:
            "If you walk into a discovery call having already labeled the prospect ('you're a Type-B insurance-payer-mix system'), they spend the rest of the call validating or correcting your label. Either way, you control the framing. This is the move underneath the 1/9/90 frame.",
        },
      ],
    },
    {
      topicId: "fl-gardening",
      topicLabel: "Florida Gardening",
      intro:
        "Peak pollinator week in west-central Florida. The rain pattern this week — daily afternoon storms after Wednesday — sets up the best planting window for native milkweed (asclepias) since March. UF/IFAS dropped two updates worth your time.",
      items: [
        {
          kind: "play",
          headline: "Plant asclepias before Friday",
          body:
            "The Tuesday-Wednesday dry window followed by sustained Thursday-Sunday rain creates ideal transplant conditions for native milkweed. Asclepias tuberosa (butterflyweed) and A. incarnata (swamp milkweed) both transplant best when the rain is locked in for 72 hours after planting. Monarchs are mid-season; plants set this week feed October migration.",
          source: "UF/IFAS Extension Pinellas · NOAA Tampa Bay 7-day",
        },
        {
          kind: "watch",
          headline: "FL-Friendly Landscaping cost-share program — May intake",
          body:
            "Pinellas County's FFL cost-share for converting turf to native pollinator garden has a quiet May intake window most homeowners miss. Reimburses up to $500 per converted area. Application is one page.",
          source: "Pinellas County Extension",
        },
        {
          kind: "apply",
          headline: "The 30-day mulch test for any new bed",
          body:
            "Pine straw vs. eucalyptus mulch is a real argument in Florida gardens. Test in your own yard: split a single bed in half with the two mulches, mark the date, photograph weekly. Thirty days tells you which one your soil actually likes — independent of what every gardening forum claims.",
        },
      ],
    },
  ],
};
