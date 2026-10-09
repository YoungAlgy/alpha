// Generic local fixtures only. No reader, provider, database or environment file.
import assert from "node:assert/strict";
import { createFederalRegisterFinanceSearch, federalRegisterFinanceFallbackEnabled,
  parseFederalRegisterFinanceMetadata, FEDERAL_REGISTER_FINANCE_ENDPOINT } from "../lib/engine/federal-register-finance-search";
import { MAX_PUBLIC_SOURCE_BYTES } from "../lib/engine/public-source-response";
import { PublicSourceBudgetError } from "../lib/engine/public-source-budget";
import { PublicSourceCircuitError, type PublicSourceAttempt } from "../lib/engine/public-source-circuit";

const flags = ["ALPHA_NO_MODEL_MODE", "ALPHA_FEDERAL_REGISTER_FINANCE_FALLBACK", "ALPHA_DURABLE_SOURCE_BUDGET", "ALPHA_DURABLE_SOURCE_COOLDOWN"];
const old = new Map(flags.map(name => [name, process.env[name]]));
const savedFetch = globalThis.fetch;
let checks = 0, forbidden = 0;
function eq(actual: unknown, expected: unknown, message?: string) { checks++; assert.deepEqual(actual, expected, message); }
async function rejects(promise: Promise<unknown>, expression: RegExp) { checks++; await assert.rejects(promise, expression); }
const now = Date.parse("2026-10-09T12:00:00Z");
const document = (overrides: Record<string, unknown> = {}) => ({
  title: "Investment Adviser Retirement Account Fees", type: "Proposed Rule", document_number: "2026-12345",
  html_url: "https://www.federalregister.gov/documents/2026/10/09/2026-12345/retirement-account-fees",
  publication_date: "2026-10-09", agencies: [{ name: "Securities and Exchange Commission", slug: "securities-and-exchange-commission" }],
  abstract: "DISCARDED_BODY", excerpts: "DISCARDED_BODY", body_html_url: "https://example.invalid/never-fetch",
  ...overrides,
});
const envelope = (rows: unknown[] = [document()]) => ({ count: rows.length, results: rows, next_page_url: "https://example.invalid/never-page" });
const response = (value: unknown = envelope()) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json; charset=utf-8" } });
const attempt: PublicSourceAttempt = async (provider, reserve, work) => { eq(provider, "federal-register-finance"); await reserve(); return work(); };
const build = (fetcher: typeof fetch, extra: Parameters<typeof createFederalRegisterFinanceSearch>[0] = {}) =>
  createFederalRegisterFinanceSearch({ now: () => now, reserve: async () => {}, attempt, fetcher, ...extra });

