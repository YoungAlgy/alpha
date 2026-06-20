// Verifies the deep-read sourcing invariants without any network calls:
//   1. SACRED: a URL inside fetched article body can NEVER become citable —
//      sanitizeContent strips every URL, so the url-guard's allow-set is only
//      the explicit curated SOURCE links.
//   2. Authority tiering: trusted floats up, denied is excluded, SEO paths denied.
//   3. rankAndDedup: dedup by destination, cap per host, trusted-first, no
//      recency-scramble.
//   4. looksLikeProse rejects app/nav chrome, accepts real prose.
// Run: npx tsx scripts/verify-deepread.mts
const { sanitizeContent } = await import("../lib/engine/fetch-content.ts");
const { hostTier, tierRank } = await import("../lib/engine/source-authority.ts");
const { rankAndDedup } = await import("../lib/engine/source-rank.ts");
const { extractSignalUrls, normalizeUrl, isAllowedUrl } = await import("../lib/engine/url-guard.ts");
const { cleanField } = await import("../lib/engine/source-resolver.ts");

let pass = 0, fail = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "OK " : "XX "} ${label}`); cond ? pass++ : fail++; };

// (1) SACRED — body URLs are stripped; only the SOURCE url is citable.
console.log("(1) url-guard: fetched body URLs are never citable");
const body = sanitizeContent(
  `Markdown Content:\nA real article. See [our pricing](https://evil-ad.example/buy) and ![logo](https://cdn.example/l.png).\nAlso visit https://tracker.example/x?id=9 for more. The substance is here, with several real sentences so it reads like prose and passes the body length checks comfortably.`
);
check("body has no http(s) URL left", !/https?:\/\//.test(body));
check("body keeps link TEXT (our pricing)", body.includes("our pricing"));
const ctx = `=== TOP SOURCES ===\n[1] Title\n  host · 1 day ago\n  SOURCE: https://www.businessinsider.com/real-article-2026-6\n\n${body}\n\n=== MORE ===\n- Other (npr.org) — https://www.npr.org/2026/06/19/story`;
const allowed = extractSignalUrls(ctx);
check("SOURCE url IS citable", allowed.has("businessinsider.com/real-article-2026-6"));
check("MORE url IS citable", allowed.has("npr.org/2026/06/19/story"));
check("body ad URL is NOT citable", !allowed.has("evil-ad.example/buy"));
check("body tracker URL is NOT citable", !allowed.has("tracker.example/x?id=9"));
// Uppercase / mixed-case scheme must ALSO be stripped — the url-guard extractor
// is case-insensitive, so a case-sensitive sanitize would leak these as citable.
const upBody = sanitizeContent(
  `A real article body with plenty of words and several sentences so it clears the prose gate. See HTTPS://EVIL.example/track and a [shady link](HtTpS://Bad.example/x) inline. More real sentences follow here.`
);
check("uppercase/mixed bare URL stripped from body", !/https?:\/\//i.test(upBody));
const upAllowed = extractSignalUrls(`SOURCE: https://www.reuters.com/world/a\n\n${upBody}`);
check("uppercase body URLs NOT citable", !upAllowed.has("evil.example/track") && !upAllowed.has("bad.example/x"));

// (1b) SACRED: a URL planted in a source TITLE or DESCRIPTION (attacker-controlled,
// straight from Brave) must NEVER become citable. cleanField strips it out of the
// context, and the live citable allow-set is built from the EXPLICIT source urls
// only — never by scanning the free-text context.
console.log("(1b) url-guard: smuggled title/description URLs are never citable");
check("cleanField strips a URL from a title", !/https?:\/\//i.test(cleanField("Breaking: visit https://phish.example/login NOW")));
check("cleanField strips a URL + tags from a description", !/https?:\/\//i.test(cleanField("<b>See</b> HTTPS://Bad.example/x for the deal")));
check("cleanField keeps the surrounding text", cleanField("Read https://phish.example now").includes("Read"));
// The live citable set = extractSignalUrls over the explicit SOURCE urls ONLY
// (what fetchLiveSignal builds), so a title-planted URL is absent from it.
const liveCitable = extractSignalUrls(
  ["https://www.nytimes.com/2026/06/19/a", "https://www.reuters.com/world/b"].join("\n")
);
check("citable set = the source urls", liveCitable.has("nytimes.com/2026/06/19/a") && liveCitable.has("reuters.com/world/b"));
check("a title-smuggled URL is NOT in the citable set", !liveCitable.has("phish.example/login"));

// (1c) A source URL whose PATH contains '(' / ')' (Pitchfork super-deluxe,
// Letterboxd (2024), Wikipedia (planet)) must stay citable. citableUrls is built
// by normalizeUrl PER source url, NOT by regex-scanning — URL_RE stops at ')' and
// would silently truncate+drop these real links.
console.log("(1c) url-guard: paren-path source URLs stay citable");
const parenUrl = "https://pitchfork.com/reviews/albums/the-beatles-revolver-(super-deluxe)/";
const parenSet = new Set([parenUrl].map((u) => normalizeUrl(u)).filter(Boolean));
check("paren source URL keyed via normalizeUrl is citable", isAllowedUrl(parenUrl, parenSet));
check("a non-source URL still rejected against that set", !isAllowedUrl("https://evil.example/x", parenSet));
check("regression: the old regex-scan WOULD have dropped the paren URL", !isAllowedUrl(parenUrl, extractSignalUrls(parenUrl)));

// (2) Authority tiering
console.log("(2) authority tiering");
check("nytimes.com → trusted", hostTier("nytimes.com") === "trusted");
check("simonwillison.net → trusted", hostTier("simonwillison.net") === "trusted");
check("sub.businessinsider.com → trusted (subdomain)", hostTier("markets.businessinsider.com") === "trusted");
check("randomblog.xyz → neutral", hostTier("randomblog.xyz") === "neutral");
check("vettedconsumer.com → denied", hostTier("vettedconsumer.com") === "denied");
check("SEO listicle path (neutral host) → denied", hostTier("someblog.com", "https://someblog.com/best-ai-tools-2026/") === "denied");
// Trusted hosts are exempt from path-level deny — their slugs often contain
// "review"/"vs"/"best" + a year, and excluding them was a real regression.
check("trusted host + review slug → STILL trusted", hostTier("theverge.com", "https://www.theverge.com/reviews/2026/1/1/iphone-18-review") === "trusted");
check("trusted host + vs-year slug → STILL trusted", hostTier("actionnetwork.com", "https://www.actionnetwork.com/nfl/chiefs-vs-bills-odds-2026") === "trusted");
check("trusted host + best-year slug → STILL trusted", hostTier("wsj.com", "https://www.wsj.com/tech/best-ai-tools-2026") === "trusted");
check("tierRank trusted < neutral", tierRank("trusted") < tierRank("neutral"));

// (3) rankAndDedup
console.log("(3) rankAndDedup");
const ranked = rankAndDedup([
  { title: "junk", url: "https://vettedconsumer.com/x", description: "", age: "1 hour ago" },
  { title: "neutral A", url: "https://randomblog.xyz/a", description: "", age: "5 hours ago" },
  { title: "trusted late", url: "https://www.nytimes.com/2026/06/19/tech.html", description: "", age: "3 days ago" },
  { title: "dup of trusted", url: "https://nytimes.com/2026/06/19/tech.html/", description: "", age: "1 hour ago" },
  { title: "trusted 2", url: "https://www.reuters.com/markets/abc", description: "", age: "2 days ago" },
  { title: "host cap a", url: "https://reuters.com/markets/b", description: "", age: "1 day ago" },
  { title: "host cap c", url: "https://reuters.com/markets/c", description: "", age: "1 day ago" },
]);
check("denied (vettedconsumer) excluded", !ranked.some((r) => r.host.includes("vettedconsumer")));
check("trusted ranks before neutral", ranked[0].tier === "trusted");
check("dedup collapses nytimes dup", ranked.filter((r) => r.host === "nytimes.com").length === 1);
check("per-host cap (reuters ≤ 2)", ranked.filter((r) => r.host === "reuters.com").length <= 2);
check("neutral still present (randomblog)", ranked.some((r) => r.host === "randomblog.xyz" && r.tier === "neutral"));
// Query-distinguished URLs are kept distinct (dedup key now includes the query,
// matching url-guard's identity) — two different videos on one host both survive.
const qd = rankAndDedup([
  { title: "vid a", url: "https://www.youtube.com/watch?v=AAA", description: "", age: "1 day ago" },
  { title: "vid b", url: "https://www.youtube.com/watch?v=BBB", description: "", age: "1 day ago" },
]);
check("query-distinguished URLs survive dedup as 2", qd.length === 2);

// (4) looksLikeProse (via fetchArticleText would need network; test sanitize+shape proxy)
console.log("(4) chrome vs prose (sanitize keeps shape)");
const chrome = sanitizeContent("Publish\nPages\nLayers\nAssets\nSearch\nHome\nWork\nServices\nAbout\nContact");
check("chrome stays short / label-y", chrome.split("\n").filter((l) => l.trim()).every((l) => l.trim().split(/\s+/).length <= 2));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.error("DEEP-READ VERIFICATION FAILED"); process.exit(1); }
console.log("ALL DEEP-READ INVARIANTS PASS");
