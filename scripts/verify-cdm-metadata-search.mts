// Offline CDM fixtures are confined to this verification script. Global network is denied.
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BraveResult } from "../lib/brave.ts";
import { CDM_METADATA_ENDPOINT, cdmMetadataFallbackEnabled, createCdmMetadataSearch } from "../lib/engine/cdm-metadata-search.ts";
import { MAX_PUBLIC_SOURCE_BYTES } from "../lib/engine/public-source-response.ts";
import { createPublicSourceBudget, PublicSourceBudgetError } from "../lib/engine/public-source-budget.ts";
import { createPublicSourceCircuit, PublicSourceCircuitError, type PublicSourceAttempt } from "../lib/engine/public-source-circuit.ts";
import { PublicSourceControlError } from "../lib/engine/public-source-control-error.ts";

let checks = 0;
function eq(actual: unknown, expected: unknown): void { checks++; assert.deepEqual(actual, expected); }
async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  checks++; await assert.rejects(promise, pattern);
}
const TOPIC = "custom:music production";
const PROVIDER = "cdm-music";
const fixedNow = Date.parse("2026-10-13T12:00:00.000Z");
const firstUrl = "https://cdm.link/2026/10/synthesizer-production/";
const secondUrl = "https://cdm.link/2026/10/sampler-production/";
const item = (fields: Record<string, string> = {}) => {
  const value = { title: "Synthesizer tools for music production", url: firstUrl,
    author: "Peter Kirn", date: "Mon, 12 Oct 2026 16:00:00 GMT", extra: "", ...fields };
  return `<item><title>${value.title}</title><link>${value.url}</link><dc:creator>${value.author}</dc:creator>` +
    `<pubDate>${value.date}</pubDate><category>Music production</category>${value.extra}` +
    `<description>ARTICLE_BODY_MUST_NOT_ESCAPE</description><content:encoded><![CDATA[PRIVATE_BODY_SENTINEL]]></content:encoded>` +
    `<enclosure url="https://example.invalid/audio.mp3"/><media:content url="https://example.invalid/photo.jpg"/></item>`;
};
const feed = (...items: string[]) => `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
  `xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/"><channel>${items.join("")}</channel></rss>`;
const response = (xml = feed(item()), headers: Record<string, string> = {}) =>
  new Response(xml, { headers: { "content-type": "application/rss+xml; charset=UTF-8", ...headers } });
