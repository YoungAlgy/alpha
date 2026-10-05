// Offline integration check for explicit no-key search mode. All articles and
// URLs below are test-only fixtures. This script never contacts a real source.
import assert from "node:assert/strict";

type FetchHandler = (url: URL) => Response;
const envNames = [
  "ALPHA_NO_KEY_SOURCES", "ALPHA_GDELT_FALLBACK", "ALPHA_PUBLIC_FEED_FALLBACK",
  "ALPHA_PUBLISHER_FEED_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET",
  "ALPHA_NO_MODEL_MODE", "ALPHA_ALLOW_PAID_AI", "BRAVE_SEARCH_API_KEY",
  "YOU_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]] as const));
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let controlledNow = originalNow();
Date.now = () => controlledNow;
const requests: URL[] = [];
let unexpectedFetches = 0;
let handler: FetchHandler = () => { throw new Error("scenario not installed"); };

// Install the network fence before importing source resolver or writer code.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  const expectedPaths = new Map([
    ["news.google.com", "/rss/search"],
    ["api.gdeltproject.org", "/api/v2/doc/doc"],
  ]);
  requests.push(url);
  if (expectedPaths.get(url.hostname) !== url.pathname) {
    unexpectedFetches++;
    throw new Error(`unexpected offline fetch destination: ${url.hostname}${url.pathname}`);
  }
  assert.ok(init?.signal instanceof AbortSignal, "source requests stay timeout-bound");
  try {
    return handler(url);
  } catch (error) {
    unexpectedFetches++;
    throw error;
  }
}) as typeof fetch;

const currentDate = new Date(controlledNow).toISOString().slice(0, 10);
const currentPubDate = () => new Date(controlledNow - 60_000).toUTCString();
const apFixtureUrl = "https://apnews.com/article/alpha-offline-test-only-research";
const exampleFixtureUrl = "https://research.example.test/alpha/offline-fixture";
const priorFixtureUrl = "https://apnews.com/article/alpha-offline-test-only-prior";

function feedXml(items: Array<{ title: string; url: string; description?: string; date?: string }>): string {
  const entries = items.map((item) => `<item>
    <title>${item.title}</title><link>${item.url}</link>
    <description>${item.description ?? "Offline fixture description."}</description>
    <pubDate>${item.date ?? currentPubDate()}</pubDate>
  </item>`).join("");
  return `<?xml version="1.0"?><rss><channel>${entries}</channel></rss>`;
}

function xmlResponse(items: Array<{ title: string; url: string; description?: string; date?: string }>): Response {
  return new Response(feedXml(items), { status: 200, headers: { "Content-Type": "application/rss+xml" } });
}

function setScenario(options: {
  noKey?: string;
  gdelt?: string;
  legacyFeed?: string;
  nextHandler: FetchHandler;
}): void {
  controlledNow += 16 * 60_000;
  for (const name of envNames) delete process.env[name];
  process.env.ALPHA_NO_MODEL_MODE = "1";
  process.env.ALPHA_ALLOW_PAID_AI = "0";
  process.env.BRAVE_SEARCH_API_KEY = "offline-brave-key";
  process.env.YOU_API_KEY = "offline-you-key";
  process.env.GEMINI_API_KEY = "offline-gemini-key";
  process.env.GROQ_API_KEY = "offline-groq-key";
  process.env.DEEPSEEK_API_KEY = "offline-deepseek-key";
  process.env.ANTHROPIC_API_KEY = "offline-anthropic-key";
  if (options.noKey !== undefined) process.env.ALPHA_NO_KEY_SOURCES = options.noKey;
  if (options.gdelt !== undefined) process.env.ALPHA_GDELT_FALLBACK = options.gdelt;
  if (options.legacyFeed !== undefined) process.env.ALPHA_PUBLIC_FEED_FALLBACK = options.legacyFeed;
  requests.length = 0;
  handler = options.nextHandler;
}

function counts(): [number, number] {
  return [
    requests.filter((url) => url.hostname === "news.google.com").length,
    requests.filter((url) => url.hostname === "api.gdeltproject.org").length,
  ];
}

