// Source authority tiering. Deep-reading a source is only worth it when the
// source is trustworthy — reading a content farm or an AI-slop SEO page just
// gives the model convincing material to confidently write up something wrong.
// So we tier every host: TRUSTED (reputable journalism + primary sources +
// the named operators the topic queries anchor on), DENIED (known junk we never
// read or cite), and NEUTRAL (everything else — citable, and deep-read only
// after trusted sources are exhausted). This is what makes "best sources" real.

// Reputable outlets, primary sources, and recognized operators across the topic
// catalog. Bare registrable domains; subdomains match via endsWith. Not
// exhaustive by design — it just needs to float the good stuff to the top.
const TRUSTED_DOMAINS: string[] = [
  // General journalism / news
  "nytimes.com", "wsj.com", "washingtonpost.com", "theatlantic.com", "newyorker.com",
  "economist.com", "ft.com", "bloomberg.com", "reuters.com", "apnews.com", "npr.org",
  "bbc.com", "bbc.co.uk", "theguardian.com", "axios.com", "politico.com", "vox.com",
  "propublica.org", "semafor.com", "time.com", "fortune.com",
  // Tech / AI journalism + primary
  "wired.com", "theverge.com", "arstechnica.com", "techcrunch.com", "businessinsider.com",
  "technologyreview.com", "theinformation.com", "404media.co", "restofworld.org",
  "anthropic.com", "openai.com", "deepmind.google", "ai.meta.com", "mistral.ai",
  "huggingface.co", "arxiv.org", "github.com", "simonwillison.net", "latent.space",
  "stratechery.com", "every.to", "platformer.news", "oneusefulthing.org", "interconnects.ai",
  // Business / startups / markets
  "cnbc.com", "marketwatch.com", "morningstar.com", "barrons.com", "hbr.org",
  "lennysnewsletter.com", "apricitas.io", "ofdollarsanddata.com", "ritholtz.com",
  "federalreserve.gov", "bls.gov", "sec.gov",
  // Health / science / longevity / nutrition
  "nejm.org", "jamanetwork.com", "thelancet.com", "nature.com", "science.org",
  "statnews.com", "kff.org", "cdc.gov", "nih.gov", "examine.com",
  "peterattiamd.com", "hubermanlab.com",
  // Healthcare industry (recruiting topic)
  "beckershospitalreview.com", "modernhealthcare.com", "fiercehealthcare.com",
  "medpagetoday.com", "healthcaredive.com", "aamc.org",
  // Real estate / housing
  "biggerpockets.com", "redfin.com", "zillow.com",
  // Sports / betting (data + sharp coverage, not tout sites)
  "unabated.com", "actionnetwork.com", "espn.com", "theathletic.com",
  // Crypto / web3 (primary + reputable)
  "ethereum.org", "vitalik.eth.limo", "coindesk.com", "theblock.co", "bankless.com",
  "a16zcrypto.com", "paradigm.xyz",
  // Culture / film / music / books
  "pitchfork.com", "stereogum.com", "letterboxd.com", "theringer.com", "indiewire.com",
  "residentadvisor.net", "billboard.com",
  // Gardening / sustainability primary
  "ifas.ufl.edu", "xerces.org", "grist.org",
];

// Known low-quality patterns we never deep-read or cite. Kept deliberately
// SMALL and conservative (a wrong deny silently removes a real source) — the
// trusted-first ranking does most of the quality work; this just hard-blocks
// the obvious offenders. Substring match against the host.
const DENIED_SUBSTRINGS: string[] = [
  "vettedconsumer", "outlookindia.com", "analyticsinsight", "techbullion",
  "marketresearchfuture", "openpr.com", "einnews.com", "globenewswire.com",
  "prnewswire.com", "benzinga.com/pressreleases", "medium.com/@",
];

// Listicle / SEO-bait URL shapes (e.g. "best-ai-tools-2026"). Deliberately
// NARROW — only the clearest "best/top/cheapest … YEAR" listicle tells — and
// only ever applied to NEUTRAL hosts (trusted outlets are exempt in hostTier),
// so it can never false-deny a real review / matchup / guide on a reputable
// site. The keyword must start a path segment and sit close to the year.
const SEO_PATH_RE = /(?:^|[-/])(best|top|cheapest)[-/][^/]*-?20\d\d(?:[/?#]|$)/i;

export type SourceTier = "trusted" | "neutral" | "denied";

function registrable(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function hostTier(host: string, url?: string): SourceTier {
  const h = registrable(host);
  if (!h) return "denied";
  // Curated trusted host wins OUTRIGHT, checked first — a reputable outlet's
  // article is never SEO bait even if its slug says "review", "vs", or "best".
  // This guarantees a path-level deny can't exclude a primary source.
  if (TRUSTED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))) return "trusted";
  // Junk hosts + obvious listicle shapes apply to NEUTRAL hosts only.
  if (DENIED_SUBSTRINGS.some((d) => h.includes(d) || (url ?? "").toLowerCase().includes(d))) {
    return "denied";
  }
  if (url && SEO_PATH_RE.test(url)) return "denied";
  return "neutral";
}

// Lower = better. Trusted floats up, denied is excluded by callers.
export function tierRank(tier: SourceTier): number {
  return tier === "trusted" ? 0 : tier === "neutral" ? 1 : 2;
}
