// Offline metadata fixtures only. Injected readers cannot contact any service.
import assert from "node:assert/strict";
import type { PublicSourceAttempt } from "../lib/engine/public-source-circuit.ts";

const oldFetch = globalThis.fetch;
const flags = ["ALPHA_OPEN_NEWS_FALLBACK", "ALPHA_NO_MODEL_MODE"] as const;
const saved = new Map(flags.map((flag) => [flag, process.env[flag]]));
let forbidden = 0;
globalThis.fetch = async () => { forbidden++; throw new Error("network denied"); };
const now = Date.UTC(2026, 9, 5, 12);
const date = "Mon, 05 Oct 2026 11:00:00 GMT";
const older = "Sat, 03 Oct 2026 11:00:00 GMT";
const attempt: PublicSourceAttempt = async (_provider, reserve, work) => { await reserve(); return work(); };
const reserve = async () => {};
type Item = { url: string; date?: string; author?: string };
const item = (value: Item) => `<item><title>Medical safety music notice</title><link>${value.url}</link><pubDate>${value.date ?? date}</pubDate><dc:creator>${value.author ?? "Fixture Author"}</dc:creator></item>`;
const feed = (items: Item[]) => `<rss><channel>${items.map(item).join("")}</channel></rss>`;
const good = "https://www.fda.gov/offline-valid-pool";
const gv = "https://globalvoices.org/2026/10/05/offline-valid-pool/";

