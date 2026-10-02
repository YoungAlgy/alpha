// Offline PLOS metadata tests. All source requests use injected responses.
import assert from "node:assert/strict";
import { createPlosMetadataSearch, parsePlosMetadata, plosMetadataFallbackEnabled } from "../lib/engine/plos-metadata-search.ts";
import { MAX_PUBLIC_SOURCE_BYTES } from "../lib/engine/public-source-response.ts";
import { PublicSourceBudgetError } from "../lib/engine/public-source-budget.ts";

let checks = 0;
const eq = (actual: unknown, expected: unknown) => { checks++; assert.deepEqual(actual, expected); };
const rejects = async (work: Promise<unknown>, pattern: RegExp) => { checks++; await assert.rejects(work, pattern); };
const now = Date.UTC(2026, 9, 1, 12);
const item = (changed: Record<string, unknown> = {}) => ({
  id: "10.1371/journal.pone.0123456", title_display: "Human nutrition research",
  publication_date: "2026-10-01T00:00:00Z", article_type: "Research Article",
  author_display: ["Ada One", "Bob Two"], journal: "PLOS ONE",
  copyright: "Creative Commons Attribution License (CC BY 4.0)", ...changed,
});
const envelope = (docs: unknown[] = [item()]) => ({ response: { numFound: docs.length, docs } });
const response = (docs: unknown[] = [item()]) => new Response(JSON.stringify(envelope(docs)), {
  headers: { "content-type": "application/json" },
});
const originalFetch = globalThis.fetch;
let external = 0;
globalThis.fetch = (async () => { external++; throw new Error("network denied"); }) as typeof fetch;
try {
  const flagNames = ["ALPHA_NO_MODEL_MODE", "ALPHA_PLOS_METADATA_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET", "ALPHA_DURABLE_SOURCE_COOLDOWN"];
  const priorFlags = new Map(flagNames.map(name => [name, process.env[name]]));
  try {
    for (const name of flagNames) delete process.env[name];
    eq(plosMetadataFallbackEnabled(), false);
    for (const name of flagNames) process.env[name] = "1";
    eq(plosMetadataFallbackEnabled(), true);
    for (const name of flagNames) {
      process.env[name] = "0";
      eq(plosMetadataFallbackEnabled(), false);
      process.env[name] = "1";
    }
  } finally { for (const name of flagNames) { const value = priorFlags.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  const valid = parsePlosMetadata(envelope());
  eq(valid.length, 1);
  eq(valid[0].url, "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0123456");
  eq(valid[0].age, "2026-10-01T00:00:00.000Z");
  eq(valid[0].attribution?.author, "Ada One, Bob Two");
  eq(valid[0].attribution?.publisher, "plos");
  eq(valid[0].description.includes("No findings or advice"), true);
  eq(parsePlosMetadata(envelope([item({ abstract: "SECRET", body: "SECRET" })])), valid);
  for (const [suffix, journal] of [["pmed", "plosmedicine"], ["pdig", "digitalhealth"], ["pmnh", "mentalhealth"]]) {
    eq(parsePlosMetadata(envelope([item({ id: `10.1371/journal.${suffix}.0123456` })]))[0]?.url,
      `https://journals.plos.org/${journal}/article?id=10.1371/journal.${suffix}.0123456`);
  }
  for (const changed of [
    { article_type: "Correction" }, { article_type: ["Research Article"] },
    { title_display: "Nutrition correction" }, { title_display: "Retraction of artificial intelligence" },
    { title_display: "Animal nutrition research" }, { title_display: "Crop nutrition" },
    { title_display: "Unrelated paper" }, { title_display: 7 },
    { publication_date: "2026-02-30T00:00:00Z" }, { publication_date: "2026-10" },
    { publication_date: "2026-10-01T00:00:00+01:00" },
    { publication_date: "2026-10-01T99:99:99Z" },
    { copyright: "All rights reserved. Creative Commons Attribution License" },
    { copyright: "CC BY-NC 4.0" }, { copyright: "Unknown license" },
    { copyright: "Creative Commons Attribution NonCommercial 4.0" },
    { copyright: "Creative Commons Attribution ShareAlike 4.0" },
    { copyright: "Creative Commons Attribution License 3.0" },
    { copyright: "CC BY 2.5" }, { copyright: "Creative Commons Attribution NoDerivs" },
    { author_display: [] }, { author_display: ["Ada One", "bad\nname"] },
    { author_display: Array.from({ length: 21 }, (_, i) => `Author ${i}`) },
    { author_display: ["A".repeat(201)] },
    { id: "10.1371/journal.pbio.0123456" }, { id: "10.1371/journal.pone.123" },
    { id: "10.1371/journal.pone.0123456/evil" },
  ]) eq(parsePlosMetadata(envelope([item(changed)])).length, 0);
  for (const bad of [null, {}, { response: { docs: [] } }, { response: { numFound: 1, docs: {} } },
    { ...envelope(), responseHeader: { status: 1 } }]) {
    checks++; assert.throws(() => parsePlosMetadata(bad), /invalid response/);
  }
  eq(parsePlosMetadata({ ...envelope(), responseHeader: { status: 0 } }).length, 1);
  eq(parsePlosMetadata(envelope(Array.from({ length: 25 }, () => item()))).length, 20);
  eq(parsePlosMetadata(envelope([...Array(20).fill(null), item()])).length, 0);
  let calls = 0;
  eq(parsePlosMetadata(envelope([item({ publication_date: "2026-10-01T16:45:00Z" })]))[0].age, "2026-10-01T16:45:00.000Z");
  let reserves = 0;
  let attempts = 0;
  const search = createPlosMetadataSearch({ now: () => now,
    reserve: async provider => { reserves++; eq(provider, "plos-research"); },
    attempt: async (provider, reserve, work) => { attempts++; eq(provider, "plos-research"); await reserve(); return work(); },
    fetcher: async (input, init) => {
      calls++;
      const url = new URL(String(input));
      eq(url.origin + url.pathname, "https://api.plos.org/search");
      eq(url.searchParams.get("q"), 'title:(nutrition OR "mental health" OR "artificial intelligence") AND article_type:"Research Article" AND publication_date:[2026-09-30T00:00:00.000Z TO 2026-10-01T23:59:59.999Z]');
      eq(url.searchParams.get("fl"), "id,title_display,publication_date,author_display,article_type,journal,copyright");
      eq([url.searchParams.get("rows"), url.searchParams.get("sort"), url.searchParams.get("wt")], ["20", "publication_date desc", "json"]);
      eq([init?.redirect, init?.credentials, init?.cache], ["error", "omit", "no-store"]);
      eq(init?.signal instanceof AbortSignal, true);
      eq(Object.keys((init?.headers ?? {}) as object), ["Accept"]);
      return response([item(), item({ title_display: "Mental health research", id: "10.1371/journal.pmnh.0123456" }),
        item({ title_display: "Artificial intelligence research", id: "10.1371/journal.pdig.0123456" }),
        item({ publication_date: "2026-10-01T23:00:00Z" }),
        item({ publication_date: "2026-10-02T00:00:00Z" })]);
    },
  });
  for (const topic of ["custom:mental health", "", "music", "nutrition-food "]) eq(await search(topic), []);
  for (const freshness of ["invalid", "2026-02-30to2026-03-01", "2026-10-02to2026-10-03"]) {
    eq(await search("nutrition-food", { freshness }), []);
  }
  eq([calls, reserves, attempts], [0, 0, 0]);
  const [nutrition, mental, ai] = await Promise.all([
    search("nutrition-food", { freshness: "pd" }), search("mental-health", { freshness: "pd" }),
    search("ai-news", { freshness: "pd" }),
  ]);
  eq([nutrition.length, mental.length, ai.length], [1, 1, 1]);
  eq([calls, reserves, attempts], [1, 1, 1]);
  nutrition[0].attribution!.author = "changed";
  eq((await search("nutrition-food", { freshness: "pd" }))[0].attribution?.author, "Ada One, Bob Two");

  for (const [label, make, pattern] of [
    ["HTTP", () => new Response("", { status: 503 }), /503/],
    ["HTML", () => new Response("<html/>", { headers: { "content-type": "text/html" } }), /content type/],
    ["JSON", () => new Response("{", { headers: { "content-type": "application/json" } }), /JSON/],
    ["envelope", () => new Response("{}", { headers: { "content-type": "application/json" } }), /invalid response/],
    ["length", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(MAX_PUBLIC_SOURCE_BYTES + 1) } }), /too large/],
    ["stream", () => new Response("x".repeat(MAX_PUBLIC_SOURCE_BYTES + 1), { headers: { "content-type": "application/json" } }), /too large/],
  ] as const) {
    let badCalls = 0;
    const bad = createPlosMetadataSearch({ now: () => now, reserve: async () => {},
      fetcher: async () => { badCalls++; return make(); } });
    await rejects(bad("nutrition-food"), pattern);
    await rejects(bad("ai-news", { freshness: "pd" }), /cooling down/);
    eq(badCalls, 1);
    void label;
  }
  let budgetCalls = 0;
  let budgetFetches = 0;
  const denied = createPlosMetadataSearch({ now: () => now,
    reserve: async () => { if (++budgetCalls === 1) throw new PublicSourceBudgetError("exhausted", "plos-research"); },
    fetcher: async () => { budgetFetches++; return response(); },
  });
  await rejects(denied("nutrition-food"), /budget exhausted/);
  eq(budgetFetches, 0);
  eq((await denied("nutrition-food", { freshness: "pd" })).length, 1);
  eq([budgetCalls, budgetFetches], [2, 1]);

  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  let timeout = 0;
  let cancelled = false;
  AbortSignal.timeout = ms => { timeout = ms; return controller.signal; };
  try {
    const stalled = createPlosMetadataSearch({ now: () => now, reserve: async () => {},
      fetcher: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
        { headers: { "content-type": "application/json" } }),
    });
    const pending = stalled("nutrition-food");
    while (!timeout) await Promise.resolve();
    eq(timeout, 5000);
    controller.abort();
    await rejects(pending, /timed out/);
    eq(cancelled, true);
  } finally { AbortSignal.timeout = originalTimeout; }
  eq(external, 0);
  console.log(`PASS PLOS metadata offline: ${checks} assertions`);
} finally { globalThis.fetch = originalFetch; }
