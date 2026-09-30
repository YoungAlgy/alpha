// Offline metadata fixtures only. No source, subscriber, DB or model request.
import assert from "node:assert/strict";
import { createPublicSourceCache } from "../lib/engine/public-source-cache.ts";
import { freshPublicResults, publicSourceWindow } from "../lib/engine/public-source-freshness.ts";
import { createPublisherFeedSearch } from "../lib/engine/publisher-feed-search.ts";
import { createPublicFeedSearch } from "../lib/engine/public-feed-search.ts";
import { normalizeUrl } from "../lib/engine/url-guard.ts";
import { rankAndDedup } from "../lib/engine/source-rank.ts";

const originalFetch = globalThis.fetch;
const originalBudget = process.env.ALPHA_DURABLE_SOURCE_BUDGET;
delete process.env.ALPHA_DURABLE_SOURCE_BUDGET;
let calls = 0;
let now = Date.UTC(2026, 8, 29, 12);
const source = { title: "Offline source", url: "https://www.fda.gov/example", description: "", age: new Date(now - 3600000).toUTCString() };
const feed = (items: Array<typeof source>) => `<rss><channel>${items.map((s) => `<item><title>${s.title}</title><link>${s.url}</link><description>${s.description}</description><pubDate>${s.age}</pubDate></item>`).join("")}</channel></rss>`;
globalThis.fetch = (async () => { throw new Error("network denied"); }) as typeof fetch;
try {
  assert.equal(publicSourceWindow("py", now), null);
  assert.equal(publicSourceWindow("2026-02-30to2026-03-01", now), null);
  assert.equal(publicSourceWindow("2020-01-01to2020-01-02", now), null);
  assert.equal(publicSourceWindow("2026-09-29to2026-09-30", now), null);
  assert.deepEqual(freshPublicResults([source], "pd", now), [source]);
  for (const changed of [{ age: "" }, { age: "invalid" }, { age: new Date(now + 1).toISOString() }, { age: new Date(now - 8 * 86400000).toISOString() }, { url: "http://www.fda.gov/example" }, { url: "https://user:pass@www.fda.gov/example" }, { url: "https://127.0.0.1/example" }]) {
    assert.equal(freshPublicResults([{ ...source, ...changed }], "pw", now).length, 0);
  }
  const cache = createPublicSourceCache(() => now);
  const work = async () => { calls++; return [source]; };
  const [one, two] = await Promise.all([cache("feed", "same", work), cache("feed", "same", work)]);
  assert.equal(calls, 1, "coalesce identical pending source calls");
  one[0].title = "mutated caller copy";
  assert.equal(two[0].title, source.title);
  assert.equal((await cache("feed", "same", work))[0].title, source.title);
  const firstReader = rankAndDedup(await cache("feed", "same", work), 2, new Set([normalizeUrl(source.url)!]));
  const otherReader = rankAndDedup(await cache("feed", "same", work), 2, new Set());
  assert.equal(firstReader.length, 0);
  assert.equal(otherReader.length, 1, "reader exclusion cannot poison raw cache");
  now += 5 * 60000;
  await cache("feed", "same", work);
  assert.equal(calls, 2, "cache expires after five minutes");
  let failedCalls = 0;
  const failure = async () => { failedCalls++; throw new Error("offline outage"); };
  await assert.rejects(cache("feed", "new", failure));
  await assert.rejects(cache("feed", "other", failure), /cooling down/);
  assert.equal(failedCalls, 1);
  assert.equal((await cache("feed", "same", work)).length, 1, "a prior valid result survives optional failure");
  await cache("independent-feed", "new", work);
  now += 60000;
  await assert.rejects(cache("feed", "new", failure));
  now += 60000;
  await assert.rejects(cache("feed", "new", failure), /cooling down/);
  assert.equal(failedCalls, 2, "repeated failure increases cooldown");
  now += 60000;
  await cache("feed", "new", work);

  // Google parser must reject HTML, stale/undated data and recheck cached dates.
  const google = createPublicFeedSearch(() => now);
  let googleCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    googleCalls++;
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    return new Response(feed([source, { ...source, url: "https://www.fda.gov/undated", age: "" }]));
  }) as typeof fetch;
  assert.equal((await google("generic topic", { freshness: "pd" })).length, 1);
  assert.equal((await google("generic topic", { freshness: "pd" })).length, 1);
  assert.equal(googleCalls, 1);
  const badGoogle = createPublicFeedSearch(() => now);
  globalThis.fetch = (async () => new Response("<html>unavailable</html>")) as typeof fetch;
  await assert.rejects(badGoogle("generic topic"), /invalid feed/);
  await assert.rejects(badGoogle("another topic"), /cooling down/);

  let publisherCalls = 0;
  const publisher = createPublisherFeedSearch({ now: () => now, reserve: async () => {}, fetcher: (async (input, init) => {
    publisherCalls++;
    assert.equal(input, "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/medwatch/rss.xml");
    assert.equal(init?.redirect, "error");
    return new Response(feed([
      { ...source, title: "Medical device recall", url: "http://www.fda.gov/example", description: "Do not republish this content" },
      { ...source, title: "Infant medicine safety notice", url: "https://www.fda.gov/infant" },
      { ...source, title: "Wrong host medical recall", url: "https://untrusted.example/recall" },
      { ...source, title: "Undated medical recall", url: "https://www.fda.gov/undated", age: "" },
      { ...source, title: "Medical recall with credentials", url: "http://user:pass@www.fda.gov/private" },
      { ...source, title: "Medical recall with port", url: "http://www.fda.gov:8080/private" },
      { ...source, title: "Medical recall lookalike host", url: "http://www.fda.gov.attacker.invalid/recall" },
    ]));
  }) as typeof fetch });
  assert.equal((await publisher("music")).length, 0);
  assert.equal((await publisher("custom:personal private topic")).length, 0);
  assert.equal(publisherCalls, 0, "unmapped/custom topics cause no publisher request");
  const health = await publisher("longevity-wellness", { freshness: "pw" });
  assert.equal(health.length, 2);
  assert.equal(health[0].url, "https://www.fda.gov/example", "upgrade only the verified first-party FDA canonical link");
  assert.ok(health.every((x) => x.title.startsWith("FDA MedWatch: ") && !x.description.includes("republish")));
  assert.equal((await publisher("parenting", { freshness: "pw" })).length, 1);
  assert.equal(publisherCalls, 1, "one raw feed reused across local topic matching");
  const exhausted = createPublisherFeedSearch({ reserve: async () => { throw new Error("budget exhausted"); }, fetcher: async () => { throw new Error("unexpected fetch"); } });
  await assert.rejects(exhausted("longevity-wellness"), /budget exhausted/);
  await assert.rejects(exhausted("parenting"), /cooling down/);
  const unavailable = createPublisherFeedSearch({ reserve: async () => {}, fetcher: async () => new Response("", { status: 503 }) });
  await assert.rejects(unavailable("real-estate"), /503/);
  await assert.rejects(unavailable("ai-news"), /cooling down/);
  let cancelled = false;
  const stalled = createPublisherFeedSearch({ reserve: async () => {}, fetcher: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  // AbortSignal.timeout is unref'ed in Node; keep this isolated mocked stream
  // test alive until the real production deadline fires.
  const keepAlive = setTimeout(() => {}, 6000);
  try { await assert.rejects(stalled("longevity-wellness"), /timed out/); }
  finally { clearTimeout(keepAlive); }
  assert.equal(cancelled, true);
  console.log("PASS public source freshness, caching, cooldown, publisher filtering and timeout (offline)");
} finally {
  globalThis.fetch = originalFetch;
  if (originalBudget === undefined) delete process.env.ALPHA_DURABLE_SOURCE_BUDGET;
  else process.env.ALPHA_DURABLE_SOURCE_BUDGET = originalBudget;
}
