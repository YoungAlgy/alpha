// Offline fixtures only. No users, database, real source requests or letters.
import assert from "node:assert/strict";
import { createOpenNewsFeedSearch } from "../lib/engine/open-news-feed-search.ts";

const previous = new Map(["ALPHA_OPEN_NEWS_FALLBACK", "ALPHA_NO_MODEL_MODE"].map(name => [name, process.env[name]]));
const now = Date.parse("2026-10-08T18:00:00Z");
let fetches = 0;
let reservations = 0;
let circuits = 0;
const titles = [
  "UK healthcare recruiting struggles",
  "US healthcare recruiting expands",
  "Healthcare recruiting expands",
  "New climate policy reforms",
  "AI climate policy reforms",
  "Space research expands",
  "ISS space research expands",
  "Formula 2 aero research",
  "Formula 1 aero research",
  "Taylor Swift tours and local fans",
  "Artificial intelligence governance",
  "USAI healthcare recruiting",
];
const xml = `<rss><channel>${titles.map((title, index) => `<item><title>${title}</title><link>https://globalvoices.org/2026/10/08/offline-qualifier-${index}/</link><pubDate>Thu, 08 Oct 2026 17:00:00 +0000</pubDate><dc:creator>Offline Test Author</dc:creator><category>Technology</category><description>Discard this fixture body</description></item>`).join("")}</channel></rss>`;
try {
  process.env.ALPHA_OPEN_NEWS_FALLBACK = "1";
  process.env.ALPHA_NO_MODEL_MODE = "1";
  const search = createOpenNewsFeedSearch({
    now: () => now,
    reserve: async provider => { assert.equal(provider, "publisher-rss"); reservations++; },
    attempt: async (provider, reserve, work) => { assert.equal(provider, "global-voices-rss"); circuits++; await reserve(); return work(); },
    fetcher: async (input, init) => {
      fetches++;
      assert.equal(String(input), "https://globalvoices.org/feed/");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      return new Response(xml);
    },
  });
  const find = async (topic: string) => (await search(`custom:${topic}`, { freshness: "pd" })).map(item => item.title.replace(/^Global Voices: /, ""));
  assert.deepEqual(await find("US healthcare recruiting"), ["US healthcare recruiting expands"], "US qualifier cannot silently accept UK, missing US or substring USAI");
  assert.deepEqual(await find("AI climate policy"), ["AI climate policy reforms"], "AI qualifier must exist as a full token");
  assert.deepEqual(await find("ISS space research"), ["ISS space research expands"], "ISS qualifier must exist as a full token");
  assert.deepEqual(await find("Formula 1 aero"), ["Formula 1 aero research"], "numeric qualifier cannot silently accept Formula 2");
  assert.deepEqual(await find("Taylor Swift"), ["Taylor Swift tours and local fans"]);
  assert.deepEqual(await find("US healthcare and recruiting"), ["US healthcare recruiting expands"], "short grammar words do not become artificial qualifiers");
  assert.deepEqual(await find("AI in radiology"), [], "retain the existing two-long-anchor minimum");
  assert.deepEqual(await find("AI climate"), [], "a short qualifier cannot substitute for the second long anchor");
  assert.deepEqual(await find("the and latest news"), []);
  assert.deepEqual(await find("US UK AI ISS EU healthcare recruiting"), [], "retain a bounded six-token selection");
  assert.deepEqual(await find("global voices"), [], "generated publisher labels are never topic evidence");
  assert.equal((await search("ai-news", { freshness: "pd" })).length, 1, "fixed-topic phrase semantics stay unchanged");
  const matched = await search("custom:US healthcare recruiting", { freshness: "pd" });
  assert.equal(matched[0]?.attribution?.publisher, "global-voices");
  assert.equal(matched[0]?.attribution?.author, "Offline Test Author");
  assert.equal(matched[0]?.attribution?.publishedAt, "2026-10-08T17:00:00.000Z");
  assert.ok(!matched[0]?.description.includes("Discard"));
  assert.equal((await search("custom:US healthcare recruiting", { freshness: "2026-10-07to2026-10-07" })).length, 0);
  assert.deepEqual({ fetches, reservations, circuits }, { fetches: 1, reservations: 1, circuits: 1 }, "topic qualifiers stay local and share the raw metadata cache");
  console.log("PASS custom qualifiers, exact tokens, existing anchor minimum, credit, privacy and cached freshness (offline)");
} finally {
  for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}
