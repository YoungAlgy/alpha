// Offline calendar fixtures only. No environment loader, DB or real source call.
import assert from "node:assert/strict";
import { freshPublicResults, parsePublicSourceTimestamp } from "../lib/engine/public-source-freshness.ts";
import { createPublicFeedSearch } from "../lib/engine/public-feed-search.ts";
import { createPublisherFeedSearch } from "../lib/engine/publisher-feed-search.ts";
import { createGdeltSearch } from "../lib/engine/gdelt-search.ts";
import type { PublicSourceAttempt } from "../lib/engine/public-source-circuit.ts";

const now = Date.UTC(2026, 2, 2, 13);
const item = { title: "Medical device safety recall", url: "https://www.fda.gov/offline-calendar-fixture", description: "" };
const invalid = [
  "Mon, 30 Feb 2026 12:00:00 GMT",
  "2026-02-30T12:00:00Z",
  "Sun, 29 Feb 2026 12:00:00 +0000",
  "2026-03",
  "2026-03-02",
  "2026-03-02T12:00:00",
  "Mon, 02 Mar 2026 12:00:00",
  "Mon, 02 Mar 2026 24:00:00 GMT",
  "2026-03-02T12:60:00Z",
  "2026-03-02T12:00:60Z",
  "2026-03-02T12:00:00+24:00",
  "Mon, 02 Mar 2026 12:00:00 +0060",
  "2026-04-31T12:00:00Z",
  "2100-02-29T12:00:00Z",
];
const valid = [
  "Mon, 02 Mar 2026 12:00:00 GMT",
  "02 Mar 2026 12:00:00 +0000",
  "Mon, 02 Mar 2026 07:00:00 EST",
  "Mon, 02 Mar 2026 12:00 GMT",
  "2026-03-02T12:00:00.000Z",
  "2026-03-02T07:00:00-05:00",
  "2026-03-02T12:00:00+0000",
  "2026-03-02T00:30:00+02:00",
];
const oldFetch = globalThis.fetch;
let forbidden = 0;
globalThis.fetch = async () => { forbidden++; throw new Error("network denied"); };
const attempt: PublicSourceAttempt = async (_provider, reserve, work) => { await reserve(); return work(); };
const reserve = async () => {};
const rss = (dates: string[]) => `<rss><channel>${dates.map((age, index) =>
  `<item><title>${item.title} ${index}</title><link>${item.url}-${index}</link><pubDate>${age}</pubDate></item>`
).join("")}</channel></rss>`;
try {
  for (const value of [undefined, null, 0, {}, "", " ", "a".repeat(129)]) {
    assert.ok(Number.isNaN(parsePublicSourceTimestamp(value)), "non-timestamps cannot supply freshness");
  }
  for (const age of invalid) {
    assert.ok(Number.isNaN(parsePublicSourceTimestamp(age)), `invalid timestamp must be rejected: ${age}`);
    assert.equal(freshPublicResults([{ ...item, age }], "pd", now).length, 0,
      `malformed calendar or incomplete timestamp must not become current: ${age}`);
  }
  for (const age of valid) {
    assert.equal(freshPublicResults([{ ...item, age }], "pd", now).length, 1,
      `valid explicit-zone timestamp must survive: ${age}`);
  }
  const leapNow = Date.UTC(2024, 1, 29, 13);
  assert.equal(freshPublicResults([{ ...item, age: "Thu, 29 Feb 2024 12:00:00 GMT" }], "pd", leapNow).length, 1);
  assert.equal(freshPublicResults([{ ...item, age: "2024-02-29T12:00:00Z" }], "pd", leapNow).length, 1);
  assert.equal(parsePublicSourceTimestamp("2026-03-02T07:00:00-05:00"), Date.UTC(2026, 2, 2, 12));
  assert.equal(parsePublicSourceTimestamp("2026-03-02T00:30:00+02:00"), Date.UTC(2026, 2, 1, 22, 30));
  assert.equal(parsePublicSourceTimestamp("2026-03-02T23:30:00-02:00"), Date.UTC(2026, 2, 3, 1, 30));
  assert.equal(parsePublicSourceTimestamp("2026-03-02T12:00:00.123456Z"), Date.UTC(2026, 2, 2, 12, 0, 0, 123));
  assert.equal(parsePublicSourceTimestamp("Thu, 01 Jan 0099 00:00:00 GMT"),
    Date.parse("0099-01-01T00:00:00Z"), "four-digit early years cannot silently acquire a different century");
  for (const [age, expected] of [
    ["2026-03-02T14:00:00+02:00", 1],
    ["2026-03-02T08:00:00-06:00", 0],
    ["Mon, 02 Mar 2026 08:00:00 -0600", 0],
    ["2026-03-01T14:00:00+02:00", 0],
  ] as const) {
    assert.equal(freshPublicResults([{ ...item, age }], "pd", now).length, expected,
      `the actual UTC instant determines freshness: ${age}`);
  }

  // The same raw pool can retain good siblings while dropping invalid dates.
  // A cached result is rechecked rather than promoted by Date.parse rollover.
  for (const label of ["google", "publisher", "gdelt"] as const) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return new Response(rss([invalid[0], valid[0]])); };
    const search = label === "google"
      ? createPublicFeedSearch(() => now, { fetcher, reserve, attempt })
      : label === "publisher"
        ? createPublisherFeedSearch({ now: () => now, fetcher, reserve, attempt })
        : createGdeltSearch({ now: () => now, fetcher, reserve, attempt });
    const query = label === "google" || label === "gdelt" ? "generic health news" : "longevity-wellness";
    for (let read = 0; read < 2; read++) {
      const results = await search(query, { freshness: "pd" });
      assert.equal(results.length, 1, `${label}: malformed date cannot crowd out good metadata`);
      assert.equal(results[0].url, `${item.url}-1`);
      assert.equal(results[0].age, valid[0]);
    }
    assert.equal(calls, 1, `${label}: second read reuses the raw pool`);

    const emptyFetcher: typeof fetch = async () => new Response(rss([invalid[0]]));
    const malformedOnly = label === "google"
      ? createPublicFeedSearch(() => now, { fetcher: emptyFetcher, reserve, attempt })
      : label === "publisher"
        ? createPublisherFeedSearch({ now: () => now, fetcher: emptyFetcher, reserve, attempt })
        : createGdeltSearch({ now: () => now, fetcher: emptyFetcher, reserve, attempt });
    assert.deepEqual(await malformedOnly(query, { freshness: "pd" }), [],
      `${label}: malformed-only feed leaves no false usable signal`);
  }
  assert.equal(forbidden, 0);
  console.log("PASS public source calendar, explicit zones, leap dates, partial preservation and cached adapter filtering (offline)");
} finally { globalThis.fetch = oldFetch; }
