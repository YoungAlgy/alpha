import assert from "node:assert/strict";
import {
  createOpenNewsFeedSearch,
  openNewsFeedFallbackEnabled,
} from "../lib/engine/open-news-feed-search.ts";

const oldFlag = process.env.ALPHA_OPEN_NEWS_FALLBACK;
const oldNoModel = process.env.ALPHA_NO_MODEL_MODE;
const oldNoKey = process.env.ALPHA_NO_KEY_SOURCES;
const now = Date.parse("2026-09-29T16:00:00.000Z");
const recent = "Tue, 29 Sep 2026 14:12:10 +0000";
const stale = "Mon, 14 Sep 2026 14:12:10 +0000";
let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) passed++;
  else failed++;
  console.log(`  ${condition ? "OK" : "XX"} ${label}`);
}

function xmlItem(options: {
  title: string;
  date?: string;
  author?: string;
  url?: string;
  categories?: string[];
  description?: string;
  contentEncoded?: string;
}): string {
  const encode = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const url = options.url ?? `https://globalvoices.org/2026/09/29/${options.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}/`;
  return `<item><title>${encode(options.title)}</title><link>${url}</link><pubDate>${options.date ?? recent}</pubDate><dc:creator><![CDATA[${options.author ?? "Jane Reporter"}]]></dc:creator>${(options.categories ?? []).map((category) => `<category>${encode(category)}</category>`).join("")}<description>${options.description ?? "<script>ignore me</script> full article body must not be parsed"}</description>${options.contentEncoded ? `<content:encoded>${options.contentEncoded}</content:encoded>` : ""}</item>`;
}