try {
  const { noKeySourcesEnabled } = await import("../lib/engine/provider-policy.ts");
  const { publicFeedFallbackEnabled } = await import("../lib/engine/public-feed-search.ts");
  const { normalizeUrl } = await import("../lib/engine/url-guard.ts");
  const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
  const { generateTopicBlurb } = await import("../lib/engine/topic-blurb.ts");
  const { readFile } = await import("node:fs/promises");

  const workflow = await readFile(new URL("../.github/workflows/daily-send.yml", import.meta.url), "utf8");
  const preflight = await readFile(new URL("./verify-send-preflight.mjs", import.meta.url), "utf8");
  const privacy = await readFile(new URL("../app/privacy/page.tsx", import.meta.url), "utf8");
  const occurrences = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].length;
  assert.equal(occurrences(workflow, /ALPHA_NO_KEY_SOURCES:\s*\$\{\{\s*vars\.SEND_ALPHA_NO_KEY_SOURCES\s*\}\}/g), 2,
    "workflow passes the no-key source setting to preflight and runtime");
  assert.equal(occurrences(workflow, /ALPHA_GDELT_FALLBACK:\s*\$\{\{\s*vars\.SEND_ALPHA_GDELT_FALLBACK\s*\}\}/g), 2,
    "workflow passes the GDELT setting to preflight and runtime");
  assert.match(preflight, /enabled\("ALPHA_NO_KEY_SOURCES"\)/, "preflight reads the no-key source setting");
  assert.match(preflight, /enabled\("ALPHA_GDELT_FALLBACK"\)/, "preflight reads the GDELT setting");
  assert.match(privacy, /Google News RSS and GDELT provide public-source backups/);
  assert.match(privacy, /They receive a topic search, including the text of a custom topic/);
  assert.match(privacy, /We do not attach your account identity\s+or other profile fields/);

  // The explicit flag is opt-in, case/whitespace tolerant, and forces public
  // RSS on even when the older RSS flag is disabled.
  for (const value of ["1", "true", "yes"]) {
    setScenario({ noKey: value, legacyFeed: "0", nextHandler: () => xmlResponse([]) });
    assert.equal(noKeySourcesEnabled(), true);
    assert.equal(publicFeedFallbackEnabled(), true);
  }
  setScenario({ noKey: "  TRUE ", legacyFeed: "0", nextHandler: () => xmlResponse([]) });
  assert.equal(noKeySourcesEnabled(), true);
  assert.equal(publicFeedFallbackEnabled(), true);
  setScenario({ noKey: "0", legacyFeed: "0", nextHandler: () => xmlResponse([]) });
  assert.equal(noKeySourcesEnabled(), false);
  assert.equal(publicFeedFallbackEnabled(), false, "legacy RSS remains off outside no-key mode");

  // A usable Google RSS signal wins. Configured API keys do not trigger any
  // keyed provider, grounded model, paid writer, or deep-read request.
  setScenario({
    noKey: "1",
    gdelt: "1",
    legacyFeed: "0",
    nextHandler: (url) => {
      assert.equal(url.hostname, "news.google.com");
      return xmlResponse([
        { title: "Artificial research: a fresh result", url: apFixtureUrl, description: "A current AP test fixture." },
        { title: "Research update from an example source", url: exampleFixtureUrl, description: "A second offline fixture." },
      ]);
    },
  });
  const signal = await resolveTopicSignal("ai-news", currentDate, { liveOnly: true, freshness: "pd" });
  assert.ok(signal, "Google RSS should produce a usable source signal");
  assert.match(signal.context, /Headlines and snippets only this period/);
  assert.doesNotMatch(signal.context, /READ IN FULL|ACTUAL article text|ARTICLE TEXT:/);
  assert.ok(counts()[0] > 0);
  assert.equal(counts()[1], 0, "GDELT waits until Google RSS has no usable signal");
  const citable = new Set(signal.citableUrls);
  assert.ok(citable.has(normalizeUrl(apFixtureUrl)!));
  assert.ok(citable.has(normalizeUrl(exampleFixtureUrl)!));
  const blurb = await generateTopicBlurb("ai-news", currentDate, signal);
  assert.ok(blurb.items.length > 0, "no-model mode formats the live sources locally");
  assert.ok(blurb.items.every((item) => item.primaryRef?.url && citable.has(normalizeUrl(item.primaryRef.url)!)));
  assert.ok(blurb.items.some((item) => item.primaryRef?.url === apFixtureUrl));
  assert.equal(unexpectedFetches, 0, "no keyed search, AI, deep-read, or other external call was attempted");

  // A healthy-empty Google response is not a source. With GDELT disabled the
  // resolver returns undefined and never contacts the GDELT endpoint.
  setScenario({
    noKey: "true",
    gdelt: "0",
    nextHandler: (url) => {
      assert.equal(url.hostname, "news.google.com");
      return xmlResponse([]);
    },
  });
  assert.equal(await resolveTopicSignal("ai-news", currentDate, { liveOnly: true, freshness: "pd" }), undefined);
  assert.ok(counts()[0] > 0);
  assert.equal(counts()[1], 0, "GDELT stays off unless its explicit flag is enabled");
  assert.equal(unexpectedFetches, 0);

  // Explicit GDELT opt-in runs one topic query after Google RSS misses. It
  // returns only dated test RSS links, and the prior-citation exclusion is
  // applied before the result can enter the citable set or deterministic copy.
  let gdeltQueryCount = 0;
  setScenario({
    noKey: "1",
    gdelt: "yes",
    legacyFeed: "0",
    nextHandler: (url) => {
      if (url.hostname === "news.google.com") return xmlResponse([]);
      assert.equal(url.hostname, "api.gdeltproject.org");
      gdeltQueryCount++;
      assert.match(url.searchParams.get("query") ?? "", /artificial intelligence/i, "ai-news maps to a topic query");
      assert.equal(url.searchParams.get("mode"), "artlist");
      return xmlResponse([
        { title: "Prior cited artificial intelligence result", url: priorFixtureUrl },
        { title: "New artificial intelligence research result", url: apFixtureUrl },
      ]);
    },
  });
  const excluded = new Set([normalizeUrl(priorFixtureUrl)!]);
  const viaGdelt = await resolveTopicSignal("ai-news", currentDate, {
    liveOnly: true,
    freshness: "pd",
    excludeUrls: excluded,
  });
  assert.ok(viaGdelt, "opt-in GDELT should recover the topic with a current feed item");
  assert.match(viaGdelt.context, /Headlines and snippets only this period/);
  assert.match(viaGdelt.context, /No source snippet supplied/);
  assert.doesNotMatch(viaGdelt.context, /READ IN FULL|ACTUAL article text|ARTICLE TEXT:/);
  assert.equal(gdeltQueryCount, 1, "GDELT is queried once per topic after Google RSS misses");
  assert.equal(counts()[1], 1);
  assert.ok(viaGdelt.context.includes(currentPubDate()), "the GDELT item retains its current source timestamp");
  const gdeltCitable = new Set(viaGdelt.citableUrls);
  assert.ok(gdeltCitable.has(normalizeUrl(apFixtureUrl)!));
  assert.ok(!gdeltCitable.has(normalizeUrl(priorFixtureUrl)!), "old links stay excluded");
  const gdeltBlurb = await generateTopicBlurb("ai-news", currentDate, viaGdelt);
  assert.ok(gdeltBlurb.items.some((item) => item.primaryRef?.url === apFixtureUrl));
  assert.ok(gdeltBlurb.items.every((item) => item.primaryRef?.url && gdeltCitable.has(normalizeUrl(item.primaryRef.url)!)));
  assert.ok(!gdeltBlurb.items.some((item) => item.primaryRef?.url === priorFixtureUrl));
  assert.ok(gdeltBlurb.items.every((item) => !/https?:\/\//i.test(`${item.headline} ${item.body}`)), "formatter does not invent prose URLs");

  // The GDELT cache must retain the raw topic results, not the first reader's
  // filtered list. A second reader with a different exclusion set can cite
  // the prior item without another provider request. Raw Google and GDELT
  // results are shared briefly, while filtering stays reader-specific.
  const googleCallsAfterFirstReader = counts()[0];
  const secondReaderSignal = await resolveTopicSignal("ai-news", currentDate, {
    liveOnly: true,
    freshness: "pd",
    excludeUrls: new Set(),
  });
  assert.ok(secondReaderSignal);
  assert.equal(counts()[0], googleCallsAfterFirstReader, "second reader reuses the raw Google RSS cache");
  assert.equal(counts()[1], 1, "second reader reuses the cached raw GDELT source results");
  const secondReaderCitable = new Set(secondReaderSignal.citableUrls);
  assert.ok(secondReaderCitable.has(normalizeUrl(priorFixtureUrl)!), "reader-specific exclusions do not poison the shared source cache");
  const secondReaderBlurb = await generateTopicBlurb("ai-news", currentDate, secondReaderSignal);
  assert.ok(secondReaderBlurb.items.some((item) => item.primaryRef?.url === priorFixtureUrl));
  assert.ok(secondReaderBlurb.items.every((item) => item.primaryRef?.url && secondReaderCitable.has(normalizeUrl(item.primaryRef.url)!)));
  assert.equal(unexpectedFetches, 0, "no keyed search, AI, deep-read, or other external call was attempted");

  // Advance past the shared raw-cache and cooldown windows. An actual Google
  // outage can still fall back to a newly fetched current GDELT result.
  setScenario({
    noKey: "1",
    gdelt: "1",
    nextHandler: (url) => {
      if (url.hostname === "news.google.com") return new Response(null, { status: 503 });
      assert.equal(url.hostname, "api.gdeltproject.org");
      return xmlResponse([
        { title: "Current artificial intelligence research result", url: apFixtureUrl },
      ]);
    },
  });
  const googleDownSignal = await resolveTopicSignal("ai-news", currentDate, { liveOnly: true, freshness: "pd" });
  assert.ok(googleDownSignal?.citableUrls?.has(normalizeUrl(apFixtureUrl)!));
  assert.equal(counts()[1], 1, "expired GDELT raw data is refreshed after the clock advances");

  // A different topic has no cached sources. If both public sources fail,
  // the resolver must stay empty without reopening keyed or model providers.
  setScenario({ noKey: "1", gdelt: "1", nextHandler: () => new Response(null, { status: 503 }) });
  const allDownSignal = await resolveTopicSignal("music", currentDate, { liveOnly: true, freshness: "pd" });
  assert.equal(allDownSignal, undefined);
  assert.equal(counts()[1], 1, "one GDELT attempt, with no automatic retry");
  assert.equal(unexpectedFetches, 0, "all-source outage cannot reopen metered providers");

  // An impossible February day used to roll into March and falsely stop the
  // source chain. Move beyond all previous cache/cooldown windows and keep the
  // issue date aligned with this isolated calendar fixture.
  controlledNow = Date.UTC(2027, 2, 2, 12);
  setScenario({
    noKey: "1",
    gdelt: "1",
    nextHandler: (url) => url.hostname === "news.google.com"
      ? xmlResponse([{ title: "Malformed artificial intelligence date", url: exampleFixtureUrl,
          date: "Tue, 30 Feb 2027 12:00:00 GMT" }])
      : xmlResponse([{ title: "Valid artificial intelligence backup", url: apFixtureUrl }]),
  });
  const calendarSignal = await resolveTopicSignal("ai-news", new Date(controlledNow).toISOString().slice(0, 10),
    { liveOnly: true, freshness: "pd" });
  assert.ok(calendarSignal?.citableUrls?.has(normalizeUrl(apFixtureUrl)!));
  assert.ok(!calendarSignal?.citableUrls?.has(normalizeUrl(exampleFixtureUrl)!));
  assert.equal(counts()[1], 1, "malformed Google dates cannot suppress the next eligible source");
  assert.equal(unexpectedFetches, 0);

  console.log("PASS verify-no-key-sources (offline source policy, Google RSS, optional GDELT, deterministic formatting)");
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  for (const name of envNames) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
