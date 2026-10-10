// Generic offline fixtures only. No account, environment loader or live client.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createGovUkNewsSearch, govUkNewsFallbackEnabled, GOVUK_NEWS_ENDPOINT } from "../lib/engine/govuk-news-search";
import { MAX_PUBLIC_SOURCE_BYTES } from "../lib/engine/public-source-response";
import { createPublicSourceBudget, PublicSourceBudgetError } from "../lib/engine/public-source-budget";
import { createPublicSourceCircuit, PUBLIC_SOURCE_CIRCUIT_PROVIDERS, PublicSourceCircuitError, type PublicSourceAttempt } from "../lib/engine/public-source-circuit";
import { PublicSourceControlError } from "../lib/engine/public-source-control-error";

const flags = ["ALPHA_NO_MODEL_MODE", "ALPHA_GOVUK_NEWS_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET", "ALPHA_DURABLE_SOURCE_COOLDOWN"];
const savedFlags = new Map(flags.map(name => [name, process.env[name]]));
const savedNoKeyFlag = process.env.ALPHA_NO_KEY_SOURCES;
const savedFetch = globalThis.fetch;
let checks = 0, forbidden = 0;
function eq(actual: unknown, expected: unknown, message?: string) { checks++; assert.deepEqual(actual, expected, message); }
async function rejects(promise: Promise<unknown>, expression: RegExp) { checks++; await assert.rejects(promise, expression); }
const instant = Date.parse("2026-10-09T12:00:00Z");
const record = (overrides: Record<string, unknown> = {}) => ({
  title: "Artificial intelligence  and housing investment", link: "/government/news/ai-housing-investment",
  public_timestamp: "2026-10-09T11:00:00+00:00", format: "press_release",
  description: "DISCARDED_BODY", body: "DISCARDED_BODY", image: "https://example.invalid/never-fetch",
  author: "DISCARDED_AUTHOR", ...overrides,
});
const envelope = (rows: unknown[] = [record()]) => ({ results: rows,
  next_page: "https://example.invalid/never-page" });
const response = (value: unknown = envelope()) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json; charset=utf-8" },
});
const attempt: PublicSourceAttempt = async (provider, reserve, work) => {
  eq(provider, "govuk-news"); await reserve(); return work();
};
const build = (fetcher: typeof fetch, extra: Parameters<typeof createGovUkNewsSearch>[0] = {}) =>
  createGovUkNewsSearch({ now: () => instant, reserve: async provider => eq(provider, "govuk-news"), attempt, fetcher, ...extra });

