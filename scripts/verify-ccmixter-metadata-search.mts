// All ccMixter responses are local fixtures. A global fetch call is a test failure.
import assert from "node:assert/strict";
import { createCcmixterMetadataSearch, ccmixterMetadataFallbackEnabled } from "../lib/engine/ccmixter-metadata-search.ts";
import { MAX_PUBLIC_SOURCE_BYTES } from "../lib/engine/public-source-response.ts";
import { PublicSourceBudgetError } from "../lib/engine/public-source-budget.ts";
import type { PublicSourceAttempt } from "../lib/engine/public-source-circuit.ts";

let checks = 0;
function eq(actual: unknown, expected: unknown): void { checks++; assert.deepEqual(actual, expected); }
async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  checks++; await assert.rejects(promise, pattern);
}
const fixedUrl = "https://ccmixter.org/api/query?f=rss&reqtags=remix&tags=hip_hop&sort=date&limit=10";
const fixedNow = Date.UTC(2026, 9, 8, 12);
const track = (fields: Record<string, string> = {}) => {
  const value = {
    title: "Fresh Tampa beat", link: "https://ccmixter.org/files/beat_maker/12345",
    pubDate: "Wed, 07 Oct 2026 16:00:00 GMT", creator: "Beat Maker",
    category: "hip_hop,remix", extra: "", ...fields,
  };
  return `<item><title>${value.title}</title><link>${value.link}</link><pubDate>${value.pubDate}</pubDate>` +
    `<dc:creator>${value.creator}</dc:creator><category>${value.category}</category>${value.extra}` +
    `<description>Do not quote this description</description><enclosure url="https://example.com/audio.mp3"/></item>`;
};
const feed = (...items: string[]) => `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>${items.join("")}</channel></rss>`;
const response = (xml = feed(track()), headers: Record<string, string> = {}) =>
  new Response(xml, { headers: { "content-type": "application/rss+xml; charset=UTF-8", ...headers } });
const offlineAttempt: PublicSourceAttempt = async (_provider, reserve, work) => { await reserve(); return work(); };

