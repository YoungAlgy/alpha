// Generic offline metadata only. No environment, source, reader, DB or model request.
import assert from "node:assert/strict";
import { createResearchMetadataSearch, parseResearchMetadata } from "../lib/engine/research-metadata-search.ts";
import { MAX_PUBLIC_SOURCE_BYTES } from "../lib/engine/public-source-response.ts";

let assertions = 0;
const check = (actual: unknown, expected: unknown, label: string) => {
  assertions++;
  assert.deepEqual(actual, expected, label);
};
const rejects = async (work: Promise<unknown>, pattern: RegExp, label: string) => {
  assertions++;
  await assert.rejects(work, pattern, label);
};
const throws = (work: () => unknown, pattern: RegExp, label: string) => {
  assertions++;
  assert.throws(work, pattern, label);
};
const baseNow = Date.UTC(2026, 8, 29, 12);
const day = 86_400_000;
const dateParts = (year = 2026, month = 9, date = 29) => ({ "date-parts": [[year, month, date]] });
const license = (overrides: Record<string, unknown> = {}) => ({
  URL: "https://creativecommons.org/licenses/by/4.0/",
  "content-version": "vor", start: dateParts(2026, 9, 28), ...overrides,
});
const record = (overrides: Record<string, unknown> = {}) => ({
  DOI: "10.1234/offline-example", title: ["Generic nutrition research"],
  type: "journal-article", "published-online": dateParts(),
  resource: { primary: { URL: "https://publisher.example/nutrition" } },
  license: [license()], ...overrides,
});
const envelope = (items: unknown[]) => ({ status: "ok", "message-type": "work-list", message: { items } });
const jsonResponse = (items: unknown[] = [record()]) => new Response(JSON.stringify(envelope(items)), {
  headers: { "content-type": "application/json" },
});
const flush = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = (promise: Promise<unknown>) => promise.then(
  value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }),
);