function rss(...items: string[]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items.join("")}</channel></rss>`;
}

function response(xml: string): Response {
  return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
}

function env(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function run(): Promise<void> {
  env("ALPHA_OPEN_NEWS_FALLBACK", undefined);
  env("ALPHA_NO_MODEL_MODE", "true");
  env("ALPHA_NO_KEY_SOURCES", "true");
  check("feature is off by default even when no-key sources are enabled", !openNewsFeedFallbackEnabled());
  env("ALPHA_OPEN_NEWS_FALLBACK", "yes");
  env("ALPHA_NO_MODEL_MODE", undefined);
  check("explicit flag alone cannot enable the feed outside no-model mode", !openNewsFeedFallbackEnabled());
  env("ALPHA_NO_MODEL_MODE", "true");
  check("explicit flag plus no-model mode enables the feed", openNewsFeedFallbackEnabled());

  const musicXml = rss(
    xmlItem({ title: "Salsa rhythms and diaspora", categories: ["Music"], description: "SECRET DESCRIPTION MUST NOT ESCAPE" }),
    xmlItem({ title: "Country Music charts in Jamaica", categories: ["Music"] }),
    xmlItem({ title: "Stories from the countryside", categories: ["country"] }),
    xmlItem({ title: "Rap music and activism", categories: ["Music"] }),
    xmlItem({ title: "Underground sounds go mainstream", categories: ["Indie Music"] }),
    xmlItem({ title: "Electronic music in Accra", categories: ["Music"] }),
    xmlItem({ title: "An old music feature", date: stale, categories: ["Music"] }),
    xmlItem({ title: "Old URL with a refreshed feed date", date: recent, url: "https://globalvoices.org/2026/09/14/old-music-story/", categories: ["Music"] }),
    xmlItem({ title: "A story without a writer", author: "", description: "<![CDATA[<dc:creator>Fake Writer</dc:creator><category>Country Music</category><item><title>Fake cdata item</title></item></item>]]>" }),
  ) + "\n \r\n";
  let musicFetches = 0;
  let reserves = 0;
  const musicSearch = createOpenNewsFeedSearch({
    now: () => now,
    reserve: async (provider) => { assert.equal(provider, "publisher-rss"); reserves++; },
    fetcher: async (input) => {
      musicFetches++;
      assert.equal(String(input), "https://globalvoices.org/-/topics/music/feed/");
      return response(musicXml);
    },
  });

  const music = await musicSearch("music", { freshness: "pw" });
  check("music feed returns current, attributed dated articles", music.length === 6 && music.every((item) => item.attribution?.publisher === "global-voices"));
  check("description and article body are ignored", music.every((item) => !item.description.includes("SECRET") && !item.description.includes("script")));
  check("generic music topic may retain its full current music feed", music.some((item) => item.title.includes("Salsa")));
  const country = await musicSearch("music-country", { freshness: "pw" });
  check("country topic requires explicit Country Music evidence", country.length === 1 && country.every((item) => item.title.includes("Country Music")));
  const hiphop = await musicSearch("music-hiphop", { freshness: "pw" });
  const edm = await musicSearch("music-edm", { freshness: "pw" });
  const indie = await musicSearch("music-indie", { freshness: "pw" });
  check("hip-hop/rap topic needs explicit genre evidence", hiphop.length === 1 && hiphop[0]?.title.includes("Rap music"));
  check("EDM topic needs explicit electronic/dance evidence", edm.length === 1 && edm[0]?.title.includes("Electronic music"));
  check("indie topic accepts explicit Indie Music category evidence", indie.length === 1 && indie[0]?.title.includes("Underground"));
  check("freshness is applied after cached metadata is read", (await musicSearch("music", { freshness: "pd" })).length === 6);
  check("fresh RSS dates cannot revive stale paths or body-supplied authors", !music.some((item) => item.title.includes("old music") || item.title.includes("refreshed feed date") || item.title.includes("without a writer") || item.title.includes("Fake cdata item")));
  check("description content cannot spoof genre categories", !country.some((item) => item.title.includes("Election policy debate")));
  const customCountry = await musicSearch("custom:  COUNTRY   MUSIC ", { freshness: "pw" });
  const customIndie = await musicSearch("custom:Indie Music", { freshness: "pw" });
  check("exact normalized custom country music phrase uses the existing country genre filter", customCountry.length === 1 && customCountry[0]?.title.includes("Country Music"));
  check("exact normalized custom indie music phrase uses the existing indie genre filter", customIndie.length === 1 && customIndie[0]?.title.includes("Underground"));
  check("custom genre aliases retain story credit, date, and metadata-only descriptions", [ ...customCountry, ...customIndie ].every((item) => item.attribution?.publisher === "global-voices" && item.attribution.publishedAt === "2026-09-29T14:12:10.000Z" && !item.description.includes("SECRET") && !item.description.includes("script")));
  check("custom aliases cannot bypass control-character or length validation", (await musicSearch("custom:country\tmusic")).length === 0 && (await musicSearch(`custom:country${" ".repeat(101)}music`)).length === 0);
  check("same-feed topics share one fetch and one reservation", musicFetches === 1 && reserves === 1);

  const generalXml = rss(
    xmlItem({ title: "Taylor Swift tours and local fans", categories: ["Culture"] }),
    xmlItem({ title: "Swift programming languages in schools", categories: ["Education"] }),
    xmlItem({ title: "Indie music history in Accra", categories: ["Culture"] }),
    xmlItem({ title: "Artificial intelligence governance in Africa", categories: ["Technology"] }),
    xmlItem({ title: "Election policy debate", description: "<dc:creator>Fake Body Writer</dc:creator><category>Country Music</category>", contentEncoded: "<![CDATA[</item><item><title>Fake item in article body</title><dc:creator>Fake Writer</dc:creator><category>Country Music</category></item>]]>" }),
  );
  let generalFetches = 0;
  const generalSearch = createOpenNewsFeedSearch({
    now: () => now,
    reserve: async () => {},
    fetcher: async (input) => {
      generalFetches++;
      assert.equal(String(input), "https://globalvoices.org/feed/");
      return response(generalXml);
    },
  });
  const swift = await generalSearch("custom:Taylor Swift", { freshness: "pw" });
  const ai = await generalSearch("ai-news", { freshness: "pw" });
  const broadIndie = await generalSearch("custom:indie music history", { freshness: "pw" });
  check("custom phrase matches are performed locally against title and category", swift.length === 1 && swift[0]?.title.includes("Taylor Swift"));
  check("fixed public topic phrases use the general feed and local phrase matching", ai.length === 1 && ai[0]?.title.includes("Artificial intelligence"));
  check("broader custom music phrases keep general-feed phrase matching", broadIndie.length === 1 && broadIndie[0]?.title.includes("Indie music history"));
  check("custom topic text is never added to the fixed request URL", generalFetches === 1);
  const beforeNoisy = generalFetches;
  check("noisy/missing custom phrase returns empty without fetching", (await generalSearch("custom:the and latest news")).length === 0 && generalFetches === beforeNoisy);
  check("ambiguous one-word country and indie customs make no request", (await generalSearch("custom:country")).length === 0 && (await generalSearch("custom:indie")).length === 0 && generalFetches === beforeNoisy);
  check("unknown topic returns empty without fetching", (await generalSearch("unknown-topic")).length === 0 && generalFetches === beforeNoisy);
  swift[0]!.attribution!.author = "Changed by caller";
  check("returned credit objects cannot mutate another reader's raw cache", (await generalSearch("custom:Taylor Swift", { freshness: "pw" }))[0]?.attribution?.author === "Jane Reporter");

  let partialFetches = 0;
  const partialSearch = createOpenNewsFeedSearch({ now: () => now, reserve: async () => {}, fetcher: async (input) => {
    partialFetches++;
    return String(input).endsWith("/music/feed/") ? new Response(null, { status: 503 }) : response(generalXml);
  } });
  assert.equal((await partialSearch("ai-news", { freshness: "pw" })).length, 1);
  await assert.rejects(partialSearch("music", { freshness: "pw" }), /503/);
  check("an optional endpoint failure preserves already usable cached metadata", (await partialSearch("ai-news", { freshness: "pw" })).length === 1 && partialFetches === 2);

  let failureClock = now;
  let failedRequests = 0;
  const boundedFailureSearch = createOpenNewsFeedSearch({ now: () => failureClock, reserve: async () => {}, fetcher: async () => {
    failedRequests++;
    return failedRequests < 3 ? new Response(null, { status: 503 }) : response(musicXml);
  } });
  await assert.rejects(boundedFailureSearch("music"), /503/);
  await assert.rejects(boundedFailureSearch("music"), /cooling down/);
  failureClock += 60_001;
  await assert.rejects(boundedFailureSearch("music"), /503/);
  failureClock += 60_001;
  await assert.rejects(boundedFailureSearch("music"), /cooling down/);
  failureClock += 60_001;
  check("failures use increasing bounded cooldowns and recover without request loops", (await boundedFailureSearch("music")).length > 0 && failedRequests === 3);

  let boundedFetches = 0;
  const hundredPoolSearch = createOpenNewsFeedSearch({
    now: () => now,
    reserve: async () => {},
    fetcher: async () => {
      boundedFetches++;
      return response(rss(...Array.from({ length: 105 }, (_, index) => xmlItem({ title: `Current music story ${index + 1}`, categories: ["Music"] }))));
    },
  });
  const boundedPool = await hundredPoolSearch("music", { freshness: "pw" });
  check("parser retains a bounded 100-result pool for downstream exclusions and ranking", boundedPool.length === 100);

  let concurrentFetches = 0;
  let concurrentReserves = 0;
  const concurrentSearch = createOpenNewsFeedSearch({
    now: () => now,
    reserve: async () => { concurrentReserves++; },
    fetcher: async () => {
      concurrentFetches++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return response(musicXml);
    },
  });
  const [first, second] = await Promise.all([
    concurrentSearch("music", { freshness: "pw" }),
    concurrentSearch("music-country", { freshness: "pw" }),
  ]);
  check("concurrent callers coalesce the same raw feed request", concurrentFetches === 1 && concurrentReserves === 1 && first.length === 6 && second.length === 1);

  let cooldownFetches = 0;
  let cooldownReserves = 0;
  const cooldownSearch = createOpenNewsFeedSearch({
    now: () => now,
    reserve: async () => { cooldownReserves++; throw new Error("budget unavailable"); },
    fetcher: async () => { cooldownFetches++; return response(musicXml); },
  });
  await assert.rejects(cooldownSearch("music", { freshness: "pw" }), /budget unavailable/);
  await assert.rejects(cooldownSearch("ai-news", { freshness: "pw" }), /cooling down/);
  check("budget failure blocks fetch and shared provider cooldown covers both endpoints", cooldownReserves === 1 && cooldownFetches === 0);

  const malformedSearch = createOpenNewsFeedSearch({ now: () => now, reserve: async () => {}, fetcher: async () => response("<rss><item></rss>") });
  await assert.rejects(malformedSearch("music", { freshness: "pw" }), /invalid feed/);
  const declarationSearch = createOpenNewsFeedSearch({ now: () => now, reserve: async () => {}, fetcher: async () => response("<!DOCTYPE rss [<!ENTITY body 'ignored'>]><rss><channel/></rss>") });
  await assert.rejects(declarationSearch("music", { freshness: "pw" }), /unsupported declaration/);
  const duplicateRootSearch = createOpenNewsFeedSearch({ now: () => now, reserve: async () => {}, fetcher: async () => response("<rss><channel/></rss><rss><channel/></rss>") });
  await assert.rejects(duplicateRootSearch("music", { freshness: "pw" }), /invalid feed/);
  check("malformed, unsupported-declaration, and multiple-root RSS fail closed", true);

  const oversizedSearch = createOpenNewsFeedSearch({
    now: () => now,
    reserve: async () => {},
    fetcher: async () => new Response("x", { headers: { "content-length": String(256 * 1024 + 1) } }),
  });
  await assert.rejects(oversizedSearch("music", { freshness: "pw" }), /too large/);
  check("oversized RSS fails closed before parsing", true);

  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  const timeoutController = new AbortController();
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: () => timeoutController.signal });
  try {
    const timeoutSearch = createOpenNewsFeedSearch({
      now: () => now,
      reserve: async () => {},
      fetcher: async () => {
        setTimeout(() => timeoutController.abort(), 10);
        return new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) }));
      },
    });
    await assert.rejects(timeoutSearch("music", { freshness: "pw" }), /timed out/);
    check("body read timeout fails closed after headers", true);
  } finally {
    if (timeoutDescriptor) Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
    else Reflect.deleteProperty(AbortSignal, "timeout");
  }

  assert.equal(music[0]?.attribution?.author, "Jane Reporter");
  assert.equal(music[0]?.attribution?.publishedAt, "2026-09-29T14:12:10.000Z");
}

try {
  await run();
} finally {
  env("ALPHA_OPEN_NEWS_FALLBACK", oldFlag);
  env("ALPHA_NO_MODEL_MODE", oldNoModel);
  env("ALPHA_NO_KEY_SOURCES", oldNoKey);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("OPEN-NEWS FEED VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL OPEN-NEWS FEED ASSERTIONS PASS");