try {
  globalThis.fetch = (async () => { forbidden++; throw new Error("external network denied"); }) as typeof fetch;
  for (const name of flags) delete process.env[name];
  eq(federalRegisterFinanceFallbackEnabled(), false);
  for (const name of flags) process.env[name] = "1";
  eq(federalRegisterFinanceFallbackEnabled(), true);
  const endpoint = new URL(FEDERAL_REGISTER_FINANCE_ENDPOINT);
  eq(endpoint.origin + endpoint.pathname, "https://www.federalregister.gov/api/v1/documents.json");
  eq(endpoint.searchParams.getAll("fields[]"), ["title", "type", "document_number", "html_url", "publication_date", "agencies"]);
  eq(endpoint.searchParams.getAll("conditions[type][]"), ["RULE", "PRORULE"]);
  eq(endpoint.searchParams.get("conditions[sections][]"), "money");
  eq([...endpoint.searchParams.keys()].includes("conditions[term]"), false);

  let calls = 0;
  const gated = build(async () => { calls++; return response(); });
  for (const name of flags) {
    delete process.env[name]; eq(await gated("personal-finance"), []); eq(calls, 0); process.env[name] = "1";
  }
  for (const topic of ["macro-markets", "ai-news", "custom:tax planning", "personal-finance ", "__proto__"]) eq(await gated(topic), []);
  eq(await gated("personal-finance", { freshness: "py" }), []);
  eq(calls, 0);

  let clock = now, reserves = 0;
  const search = build(async (input, init) => {
    calls++; eq(String(input), FEDERAL_REGISTER_FINANCE_ENDPOINT);
    eq([init?.redirect, init?.credentials, init?.cache], ["error", "omit", "no-store"]);
    eq([init?.method, init?.body], [undefined, undefined]);
    eq(Object.keys(init?.headers ?? {}), ["Accept"]); eq(init?.signal instanceof AbortSignal, true);
    return response();
  }, { now: () => clock, reserve: async provider => { reserves++; eq(provider, "federal-register-finance"); } });
  const [first, coalesced] = await Promise.all([search("personal-finance", { freshness: "pd" }), search("personal-finance", { freshness: "pw" })]);
  eq(calls, 1); eq(reserves, 1); eq(first, coalesced); eq(first.length, 1);
  eq(first[0].age, "2026-10-09");
  assert.match(first[0].title, /^Federal Register proposed rule:/);
  assert.match(first[0].description, /^Proposed-rule document\. This is a proposal\./);
  assert.match(first[0].description, /Securities and Exchange Commission/);
  assert.doesNotMatch(JSON.stringify(first), /DISCARDED_BODY|never-fetch|never-page|T00:00/);
  first[0].title = "mutated caller copy";
  assert.notEqual((await search("personal-finance"))[0].title, first[0].title);
  clock = Date.parse("2026-10-09T23:59:00Z");
  await search("personal-finance", { freshness: "pd" }); // refresh cache before midnight
  eq(calls, 2);
  clock = Date.parse("2026-10-10T00:00:01Z");
  eq(await search("personal-finance", { freshness: "pd" }), []);
  eq(calls, 2, "calendar freshness rechecked on cached metadata");
  eq((await search("personal-finance", { freshness: "pw" })).length, 1);
  eq(calls, 2);

  const badRows = [
    { type: "Notice" }, { type: "PRORULE" }, { title: "Agency Information Collection Activities: Retirement Account Fees" },
    { title: "Self-Regulatory Organizations; Retirement Fund Listing" }, { title: "Corporate Capital Requirements" },
    { title: "Foreign Sanctions on Investment Advisers" }, { title: "Investment Adviser Rules; Withdrawal" },
    { title: "Advanced Manufacturing Production Tax Credits" }, { title: "New Markets Tax Credit" },
    { title: "Corporate Business Tax Credit" },
    { title: "\u0000Investment adviser fees" }, { title: "Investment adviser " + "a".repeat(1000) },
    { publication_date: "2026-02-30" }, { publication_date: "2026-13-01" }, { publication_date: "2026-10" },
    { publication_date: "2026-10-09T12:00:00" }, { publication_date: "2026-10-09T12:00:00Z" },
    { document_number: "2026-0" }, { document_number: "2026-00000" }, { document_number: "2026-1234567" },
    { html_url: "https://www.federalregister.gov/documents/2026/10/08/2026-12345/retirement-account-fees" },
    { html_url: "https://www.federalregister.gov/documents/2026/10/09/2026-99999/retirement-account-fees" },
    { html_url: "https://user@www.federalregister.gov/documents/2026/10/09/2026-12345/retirement-account-fees" },
    { html_url: document().html_url + "?redirect=https://example.invalid" }, { html_url: document().html_url + "#body" },
    { html_url: document().html_url.replace("https:", "http:") }, { html_url: document().html_url.replace("www.federalregister.gov", "www.federalregister.gov.evil.test") },
    { html_url: document().html_url.replace("www.federalregister.gov", "www.federalregister.gov:443") },
    { agencies: [] }, { agencies: [{ slug: "internal-revenue-service", name: "Third-party guest" }] },
    { agencies: [{ slug: "unknown-agency", name: "Unknown agency" }] },
  ];
  for (const fields of badRows) eq(parseFederalRegisterFinanceMetadata(envelope([document(fields)])), []);
  for (const title of ["Child Tax Credit", "Earned Income Tax Credit", "Premium Tax Credit", "Education Tax Credits", "Individual Income Tax Filing"])
    eq(parseFederalRegisterFinanceMetadata(envelope([document({ title, agencies: [{ name: "Internal Revenue Service", slug: "internal-revenue-service" }] })])).length, 1);
  eq(parseFederalRegisterFinanceMetadata(envelope([document({ document_number: "2026-00123",
    html_url: document().html_url.replace("2026-12345", "2026-00123") })])).length, 1, "leading-zero journal sequence retained");
  const crossYear = document({ document_number: "2025-24130", publication_date: "2026-01-02",
    html_url: "https://www.federalregister.gov/documents/2026/01/02/2025-24130/retirement-account-fees" });
  eq(parseFederalRegisterFinanceMetadata(envelope([crossYear])).length, 1, "document number year is independent of publication day");
  eq(await build(async () => response(envelope([crossYear])))("personal-finance"), [], "cross-year format admission does not admit stale publication");
  eq(parseFederalRegisterFinanceMetadata(envelope([document(), document()] )).length, 1);
  const mixed = [...badRows.map(fields => document(fields)), document()];
  eq(parseFederalRegisterFinanceMetadata(envelope(mixed)).length, 1, "bad earlier siblings retain useful later metadata");
  for (const value of [{}, null, { count: -1, results: [] }, { count: 0, results: [document()] }, envelope(Array(101).fill(document()))]) {
    checks++; assert.throws(() => parseFederalRegisterFinanceMetadata(value), /invalid response/);
  }
  const future = document({ publication_date: "2026-10-10", html_url: document().html_url.replace("/10/09/", "/10/10/") });
  eq(await build(async () => response(envelope([future])))("personal-finance"), []);
  const rule = await build(async () => response(envelope([document({ type: "Rule" })])))("personal-finance");
  assert.match(rule[0].description, /^Rule publication\. Publication does not establish its effective date\./);

  await rejects(build(async () => new Response(null, { status: 503 }))("personal-finance"), /unavailable/);
  await rejects(build(async () => new Response("<html>error</html>", { headers: { "content-type": "text/html" } }))("personal-finance"), /invalid content type/);
  await rejects(build(async () => new Response("{", { headers: { "content-type": "application/json" } }))("personal-finance"), /JSON/);
  await rejects(build(async () => new Response("x", { headers: { "content-type": "application/json", "content-length": String(MAX_PUBLIC_SOURCE_BYTES + 1) } }))("personal-finance"), /too large/);
  await rejects(build(async () => new Response("x".repeat(MAX_PUBLIC_SOURCE_BYTES + 1), { headers: { "content-type": "application/json" } }))("personal-finance"), /too large/);
  await rejects(build(async (_input, init) => {
    setImmediate(() => init?.signal!.dispatchEvent(new Event("abort")));
    return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } });
  })("personal-finance"), /timed out/);

  let outageCalls = 0, outageClock = now;
  const outage = build(async () => { outageCalls++; return new Response(null, { status: 503 }); }, { now: () => outageClock });
  await rejects(outage("personal-finance"), /unavailable/); await rejects(outage("personal-finance"), /cooling down/); eq(outageCalls, 1);
  outageClock += 60_001; await rejects(outage("personal-finance"), /unavailable/); eq(outageCalls, 2);
  await rejects(outage("personal-finance"), /cooling down/); eq(outageCalls, 2);
  let deniedFetches = 0, reservationCalls = 0;
  const denied = build(async () => { deniedFetches++; return response(); }, { reserve: async () => {
    reservationCalls++; if (reservationCalls === 1) throw new PublicSourceBudgetError("exhausted", "federal-register-finance");
  } });
  await rejects(denied("personal-finance"), /budget exhausted/);
  eq((await denied("personal-finance")).length, 1, "budget control denial does not create provider outage"); eq(deniedFetches, 1);
  const circuitDenied = build(async () => { deniedFetches++; return response(); }, {
    attempt: async () => { throw new PublicSourceCircuitError("cooling_down", "federal-register-finance"); },
  });
  await rejects(circuitDenied("personal-finance"), /cooling_down/); eq(deniedFetches, 1);
  eq(await build(async () => response(envelope([])))("personal-finance"), []);
  eq(forbidden, 0);
  console.log(`PASS Federal Register finance adapter: ${checks} focused assertions, generic offline fixtures only.`);
} finally {
  globalThis.fetch = savedFetch;
  for (const flag of flags) { const value = old.get(flag); if (value === undefined) delete process.env[flag]; else process.env[flag] = value; }
}