// Production fetch is a tripwire. Every adapter instance gets an offline fetcher
// and reservation stub, so no environment flag or credential is read by a test.
const originalFetch = globalThis.fetch;
let unexpectedFetches = 0;
globalThis.fetch = (async () => { unexpectedFetches++; throw new Error("network denied"); }) as typeof fetch;
try {
  const valid = parseResearchMetadata(envelope([record()]), baseNow);
  check(valid.length, 1, "valid open-license direct-publisher record");
  check(valid[0].title, "Research citation: Generic nutrition research", "citation labeled as metadata");
  check(valid[0].url, "https://publisher.example/nutrition", "direct publisher URL retained");
  check(valid[0].age, "2026-09-29T00:00:00.000Z", "online publication date is explicit");
  check(valid[0].description.includes("source-linked research reading item"), true, "description does not claim article review");
  for (const url of [
    "http://creativecommons.org/licenses/by/3.0", "https://creativecommons.org/licenses/by/4.0/",
    "https://creativecommons.org/licenses/by-sa/3.0/", "https://creativecommons.org/licenses/by-sa/4.0",
  ]) check(parseResearchMetadata(envelope([record({ license: [license({ URL: url })] })]), baseNow).length, 1, `open license ${url}`);
  for (const changed of [
    { license: undefined }, { license: [] }, { license: [license({ "content-version": "tdm" })] },
    { license: [license({ "content-version": "am" })] }, { license: [license({ start: undefined })] },
    { license: [license({ start: dateParts(2026, 9, 30) })] },
    { license: [license({ start: { "date-parts": [[2026, 9]] } })] },
    { license: [license({ URL: "https://creativecommons.org/licenses/by-nc/4.0/" })] },
    { license: [license({ URL: "https://creativecommons.org/licenses/by/2.0/" })] },
    { license: [license({ URL: "https://creativecommons.org.attacker.invalid/licenses/by/4.0/" })] },
    { license: [license({ URL: "https://publisher.example/license" })] },
  ]) check(parseResearchMetadata(envelope([record(changed)]), baseNow).length, 0, "unknown, future or unsupported license rejected");
  for (const url of [
    "https://doi.org/10.1234/example", "https://dx.doi.org/10.1234/example", "https://api.crossref.org/works/example",
    "https://www.doi.org/10.1234/example", "https://doi.org./10.1234/example", "https://www.dx.doi.org/10.1234/example",
    "https://www.nejm.org/example", "https://sub.jamanetwork.com/example", "https://www.thelancet.com/example",
    "https://jamanetwork.com./example", "https://www.jamanetwork.com./example",
    "https://www.openpr.com/example", "https://publisher.example/best-nutrition-2026",
    "http://publisher.example/example", "https://user:password@publisher.example/example",
    "https://publisher.example:8443/example", "https://127.0.0.1/example", "https://[::1]/example",
    "https://localhost/example", "https://service.local/example", "https://intranet/example", "invalid",
  ]) check(parseResearchMetadata(envelope([record({ resource: { primary: { URL: url } } })]), baseNow).length, 0, "wrapper, denied or unsafe publisher rejected");
  for (const changed of [
    { type: "book-chapter" }, { type: "posted-content" }, { title: ["Generic unrelated research"] },
    { title: ["Correction nutrition research"] }, { title: ["Retraction nutrition research"] },
    { title: ["Withdrawal nutrition research"] }, { title: ["Retracted nutrition research"] },
    { title: ["Withdrawn nutrition research"] }, { title: [] }, { title: [42] },
    { DOI: "invalid" }, { DOI: "10.1234/contains space" }, { DOI: `10.1234/${"a".repeat(300)}` },
    { resource: undefined }, { resource: { primary: { URL: 42 } } },
  ]) check(parseResearchMetadata(envelope([record(changed)]), baseNow).length, 0, "invalid record excluded");
  for (const title of [
    "Aquaculture nutrition research", "Livestock nutrition outcomes", "Poultry nutritional requirements",
    "Nutrition outcomes among broilers", "Cattle nutrition research", "Piglet nutrition research", "Swine nutrition research",
    "Ruminant nutrition research", "Canine nutrition research", "Feline nutrition research", "Veterinary nutrition research",
    "Nutritional strategy for dairy cows", "Plant nutrition research", "Crop nutrition research", "Animal nutrition research",
    "Fish nutrition research", "Nutrition effects of fish feed", "Nutrition outcomes among rodents", "Nutrition outcomes among mice",
    "Nutrition outcomes among rats",
  ]) check(parseResearchMetadata(envelope([record({ title: [title] })]), baseNow).length, 0, `explicit non-human topic excluded: ${title}`);
  check(parseResearchMetadata(envelope([record({ title: ["Fish consumption in human nutrition"] })]), baseNow).length, 1, "human fish-consumption research remains eligible");
  check(parseResearchMetadata(envelope([record({ resource: { primary: { URL: "https://publisher.example./nutrition" } } })]), baseNow)[0]?.url,
    "https://publisher.example/nutrition", "allowed publisher hostname is canonicalized before authority checks");
  const ignored = parseResearchMetadata(envelope([record({
    abstract: "PRIVATE_ABSTRACT_MARKER", body: "PRIVATE_BODY_MARKER", image: "PRIVATE_IMAGE_MARKER",
  })]), baseNow);
  check(ignored, valid, "abstract, body and image never affect copied metadata");
  check(parseResearchMetadata(envelope([record({ title: ["Generic nutritional research"] })]), baseNow).length, 1, "nutritional title accepted");
  check(parseResearchMetadata(envelope(Array.from({ length: 25 }, () => record())), baseNow).length, 20, "parser is bounded at twenty records");
  check(parseResearchMetadata(envelope([...Array.from({ length: 20 }, () => null), record()]), baseNow).length, 0, "record twenty-one is never parsed");
  check(parseResearchMetadata(envelope([record({ license: [...Array.from({ length: 20 }, () => null), license()] })]), baseNow).length, 0, "license twenty-one cannot bypass the parser bound");
  for (const malformed of [null, {}, { ...envelope([]), status: "error" }, { ...envelope([]), "message-type": "work" },
    { ...envelope([]), message: { items: {} } }]) throws(() => parseResearchMetadata(malformed, baseNow), /invalid response/, "invalid response envelope throws");

  let fetchCalls = 0;
  let reservations = 0;
  let now = baseNow;
  const search = createResearchMetadataSearch({
    now: () => now, sleep: async ms => { now += ms; },
    reserve: async provider => { reservations++; check(provider, "publisher-rss", "fixed durable ceiling identity"); },
    fetcher: async (input, init) => {
      fetchCalls++;
      const url = new URL(String(input));
      check(url.origin + url.pathname, "https://api.crossref.org/works", "fixed metadata endpoint");
      check(url.searchParams.get("query"), "nutrition", "fixed public query");
      check(url.searchParams.get("rows"), "20", "request record limit");
      check(url.searchParams.get("select"), "DOI,title,published-online,type,resource,license", "request excludes abstracts and bodies");
      check(url.searchParams.get("filter"), "from-online-pub-date:2026-09-28,until-online-pub-date:2026-09-29,type:journal-article,has-license:true", "bounded publication query");
      check([init?.redirect, init?.credentials, init?.cache], ["error", "omit", "no-store"], "request cannot follow publisher redirects or send credentials");
      check(init?.signal instanceof AbortSignal, true, "request has a deadline signal");
      return jsonResponse([
        record(), record({ "published-online": undefined }), record({ "published-online": { "date-parts": [[2026, 9]] } }),
        record({ "published-online": dateParts(2026, 2, 30) }), record({ "published-online": dateParts(2026, 9, 30) }),
        record({ "published-online": dateParts(2026, 9, 21) }), record({ "published-online": { "date-parts": [["2026", 9, 29]] } }),
        record({ "published-online": dateParts(2026, 13, 1) }), record({ "published-online": dateParts(2026, 9, 0) }),
        record({ "published-online": dateParts(1999, 9, 29) }), record({ "published-online": { "date-parts": [[2026, 9, 29, 1]] } }),
      ]);
    },
  });
  for (const topic of ["music", "longevity-wellness", "custom:generic offline topic", "nutrition-food ", ""]) {
    check(await search(topic), [], "unsupported and custom topics do not fetch");
  }
  for (const freshness of ["py", "invalid", "2026-02-30to2026-03-01", "2020-01-01to2020-01-02", "2026-09-29to2026-09-30"]) {
    check(await search("nutrition-food", { freshness }), [], "unsupported or invalid date window does not fetch");
  }
  check([fetchCalls, reservations], [0, 0], "unsupported input reserves no budget");
  const [one, two] = await Promise.all([search("nutrition-food", { freshness: "pd" }), search("nutrition-food", { freshness: "pd" })]);
  check(one.length, 1, "search drops malformed, partial, future and stale dates locally");
  check([fetchCalls, reservations], [1, 1], "identical pending search coalesces");
  one[0].title = "caller changed title";
  check(two[0].title, valid[0].title, "coalesced results are separate copies");
  check((await search("nutrition-food", { freshness: "pd" }))[0].title, valid[0].title, "caller cannot mutate cached metadata");
  now += 5 * 60_000;
  check((await search("nutrition-food", { freshness: "pd" })).length, 1, "expired cache refetches");
  check(fetchCalls, 2, "five-minute successful cache bound");

  // A date that becomes too old within the five-minute cache window is checked
  // again for each caller even though the day-based request key stays identical.
  let movingNow = Date.UTC(2026, 8, 29, 0);
  let movingCalls = 0;
  const moving = createResearchMetadataSearch({ now: () => movingNow, reserve: async () => {},
    fetcher: async () => { movingCalls++; return jsonResponse([record({ "published-online": dateParts(2026, 9, 28) })]); },
  });
  check((await moving("nutrition-food", { freshness: "pd" })).length, 1, "publication at freshness lower bound accepted");
  movingNow += 1;
  check((await moving("nutrition-food", { freshness: "pd" })).length, 0, "cached publication is checked against current time");
  check(movingCalls, 1, "freshness recheck uses the shared raw cache");

  // Clock-controlled queue checks use production control flow without real
  // one-second sleeps or fifteen-second cancellation waits.
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let timerId = 0;
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    const id = ++timerId; timers.set(id, { callback, ms }); return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(Number(id)); }) as unknown as typeof clearTimeout;
  try {
    let queueNow = baseNow;
    let active = 0;
    let maxActive = 0;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const gate = deferred<Response>();
    const queueSearch = createResearchMetadataSearch({ now: () => queueNow, reserve: async () => {},
      sleep: async ms => { sleeps.push(ms); queueNow += ms; },
      fetcher: async () => {
        active++; maxActive = Math.max(maxActive, active); starts.push(queueNow);
        try { return starts.length === 1 ? await gate.promise : jsonResponse(); }
        finally { active--; }
      },
    });
    const pending = ["pd", "pw", "pm", "2026-09-25to2026-09-29"].map(freshness => queueSearch("nutrition-food", { freshness }));
    await flush();
    check(starts.length, 1, "only first request starts while it is active");
    check(timers.size, 3, "three bounded waiting queue entries");
    await rejects(queueSearch("nutrition-food", { freshness: "2026-09-24to2026-09-29" }), /queue full/, "fifth distinct request fails without fetching");
    gate.resolve(jsonResponse());
    check((await Promise.all(pending)).map(items => items.length), [1, 1, 1, 1], "accepted queue drains in order");
    check(maxActive, 1, "maximum one active source request");
    check(starts, [baseNow, baseNow + 1000, baseNow + 2000, baseNow + 3000], "one-second spacing between serialized requests");
    check(sleeps, [1000, 1000, 1000], "injected sleep receives full required spacing");
    check(timers.size, 0, "successful and capacity-error queue timers cleaned up");

    let failureNow = baseNow;
    let failureCalls = 0;
    const failureGate = deferred<Response>();
    const failureSearch = createResearchMetadataSearch({ now: () => failureNow, reserve: async () => {},
      sleep: async ms => { failureNow += ms; },
      fetcher: async () => { failureCalls++; return failureCalls === 1 ? failureGate.promise : jsonResponse(); },
    });
    const failed = settle(failureSearch("nutrition-food", { freshness: "pd" }));
    const waiting = settle(failureSearch("nutrition-food", { freshness: "pw" }));
    await flush();
    failureGate.reject(new Error("offline metadata failure"));
    check((await failed).error?.message, "offline metadata failure", "first source error surfaced");
    check((await waiting).error?.message, "Research metadata cooling down", "already queued request stops after source error");
    check(failureCalls, 1, "cooldown prevents queued fetch");
    check(timers.size, 0, "cooldown rejection clears waiting timer");
    await rejects(failureSearch("nutrition-food", { freshness: "pm" }), /cooling down/, "new request respects provider cooldown");
    failureNow += 120_000;
    check((await failureSearch("nutrition-food", { freshness: "pd" })).length, 1, "lane recovers after bounded repeated-error cooldown");
    check(failureCalls, 2, "recovery issues exactly one further fetch");

    let cancelNow = baseNow;
    let cancelCalls = 0;
    const cancelGate = deferred<Response>();
    const cancelSearch = createResearchMetadataSearch({ now: () => cancelNow, reserve: async () => {},
      sleep: async ms => { cancelNow += ms; },
      fetcher: async () => { cancelCalls++; return cancelCalls === 1 ? cancelGate.promise : jsonResponse(); },
    });
    const occupied = cancelSearch("nutrition-food", { freshness: "pd" });
    const cancelled = settle(cancelSearch("nutrition-food", { freshness: "pw" }));
    await flush();
    check(timers.size, 1, "waiting request has one cancellation timer");
    const deadline = [...timers.values()][0];
    check(deadline.ms, 15_000, "queue cancellation is bounded at fifteen seconds");
    cancelNow += 15_000;
    for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); }
    check((await cancelled).error?.message, "Research metadata queue timed out", "waiting caller settles at queue deadline");
    check(cancelCalls, 1, "deadline does not start a queued fetch while first is active");
    cancelGate.resolve(jsonResponse());
    await occupied;
    await flush();
    check(cancelCalls, 1, "cancelled queued request cannot fetch later");
    check(timers.size, 0, "cancelled queue leaves no timer");
    cancelNow += 60_000;
    check((await cancelSearch("nutrition-food", { freshness: "pm" })).length, 1, "cancelled queue does not poison serial lane");

    let spacingNow = baseNow;
    let spacingCalls = 0;
    const spacingSearch = createResearchMetadataSearch({ now: () => spacingNow, reserve: async () => {},
      sleep: async () => { spacingNow += 15_000; },
      fetcher: async () => { spacingCalls++; return jsonResponse(); },
    });
    await spacingSearch("nutrition-food", { freshness: "pd" });
    await rejects(spacingSearch("nutrition-food", { freshness: "pw" }), /queue timed out/, "deadline rechecked after a delayed spacing sleep");
    check(spacingCalls, 1, "expired spacing waiter does not fetch");
    check(timers.size, 0, "elapsed queue deadline clears timer without callback firing");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  for (const kind of ["status", "content-type", "length", "stream"] as const) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(stream) { if (kind === "stream") stream.enqueue(new Uint8Array(MAX_PUBLIC_SOURCE_BYTES + 1)); },
      cancel() { cancelled = true; },
    });
    const discard = createResearchMetadataSearch({ now: () => baseNow, reserve: async () => {}, fetcher: async () => new Response(body, {
      status: kind === "status" ? 503 : 200,
      headers: { "content-type": kind === "content-type" ? "text/html" : "application/json",
        ...(kind === "length" ? { "content-length": String(MAX_PUBLIC_SOURCE_BYTES + 1) } : {}),
      },
    }) });
    await rejects(discard("nutrition-food"), /503|invalid content type|too large/, `${kind} rejects response`);
    check(cancelled, true, `${kind} cancels discarded body`);
  }

  for (const [label, response, pattern] of [
    ["HTTP error", () => new Response("", { status: 503 }), /503/],
    ["HTML content", () => new Response("<html>offline</html>", { headers: { "content-type": "text/html" } }), /invalid content type/],
    ["invalid JSON", () => new Response("{", { headers: { "content-type": "application/json" } }), /JSON/],
    ["invalid envelope", () => new Response("{}", { headers: { "content-type": "application/json" } }), /invalid response/],
    ["oversized declared body", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(MAX_PUBLIC_SOURCE_BYTES + 1) } }), /too large/],
    ["invalid length", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "invalid" } }), /invalid length/],
    ["oversized streamed body", () => new Response("x".repeat(MAX_PUBLIC_SOURCE_BYTES + 1), { headers: { "content-type": "application/json" } }), /too large/],
  ] as const) {
    let responseCalls = 0;
    const bad = createResearchMetadataSearch({ now: () => baseNow, reserve: async () => {},
      fetcher: async () => { responseCalls++; return response(); },
    });
    await rejects(bad("nutrition-food"), pattern, `${label} fails closed`);
    await rejects(bad("nutrition-food", { freshness: "pd" }), /cooling down/, `${label} activates cooldown`);
    check(responseCalls, 1, `${label} causes no immediate retry`);
  }
  let budgetFetches = 0;
  const exhausted = createResearchMetadataSearch({ now: () => baseNow,
    reserve: async () => { throw new Error("offline budget exhausted"); },
    fetcher: async () => { budgetFetches++; return jsonResponse(); },
  });
  await rejects(exhausted("nutrition-food"), /budget exhausted/, "denied reservation fails closed");
  check(budgetFetches, 0, "budget denial causes no metadata fetch");
  await rejects(exhausted("nutrition-food", { freshness: "pd" }), /cooling down/, "budget denial activates cooldown");

  // Replace only signal creation for deterministic timeout coverage. Production
  // requests must still ask for 5,000 ms, and their real abort listener cancels
  // the mocked stalled body. No wall-clock five-second wait is required.
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  let timeoutMs = 0;
  let bodyCancelled = false;
  let timeoutFetches = 0;
  AbortSignal.timeout = (ms: number) => { timeoutMs = ms; return controller.signal; };
  try {
    const stalled = createResearchMetadataSearch({ now: () => baseNow, reserve: async () => {},
      fetcher: async (_input, init) => {
        timeoutFetches++;
        check(init?.signal, controller.signal, "same signal covers headers and streamed body");
        return new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }), { headers: { "content-type": "application/json" } });
      },
    });
    const reading = settle(stalled("nutrition-food"));
    await flush();
    check(timeoutMs, 5000, "production response deadline remains five seconds");
    controller.abort();
    check((await reading).error?.message, "Public source response timed out", "stalled body rejects on deadline signal");
    check(bodyCancelled, true, "timeout cancels stalled response body");
    await rejects(stalled("nutrition-food", { freshness: "pd" }), /cooling down/, "response timeout activates cooldown");
    check(timeoutFetches, 1, "timeout causes no immediate second fetch");
  } finally { AbortSignal.timeout = originalTimeout; }
  check(unexpectedFetches, 0, "no production network request occurred");
  console.log(`PASS research metadata parser, filtering, cache, queue, budget and response bounds: ${assertions} assertions (offline)`);
} finally { globalThis.fetch = originalFetch; }