try {
  globalThis.fetch = (async () => { forbidden++; throw new Error("external network denied"); }) as typeof fetch;
  for (const name of flags) delete process.env[name];
  eq(govUkNewsFallbackEnabled(), false);
  for (const name of flags) process.env[name] = "1";
  eq(govUkNewsFallbackEnabled(), true);
  eq(GOVUK_NEWS_ENDPOINT, "https://www.gov.uk/api/search.json?count=100&order=-public_timestamp&filter_format=news_story&filter_format=press_release&fields=title,link,public_timestamp,format");
  const endpoint = new URL(GOVUK_NEWS_ENDPOINT);
  eq(endpoint.searchParams.getAll("filter_format"), ["news_story", "press_release"]);
  eq(endpoint.searchParams.get("fields"), "title,link,public_timestamp,format");
  eq([...endpoint.searchParams.keys()], ["count", "order", "filter_format", "filter_format", "fields"]);

  let calls = 0;
  const gated = build(async () => { calls++; return response(); });
  for (const flag of flags) {
    delete process.env[flag];
    eq(await gated("ai-news"), []); eq(calls, 0);
    process.env[flag] = "0"; eq(await gated("ai-news"), []); eq(calls, 0);
    process.env[flag] = "1";
  }
  process.env.ALPHA_NO_KEY_SOURCES = "1";
  delete process.env.ALPHA_GOVUK_NEWS_FALLBACK;
  eq(await gated("ai-news"), [], "no-key mode cannot opt in this tier");
  delete process.env.ALPHA_NO_KEY_SOURCES;
  process.env.ALPHA_GOVUK_NEWS_FALLBACK = "1";
  for (const topic of ["music", "personal-finance", "custom:artificial intelligence", "AI-news", "ai-news ", "__proto__", "constructor"]) {
    eq(await gated(topic), []);
  }
  for (const freshness of ["py", "bad", "2026-02-30to2026-10-09", "2026-10-10to2026-10-11"]) {
    eq(await gated("ai-news", { freshness: freshness as "py" }), []);
  }
  eq(calls, 0);
  eq(await build(async () => response(), { now: () => NaN })("ai-news"), []);

  let clock = instant, reserves = 0;
  const pool = [record(), record({ title: "Interest rates and economic growth", link: "/government/news/economic-growth", public_timestamp: "2026-10-07T12:00:00Z", format: "news_story" })];
  const search = build(async (input, init) => {
    calls++; eq(String(input), GOVUK_NEWS_ENDPOINT);
    eq([init?.redirect, init?.credentials, init?.cache], ["error", "omit", "no-store"]);
    eq([init?.method, init?.body], [undefined, undefined]);
    eq(init?.headers, { Accept: "application/json" });
    eq(init?.signal instanceof AbortSignal, true);
    return response(envelope(pool));
  }, { now: () => clock, reserve: async provider => { reserves++; eq(provider, "govuk-news"); } });
  const [ai, macroDay, houses, macroWeek] = await Promise.all([
    search("ai-news", { freshness: "pd", count: 1, country: "US" }),
    search("macro-markets", { freshness: "pd" }), search("real-estate", { freshness: "pw" }),
    search("macro-markets", { freshness: "pw" }),
  ]);
  eq([calls, reserves], [1, 1], "one fixed raw request coalesces topics and freshness windows");
  eq([ai.length, macroDay.length, houses.length, macroWeek.length], [1, 0, 1, 1]);
  eq(ai[0].title, pool[0].title); eq(ai[0].url, "https://www.gov.uk" + pool[0].link);
  eq(ai[0].age, "2026-10-09T11:00:00.000Z"); eq(ai[0].description, "");
  eq(ai[0].attribution?.publisher, "govuk");
  eq(Object.keys(ai[0].attribution!).sort(), ["format", "kind", "publicTimestamp", "publisher", "timestampMeaning", "title", "url"].sort());
  checks++; assert.doesNotMatch(JSON.stringify(ai), /DISCARDED_|never-fetch|never-page/);
  checks++; assert.notEqual(ai[0].attribution, houses[0].attribution);
  ai[0].title = "mutated caller title";
  (ai[0].attribution as Record<string, unknown>).title = "mutated credit";
  (ai[0].attribution as Record<string, unknown>).url = "https://example.invalid/mutated";
  const freshCopy = (await search("ai-news"))[0];
  eq(freshCopy.title, pool[0].title); eq((freshCopy.attribution as Record<string, unknown>).title, pool[0].title);
  eq(freshCopy.attribution, houses[0].attribution);
  eq((await search("macro-markets", { freshness: "2026-10-09to2026-10-09" })).length, 0);
  eq([calls, reserves], [1, 1]);
  clock += 5 * 60_000 + 1;
  await search("real-estate"); eq([calls, reserves], [2, 2], "cache expiry makes one new reservation");

  let futureClock = instant, futureCalls = 0;
  const futureSearch = build(async () => { futureCalls++; return response(envelope([record({ public_timestamp: "2026-10-09T12:02:00Z" })])); }, { now: () => futureClock });
  eq(await futureSearch("ai-news", { freshness: "pd" }), []);
  futureClock += 120_000;
  eq((await futureSearch("real-estate", { freshness: "pd" })).length, 1);
  eq(futureCalls, 1, "a future publication becomes current in the shared raw cache");
  let agingClock = instant;
  const aging = build(async () => response(envelope([record({ public_timestamp: "2026-10-08T12:00:30Z" })])), { now: () => agingClock });
  eq((await aging("ai-news", { freshness: "pd" })).length, 1);
  agingClock += 60_000;
  eq(await aging("ai-news", { freshness: "pd" }), []);
  eq((await aging("ai-news", { freshness: "pw" })).length, 1);

  await rejects(build(async () => new Response(null, { status: 503 }))("ai-news"), /unavailable/);
  for (const contentType of ["text/html", "text/application/json", "application/jsonp", "application/problem+json", "application/json trailing"]) {
    await rejects(build(async () => new Response("{}", { headers: { "content-type": contentType } }))("ai-news"), /invalid content type/);
  }
  await rejects(build(async () => new Response("{}"))("ai-news"), /invalid content type/);
  await rejects(build(async () => new Response("{", { headers: { "content-type": "application/json" } }))("ai-news"), /JSON/);
  for (const value of [null, {}, { results: "bad" }, envelope(Array(101).fill(record()))]) {
    await rejects(build(async () => response(value))("ai-news"), /invalid|oversized/);
  }
  for (const length of [String(MAX_PUBLIC_SOURCE_BYTES + 1), "unknown", "-1"]) {
    await rejects(build(async () => new Response("{}", { headers: { "content-type": "application/json", "content-length": length } }))("ai-news"), /too large|invalid length/);
  }
  await rejects(build(async () => new Response("x".repeat(MAX_PUBLIC_SOURCE_BYTES + 1), { headers: { "content-type": "application/json" } }))("ai-news"), /too large/);
  eq((await build(async () => response(envelope([{ ...record(), link: "https://example.invalid/unsafe" }, record()])))("ai-news")).length, 1, "useful siblings survive invalid metadata");
  eq(await build(async () => response(envelope([])))("ai-news"), []);

  let cancelled = false, headerSignal: AbortSignal | undefined;
  const wallStart = Date.now();
  await Promise.all([
    rejects(build(async () => new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }), {
      headers: { "content-type": "application/json" },
    }))("ai-news"), /timed out/),
    rejects(build(async (_input, init) => { headerSignal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); })("ai-news"), /timed out/),
  ]);
  eq(cancelled, true); eq(headerSignal?.aborted, true);
  checks++; assert.ok(Date.now() - wallStart >= 4500 && Date.now() - wallStart < 8000, "real five-second deadline covers headers and a stalled body");

  let outageCalls = 0, outageClock = instant;
  const outage = build(async () => { outageCalls++; throw new Error("fixture upstream failure"); }, { now: () => outageClock });
  await rejects(outage("ai-news"), /fixture upstream/);
  await rejects(outage("real-estate"), /cooling down/); eq(outageCalls, 1);
  outageClock += 60_001; await rejects(outage("macro-markets"), /fixture upstream/); eq(outageCalls, 2);
  for (const code of ["exhausted", "unavailable"] as const) {
    let deniedFetches = 0, reservationCalls = 0;
    const denied = build(async () => { deniedFetches++; return response(); }, { reserve: async provider => {
      eq(provider, "govuk-news"); if (++reservationCalls === 1) throw new PublicSourceBudgetError(code, provider);
    } });
    await rejects(denied("ai-news"), new RegExp(`budget ${code}`)); eq(deniedFetches, 0);
    eq((await denied("real-estate")).length, 1); eq(deniedFetches, 1, "budget denial never poisons the provider cache");
  }
  for (const error of [new PublicSourceCircuitError("cooling_down", "govuk-news"), new PublicSourceCircuitError("unavailable", "govuk-news"), new PublicSourceControlError("dispatch gate expired")]) {
    let attempts = 0, deniedFetches = 0;
    const denied = build(async () => { deniedFetches++; return response(); }, { attempt: async (_provider, reserve, work) => {
      if (++attempts === 1) throw error; await reserve(); return work();
    } });
    await rejects(denied("ai-news"), /circuit|dispatch gate/); eq(deniedFetches, 0);
    eq((await denied("ai-news")).length, 1); eq(deniedFetches, 1);
  }

  const generation = "11111111-1111-4111-8111-111111111111";
  const probeToken = "22222222-2222-4222-8222-222222222222";
  const completions: Record<string, unknown>[] = [];
  let admission: unknown = [{ admitted: true, generation, probe_token: null, retry_after_sec: 0 }];
  let completionUnavailable = false, warnings = 0;
  const circuit = createPublicSourceCircuit({ enabled: () => true, warn: () => warnings++, loadClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      eq(args.p_provider, "govuk-news");
      if (name === "begin_alpha_public_source") return { data: admission, error: null };
      eq(name, "complete_alpha_public_source"); completions.push(args);
      return completionUnavailable ? { data: null, error: { message: "fixture completion unavailable" } } : { data: true, error: null };
    },
  }) as unknown as Pick<SupabaseClient, "rpc"> });
  let controlledFetches = 0, controlledReserves = 0;
  const controlled = () => build(async () => { controlledFetches++; return response(); }, {
    attempt: circuit, reserve: async () => { controlledReserves++; },
  });
  eq(PUBLIC_SOURCE_CIRCUIT_PROVIDERS.includes("govuk-news"), true);
  admission = [];
  await rejects(controlled()("ai-news"), /circuit unavailable/); eq([controlledFetches, controlledReserves], [0, 0]);
  admission = [{ admitted: false, generation, probe_token: null, retry_after_sec: 900 }];
  await rejects(controlled()("ai-news"), /cooling_down/); eq([controlledFetches, controlledReserves], [0, 0]);
  admission = [{ admitted: true, generation, probe_token: probeToken, retry_after_sec: 0 }];
  const reserveDenied = build(async () => { controlledFetches++; return response(); }, {
    attempt: circuit, reserve: async () => { throw new PublicSourceBudgetError("exhausted", "govuk-news"); },
  });
  await rejects(reserveDenied("ai-news"), /budget exhausted/);
  eq(completions.at(-1)?.p_outcome, "neutral"); eq(controlledFetches, 0);
  await rejects(build(async () => { throw new Error("fixture actual upstream failure"); }, { attempt: circuit })("ai-news"), /actual upstream/);
  eq(completions.at(-1)?.p_outcome, "failure");
  completionUnavailable = true;
  eq((await controlled()("ai-news")).length, 1, "real metadata survives optional completion failure");
  eq(completions.at(-1)?.p_outcome, "success"); eq(warnings, 1);
  eq(completions.at(-1)?.p_generation, generation); eq(completions.at(-1)?.p_probe_token, probeToken);

  let budgetLoads = 0;
  const disabledBudget = createPublicSourceBudget({ enabled: () => false, loadClient: async () => { budgetLoads++; throw new Error("forbidden private load"); } });
  await disabledBudget("govuk-news"); eq(budgetLoads, 0);
  // Inject only the private limiter boundary. Exercise the real budget's fixed
  // provider/scope/cap/window wiring without reading or setting a secret.
  let budgetClock = instant, budgetConsumes = 0;
  const reservations = new Map<string, number>();
  const fixtureClient = { rpc: async () => { throw new Error("private RPC forbidden"); } } as unknown as Pick<SupabaseClient, "rpc">;
  const makeBudget = () => createPublicSourceBudget({ enabled: () => true, loadClient: async () => fixtureClient,
    consume: async (client, scope, identifier, options) => {
      eq(client, fixtureClient); eq(identifier, scope === "public_source:govuk_news" ? "govuk-news" : "plos-research");
      eq(options, { limit: 2, windowMs: 15 * 60_000 }); budgetConsumes++;
      const key = `${scope}|${Math.floor(budgetClock / options.windowMs)}`;
      const count = (reservations.get(key) ?? 0) + 1;
      reservations.set(key, count);
      return { available: true, ok: count <= options.limit, remaining: Math.max(0, options.limit - count), retryAfterSec: count <= options.limit ? 0 : 900 };
    },
  });
  const budgetOne = makeBudget(), budgetTwo = makeBudget();
  await budgetOne("govuk-news"); await budgetTwo("govuk-news");
  await rejects(budgetOne("govuk-news"), /budget exhausted/); eq(budgetConsumes, 3);
  await budgetTwo("plos-research"); eq(budgetConsumes, 4, "GOV.UK budget is independent from PLOS");
  budgetClock += 15 * 60_000;
  await budgetTwo("govuk-news"); eq(budgetConsumes, 5, "a new fixed window admits another instance");
  const unavailableBudget = createPublicSourceBudget({ enabled: () => true, loadClient: async () => fixtureClient,
    consume: async () => ({ available: false, ok: false, remaining: 0, retryAfterSec: 0 }),
  });
  await rejects(unavailableBudget("govuk-news"), /budget unavailable/);
  const migration = await readFile(new URL("../supabase/migrations/20261010000000_govuk_public_source_circuit.sql", import.meta.url), "utf8");
  checks++; assert.match(migration, /exact ten prior source identities/);
  checks++; assert.match(migration, /unexpected provider constraint/);
  checks++; assert.doesNotMatch(migration, /create(?: or replace)? function|\bgrant\b|\brevoke\b|\bupdate public\./i);
  eq(forbidden, 0);
  console.log(`PASS GOV.UK news adapter: ${checks} focused assertions, generic offline fixtures only, zero external requests.`);
} finally {
  globalThis.fetch = savedFetch;
  if (savedNoKeyFlag === undefined) delete process.env.ALPHA_NO_KEY_SOURCES;
  else process.env.ALPHA_NO_KEY_SOURCES = savedNoKeyFlag;
  for (const flag of flags) { const value = savedFlags.get(flag); if (value === undefined) delete process.env[flag]; else process.env[flag] = value; }
}
