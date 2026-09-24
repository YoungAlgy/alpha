// Offline integration check for the no-model source ladder. All URLs and
// responses below are test-only fixtures. No subscriber or provider is used.
import assert from "node:assert/strict";
import type { BraveQuotaState } from "../lib/brave.ts";
import { normalizeUrl } from "../lib/engine/url-guard.ts";

type FetchHandler = (url: URL) => Response;
const envNames = [
  "ALPHA_NO_MODEL_MODE", "ALPHA_ALLOW_PAID_AI", "ALPHA_PUBLIC_FEED_FALLBACK",
  "BRAVE_SEARCH_API_KEY", "YOU_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY",
  "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY",
] as const;
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]] as const));
const originalFetch = globalThis.fetch;
let unexpectedFetches = 0;
let handler: FetchHandler = () => { throw new Error("scenario not installed"); };
const requests: string[] = [];

// Install the complete network fence BEFORE importing resolver or writer code.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  requests.push(url.hostname);
  const expectedPaths = new Map([
    ["api.search.brave.com", "/res/v1/web/search"],
    ["ydc-index.io", "/v1/search"],
    ["news.google.com", "/rss/search"],
  ]);
  if (expectedPaths.get(url.hostname) !== url.pathname) {
    unexpectedFetches++;
    throw new Error(`unexpected offline fetch destination: ${url.hostname}${url.pathname}`);
  }
  assert.ok(init?.signal instanceof AbortSignal, "all search requests stay timeout-bound");
  try {
    return handler(url);
  } catch (error) {
    unexpectedFetches++;
    throw error;
  }
}) as typeof fetch;

const rssXml = `<?xml version="1.0"?><rss><channel>
  <item><title>Alpha research &amp; new findings</title>
    <link>https://www.reuters.com/world/alpha-research-example</link>
    <description>Researchers published a current result.</description>
    <pubDate>Thu, 24 Sep 2026 10:00:00 GMT</pubDate></item>
  <item><title>Duplicate research result</title>
    <link>https://www.reuters.com/world/alpha-research-example?utm_source=fixture</link>
    <description>The same article with tracking.</description></item>
  <item><title>Another current finding</title>
    <link>https://apnews.com/article/alpha-research-example</link>
    <description>An independent current report.</description></item>
</channel></rss>`;

function setScenario(feedEnabled: boolean, nextHandler: FetchHandler): void {
  for (const name of envNames) delete process.env[name];
  process.env.ALPHA_NO_MODEL_MODE = "1";
  process.env.ALPHA_ALLOW_PAID_AI = "0";
  process.env.BRAVE_SEARCH_API_KEY = "offline-brave";
  process.env.YOU_API_KEY = "offline-you";
  // Configured model tiers must still be skipped, not just absent.
  process.env.GEMINI_API_KEY = "offline-gemini";
  process.env.GROQ_API_KEY = "offline-groq";
  if (feedEnabled) process.env.ALPHA_PUBLIC_FEED_FALLBACK = "1";
  requests.length = 0;
  handler = nextHandler;
}

