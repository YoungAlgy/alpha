// Offline source resolution/formatting. No real letters, users or database.
import assert from "node:assert/strict";
const names = ["ALPHA_NO_KEY_SOURCES", "ALPHA_NO_MODEL_MODE", "ALPHA_ALLOW_PAID_AI", "ALPHA_PUBLISHER_FEED_FALLBACK", "ALPHA_GDELT_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET"];
const env = new Map(names.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const warnings: string[] = [];
const counts = { google: 0, fda: 0, nist: 0, unexpected: 0 };
console.warn = (...args) => { warnings.push(args.join(" ")); };
const date = new Date(Date.now() - 60000).toUTCString();
const xml = (host: string, titles: string[]) => `<rss><channel>${titles.map((title, n) => `<item><title>${title}</title><link>https://${host}/offline-fixture-${n}</link><pubDate>${date}</pubDate></item>`).join("")}</channel></rss>`;
try {
  process.env.ALPHA_NO_KEY_SOURCES = "1";
  process.env.ALPHA_NO_MODEL_MODE = "1";
  process.env.ALPHA_ALLOW_PAID_AI = "0";
  process.env.ALPHA_PUBLISHER_FEED_FALLBACK = "1";
  process.env.ALPHA_GDELT_FALLBACK = "0";
  delete process.env.ALPHA_DURABLE_SOURCE_BUDGET;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    if (url.hostname === "news.google.com" && url.pathname === "/rss/search") { counts.google++; return new Response(null, { status: 503 }); }
    if (url.href === "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/medwatch/rss.xml") {
      counts.fda++;
      return new Response(xml("www.fda.gov", ["Medical device recall", "Infant medicine safety notice"]));
    }
    if (url.href === "https://www.nist.gov/news-events/news/rss.xml") {
      counts.nist++;
      return new Response(xml("www.nist.gov", ["Construction safety research update", "Unrelated electronics update"]));
    }
    counts.unexpected++;
    throw new Error("unexpected network call blocked");
  }) as typeof fetch;
  const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
  const { generateTopicBlurb } = await import("../lib/engine/topic-blurb.ts");
  const { normalizeUrl } = await import("../lib/engine/url-guard.ts");
  const issueDate = new Date().toISOString().slice(0, 10);
  const excluded = normalizeUrl("https://www.fda.gov/offline-fixture-0")!;
  const health = await resolveTopicSignal("longevity-wellness", issueDate, { freshness: "pd", excludeUrls: new Set([excluded]) });
  assert.ok(health);
  assert.equal(health.citableUrls?.size, 1);
  assert.ok(!health.citableUrls?.has(excluded));
  const blurb = await generateTopicBlurb("longevity-wellness", issueDate, health);
  assert.equal(blurb.items.length, 1);
  assert.match(blurb.items[0].headline, /FDA MedWatch/);
  assert.ok(blurb.items[0].primaryRef?.url.endsWith("offline-fixture-1"));
  assert.deepEqual(counts, { google: 3, fda: 1, nist: 0, unexpected: 0 });
  const other = await resolveTopicSignal("longevity-wellness", issueDate, { freshness: "pd", excludeUrls: new Set() });
  assert.equal(other?.citableUrls?.size, 2);
  assert.deepEqual(counts, { google: 3, fda: 1, nist: 0, unexpected: 0 }, "Google cooldown and raw publisher cache prevent repeated requests");
  const construction = await resolveTopicSignal("real-estate", issueDate, { freshness: "pd" });
  assert.equal(construction?.citableUrls?.size, 1);
  assert.match(construction?.sources?.[0]?.title ?? "", /NIST/);
  assert.deepEqual(counts, { google: 3, fda: 1, nist: 1, unexpected: 0 });
  assert.equal(await resolveTopicSignal("custom:PRIVATE_TEST_TOPIC", issueDate, { freshness: "pd" }), undefined);
  assert.equal(counts.unexpected, 0);
  assert.ok(warnings.every((line) => !line.includes("PRIVATE_TEST_TOPIC")), "custom topic text does not reach source-failure diagnostics");
  console.log("PASS Google outage to independent publisher chain, exclusions, privacy and no-model formatting (offline)");
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  for (const name of names) { const value = env.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}