try {
  process.env.ALPHA_OPEN_NEWS_FALLBACK = "1";
  process.env.ALPHA_NO_MODEL_MODE = "1";
  const { createPublicFeedSearch } = await import("../lib/engine/public-feed-search.ts");
  const { createPublisherFeedSearch } = await import("../lib/engine/publisher-feed-search.ts");
  const { createOpenNewsFeedSearch } = await import("../lib/engine/open-news-feed-search.ts");
  const { publicFeedSnapshot } = await import("../lib/engine/public-feed-cache.ts");
  const body = "BODY_MUST_BE_DISCARDED";
  const media = "MEDIA_MUST_BE_DISCARDED";
  const withBody = feed([{ url: gv }]).replace("</item>",
    `<description>${body}</description><content:encoded><![CDATA[${body}]]></content:encoded><media:content url="${media}"/></item>`);
  for (const kind of ["publisher", "licensed"] as const) {
    const snapshot = publicFeedSnapshot(withBody, "Offline RSS", true, kind);
    assert.equal(snapshot.xml.includes(body), false, `${kind}: source bodies never enter warm cache`);
    assert.equal(snapshot.xml.includes(media), false, `${kind}: media never enter warm cache`);
    assert.equal(snapshot.xml.includes("dc:creator"), kind === "licensed");
  }
  const searchSnapshot = publicFeedSnapshot(withBody, "Offline RSS", true, "search");
  assert.ok(searchSnapshot.xml.includes("description"), "search keeps its permitted source snippet");
  assert.equal(searchSnapshot.xml.includes("content:encoded"), false);
  assert.equal(searchSnapshot.xml.includes(media), false);
  assert.throws(() => publicFeedSnapshot("<rss><channel><item></rss>", "Offline RSS", false, "publisher"), /invalid feed/);

  for (const provider of ["google", "publisher", "open-news"] as const) {
    const valid = { url: provider === "open-news" ? gv : good };
    const invalids: Item[] = [
      { ...valid, date: "" },
      { ...valid, date: "Mon, 30 Feb 2026 11:00:00 GMT" },
      { ...valid, date: "Mon, 05 Oct 2026 13:00:00 GMT" },
      { ...valid, date: older },
      { ...valid, url: "https://user:pass@www.fda.gov/offline-invalid" },
      ...(provider === "google" ? [{ ...valid, url: "http://example.test/offline-invalid" }] : []),
      ...(provider === "publisher" ? [{ ...valid, url: "https://wrong.example.test/offline-invalid" }] : []),
      ...(provider === "open-news" ? [
        { ...valid, author: "" },
        { ...valid, url: "https://globalvoices.org/2026/10/03/offline-old-path/" },
      ] : []),
    ];
    for (const invalid of invalids) {
      let calls = 0;
      const fetcher: typeof fetch = async () => {
        calls++;
        return new Response(feed([...Array.from({ length: 100 }, () => invalid), valid]));
      };
      const search = provider === "google" ? createPublicFeedSearch(() => now, { fetcher, reserve, attempt })
        : provider === "publisher" ? createPublisherFeedSearch({ now: () => now, fetcher, reserve, attempt })
          : createOpenNewsFeedSearch({ now: () => now, fetcher, reserve, attempt });
      const topic = provider === "google" ? "generic safety" : provider === "publisher" ? "longevity-wellness" : "music";
      for (let read = 0; read < 2; read++) {
        const results = await search(topic, { freshness: "pd" });
        assert.equal(results.length, 1, `${provider}: rejected metadata cannot hide valid item 101`);
        assert.equal(results[0].url, valid.url);
      }
      assert.equal(calls, 1, `${provider}: accepted pool is cached`);
    }

    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response(feed(Array.from({ length: 105 }, (_, index) => ({
        ...valid, url: provider === "open-news" ? `https://globalvoices.org/2026/10/05/offline-pool-${index}/` : `${good}-${index}`,
      }))));
    };
    const search = provider === "google" ? createPublicFeedSearch(() => now, { fetcher, reserve, attempt })
      : provider === "publisher" ? createPublisherFeedSearch({ now: () => now, fetcher, reserve, attempt })
        : createOpenNewsFeedSearch({ now: () => now, fetcher, reserve, attempt });
    const topic = provider === "google" ? "generic safety" : provider === "publisher" ? "longevity-wellness" : "music";
    assert.equal((await search(topic, { freshness: "pd" })).length, 100, `${provider}: usable pool retains hard cap`);
    assert.equal((await search(topic, { freshness: "pd" })).length, 100);
    assert.equal(calls, 1);

    const olderItem = provider === "open-news"
      ? { url: "https://globalvoices.org/2026/10/03/offline-older/", date: older } : { ...valid, date: older };
    let windowCalls = 0;
    const windowFetcher: typeof fetch = async () => { windowCalls++; return new Response(feed([olderItem, valid])); };
    const windows = provider === "google" ? createPublicFeedSearch(() => now, { fetcher: windowFetcher, reserve, attempt })
      : provider === "publisher" ? createPublisherFeedSearch({ now: () => now, fetcher: windowFetcher, reserve, attempt })
        : createOpenNewsFeedSearch({ now: () => now, fetcher: windowFetcher, reserve, attempt });
    assert.equal((await windows(topic, { freshness: "pd" })).length, 1);
    assert.equal((await windows(topic, { freshness: "pw" })).length, 2, `${provider}: narrow cache cannot poison wider fallback`);
    assert.equal((await windows(topic, { freshness: "pw" })).length, 2);
    assert.equal(windowCalls, provider === "google" ? 2 : 1,
      `${provider}: fixed-feed windows reuse one snapshot, Google keeps distinct upstream queries`);

    let clock = now;
    let maturityCalls = 0;
    const future = { ...valid, url: `${valid.url.replace(/\/$/, "")}-future${provider === "open-news" ? "/" : ""}`,
      date: new Date(now + 60_000).toUTCString() };
    const maturityFetcher: typeof fetch = async () => { maturityCalls++; return new Response(feed([valid, future])); };
    const maturity = provider === "google" ? createPublicFeedSearch(() => clock, { fetcher: maturityFetcher, reserve, attempt })
      : provider === "publisher" ? createPublisherFeedSearch({ now: () => clock, fetcher: maturityFetcher, reserve, attempt })
        : createOpenNewsFeedSearch({ now: () => clock, fetcher: maturityFetcher, reserve, attempt });
    assert.equal((await maturity(topic, { freshness: "pw" })).length, 1);
    clock += 120_000;
    assert.equal((await maturity(topic, { freshness: "pw" })).length, 2,
      `${provider}: publication time can mature while snapshot is cached`);
    assert.equal(maturityCalls, 1);

    for (const emptyItem of [undefined, provider === "open-news" ? { ...valid, author: "" }
      : provider === "publisher" ? { ...valid, url: "https://wrong.example.test/offline-empty" }
        : { ...valid, date: "" }]) {
      let emptyClock = now;
      let emptyCalls = 0;
      const emptyFetcher: typeof fetch = async () => {
        emptyCalls++;
        return new Response(feed(emptyCalls === 1 ? emptyItem ? [emptyItem] : [] : [valid]));
      };
      const empty = provider === "google" ? createPublicFeedSearch(() => emptyClock, { fetcher: emptyFetcher, reserve, attempt })
        : provider === "publisher" ? createPublisherFeedSearch({ now: () => emptyClock, fetcher: emptyFetcher, reserve, attempt })
          : createOpenNewsFeedSearch({ now: () => emptyClock, fetcher: emptyFetcher, reserve, attempt });
      assert.equal((await empty(topic, { freshness: "pw" })).length, 0);
      emptyClock += 59_000;
      assert.equal((await empty(topic, { freshness: "pw" })).length, 0);
      assert.equal(emptyCalls, 1);
      emptyClock += 2_000;
      assert.equal((await empty(topic, { freshness: "pw" })).length, 1,
        `${provider}: empty or unusable snapshot expires after one minute`);
      assert.equal(emptyCalls, 2);
    }
  }
  assert.equal(forbidden, 0);
  console.log("PASS valid feed pools, later usable siblings, bounded shared snapshots and publication-time rechecks (offline)");
} finally {
  globalThis.fetch = oldFetch;
  for (const [flag, value] of saved) {
    if (value === undefined) delete process.env[flag];
    else process.env[flag] = value;
  }
}