function counts(): [number, number, number] {
  return [
    requests.filter((host) => host === "api.search.brave.com").length,
    requests.filter((host) => host === "ydc-index.io").length,
    requests.filter((host) => host === "news.google.com").length,
  ];
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function exhaustedThenFeed(feed: Response): FetchHandler {
  return (url) => {
    if (url.hostname === "api.search.brave.com") return new Response("offline monthly cap", { status: 402 });
    if (url.hostname === "ydc-index.io") return new Response("offline rate limit", { status: 429 });
    return feed.clone();
  };
}

try {
  const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
  const { generateTopicBlurb } = await import("../lib/engine/topic-blurb.ts");

  setScenario(true, exhaustedThenFeed(new Response(rssXml, { status: 200 })));
  const signal = await resolveTopicSignal("ai-news", "2026-09-24", { liveOnly: true });
  assert.ok(signal, "RSS must recover an exhausted Brave and You.com search");
  assert.deepEqual(counts(), [3, 3, 3], "each tier gets exactly the three topic queries");
  const allowed = signal.citableUrls;
  assert.ok(allowed);
  assert.deepEqual([...allowed].sort(), [
    normalizeUrl("https://www.reuters.com/world/alpha-research-example"),
    normalizeUrl("https://apnews.com/article/alpha-research-example"),
  ].sort(), "RSS links are allowed and tracking duplicates collapse");
  const blurb = await generateTopicBlurb("ai-news", "2026-09-24", signal);
  assert.equal(blurb.items.length, 2);
  assert.deepEqual(blurb.items.map((item) => item.primaryRef?.url), [
    "https://www.reuters.com/world/alpha-research-example",
    "https://apnews.com/article/alpha-research-example",
  ]);
  assert.match(blurb.items[0]?.headline ?? "", /research & new findings/);
  assert.deepEqual(counts(), [3, 3, 3], "deterministic writing makes no more requests");

  // Real Google News RSS links are aggregator wrappers, with thin descriptions.
  // Keep this shape explicit: it shares one host and therefore the host cap.
  const wrapperFeed = `<rss><channel>${[1,2,3].map((n) => `<item>
    <title>Public news fixture ${n} - Publisher</title>
    <link>https://news.google.com/rss/articles/offline-fixture-${n}?oc=5</link>
    <description>&lt;a href=&quot;https://news.google.com/rss/articles/offline-fixture-${n}?oc=5&quot;&gt;Public news fixture ${n}&lt;/a&gt; Publisher</description>
  </item>`).join("")}</channel></rss>`;
  setScenario(true, exhaustedThenFeed(new Response(wrapperFeed)));
  const wrappedSignal = await resolveTopicSignal("ai-news", "2026-09-24", { liveOnly: true });
  assert.ok(wrappedSignal);
  const wrappedBlurb = await generateTopicBlurb("ai-news", "2026-09-24", wrappedSignal);
  assert.equal(wrappedBlurb.items.length, 2, "aggregator sources retain the existing two-per-host ceiling");
  assert.ok(wrappedBlurb.items.every((item) => item.primaryRef?.url.startsWith("https://news.google.com/rss/articles/")));
  assert.ok(wrappedBlurb.items.every((item) => !/<a|https?:/.test(item.body)));
  assert.deepEqual(counts(), [3,3,3]);

  setScenario(false, exhaustedThenFeed(new Response(rssXml, { status: 200 })));
  assert.equal(await resolveTopicSignal("ai-news", "2026-09-24", { liveOnly: true }), undefined);
  assert.deepEqual(counts(), [3, 3, 0], "disabled RSS is never contacted");

  for (const feed of [
    new Response("offline feed outage", { status: 503 }),
    new Response("<rss><channel></channel></rss>", { status: 200 }),
  ]) {
    setScenario(true, exhaustedThenFeed(feed));
    assert.equal(await resolveTopicSignal("ai-news", "2026-09-24", { liveOnly: true }), undefined);
    assert.deepEqual(counts(), [3, 3, 3], "failed or empty RSS stays a bounded miss");
  }

  setScenario(true, (url) => {
    if (url.hostname === "api.search.brave.com") return json({ web: { results: [] } });
    throw new Error("healthy-empty Brave must leave this topic quiet");
  });
  assert.equal(await resolveTopicSignal("ai-news", "2026-09-24", { liveOnly: true }), undefined);
  assert.deepEqual(counts(), [3, 0, 0]);

  setScenario(true, (url) => {
    if (url.hostname === "api.search.brave.com") return new Response("offline monthly cap", { status: 402 });
    if (url.hostname === "ydc-index.io") return json({ results: { web: [{
      url: "https://apnews.com/article/you-success-example",
      title: "Independent search result",
      description: "A current report from You.com search.",
      page_age: "1 day ago",
    }] } });
    throw new Error("RSS must not run after You.com succeeds");
  });
  const viaYou = await resolveTopicSignal("ai-news", "2026-09-24", { liveOnly: true });
  assert.ok(viaYou?.citableUrls?.has(normalizeUrl("https://apnews.com/article/you-success-example")!));
  assert.deepEqual(counts(), [3, 3, 0]);

  // A confirmed monthly quota is shared across topics and wider retries only
  // in this caller's batch. The complete source ladder still reaches RSS.
  const monthlyState: BraveQuotaState = { monthlyExhausted: false };
  setScenario(true, (url) => {
    if (url.hostname === "api.search.brave.com") return new Response(JSON.stringify({
      error: { code: "USAGE_LIMIT_EXCEEDED", meta: { usage_limit_type: "monthly" } },
    }), { status: 402 });
    if (url.hostname === "ydc-index.io") return new Response("offline rate limit", { status: 429 });
    return new Response(rssXml);
  });
  assert.ok(await resolveTopicSignal("ai-news", "2026-09-24", {
    liveOnly: true, freshness: "pd", quotaState: monthlyState,
  }));
  assert.equal(monthlyState.monthlyExhausted, true);
  assert.deepEqual(counts(), [3, 3, 3], "initial parallel wave learns the monthly cap");
  assert.ok(await resolveTopicSignal("custom:research", "2026-09-24", {
    liveOnly: true, quotaState: monthlyState,
  }));
  assert.deepEqual(counts(), [3, 6, 6], "later topic skips Brave and still reaches RSS");
  assert.ok(await resolveTopicSignal("ai-news", "2026-09-24", {
    liveOnly: true, freshness: "pw", quotaState: monthlyState,
  }));
  assert.deepEqual(counts(), [3, 9, 9], "wider retry shares the same quota verdict");
  assert.ok(await resolveTopicSignal("ai-news", "2026-09-24", {
    liveOnly: true, quotaState: { monthlyExhausted: false },
  }));
  assert.deepEqual(counts(), [6, 12, 12], "fresh batch probes Brave again");

  // An unrelated in-flight topic's quota result must not discard good results.
  let waveRequests = 0;
  const partialState: BraveQuotaState = { monthlyExhausted: false };
  setScenario(true, (url) => {
    if (url.hostname !== "api.search.brave.com") throw new Error("partial success must stay usable");
    waveRequests++;
    if (waveRequests === 1) return new Response(JSON.stringify({
      code: "USAGE_LIMIT_EXCEEDED", meta: { usage_limit_type: "monthly" },
    }), { status: 402 });
    return json({ web: { results: [{
      title: "Offline research result", url: "https://apnews.com/article/offline-partial-success",
      description: "An offline fixture of a usable search result.",
    }] } });
  });
  assert.ok(await resolveTopicSignal("ai-news", "2026-09-24", { quotaState: partialState }));
  assert.equal(partialState.monthlyExhausted, true);
  assert.deepEqual(counts(), [3, 0, 0], "successful in-flight results stop the fallback chain");
  assert.equal(unexpectedFetches, 0, "no hidden model, deep-read, or unexpected request was swallowed");
  console.log("PASS verify-public-feed-failover (offline no-model source ladder)");
} finally {
  globalThis.fetch = originalFetch;
  for (const name of envNames) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