const flags = ["ALPHA_NO_MODEL_MODE", "ALPHA_CCMIXTER_METADATA_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET", "ALPHA_DURABLE_SOURCE_COOLDOWN"];
const savedFlags = new Map(flags.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
let globalFetches = 0;
globalThis.fetch = (async () => { globalFetches++; throw new Error("network denied"); }) as typeof fetch;

try {
  for (const name of flags) delete process.env[name];
  eq(ccmixterMetadataFallbackEnabled(), false);
  for (const name of flags) process.env[name] = "1";
  eq(ccmixterMetadataFallbackEnabled(), true);
  for (const name of flags) {
    process.env[name] = "0";
    eq(ccmixterMetadataFallbackEnabled(), false);
    process.env[name] = "1";
  }
  let gatedFetches = 0;
  const gated = createCcmixterMetadataSearch({ now: () => fixedNow, reserve: async () => {},
    attempt: offlineAttempt, fetcher: async () => { gatedFetches++; return response(); } });
  delete process.env.ALPHA_CCMIXTER_METADATA_FALLBACK;
  eq(await gated("music-hiphop"), []);
  eq(gatedFetches, 0);
  process.env.ALPHA_CCMIXTER_METADATA_FALLBACK = "1";

  let clock = fixedNow;
  let calls = 0;
  let reserves = 0;
  let attempts = 0;
  const search = createCcmixterMetadataSearch({ now: () => clock,
    reserve: async provider => { reserves++; eq(provider, "ccmixter-uploads"); },
    attempt: async (provider, reserve, work) => {
      attempts++; eq(provider, "ccmixter-uploads"); await reserve(); return work();
    },
    fetcher: async (input, init) => {
      calls++;
      eq(String(input), fixedUrl);
      eq([init?.redirect, init?.credentials, init?.cache], ["error", "omit", "no-store"]);
      eq(init?.signal instanceof AbortSignal, true);
      eq(init?.method, undefined);
      eq(init?.body, undefined);
      eq(Object.keys((init?.headers ?? {}) as object), ["Accept"]);
      return response(feed(
        track({ title: "Fresh Tampa beat", extra: "<media:content url=\"https://example.com/media\"/>" }),
        track({ title: "Older beat", link: "https://ccmixter.org/files/older/22222", pubDate: "Wed, 30 Sep 2026 10:00:00 GMT" }),
        track({ title: "Later beat", link: "https://ccmixter.org/files/future/33333", pubDate: "Thu, 08 Oct 2026 12:02:00 GMT" }),
      ));
    },
  });
  for (const topic of ["", "music", "music-hiphop ", "custom:hip hop", "music-edm"]) eq(await search(topic), []);
  for (const freshness of ["py", "bad", "2026-02-30to2026-03-01", "2026-10-09to2026-10-10"]) {
    eq(await search("music-hiphop", { freshness: freshness as "pd" }), []);
  }
  eq([calls, reserves, attempts], [0, 0, 0]);
  const [today, week, month] = await Promise.all([
    search("music-hiphop", { freshness: "pd" }),
    search("music-hiphop", { freshness: "pw" }),
    search("music-hiphop", { freshness: "pm" }),
  ]);
  eq([today.length, week.length, month.length], [1, 1, 2]);
  eq([calls, reserves, attempts], [1, 1, 1]);
  eq(today[0], {
    title: "Community remix: Fresh Tampa beat", url: "https://ccmixter.org/files/beat_maker/12345",
    description: "Credited creator: Beat Maker. Uploaded to ccMixter 2026-10-07. Tagged hip-hop.",
    age: "2026-10-07T16:00:00.000Z",
  });
  eq(JSON.stringify(today).includes("description>"), false);
  eq(JSON.stringify(today).includes("audio.mp3"), false);
  eq(JSON.stringify(today).includes("media"), false);
  today[0]!.title = "mutated";
  eq((await search("music-hiphop", { freshness: "pd" }))[0]?.title, "Community remix: Fresh Tampa beat");
  eq((await search("music-hiphop", { freshness: "2026-09-30to2026-09-30" })).map(item => item.url),
    ["https://ccmixter.org/files/older/22222"]);
  clock = fixedNow + 3 * 60_000;
  eq((await search("music-hiphop", { freshness: "pd" })).map(item => item.url),
    ["https://ccmixter.org/files/beat_maker/12345", "https://ccmixter.org/files/future/33333"]);
  eq(calls, 1);

  // A bad record is discarded; no unverified media or metadata is synthesized.
  const badRecords = [
    track({ title: "" }), track({ creator: "" }), track({ pubDate: "2026-10-07" }),
    track({ pubDate: "Fri, 30 Feb 2026 10:00:00 GMT" }),
    track({ category: "hip_hop" }), track({ category: "remix" }),
    track({ category: "not_hip_hop,remix" }), track({ category: "hip_hop_remix" }),
    track({ category: "hip_hop,remix" + "x".repeat(201) }),
    track({ extra: "<category>hip_hop,remix</category>".repeat(20) }),
    track({ title: "x".repeat(301) }), track({ creator: "x".repeat(161) }),
    track({ creator: "", extra: "<author>Other name</author>" }),
    track({ link: "https://ccmixter.org.evil.test/files/beat_maker/12345" }),
    track({ link: "http://ccmixter.org/files/beat_maker/12345" }),
    track({ link: "https://ccmixter.org:443/files/beat_maker/12345" }),
    track({ link: "https://ccmixter.org/files/beat_maker/12345?download=1" }),
    track({ link: "https://ccmixter.org/files/beat_maker/12345#player" }),
    track({ link: "https://user@ccmixter.org/files/beat_maker/12345" }),
    track({ link: "https://ccmixter.org/files/beat_maker/12345/extra" }),
    track({ extra: "<title>Duplicate</title>" }),
    track({ extra: "<title></title>" }),
    track({ extra: "<link>https://ccmixter.org/files/other/11111</link>" }),
    track({ extra: "<pubDate>Wed, 07 Oct 2026 16:00:00 GMT</pubDate>" }),
    track({ extra: "<dc:creator>Another creator</dc:creator>" }),
  ];
  for (const bad of badRecords) {
    const check = createCcmixterMetadataSearch({ now: () => fixedNow,
      reserve: async () => {}, attempt: offlineAttempt, fetcher: async () => response(feed(bad)) });
    eq(await check("music-hiphop"), []);
  }
  const sanitizing = createCcmixterMetadataSearch({ now: () => fixedNow,
    reserve: async () => {}, attempt: offlineAttempt, fetcher: async () => response(feed(track({
      title: "&lt;b&gt;Beat&lt;/b&gt;", creator: "A &amp; B",
    }))) });
  eq((await sanitizing("music-hiphop"))[0]?.title, "Community remix: Beat");
  eq((await sanitizing("music-hiphop"))[0]?.description,
    "Credited creator: A & B. Uploaded to ccMixter 2026-10-07. Tagged hip-hop.");
  const cap = createCcmixterMetadataSearch({ now: () => fixedNow,
    reserve: async () => {}, attempt: offlineAttempt, fetcher: async () => response(feed(...Array.from({ length: 12 }, (_, i) =>
      track({ link: `https://ccmixter.org/files/maker/${10000 + i}` })))) });
  eq((await cap("music-hiphop")).length, 10);
  const dedupe = createCcmixterMetadataSearch({ now: () => fixedNow,
    reserve: async () => {}, attempt: offlineAttempt, fetcher: async () => response(feed(track(), track())) });
  eq((await dedupe("music-hiphop")).length, 1);
  // Feed admission follows the strict RSS envelope, not an unverified MIME
  // header. HTML still fails even when mislabeled as XML.
  const unverifiedHeader = createCcmixterMetadataSearch({ now: () => fixedNow,
    reserve: async () => {}, attempt: offlineAttempt,
    fetcher: async () => new Response(feed(track()), { headers: { "content-type": "text/plain" } }) });
  eq((await unverifiedHeader("music-hiphop")).length, 1);
  const mislabeledHtml = createCcmixterMetadataSearch({ now: () => fixedNow,
    reserve: async () => {}, attempt: offlineAttempt,
    fetcher: async () => response("<html><body>Not an RSS feed</body></html>") });
  await rejects(mislabeledHtml("music-hiphop"), /invalid feed/);

  for (const [make, pattern] of [
    [() => new Response("", { status: 503 }), /503/],
    [() => new Response("<html/>", { headers: { "content-type": "text/html" } }), /invalid feed/],
    [() => response("<rss>"), /invalid feed/],
    [() => response(feed(track()), { "content-length": String(MAX_PUBLIC_SOURCE_BYTES + 1) }), /too large/],
    [() => response("x".repeat(MAX_PUBLIC_SOURCE_BYTES + 1)), /too large/],
  ] as const) {
    let failures = 0;
    let failedAttempts = 0;
    const broken = createCcmixterMetadataSearch({ now: () => fixedNow, reserve: async () => {},
      attempt: async (_provider, reserve, work) => { failedAttempts++; await reserve(); return work(); },
      fetcher: async () => { failures++; return make(); } });
    await rejects(broken("music-hiphop"), pattern);
    await rejects(broken("music-hiphop"), /cooling down/);
    eq([failures, failedAttempts], [1, 1]);
  }
  let deniedFetches = 0;
  let deniedReserves = 0;
  const denied = createCcmixterMetadataSearch({ now: () => fixedNow,
    reserve: async () => { deniedReserves++; if (deniedReserves === 1) throw new PublicSourceBudgetError("exhausted", "ccmixter-uploads"); },
    attempt: offlineAttempt,
    fetcher: async () => { deniedFetches++; return response(); },
  });
  await rejects(denied("music-hiphop"), /budget exhausted/);
  eq(deniedFetches, 0);
  eq((await denied("music-hiphop")).length, 1);
  eq([deniedReserves, deniedFetches], [2, 1]);

  const empty = createCcmixterMetadataSearch({ now: () => fixedNow, reserve: async () => {},
    attempt: offlineAttempt,
    fetcher: async () => { emptyCalls++; return response(feed()); } });
  let emptyCalls = 0;
  eq(await empty("music-hiphop"), []);
  eq(await empty("music-hiphop"), []);
  eq(emptyCalls, 1);

  const originalTimeout = AbortSignal.timeout;
  const abort = new AbortController();
  let timeoutMs = 0;
  let cancelled = false;
  AbortSignal.timeout = ms => { timeoutMs = ms; return abort.signal; };
  try {
    const stalled = createCcmixterMetadataSearch({ now: () => fixedNow, reserve: async () => {},
      attempt: offlineAttempt,
      fetcher: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
        { headers: { "content-type": "application/rss+xml" } }),
    });
    const pending = stalled("music-hiphop");
    while (!timeoutMs) await Promise.resolve();
    eq(timeoutMs, 5000);
    abort.abort();
    await rejects(pending, /timed out/);
    eq(cancelled, true);
  } finally { AbortSignal.timeout = originalTimeout; }
  eq(globalFetches, 0);
  console.log(`PASS ccMixter metadata offline: ${checks} assertions`);
} finally {
  globalThis.fetch = originalFetch;
  for (const name of flags) {
    const saved = savedFlags.get(name);
    if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
  }
}
