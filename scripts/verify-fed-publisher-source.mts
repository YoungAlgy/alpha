// Generic offline metadata only. All fetches are fenced before module imports.
import assert from "node:assert/strict";
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const names = ["ALPHA_NO_KEY_SOURCES", "ALPHA_NO_MODEL_MODE", "ALPHA_ALLOW_PAID_AI", "ALPHA_PUBLIC_FEED_FALLBACK", "ALPHA_PUBLISHER_FEED_FALLBACK", "ALPHA_OPEN_NEWS_FALLBACK", "ALPHA_RESEARCH_METADATA_FALLBACK", "ALPHA_GDELT_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET"];
const env = new Map(names.map((name) => [name, process.env[name]]));
let now = Date.parse("2026-10-01T12:00:00.000Z");
Date.now = () => now;
globalThis.fetch = (async () => { throw new Error("unfenced network denied"); }) as typeof fetch;
const endpoint = "https://www.federalreserve.gov/feeds/speeches_and_testimony.xml";
const recent = new Date(now - 3600_000).toUTCString();
const first = "https://www.federalreserve.gov/newsevents/speech/example20261001a.htm";
const second = "https://www.federalreserve.gov/newsevents/testimony/example20261001.htm";
function rss(items: Array<{ title: string; url?: string; date?: string }>): Response {
  return new Response(`<rss><channel>${items.map((item) => `<item><title>${item.title}</title><link>${item.url ?? first}</link><pubDate>${item.date ?? recent}</pubDate><description>PRIVATE BODY FIXTURE MUST NOT ESCAPE</description></item>`).join("")}</channel></rss>`);
}
try {
  const { createPublisherFeedSearch } = await import("../lib/engine/publisher-feed-search.ts");
  const { rankAndDedup } = await import("../lib/engine/source-rank.ts");
  const { normalizeUrl } = await import("../lib/engine/url-guard.ts");
  let calls = 0;
  let reservations = 0;
  const adapter = createPublisherFeedSearch({ now: () => now, reserve: async (provider) => { assert.equal(provider, "publisher-rss"); reservations++; }, fetcher: async (input, init) => {
    calls++;
    assert.equal(input, endpoint);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual([...new Headers(init?.headers).keys()], ["accept"]);
    return rss([
      { title: "Economic conditions and monetary policy" },
      { title: "Financial stability and the labor market", url: second },
      { title: "Community payments conference", url: first.replace("example", "irrelevant") },
      { title: "Inflation stale item", date: new Date(now - 8 * 86400_000).toUTCString() },
      { title: "Interest rate future item", date: new Date(now + 1).toISOString() },
      { title: "Monetary policy undated item", date: "invalid" },
      ...["http://www.federalreserve.gov/newsevents/speech/old.htm", "https://user:pass@www.federalreserve.gov/newsevents/speech/private.htm", "https://www.federalreserve.gov:8443/newsevents/speech/port.htm", "https://www.federalreserve.gov.attacker.invalid/newsevents/speech/false.htm", "https://other.example.org/newsevents/speech/external.htm", "https://www.federalreserve.gov/", "https://www.federalreserve.gov/newsevents/speech/", "https://www.federalreserve.gov/feeds/other.xml"].map((url) => ({ title: "Economic outlook rejected link", url })),
    ]);
  } });
  assert.deepEqual(await adapter("custom:private economics interests"), []);
  assert.deepEqual(await adapter("personal-finance"), []);
  assert.deepEqual(await adapter("macro-markets", { freshness: "py" }), []);
  assert.equal(calls, 0, "unsupported topic or date range performs no source request");
  const [one, two] = await Promise.all([adapter("macro-markets", { freshness: "pd" }), adapter("macro-markets", { freshness: "pw" })]);
  assert.equal(calls, 1);
  assert.equal(reservations, 1);
  assert.equal(one.length, 2);
  assert.deepEqual(one, two);
  assert.ok(one.every((item) => item.title.startsWith("Federal Reserve Board: ") && item.description === "Economic policy speech or testimony. Source date: 2026-10-01."));
  one[0].title = "caller mutation";
  assert.ok((await adapter("macro-markets"))[0].title.startsWith("Federal Reserve Board: "));
  assert.deepEqual(rankAndDedup(two, 2, new Set([normalizeUrl(first)!]), "macro-markets").map((item) => item.url), [second]);
  now += 2 * 86400_000;
  assert.deepEqual(await adapter("macro-markets", { freshness: "pd" }), [], "current date bounds are rechecked, old metadata does not become a fresh letter");

  let blockedFetches = 0;
  const denied = createPublisherFeedSearch({ reserve: async () => { throw new Error("budget exhausted"); }, fetcher: async () => { blockedFetches++; return rss([]); } });
  await assert.rejects(denied("macro-markets"), /budget exhausted/);
  await assert.rejects(denied("macro-markets"), /cooling down/);
  assert.equal(blockedFetches, 0);

  let failureCalls = 0;
  const failed = createPublisherFeedSearch({ now: () => now, reserve: async () => {}, fetcher: async (input) => {
    failureCalls++;
    return String(input) === endpoint ? new Response(null, { status: 503 }) : rss([{ title: "Medical device safety", url: "https://www.fda.gov/offline-fixture" }]);
  } });
  await assert.rejects(failed("macro-markets"), /503/);
  await assert.rejects(failed("macro-markets"), /cooling down/);
  assert.equal((await failed("longevity-wellness")).length, 1, "Fed failure does not cool down an independent FDA feed");
  assert.equal(failureCalls, 2);
  const malformed = createPublisherFeedSearch({ reserve: async () => {}, fetcher: async () => new Response("<html>temporarily unavailable</html>") });
  await assert.rejects(malformed("macro-markets"), /invalid feed/);

  // Use the existing guarded ladder, source ranking, exclusions and formatter.
  for (const name of names) delete process.env[name];
  Object.assign(process.env, { ALPHA_NO_KEY_SOURCES: "1", ALPHA_NO_MODEL_MODE: "1", ALPHA_ALLOW_PAID_AI: "0", ALPHA_PUBLIC_FEED_FALLBACK: "1", ALPHA_PUBLISHER_FEED_FALLBACK: "1", ALPHA_OPEN_NEWS_FALLBACK: "1", ALPHA_RESEARCH_METADATA_FALLBACK: "1", ALPHA_GDELT_FALLBACK: "0", ALPHA_DURABLE_SOURCE_BUDGET: "0" });
  const count = { google: 0, fed: 0, unexpected: 0 };
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "news.google.com" && url.pathname === "/rss/search") { count.google++; return new Response(null, { status: 503 }); }
    if (url.href === endpoint) { count.fed++; return rss([{ title: "Economic outlook", date: new Date(now - 60_000).toUTCString() }, { title: "Monetary policy", url: second, date: new Date(now - 60_000).toUTCString() }]); }
    count.unexpected++;
    throw new Error("unexpected offline fetch denied");
  }) as typeof fetch;
  const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
  const { buildDeterministicBlurb } = await import("../lib/engine/deterministic-fallback.ts");
  const signal = await resolveTopicSignal("macro-markets", new Date(now).toISOString().slice(0, 10), { liveOnly: true, freshness: "pd", excludeUrls: new Set([normalizeUrl(first)!]) });
  assert.ok(signal);
  assert.deepEqual([...signal.citableUrls], [normalizeUrl(second)!]);
  const blurb = buildDeterministicBlurb(signal);
  assert.ok(blurb && blurb.items.length === 1);
  assert.ok(blurb.items[0].primaryRef && signal.citableUrls.has(normalizeUrl(blurb.items[0].primaryRef.url)!));
  assert.match(blurb.items[0].headline, /Federal Reserve Board/);
  assert.ok(!blurb.items[0].body.includes("PRIVATE BODY"));
  assert.deepEqual(count, { google: 3, fed: 1, unexpected: 0 }, "earlier useful tier short-circuits all later sources, writer, database and article-body requests");
  const otherReader = await resolveTopicSignal("macro-markets", new Date(now).toISOString().slice(0, 10), { liveOnly: true, freshness: "pd" });
  assert.equal(otherReader?.citableUrls.size, 2);
  assert.equal(count.fed, 1, "reader exclusions cannot poison or re-request the shared feed");
  now += 16 * 60_000;
  const fallbackCalls = { google: 0, fed: 0, open: 0, unexpected: 0 };
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "news.google.com" && url.pathname === "/rss/search") { fallbackCalls.google++; return new Response(null, { status: 503 }); }
    if (url.href === endpoint) { fallbackCalls.fed++; return new Response(null, { status: 503 }); }
    if (url.href === "https://globalvoices.org/feed/") {
      fallbackCalls.open++;
      return new Response(`<rss><channel><item><title>Economy news in a generic fixture</title><link>https://globalvoices.org/${new Date(now).toISOString().slice(0, 10).replaceAll("-", "/")}/economy-fixture/</link><pubDate>${new Date(now - 60_000).toUTCString()}</pubDate><dc:creator>Fixture Reporter</dc:creator><description>BODY MUST NOT ESCAPE</description></item></channel></rss>`);
    }
    fallbackCalls.unexpected++;
    throw new Error("unexpected offline fallback fetch denied");
  }) as typeof fetch;
  const backupSignal = await resolveTopicSignal("macro-markets", new Date(now).toISOString().slice(0, 10), { liveOnly: true, freshness: "pd" });
  assert.ok(backupSignal?.sources?.every((item) => item.attribution?.publisher === "global-voices"));
  assert.deepEqual(fallbackCalls, { google: 3, fed: 1, open: 1, unexpected: 0 }, "failed Fed tier falls through once to the existing licensed-news tier");
  now += 16 * 60_000;
  let emptyCalls = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    assert.ok((url.hostname === "news.google.com" && url.pathname === "/rss/search") || url.href === endpoint || url.href === "https://globalvoices.org/feed/", "exhaustion never calls a model, keyed source, article body or database");
    emptyCalls++;
    return rss([]);
  }) as typeof fetch;
  assert.equal(await resolveTopicSignal("macro-markets", new Date(now).toISOString().slice(0, 10), { liveOnly: true, freshness: "pd" }), undefined, "a fully exhausted ladder stays quiet instead of inventing weak or stale material");
  assert.equal(emptyCalls, 5);
  console.log("PASS Fed economics source, bounded failure, cache, privacy, exclusions and no-model ladder (offline)");
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  for (const name of names) { const value = env.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}
