// Generic offline fixtures only. No account, environment loader or live client.
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStatCanLabourSearch, statCanLabourFallbackEnabled, STATCAN_LABOUR_ENDPOINT } from "../lib/engine/statcan-labour-search";
import { inspectStatCanLabourMetadata, parseStatCanLabourPool, selectStatCanLabourMetadata, statCanLabourStoryKey, validatedStatCanLabourMetadata } from "../lib/engine/statcan-labour-metadata";
import { MAX_PUBLIC_SOURCE_BYTES } from "../lib/engine/public-source-response";
import { createPublicSourceBudget, PublicSourceBudgetError } from "../lib/engine/public-source-budget";
import { createPublicSourceCircuit, PUBLIC_SOURCE_CIRCUIT_PROVIDERS, PublicSourceCircuitError, type PublicSourceAttempt } from "../lib/engine/public-source-circuit";
import { PublicSourceControlError } from "../lib/engine/public-source-control-error";

const flags = ["ALPHA_NO_MODEL_MODE", "ALPHA_STATCAN_LABOUR_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET", "ALPHA_DURABLE_SOURCE_COOLDOWN", "ALPHA_NO_KEY_SOURCES"];
const savedFlags = new Map(flags.map(name => [name, process.env[name]]));
const savedFetch = globalThis.fetch;
let checks = 0, forbidden = 0;
function eq(actual: unknown, expected: unknown, message?: string) { checks++; assert.deepEqual(actual, expected, message); }
async function rejects(promise: Promise<unknown>, expression: RegExp) { checks++; await assert.rejects(promise, expression); }
const now = Date.parse("2026-10-10T12:00:00Z");
const title = "Employment indicators  and unemployment";
const stamp = "2026-10-10T11:00:00Z";
const url = (suffix = "a", day = "261010", alias = false) => `https://${alias ? "www150.statcan.gc.ca/n1" : "www.statcan.gc.ca"}/daily-quotidien/${day}/dq${day}${suffix}-eng.htm`;
const entry = (headline = title, link = url(), updated = stamp, extra = "") => `<entry><title>${headline}</title><updated>${updated}</updated><link href="${link}"/>${extra}</entry>`;
const feed = (entries = entry()) => `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
const response = (xml = feed()) => new Response(xml, { headers: { "content-type": "application/atom+xml; charset=utf-8" } });
const attempt: PublicSourceAttempt = async (provider, reserve, work) => { eq(provider, "statcan-labour"); await reserve(); return work(); };
const build = (fetcher: typeof fetch, extra: Parameters<typeof createStatCanLabourSearch>[0] = {}) =>
  createStatCanLabourSearch({ now: () => now, reserve: async provider => eq(provider, "statcan-labour"), attempt, fetcher, ...extra });

try {
  globalThis.fetch = (async () => { forbidden++; throw new Error("external network denied"); }) as typeof fetch;
  for (const name of flags) delete process.env[name];
  eq(statCanLabourFallbackEnabled(), false);
  for (const name of flags.slice(0, 4)) process.env[name] = "1";
  eq(statCanLabourFallbackEnabled(), true);
  eq(STATCAN_LABOUR_ENDPOINT, "https://www150.statcan.gc.ca/n1/rss/dai-quo/14-eng.atom");
  eq(new URL(STATCAN_LABOUR_ENDPOINT).search, "");

  let calls = 0, privateLoads = 0;
  const noPrivate = async () => { privateLoads++; throw new Error("private client forbidden"); };
  const gated = build(async () => { calls++; return response(); }, {
    reserve: createPublicSourceBudget({ enabled: () => true, loadClient: noPrivate }),
    attempt: createPublicSourceCircuit({ enabled: () => true, loadClient: noPrivate }),
  });
  for (const flag of flags.slice(0, 4)) {
    delete process.env[flag]; eq(await gated("macro-markets"), []);
    process.env[flag] = "0"; eq(await gated("macro-markets"), []);
    process.env[flag] = "1";
  }
  process.env.ALPHA_NO_KEY_SOURCES = "1"; delete process.env.ALPHA_STATCAN_LABOUR_FALLBACK;
  eq(await gated("macro-markets"), [], "no-key mode cannot activate StatCan");
  delete process.env.ALPHA_NO_KEY_SOURCES; process.env.ALPHA_STATCAN_LABOUR_FALLBACK = "1";
  for (const topic of ["music", "personal-finance", "ai-news", "custom:employment", "macro-markets ", "Macro-markets", "__proto__", "constructor"]) eq(await gated(topic), []);
  for (const freshness of ["py", "bad", "2026-02-30to2026-10-10", "2026-10-11to2026-10-12"]) eq(await gated("macro-markets", { freshness: freshness as "py" }), []);
  eq(await build(async () => response(), { now: () => NaN })("macro-markets"), []);
  eq([calls, privateLoads], [0, 0], "disabled/unsupported paths cannot load a database or fetch");

  let clock = now, reservations = 0;
  const xml = feed(entry() + entry("Employment insurance", url("b", "261007"), "2026-10-07T11:00:00Z", "<summary>DISCARDED_BODY</summary><content>DISCARDED_BODY</content>"));
  const search = build(async (input, init) => {
    calls++; eq(String(input), STATCAN_LABOUR_ENDPOINT);
    eq([init?.redirect, init?.credentials, init?.cache], ["error", "omit", "no-store"]);
    eq([init?.method, init?.body], [undefined, undefined]);
    eq(init?.headers, { Accept: "application/atom+xml" });
    eq(init?.signal instanceof AbortSignal, true);
    return response(xml);
  }, { now: () => clock, reserve: async provider => { eq(provider, "statcan-labour"); reservations++; } });
  const [day, week, excluded] = await Promise.all([
    search("macro-markets", { freshness: "pd", count: 1, country: "US" }),
    search("macro-markets", { freshness: "pw" }),
    search("macro-markets", { freshness: "pw" }, new Set([url("a", "261010", true)])),
  ]);
  eq([calls, reservations], [1, 1], "coalesced raw request ignores windows and readers");
  eq([day.length, week.length, excluded.length], [1, 2, 1]);
  eq([day[0].title, day[0].url, day[0].age, day[0].description], [title, url(), stamp, ""]);
  eq(day[0].attribution, parseStatCanLabourPool(feed())[0]);
  eq(Object.keys(day[0].attribution!).sort(), ["title", "url", "updatedInstant", "dailyLinkDay", "publisher", "kind", "dateBasis"].sort());
  checks++; assert.doesNotMatch(JSON.stringify(week), /DISCARDED_BODY|summary|content|publication|publishedAt/);
  checks++; assert.notEqual(day[0].attribution, week[0].attribution);
  day[0].title = "caller mutation";
  (day[0].attribution as Record<string, unknown>).title = "caller credit mutation";
  eq((await search("macro-markets"))[0].title, title);
  eq((await search("macro-markets"))[0].attribution, week[0].attribution);
  clock += 5 * 60_000 + 1;
  await search("macro-markets"); eq([calls, reservations], [2, 2]);

  const raw = parseStatCanLabourPool(feed(entry("General bulletin") + entry("Employment", url("b"), "2026-10-10T12:02:00Z") + entry("Employment", url("c", "261001"), "2026-10-01T10:00:00Z")));
  eq(raw.length, 3, "pool is topic and date neutral");
  eq(selectStatCanLabourMetadata(raw, "macro-markets", { now, freshness: "pw" }), []);
  eq(selectStatCanLabourMetadata(raw, "macro-markets", { now: now + 120_000, freshness: "pd" }).length, 1);
  eq(selectStatCanLabourMetadata(raw, "ai-news", { now, freshness: "pw" }), []);
  eq(validatedStatCanLabourMetadata({ ...raw[0], publisher: "other" }), undefined);
  eq(validatedStatCanLabourMetadata({ ...raw[0], dailyLinkDay: "2026-10-09" }), undefined);
  eq(validatedStatCanLabourMetadata(Object.defineProperty({}, "title", { get() { throw new Error("forbidden getter"); } })), undefined);
  for (const [first, second] of [[url(), url("a", "261010", true)], [url("a", "261010", true), url()]]) {
    eq(statCanLabourStoryKey(first), statCanLabourStoryKey(second));
    const row = parseStatCanLabourPool(feed(entry(title, first)));
    for (const link of [second, url().replace("https://www.", ""), url("a", "261010", true).replace("https://", "")]) {
      eq(selectStatCanLabourMetadata(row, "macro-markets", { now, excludedLinks: new Set([link]) }), []);
      eq(await build(async () => response(feed(entry(title, first))))("macro-markets", {}, new Set([link])), []);
      const inspected = inspectStatCanLabourMetadata(feed(entry(title, first)), { now, topicId: "macro-markets", excludedLinks: new Set([link]) });
      eq(inspected.items, []);
      eq(inspected.diagnostics.priorLinkRejected, 1);
    }
  }
  const manyEntries = Array.from({ length: 105 }, (_, i) => entry(title, url(`a${i}`))).join("");
  const many = parseStatCanLabourPool(feed(manyEntries));
  eq(many.length, 105, "raw valid pool is retained past the selected cap");
  const excludedMany = new Set(many.slice(0, 100).map(row => row.url.replace("https://www.", "")));
  eq(selectStatCanLabourMetadata(many, "macro-markets", { now, excludedLinks: excludedMany }).map(row => row.url), many.slice(100).map(row => row.url));
  eq((await build(async () => response(feed(manyEntries)))("macro-markets", {}, excludedMany)).length, 5);
  eq(selectStatCanLabourMetadata(many, "macro-markets", { now }).length, 100);
  eq(selectStatCanLabourMetadata([raw[0], { ...many[0], title: "Employment" }, { ...many[1], updatedInstant: "2026-10-11T12:00:00Z" }, ...many.slice(2)], "macro-markets", { now }).length, 100);
  for (const [headline, day, updated] of [
    ["General bulletin", "261010", stamp],
    [title, "261001", "2026-10-01T11:00:00Z"],
    [title, "261010", "2026-10-10T12:02:00Z"],
  ]) {
    const rejectedFirst = Array.from({ length: 100 }, (_, i) => entry(headline, url(`b${i}`, day), updated)).join("");
    const pool = parseStatCanLabourPool(feed(rejectedFirst + entry()));
    eq(pool.length, 101);
    eq(selectStatCanLabourMetadata(pool, "macro-markets", { now, freshness: "pd" }).map(row => row.url), [url()], "100 rejected topic/date rows cannot hide a usable sibling");
    eq((await build(async () => response(feed(rejectedFirst + entry())))("macro-markets", { freshness: "pd" })).map(row => row.url), [url()]);
  }
  eq(statCanLabourStoryKey(url().replace("https://", "")), undefined, "absolute story identity stays strict");
  eq(statCanLabourStoryKey(url() + "?ignored=1"), undefined);
  eq(selectStatCanLabourMetadata([many[0], { ...many[0], url: url("a0", "261010", true) }, many[1]], "macro-markets", { now }).length, 2);
  eq(selectStatCanLabourMetadata([many[0]], "macro-markets", { now, excludedLinks: new Set([url("a0") + "?ignored=1"]) }).length, 1, "unsupported prior URL forms cannot become guessed identities");
  checks++; assert.throws(() => parseStatCanLabourPool(feed(manyEntries + '<x:entry xmlns:x="urn:foreign"/>')), /invalid/);
  checks++; assert.throws(() => parseStatCanLabourPool(feed(manyEntries) + "<bad>"), /invalid/);
  const expandingEntries = Array.from({ length: 1100 }, (_, i) => entry("Employment", url(`c${i}`))).join("");
  const expandingXml = feed(expandingEntries);
  checks++; assert.ok(new TextEncoder().encode(expandingXml).byteLength < MAX_PUBLIC_SOURCE_BYTES, "input fits but scalar credit projection can grow beyond cache bound");
  checks++; assert.throws(() => parseStatCanLabourPool(expandingXml), /invalid or oversized metadata pool/);
  await rejects(build(async () => response(expandingXml))("macro-markets"), /invalid or oversized metadata pool/);
  checks++; assert.throws(() => parseStatCanLabourPool(feed(expandingEntries + '<x:entry xmlns:x="urn:foreign"/>')), /invalid or unsupported XML/, "whole envelope is checked before projection bound");

  let futureClock = now, futureCalls = 0;
  const futureSearch = build(async () => { futureCalls++; return response(feed(entry(title, url(), "2026-10-10T12:02:00Z"))); }, { now: () => futureClock });
  eq(await futureSearch("macro-markets"), []); futureClock += 120_000;
  eq((await futureSearch("macro-markets")).length, 1); eq(futureCalls, 1);
  let agingClock = now, agingCalls = 0;
  const aging = build(async () => { agingCalls++; return response(feed(entry(title, url("a", "261009"), "2026-10-09T12:00:30Z"))); }, { now: () => agingClock });
  eq((await aging("macro-markets", { freshness: "pd" })).length, 1); agingClock += 60_000;
  eq(await aging("macro-markets", { freshness: "pd" }), []);
  eq((await aging("macro-markets", { freshness: "pw" })).length, 1); eq(agingCalls, 1);

  await rejects(build(async () => new Response(null, { status: 503 }))("macro-markets"), /unavailable/);
  for (const contentType of ["text/html", "text/xml", "application/xml", "application/atom+xmlx", "text/application/atom+xml", "application/atom+xml trailing"]) {
    await rejects(build(async () => new Response(feed(), { headers: { "content-type": contentType } }))("macro-markets"), /invalid content type/);
  }
  await rejects(build(async () => new Response(feed()))("macro-markets"), /invalid content type/);
  await rejects(build(async () => response("<feed>"))("macro-markets"), /invalid/);
  await rejects(build(async () => new Response(null, { headers: { "content-type": "application/atom+xml" } }))("macro-markets"), /missing body/);
  for (const length of [String(MAX_PUBLIC_SOURCE_BYTES + 1), "unknown", "-1"]) {
    await rejects(build(async () => new Response(feed(), { headers: { "content-type": "application/atom+xml", "content-length": length } }))("macro-markets"), /too large|invalid length/);
  }
  await rejects(build(async () => response("x".repeat(MAX_PUBLIC_SOURCE_BYTES + 1)))("macro-markets"), /too large/);
  await rejects(build(async () => response("é".repeat(MAX_PUBLIC_SOURCE_BYTES / 2 + 1)))("macro-markets"), /too large/);
  eq((await build(async () => response(feed(entry(title, "https://example.invalid/unsafe") + entry())))("macro-markets")).length, 1);
  eq(await build(async () => response(feed("")))("macro-markets"), []);

  let cancelled = false, headerSignal: AbortSignal | undefined;
  const wallStart = Date.now();
  await Promise.all([
    rejects(build(async () => new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }), { headers: { "content-type": "application/atom+xml" } }))("macro-markets"), /timed out/),
    rejects(build(async (_input, init) => { headerSignal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); })("macro-markets"), /timed out/),
  ]);
  eq(cancelled, true); eq(headerSignal?.aborted, true);
  checks++; assert.ok(Date.now() - wallStart >= 4500 && Date.now() - wallStart < 8000);
  let outageCalls = 0, outageClock = now;
  const outage = build(async () => { outageCalls++; throw new Error("fixture upstream failure"); }, { now: () => outageClock });
  await rejects(outage("macro-markets"), /fixture upstream/);
  await rejects(outage("macro-markets"), /cooling down/); eq(outageCalls, 1);
  outageClock += 60_001; await rejects(outage("macro-markets"), /fixture upstream/); eq(outageCalls, 2);
  for (const code of ["exhausted", "unavailable"] as const) {
    let deniedCalls = 0, reserves = 0;
    const denied = build(async () => { deniedCalls++; return response(); }, { reserve: async provider => { if (++reserves === 1) throw new PublicSourceBudgetError(code, provider); } });
    await rejects(denied("macro-markets"), new RegExp(`budget ${code}`)); eq(deniedCalls, 0);
    eq((await denied("macro-markets")).length, 1); eq(deniedCalls, 1);
  }
  for (const error of [new PublicSourceCircuitError("cooling_down", "statcan-labour"), new PublicSourceCircuitError("unavailable", "statcan-labour"), new PublicSourceControlError("dispatch gate expired")]) {
    let attempts = 0, deniedCalls = 0;
    const denied = build(async () => { deniedCalls++; return response(); }, { attempt: async (_provider, reserve, work) => { if (++attempts === 1) throw error; await reserve(); return work(); } });
    await rejects(denied("macro-markets"), /circuit|dispatch gate/); eq(deniedCalls, 0);
    eq((await denied("macro-markets")).length, 1); eq(deniedCalls, 1);
  }

  const generation = "11111111-1111-4111-8111-111111111111", probe = "22222222-2222-4222-8222-222222222222";
  let admission: unknown = [{ admitted: true, generation, probe_token: null, retry_after_sec: 0 }];
  let dbError = false, completionError = false, warnings = 0;
  const events: string[] = [], completions: Record<string, unknown>[] = [];
  const circuit = createPublicSourceCircuit({ enabled: () => true, warn: () => warnings++, loadClient: async () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
    eq(args.p_provider, "statcan-labour");
    if (name === "begin_alpha_public_source") { events.push("admit"); return { data: admission, error: dbError ? { message: "fixture DB unavailable" } : null }; }
    eq(name, "complete_alpha_public_source"); completions.push(args);
    return { data: completionError ? null : true, error: completionError ? { message: "fixture completion unavailable" } : null };
  } }) as unknown as Pick<SupabaseClient, "rpc"> });
  const controlled = () => build(async () => { events.push("fetch"); return response(); }, { attempt: circuit, reserve: async () => { events.push("budget"); } });
  eq(PUBLIC_SOURCE_CIRCUIT_PROVIDERS.includes("statcan-labour"), true);
  eq((await controlled()("macro-markets")).length, 1); eq(events, ["admit", "budget", "fetch"]); events.length = 0;
  admission = []; await rejects(controlled()("macro-markets"), /circuit unavailable/); eq(events, ["admit"]); events.length = 0;
  admission = [{ admitted: false, generation, probe_token: null, retry_after_sec: 900 }];
  await rejects(controlled()("macro-markets"), /cooling_down/); eq(events, ["admit"]); events.length = 0;
  dbError = true; await rejects(controlled()("macro-markets"), /circuit unavailable/); eq(events, ["admit"]); events.length = 0; dbError = false;
  admission = [{ admitted: true, generation, probe_token: probe, retry_after_sec: 0 }];
  const reserveDenied = build(async () => { events.push("fetch"); return response(); }, { attempt: circuit, reserve: async () => { throw new PublicSourceBudgetError("exhausted", "statcan-labour"); } });
  await rejects(reserveDenied("macro-markets"), /budget exhausted/); eq(events, ["admit"]); eq(completions.at(-1)?.p_outcome, "neutral"); events.length = 0;
  await rejects(build(async () => { throw new Error("fixture actual provider failure"); }, { attempt: circuit })("macro-markets"), /actual provider/);
  eq(completions.at(-1)?.p_outcome, "failure");
  completionError = true; eq((await controlled()("macro-markets")).length, 1);
  eq(completions.at(-1)?.p_outcome, "success"); eq(warnings, 1);
  eq([completions.at(-1)?.p_generation, completions.at(-1)?.p_probe_token], [generation, probe]);

  let budgetLoads = 0;
  const disabledBudget = createPublicSourceBudget({ enabled: () => false, loadClient: async () => { budgetLoads++; throw new Error("forbidden private load"); } });
  await disabledBudget("statcan-labour"); eq(budgetLoads, 0);
  let budgetClock = now, budgetConsumes = 0;
  const counts = new Map<string, number>();
  const fixtureClient = { rpc: async () => { throw new Error("real RPC forbidden"); } } as unknown as Pick<SupabaseClient, "rpc">;
  const makeBudget = () => createPublicSourceBudget({ enabled: () => true, loadClient: async () => fixtureClient, consume: async (client, scope, identifier, options) => {
    eq(client, fixtureClient); eq(identifier, scope === "public_source:statcan_labour" ? "statcan-labour" : "govuk-news");
    eq(options, { limit: 2, windowMs: 15 * 60_000 }); budgetConsumes++;
    const key = `${scope}|${Math.floor(budgetClock / options.windowMs)}`, count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return { available: true, ok: count <= options.limit, remaining: Math.max(0, options.limit - count), retryAfterSec: count <= options.limit ? 0 : 900 };
  } });
  const one = makeBudget(), two = makeBudget();
  await one("statcan-labour"); await two("statcan-labour"); await rejects(one("statcan-labour"), /budget exhausted/);
  await two("govuk-news"); eq(budgetConsumes, 4, "StatCan budget is independent from GOV.UK");
  budgetClock += 15 * 60_000; await two("statcan-labour"); eq(budgetConsumes, 5);
  for (const reserve of [
    createPublicSourceBudget({ enabled: () => true, loadClient: async () => { throw new Error("fixture DB load failure"); } }),
    createPublicSourceBudget({ enabled: () => true, loadClient: async () => fixtureClient, consume: async () => ({ available: false, ok: false, remaining: 0, retryAfterSec: 0 }) }),
  ]) await rejects(reserve("statcan-labour"), /budget unavailable/);
  eq(forbidden, 0);
  console.log(`PASS StatCan labour adapter: ${checks} focused assertions, generic offline fixtures only, zero external requests.`);
} finally {
  globalThis.fetch = savedFetch;
  for (const flag of flags) { const value = savedFlags.get(flag); if (value === undefined) delete process.env[flag]; else process.env[flag] = value; }
}