const cdmCredit = (result: BraveResult | undefined) => {
  const attribution = result?.attribution;
  if (attribution?.publisher !== "cdm") throw new Error("Expected exact CDM attribution");
  return attribution;
};
const offlineAttempt: PublicSourceAttempt = async (provider, reserve, work) => {
  eq(provider, PROVIDER); await reserve(); return work();
};
const flags = ["ALPHA_CDM_METADATA_FALLBACK", "ALPHA_NO_MODEL_MODE", "ALPHA_DURABLE_SOURCE_BUDGET", "ALPHA_DURABLE_SOURCE_COOLDOWN", "ALPHA_NO_KEY_SOURCES"];
const savedFlags = new Map(flags.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
let globalFetches = 0;
globalThis.fetch = (async () => { globalFetches++; throw new Error("Unexpected global network call"); }) as typeof fetch;

try {
  for (const flag of flags) delete process.env[flag];
  eq(cdmMetadataFallbackEnabled(), false);
  process.env.ALPHA_NO_KEY_SOURCES = "1";
  eq(cdmMetadataFallbackEnabled(), false);
  for (const flag of flags) process.env[flag] = "1";
  eq(cdmMetadataFallbackEnabled(), true);
  let gateFetches = 0;
  let gateReserves = 0;
  let gateAttempts = 0;
  const gated = createCdmMetadataSearch({ now: () => fixedNow,
    fetcher: async () => { gateFetches++; return response(); },
    reserve: async () => { gateReserves++; },
    attempt: async (_provider, reserve, work) => { gateAttempts++; await reserve(); return work(); },
  });
  for (const flag of flags.slice(0, 4)) {
    for (const disabled of [undefined, "0", "false", "no", "garbage"]) {
      if (disabled === undefined) delete process.env[flag]; else process.env[flag] = disabled;
      eq(cdmMetadataFallbackEnabled(), false);
      eq(await gated(TOPIC), []);
      eq([gateFetches, gateReserves, gateAttempts], [0, 0, 0]);
    }
    process.env[flag] = "1";
  }
  for (const enabled of ["true", "YES", " 1 "]) {
    for (const flag of flags.slice(0, 4)) process.env[flag] = enabled;
    eq(cdmMetadataFallbackEnabled(), true);
  }
  for (const flag of flags) process.env[flag] = "1";
  for (const topic of ["", "music", "music-hiphop", "music-edm", "custom:music", "custom:music production news",
    "custom:Music Production", "custom:music production ", "custom:private reader topic"]) {
    eq(await gated(topic), []);
  }
  for (const freshness of ["bad", "py", "2026-02-30to2026-03-01", "2026-10-14to2026-10-15"]) {
    eq(await gated(TOPIC, { freshness: freshness as "pd" }), []);
  }
  eq([gateFetches, gateReserves, gateAttempts], [0, 0, 0]);

  // One fixed raw pool is shared before each caller's freshness and history filters.
  let clock = fixedNow;
  let calls = 0;
  let reserves = 0;
  let attempts = 0;
  let releaseFetch: (() => void) | undefined;
  const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve; });
  const search = createCdmMetadataSearch({ now: () => clock,
    reserve: async provider => { reserves++; eq(provider, PROVIDER); },
    attempt: async (provider, reserve, work) => { attempts++; eq(provider, PROVIDER); await reserve(); return work(); },
    fetcher: async (input, init) => {
      calls++;
      eq(String(input), "https://cdm.link/feed/");
      eq(CDM_METADATA_ENDPOINT, "https://cdm.link/feed/");
      eq([init?.redirect, init?.credentials, init?.cache], ["error", "omit", "no-store"]);
      eq(init?.signal instanceof AbortSignal, true);
      eq(init?.method ?? "GET", "GET");
      eq(init?.body, undefined);
      eq(Object.keys(init?.headers ?? {}), ["Accept"]);
      eq(JSON.stringify([String(input), init?.headers, init?.body]).includes("music production"), false);
      await fetchGate;
      return response(feed(item(), item({ title: "Sampler workflow for music production", url: secondUrl }),
        item({ title: "Older music production tools", url: "https://cdm.link/2026/10/older-production/", date: "Tue, 06 Oct 2026 10:00:00 GMT" }),
        item({ title: "Future music production tools", url: "https://cdm.link/2026/10/future-production/", date: "Tue, 13 Oct 2026 12:02:00 GMT" })));
    },
  });
  const dailyPending = search(TOPIC, { freshness: "pd" });
  const weeklyPending = search(TOPIC, { freshness: "pw" }, new Set([firstUrl]));
  const olderPending = search(TOPIC, { freshness: "2026-10-06to2026-10-06" });
  releaseFetch!();
  const [daily, weekly, older] = await Promise.all([dailyPending, weeklyPending, olderPending]);
  eq([calls, reserves, attempts], [1, 1, 1]);
  eq([daily.length, weekly.length, older.length], [1, 1, 1]);
  eq(daily[0]?.title, "Synthesizer tools for music production");
  eq(daily[0]?.url, firstUrl);
  eq(daily[0]?.description, "");
  eq(daily[0]?.age, "2026-10-12T16:00:00.000Z");
  eq(daily[0]?.attribution, { publisher: "cdm", kind: "music-production-metadata", title: daily[0]!.title,
    url: firstUrl, author: "Peter Kirn", publishedAt: daily[0]!.age, dateBasis: "feed-pubdate" });
  eq(weekly[0]?.url, secondUrl);
  eq(older[0]?.url, "https://cdm.link/2026/10/older-production/");
  eq(/ARTICLE_BODY|PRIVATE_BODY|audio\.mp3|photo\.jpg|content:encoded/.test(JSON.stringify(daily)), false);
  daily[0]!.title = "caller mutation";
  cdmCredit(daily[0]).author = "caller mutation";
  eq((await search(TOPIC, { freshness: "pd" }))[0]?.title, "Synthesizer tools for music production");
  eq(cdmCredit((await search(TOPIC, { freshness: "pd" }))[0]).author, "Peter Kirn");
  eq(cdmCredit(weekly[0]).author, "Peter Kirn");
  eq(await search(TOPIC, { freshness: "pd" }, new Set([firstUrl, secondUrl])), []);
  eq((await search(TOPIC, { freshness: "pd" }, new Set([firstUrl])))[0]?.url, secondUrl);
  eq((await search(TOPIC, { freshness: "pd" }))[0]?.url, firstUrl);
  eq(calls, 1);
  // A future record can become current while the raw pool remains cached.
  clock += 3 * 60_000;
  eq((await search(TOPIC, { freshness: "pd" }, new Set([firstUrl, secondUrl])))[0]?.url,
    "https://cdm.link/2026/10/future-production/");
  eq(calls, 1);

  // Completeness is raw-pool metadata and must follow every cached reader.
  const invalidRows = [item({ author: "" }), item({ date: "not a date" }),
    item({ extra: "<dc:rights>Separate restricted rights</dc:rights>" }),
    item({ extra: `<category>${"x".repeat(101)}</category>` }),
    item({ extra: "<title>Ambiguous duplicate title</title>" })];
  for (const invalidRow of invalidRows) {
    let partialFetches = 0;
    let partialNotices = 0;
    const partial = createCdmMetadataSearch({ now: () => fixedNow, reserve: async () => {}, attempt: offlineAttempt,
      fetcher: async () => { partialFetches++; return response(feed(invalidRow, item())); } });
    const opts = { freshness: "pd" as const, onIncompleteResults: () => { partialNotices++; } };
    eq((await partial(TOPIC, opts))[0]?.url, firstUrl);
    eq([partialFetches, partialNotices], [1, 1]);
    eq((await partial(TOPIC, opts))[0]?.url, firstUrl);
    eq([partialFetches, partialNotices], [1, 2]);
    eq(await partial(TOPIC, opts, new Set([firstUrl])), []);
    eq([partialFetches, partialNotices], [1, 3]);
    eq((await partial(TOPIC, { freshness: "pd" }))[0]?.url, firstUrl);
    eq((await partial(TOPIC, { freshness: "pd", onIncompleteResults: () => { throw new Error("Optional callback failed"); } }))[0]?.url, firstUrl);
    eq([partialFetches, partialNotices], [1, 3]);
    let whollyInvalidFetches = 0;
    const whollyInvalid = createCdmMetadataSearch({ now: () => fixedNow, reserve: async () => {}, attempt: offlineAttempt,
      fetcher: async () => { whollyInvalidFetches++; return response(feed(invalidRow)); } });
    await rejects(whollyInvalid(TOPIC), /no validated records/);
    await rejects(whollyInvalid(TOPIC), /cooling down/);
    eq(whollyInvalidFetches, 1);
  }
  let emptyNotices = 0;
  let emptyFetches = 0;
  const healthyEmpty = createCdmMetadataSearch({ now: () => fixedNow, reserve: async () => {}, attempt: offlineAttempt,
    fetcher: async () => { emptyFetches++; return response(feed()); } });
  for (let read = 0; read < 2; read++) {
    eq(await healthyEmpty(TOPIC, { onIncompleteResults: () => { emptyNotices++; } }), []);
  }
  eq([emptyFetches, emptyNotices], [1, 0]);
  for (const size of [100, 101]) {
    let cappedFetches = 0;
    let cappedNotices = 0;
    const urls = Array.from({ length: size }, (_, index) => `https://cdm.link/2026/10/music-production-${index}/`);
    const capped = createCdmMetadataSearch({ now: () => fixedNow, reserve: async () => {}, attempt: offlineAttempt,
      fetcher: async () => { cappedFetches++; return response(feed(...urls.map(url => item({ url })))); } });
    const opts = { onIncompleteResults: () => { cappedNotices++; } };
    eq((await capped(TOPIC, opts))[0]?.url, urls[0]);
    eq([cappedFetches, cappedNotices], [1, size === 101 ? 1 : 0]);
    eq((await capped(TOPIC, opts, new Set(urls.slice(0, 99))))[0]?.url, urls[99]);
    eq([cappedFetches, cappedNotices], [1, size === 101 ? 2 : 0]);
    // The 101st row cannot hide the truncated-pool warning or bypass its cap.
    eq(await capped(TOPIC, opts, new Set(urls.slice(0, 100))), []);
    eq([cappedFetches, cappedNotices], [1, size === 101 ? 3 : 0]);
  }

  // Upstream failures have a process cooldown and are never automatically retried.
  for (const [make, pattern] of [
    [() => new Response("", { status: 503 }), /unavailable/],
    [() => new Response("", { status: 302, headers: { location: "https://example.invalid/" } }), /unavailable/],
    [() => new Response("<html/>", { headers: { "content-type": "text/html" } }), /MIME|content.type|invalid feed/i],
    [() => response(feed(item()), { "content-type": "text/plain" }), /MIME|content.type/i],
    [() => response("<rss>"), /invalid feed/i],
    [() => response(feed(item()), { "content-length": String(MAX_PUBLIC_SOURCE_BYTES + 1) }), /too large/],
    [() => response(feed(item()), { "content-length": "invalid" }), /too large|invalid length/],
    [() => response("x".repeat(MAX_PUBLIC_SOURCE_BYTES + 1)), /too large/],
  ] as const) {
    let failureCalls = 0;
    const broken = createCdmMetadataSearch({ now: () => fixedNow, reserve: async () => {}, attempt: offlineAttempt,
      fetcher: async () => { failureCalls++; return make(); } });
    await rejects(broken(TOPIC), pattern);
    await rejects(broken(TOPIC), /cooling down/);
    eq(failureCalls, 1);
  }
  let failureClock = fixedNow;
  let recoveredCalls = 0;
  const recovery = createCdmMetadataSearch({ now: () => failureClock, reserve: async () => {}, attempt: offlineAttempt,
    fetcher: async () => { recoveredCalls++; if (recoveredCalls === 1) return new Response("", { status: 503 }); return response(); } });
  await rejects(recovery(TOPIC), /unavailable/);
  failureClock += 59_999;
  await rejects(recovery(TOPIC), /cooling down/);
  eq(recoveredCalls, 1);
  failureClock++;
  eq((await recovery(TOPIC)).length, 1);
  eq(recoveredCalls, 2);

  // Successful empty pools get the shorter TTL, and populated metadata expires too.
  for (const [xml, ttl, expectedCount] of [[feed(), 60_000, 0], [feed(item()), 300_000, 1]] as const) {
    let cacheClock = fixedNow;
    let cacheFetches = 0;
    const expiring = createCdmMetadataSearch({ now: () => cacheClock, reserve: async () => {}, attempt: offlineAttempt,
      fetcher: async () => { cacheFetches++; return response(xml); } });
    eq((await expiring(TOPIC)).length, expectedCount);
    cacheClock += ttl - 1;
    eq((await expiring(TOPIC)).length, expectedCount);
    eq(cacheFetches, 1);
    cacheClock++;
    eq((await expiring(TOPIC)).length, expectedCount);
    eq(cacheFetches, 2);
  }

  // The complete five-second deadline covers both stalled headers and body.
  for (const phase of ["headers", "body"] as const) {
    const originalTimer = globalThis.setTimeout;
    let timeoutMs = 0;
    let expire: (() => void) | undefined;
    let enteredFetch: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { enteredFetch = resolve; });
    let cancelled = false;
    let timeoutFetches = 0;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === 5000) {
        timeoutMs = ms;
        expire = () => callback(...args);
        return originalTimer(() => {}, 30_000);
      }
      return originalTimer(callback, ms, ...args);
    }) as typeof setTimeout;
    try {
      const stalled = createCdmMetadataSearch({ now: () => fixedNow, reserve: async () => {}, attempt: offlineAttempt,
        fetcher: async () => {
          timeoutFetches++; enteredFetch!();
          if (phase === "headers") return new Promise<Response>(() => {});
          return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
            { headers: { "content-type": "application/rss+xml" } });
        } });
      const pending = stalled(TOPIC);
      await entered;
      await Promise.resolve();
      eq(timeoutMs, 5000);
      expire!();
      await rejects(pending, /timed out|abort/i);
      if (phase === "body") eq(cancelled, true);
      await rejects(stalled(TOPIC), /cooling down/);
      eq(timeoutFetches, 1);
    } finally { globalThis.setTimeout = originalTimer; }
  }

  // Budget/DB/circuit admission errors cannot fetch or become source outages.
  for (const code of ["exhausted", "unavailable"] as const) {
    let deniedFetches = 0;
    let deniedReserves = 0;
    const denied = createCdmMetadataSearch({ now: () => fixedNow, attempt: offlineAttempt,
      reserve: async () => { if (++deniedReserves === 1) throw new PublicSourceBudgetError(code, PROVIDER); },
      fetcher: async () => { deniedFetches++; return response(); } });
    await rejects(denied(TOPIC), new RegExp(`budget ${code}`));
    eq(deniedFetches, 0);
    eq((await denied(TOPIC)).length, 1);
    eq([deniedReserves, deniedFetches], [2, 1]);
  }
  for (const code of ["cooling_down", "unavailable"] as const) {
    let deniedFetches = 0;
    let deniedReserves = 0;
    let deniedAttempts = 0;
    const denied = createCdmMetadataSearch({ now: () => fixedNow,
      reserve: async () => { deniedReserves++; },
      attempt: async (_provider, reserve, work) => {
        if (++deniedAttempts === 1) throw new PublicSourceCircuitError(code, PROVIDER);
        await reserve(); return work();
      }, fetcher: async () => { deniedFetches++; return response(); } });
    await rejects(denied(TOPIC), new RegExp(`circuit ${code}`));
    eq([deniedFetches, deniedReserves], [0, 0]);
    eq((await denied(TOPIC)).length, 1);
    eq([deniedAttempts, deniedReserves, deniedFetches], [2, 1, 1]);
  }

  // Separate adapter and client instances share only an injected durable fixture.
  const generation = "00000000-0000-4000-8000-000000000001";
  const probeToken = "00000000-0000-4000-8000-000000000002";
  let durableClock = fixedNow;
  let durableFailed = false;
  let probe = false;
  let completionFails = false;
  let beginUnavailable = false;
  const counts = new Map<number, number>();
  const completed: string[] = [];
  let budgetRpcCalls = 0;
  let durableFetches = 0;
  const rpcClient = () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "consume_alpha_rate_limit") {
      budgetRpcCalls++;
      eq(args, { p_scope: "public_source:cdm_music", p_key: PROVIDER, p_limit: 2, p_window_seconds: 900 });
      const window = Math.floor(durableClock / 900_000);
      const count = (counts.get(window) ?? 0) + 1;
      counts.set(window, count);
      return { data: [{ allowed: count <= 2 }], error: null };
    }
    if (name === "begin_alpha_public_source") {
      eq(args, { p_provider: PROVIDER });
      if (beginUnavailable) return { data: null, error: { message: "offline fixture DB unavailable" } };
      return { data: [{ admitted: !durableFailed, generation,
        probe_token: !durableFailed && probe ? probeToken : null,
        retry_after_sec: durableFailed ? 900 : 0 }], error: null };
    }
    eq(name, "complete_alpha_public_source");
    eq(args.p_provider, PROVIDER);
    eq(args.p_generation, generation);
    completed.push(String(args.p_outcome));
    if (completionFails) return { data: null, error: { message: "offline completion failed" } };
    if (args.p_outcome === "failure") durableFailed = true;
    if (args.p_outcome === "success") durableFailed = false;
    return { data: true, error: null };
  } }) as unknown as Pick<SupabaseClient, "rpc">;
  const firstClient = rpcClient();
  const secondClient = rpcClient();
  eq(firstClient === secondClient, false);
  const durableBudget = (client: Pick<SupabaseClient, "rpc">) => createPublicSourceBudget({
    enabled: () => true, loadClient: async () => client,
    consume: async (target, scope, key, opts) => {
      const { data, error } = await target.rpc("consume_alpha_rate_limit", { p_scope: scope, p_key: key,
        p_limit: opts.limit, p_window_seconds: opts.windowMs / 1000 });
      return { available: !error, ok: !error && data[0].allowed === true,
        remaining: 0, retryAfterSec: 0 };
    },
  });
  const warnings: string[] = [];
  const makeDurable = (client: Pick<SupabaseClient, "rpc">, failed = false) => createCdmMetadataSearch({
    now: () => durableClock, reserve: durableBudget(client),
    attempt: createPublicSourceCircuit({ enabled: () => true, loadClient: async () => client, warn: message => warnings.push(message) }),
    fetcher: async () => { durableFetches++; return failed ? new Response("", { status: 503 }) : response(); },
  });
  eq((await makeDurable(firstClient)(TOPIC)).length, 1);
  eq((await makeDurable(secondClient)(TOPIC)).length, 1);
  await rejects(makeDurable(firstClient)(TOPIC), /budget exhausted/);
  eq([budgetRpcCalls, durableFetches], [3, 2]);
  eq(completed, []);
  durableClock += 900_000;
  eq((await makeDurable(secondClient)(TOPIC)).length, 1);
  eq([budgetRpcCalls, durableFetches], [4, 3]);
  await rejects(makeDurable(firstClient, true)(TOPIC), /unavailable/);
  eq(completed, ["failure"]);
  await rejects(makeDurable(secondClient)(TOPIC), /circuit cooling_down/);
  eq([budgetRpcCalls, durableFetches], [5, 4]);
  durableFailed = false;
  beginUnavailable = true;
  await rejects(makeDurable(secondClient)(TOPIC), /circuit unavailable/);
  eq([budgetRpcCalls, durableFetches], [5, 4]);
  beginUnavailable = false;
  durableClock += 900_000;
  probe = true;
  completionFails = true;
  eq((await makeDurable(secondClient)(TOPIC)).length, 1);
  eq(completed, ["failure", "success"]);
  eq(warnings.some(message => /durable recovery unconfirmed/.test(message)), true);
  completionFails = false;
  const neutralAttempt = createPublicSourceCircuit({ enabled: () => true, loadClient: async () => secondClient });
  await rejects(neutralAttempt(PROVIDER, async () => { throw new PublicSourceBudgetError("exhausted", PROVIDER); },
    async () => { throw new Error("must never run"); }), /budget exhausted/);
  await rejects(neutralAttempt(PROVIDER, async () => {}, async () => { throw new PublicSourceControlError("local dispatch expired"); }),
    /local dispatch expired/);
  eq(completed, ["failure", "success", "neutral", "neutral"]);
  eq(globalFetches, 0);
  console.log(`PASS CDM metadata runtime offline: ${checks} assertions`);
} finally {
  globalThis.fetch = originalFetch;
  for (const flag of flags) {
    const saved = savedFlags.get(flag);
    if (saved === undefined) delete process.env[flag]; else process.env[flag] = saved;
  }
}
