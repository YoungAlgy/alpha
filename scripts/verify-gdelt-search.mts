// Offline checks for the optional no-key GDELT source. No real provider call.
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
const originalFlag = process.env.ALPHA_GDELT_FALLBACK;
const originalBudgetFlag = process.env.ALPHA_DURABLE_SOURCE_BUDGET;
delete process.env.ALPHA_DURABLE_SOURCE_BUDGET;
let unexpectedNetwork = 0;
globalThis.fetch = (async () => {
  unexpectedNetwork++;
  throw new Error("unfenced network call");
}) as typeof fetch;

const fixedNow = Date.parse("2026-09-29T12:00:00.000Z");
const item = (title: string, url: string, date: string, description = "private feed text") =>
  `<item><title><![CDATA[${title}]]></title><link>${url.replaceAll("&", "&amp;")}</link>` +
  `<description>${description}</description><pubDate>${date}</pubDate></item>`;
const rss = (...items: string[]) => new Response(`<rss><channel>${items.join("")}</channel></rss>`, {
  status: 200, headers: { "Content-Type": "application/rss+xml" },
});
const current = "Tue, 29 Sep 2026 10:00:00 GMT";

try {
  const { createGdeltSearch, gdeltFallbackEnabled } = await import("../lib/engine/gdelt-search.ts");
  delete process.env.ALPHA_GDELT_FALLBACK;
  assert.equal(gdeltFallbackEnabled(), false, "GDELT is off unless explicitly enabled");
  process.env.ALPHA_GDELT_FALLBACK = "yes";
  assert.equal(gdeltFallbackEnabled(), true);
  process.env.ALPHA_GDELT_FALLBACK = "0";
  assert.equal(gdeltFallbackEnabled(), false);

  let time = fixedNow;
  let calls = 0;
  const destinations: URL[] = [];
  const options: RequestInit[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    destinations.push(new URL(String(input)));
    options.push(init ?? {});
    return rss(
      item("Current source", "https://example.org/news/one", current),
      item("Old source", "https://example.org/news/old", "Mon, 01 Sep 2025 10:00:00 GMT"),
      item("Future source", "https://example.org/news/future", "Tue, 30 Sep 2026 10:00:00 GMT"),
      item("Missing date", "https://example.org/news/no-date", ""),
      item("Unsafe protocol", "http://example.org/news/http", current),
      item("Bad host", "https://localhost/private", current),
      item("Bad credentials", "https://user:pass@example.org/news/creds", current)
    );
  };
  const search = createGdeltSearch({
    fetcher,
    now: () => time,
    sleep: async (ms) => { time += ms; },
  });
  const result = await search(' AI: OR site:evil.test "news" ', { freshness: "pw" });
  assert.equal(calls, 1);
  assert.deepEqual(result.map((r) => r.url), ["https://example.org/news/one"]);
  assert.equal(result[0]?.description, "", "feed descriptions never become source text");
  const request = destinations[0]!;
  assert.equal(request.origin + request.pathname, "https://api.gdeltproject.org/api/v2/doc/doc");
  assert.equal(request.searchParams.get("mode"), "artlist");
  assert.equal(request.searchParams.get("format"), "rss");
  assert.equal(request.searchParams.get("maxrecords"), "10");
  assert.equal(request.searchParams.get("query"), '"AI OR site evil test news" sourcelang:english');
  assert.equal(request.searchParams.get("startdatetime"), "20260922120000");
  assert.equal(request.searchParams.get("enddatetime"), "20260929120000");
  assert.equal(options[0]?.redirect, "error");
  assert.equal(options[0]?.credentials, "omit");
  assert.equal(options[0]?.cache, "no-store");
  assert.ok(options[0]?.signal instanceof AbortSignal);
  assert.equal(options[0]?.headers && (options[0].headers as Record<string, string>).Accept?.includes("rss+xml"), true);
  assert.equal(request.searchParams.has("key"), false, "no API key is sent");

  result[0]!.title = "mutated by caller";
  const cached = await search(' AI: OR site:evil.test "news" ', { freshness: "pw" });
  assert.equal(calls, 1, "successful raw results are reused within five minutes");
  assert.equal(cached[0]?.title, "Current source", "callers cannot mutate cached results");
  await search("Another topic", { freshness: "pd" });
  assert.equal(calls, 2);
  assert.equal(time, fixedNow + 5000, "different public requests are spaced five seconds apart");
  assert.equal(destinations[1]?.searchParams.get("startdatetime"), "20260928120000");
  assert.equal((await search("a topic", { freshness: "py" })).length, 0);
  assert.equal((await search("a topic", { freshness: "2026-02-30to2026-09-29" })).length, 0);
  assert.equal((await search("a topic", { freshness: "2026-09-30to2026-09-29" })).length, 0);
  assert.equal((await search("a topic", { freshness: "2026-01-01to2026-09-29" })).length, 0);
  assert.equal((await search("a topic", { freshness: "2020-01-01to2020-01-02" })).length, 0);
  assert.equal((await search("a topic", { freshness: "2026-09-29to2026-09-30" })).length, 0);
  assert.equal(calls, 2, "unsupported or invalid windows do not fetch");
  time += 5 * 60_000 + 1;
  assert.equal((await search(' AI: OR site:evil.test "news" ', { freshness: "pw" })).length, 1);
  assert.equal(calls, 3, "a cached provider result expires after five minutes");

  let resolveFirst!: (response: Response) => void;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  let inFlightCalls = 0;
  const pendingSearch = createGdeltSearch({
    fetcher: async () => {
      inFlightCalls++;
      markFetchStarted();
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    },
    now: () => fixedNow,
  });
  const first = pendingSearch("same topic");
  const second = pendingSearch("same topic");
  // The cross-run budget reservation is asynchronous even when disabled.
  await fetchStarted;
  assert.equal(inFlightCalls, 1, "identical requests share the one in-flight fetch");
  resolveFirst(rss(item("Shared source", "https://example.org/news/shared", current)));
  assert.deepEqual((await first).map((r) => r.url), (await second).map((r) => r.url));

  let failureCalls = 0;
  let failureTime = fixedNow;
  let failedBodyCancelled = false;
  const failureSearch = createGdeltSearch({
    fetcher: async () => {
      failureCalls++;
      return failureCalls === 1 ? new Response(new ReadableStream<Uint8Array>({
        cancel() { failedBodyCancelled = true; },
      }), { status: 429 })
        : rss(item("Recovered", "https://example.org/news/recovered", current));
    },
    now: () => failureTime,
    sleep: async (ms) => { failureTime += ms; },
  });
  await assert.rejects(failureSearch("first topic"), /429/);
  assert.equal(failedBodyCancelled, true, "failed response bodies are cancelled without reading them");
  await assert.rejects(failureSearch("next topic"), /cooling down/);
  assert.equal(failureCalls, 1, "failure cooldown prevents another request");
  failureTime += 60_001;
  assert.equal((await failureSearch("first topic")).length, 1, "failed results were not cached");
  assert.equal(failureCalls, 2);

  let queueTime = fixedNow;
  let queuedFetches = 0;
  let releaseFirst!: (response: Response) => void;
  let markQueuedStarted!: () => void;
  const queuedStarted = new Promise<void>((resolve) => { markQueuedStarted = resolve; });
  const queuedSleeps: Array<() => void> = [];
  const queuedSearch = createGdeltSearch({
    fetcher: async () => {
      queuedFetches++;
      markQueuedStarted();
      return new Promise<Response>((resolve) => { releaseFirst = resolve; });
    },
    now: () => queueTime,
    sleep: (ms) => new Promise<void>((resolve) => {
      queuedSleeps.push(() => { queueTime += ms; resolve(); });
    }),
  });
  const queued = ["one", "two", "three", "four", "five"].map((topic) => queuedSearch(topic));
  const outcomes = Promise.allSettled(queued);
  await queuedStarted;
  assert.equal(queuedFetches, 1);
  assert.equal(queuedSleeps.length, 3, "three queued slots fit within fifteen seconds");
  await assert.rejects(queued[4], /queue is full/, "the next unique query fails at the queue bound");
  releaseFirst(new Response("limited", { status: 429 }));
  await assert.rejects(queued[0], /429/);
  for (const release of queuedSleeps) release();
  const queueResults = await outcomes;
  assert.deepEqual(queueResults.map((outcome) => outcome.status),
    ["rejected", "rejected", "rejected", "rejected", "rejected"]);
  assert.equal(queuedFetches, 1, "already queued requests honor the failure cooldown");

  const invalidSearch = createGdeltSearch({
    fetcher: async () => new Response("<html>provider error</html>", { status: 200 }),
    now: () => fixedNow,
  });
  await assert.rejects(invalidSearch("invalid feed"), /invalid RSS/);
  await assert.rejects(invalidSearch("another topic"), /cooling down/);
  const truncatedSearch = createGdeltSearch({
    fetcher: async () => new Response(`<rss><channel>${item("Current source", "https://example.org/news/one", current)}`),
    now: () => fixedNow,
  });
  await assert.rejects(truncatedSearch("truncated feed"), /invalid RSS/);

  let oversizedCalls = 0;
  const oversizedSearch = createGdeltSearch({
    fetcher: async () => {
      oversizedCalls++;
      return new Response("x".repeat(256 * 1024 + 1), { status: 200 });
    },
    now: () => fixedNow,
  });
  await assert.rejects(oversizedSearch("large topic"), /size|large|limit|bytes/i);
  assert.equal(oversizedCalls, 1, "oversized body is rejected once");
  assert.equal(unexpectedNetwork, 0, "all requests stayed within the offline fence");
  console.log("PASS verify-gdelt-search (offline)");
} finally {
  globalThis.fetch = originalFetch;
  if (originalFlag === undefined) delete process.env.ALPHA_GDELT_FALLBACK;
  else process.env.ALPHA_GDELT_FALLBACK = originalFlag;
  if (originalBudgetFlag === undefined) delete process.env.ALPHA_DURABLE_SOURCE_BUDGET;
  else process.env.ALPHA_DURABLE_SOURCE_BUDGET = originalBudgetFlag;
}
