import assert from "node:assert/strict";

// Only injected synthetic data. Any accidental native request fails immediately.
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("Offline OpenAlex verifier forbids fetch"); };
const {
  OPENALEX_TOPICS, openAlexTopicLane, openAlexCompletedDayBounds, openAlexQueryUrl,
  validatedOpenAlexMetadata, parseOpenAlexMetadata, selectOpenAlexMetadata, openAlexCitationKeys,
} = await import("../lib/engine/openalex-metadata.ts");
const { normalizeUrl } = await import("../lib/engine/url-guard.ts");
const { makeCustomTopic } = await import("../lib/topics.ts");

let assertions = 0;
const failures: string[] = [];
function check(name: string, action: () => void) {
  assertions++;
  try { action(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : "failed"}`); }
}
function eq(name: string, actual: unknown, expected: unknown) { check(name, () => assert.deepEqual(actual, expected)); }
const now = Date.parse("2026-10-13T12:00:00Z");
const topic = "custom:artificial intelligence research";
const native = (overrides: Record<string, unknown> = {}) => ({
  id: "https://openalex.org/W10001", doi: "https://doi.org/10.1234/Offline.Research",
  title: "Artificial intelligence research &amp; evidence", publication_date: "2026-10-12",
  publication_year: 2026, type: "article", language: "en", is_retracted: false,
  indexed_in: ["crossref", "arxiv"], ...overrides,
});
const envelope = (rows: unknown[] = [native()], overrides: Record<string, unknown> = {}) => ({
  meta: { count: rows.length, page: 1, per_page: 20, db_response_time_ms: 1 },
  results: rows, group_by: [], ...overrides,
});
const expected = {
  title: "Artificial intelligence research & evidence", url: "https://doi.org/10.1234/Offline.Research",
  workUrl: "https://openalex.org/W10001", publicationDay: "2026-10-12",
  publisher: "openalex", kind: "research-metadata-citation-only", dateBasis: "reported-publication-day",
};
const select = (rows: readonly unknown[] = [expected], options = {}, topicId = topic) =>
  selectOpenAlexMetadata(rows, topicId, { now, freshness: "2026-10-12to2026-10-13", ...options });
const parsedRow = (overrides: Record<string, unknown>) => parseOpenAlexMetadata(envelope([native(overrides)]));

eq("exact fixed map", OPENALEX_TOPICS, { aiResearch: "artificial intelligence", musicResearch: "music", climateResearch: "climate change" });
eq("fixed map frozen", Object.isFrozen(OPENALEX_TOPICS), true);
for (const [lane, phrase] of Object.entries(OPENALEX_TOPICS)) {
  const id = makeCustomTopic(`${phrase} research`)!;
  eq("canonical custom id", id, `custom:${phrase} research`);
  eq("exact lane", openAlexTopicLane(id), lane);
  const query = new URL(openAlexQueryUrl(lane as keyof typeof OPENALEX_TOPICS, now)!);
  eq("fixed works endpoint", query.origin + query.pathname, "https://api.openalex.org/works");
  eq("fixed generic title query", query.searchParams.get("search.title"), phrase);
  eq("query completed days", query.searchParams.get("filter"), "from_publication_date:2026-10-06,to_publication_date:2026-10-12,type:article,language:en,is_retracted:false,has_doi:true");
  eq("exact nine field projection", query.searchParams.get("select"), "id,doi,title,publication_date,publication_year,type,language,is_retracted,indexed_in");
  eq("query page one", query.searchParams.get("page"), "1");
  eq("query twenty row bound", query.searchParams.get("per_page"), "20");
  eq("descending publication order", query.searchParams.get("sort"), "publication_date:desc");
  eq("no private query account key rerank abstract params", [...query.searchParams.keys()].sort(), ["filter", "page", "per_page", "search.title", "select", "sort"].sort());
}
for (const id of ["ai-news", "music", "custom:music", "custom:ai research", "custom:climate research", "custom:artificial intelligence research ", "custom:Artificial Intelligence Research", "custom:music research private person", "constructor", "__proto__", "toString", "", "custom:artificial intelligence research?api_key=private"]) {
  eq("unsupported topic stays closed", openAlexTopicLane(id), undefined);
  eq("unsupported selector stays closed", select([expected], {}, id), []);
}
eq("unsupported runtime lane has no URL", openAlexQueryUrl("private reader query" as never, now), null);
eq("prototype lane has no URL", openAlexQueryUrl("constructor" as never, now), null);
eq("seven completed days", openAlexCompletedDayBounds(now), { start: "2026-10-06", end: "2026-10-12" });
eq("same query through UTC day", openAlexQueryUrl("aiResearch", now), openAlexQueryUrl("aiResearch", Date.parse("2026-10-13T23:59:59.999Z")));
eq("year rollover", openAlexCompletedDayBounds(Date.parse("2027-01-01T00:00:00Z")), { start: "2026-12-25", end: "2026-12-31" });
eq("leap rollover", openAlexCompletedDayBounds(Date.parse("2028-03-01T03:00:00Z")), { start: "2028-02-23", end: "2028-02-29" });
eq("nonleap rollover", openAlexCompletedDayBounds(Date.parse("2027-03-01T03:00:00Z")), { start: "2027-02-22", end: "2027-02-28" });
for (const value of [NaN, Infinity, -Infinity, 9e20]) {
  eq("invalid clock bounds", openAlexCompletedDayBounds(value), null);
  eq("invalid clock URL", openAlexQueryUrl("aiResearch", value), null);
  eq("invalid clock selection", select([expected], { now: value }), []);
}

eq("native metadata projection", parseOpenAlexMetadata(envelope()), [expected]);
eq("cache metadata revalidated", validatedOpenAlexMetadata(expected), expected);
eq("only exact seven fields retained", Object.keys(parseOpenAlexMetadata(envelope())![0]!).sort(), Object.keys(expected).sort());
eq("no mutable record cached", Object.isFrozen(parseOpenAlexMetadata(envelope())![0]!), true);
const original = native();
const detached = parseOpenAlexMetadata(envelope([original]))![0]!;
original.title = "Changed source";
eq("native source mutation cannot affect cached title", detached.title, expected.title);
const cacheInput = { ...expected };
const cacheCopy = validatedOpenAlexMetadata(cacheInput)!;
cacheInput.title = "Changed input";
eq("cache input mutation cannot affect revalidated record", cacheCopy.title, expected.title);
check("cache result is a fresh object", () => assert.notEqual(cacheCopy, cacheInput));
check("frozen metadata refuses mutation", () => assert.throws(() => { (cacheCopy as { title: string }).title = "unsafe"; }));
eq("citation identity both DOI and work", openAlexCitationKeys(expected), ["doi.org/10.1234/offline.research", "openalex.org/w10001"]);
eq("null prototype own plain record accepted", validatedOpenAlexMetadata(Object.assign(Object.create(null), expected)), expected);

for (const value of [null, undefined, false, 1, "not JSON", JSON.stringify(envelope()), [], new Date(), { meta: {}, results: [] }, envelope([], { results: {} }), envelope(Array.from({ length: 21 }, () => native()))]) {
  eq("bad supplied envelope refused without JSON repair", parseOpenAlexMetadata(value), null);
}
eq("empty bounded response", parseOpenAlexMetadata(envelope([])), []);
for (const count of [-1, 0.5, NaN, Infinity, "1", null, 0, Number.MAX_SAFE_INTEGER + 1]) {
  eq("invalid native count", parseOpenAlexMetadata(envelope([native()], { meta: { count, page: 1, per_page: 20 } })), null);
}
for (const meta of [{ count: 1, page: 2, per_page: 20 }, { count: 1, page: 1, per_page: 10 }, { count: 1, page: "1", per_page: 20 }]) {
  eq("native page or projection bound drift", parseOpenAlexMetadata(envelope([native()], { meta })), null);
}
for (const key of Object.keys(native())) {
  const missing = native();
  delete missing[key as keyof typeof missing];
  eq("missing native projected field fails whole response", parseOpenAlexMetadata(envelope([native(), missing])), null);
}
for (const key of ["abstract_inverted_index", "locations", "authors", "body", "created_date", "updated_date", "unexpected"]) {
  eq("extra projected field fails whole response", parseOpenAlexMetadata(envelope([native(), native({ [key]: "discarded" })])), null);
}
for (const invalid of [{ title: null }, { title: 12 }, { doi: null }, { publication_year: "2026" }, { publication_year: 2025 }, { type: "book" }, { language: "es" }, { is_retracted: true }, { is_retracted: "false" }, { indexed_in: null }, { indexed_in: ["crossref", {}] }, { indexed_in: ["Bad index"] }, { indexed_in: Array.from({ length: 11 }, () => "crossref") }]) {
  eq("malformed scalar row skipped", parsedRow(invalid), []);
  eq("malformed scalar cannot hide valid sibling", parseOpenAlexMetadata(envelope([native(invalid), native()])), [expected]);
}
for (const day of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "2026-10-00", "2026-1-12", "2026-10", "2026", "2026-10-12T00:00:00Z", " 2026-10-12", "2026-10-12 ", null]) {
  eq("strict complete calendar day", parsedRow({ publication_date: day }), []);
}
eq("valid leap day native", parsedRow({ publication_date: "2028-02-29", publication_year: 2028 })?.length, 1);
eq("year below 100 calendar handled", parsedRow({ publication_date: "0099-01-01", publication_year: 99 })?.length, 1);

for (const title of ["", " ", "Artificial <b>intelligence</b>", "Artificial &lt;b&gt;intelligence&lt;/b&gt;", "Artificial &amp;lt;b&amp;gt;intelligence", "Artificial intelligence &#0;", "Artificial intelligence &#xD800;", "Artificial intelligence &#x110000;", "Artificial intelligence &#x7f;", "Artificial intelligence &#x200b;", "Artificial intelligence &unknown;", "Artificial intelligence \ud800", "Artificial intelligence \u202e", "Artificial intelligence \ufffd", "Artificial intelligence \n", "Artificial intelligence https://example.invalid", "Artificial intelligence data:text/plain,hello", "Artificial intelligence " + "x".repeat(1500)]) {
  eq("unsafe title rejected after one decode", parsedRow({ title }), []);
}
eq("numeric entities decode once", parsedRow({ title: "Artificial intelligence &#38; evidence &#x1f52c;" })?.[0]?.title, "Artificial intelligence & evidence \u{1f52c}");
eq("title leading spaces preserved", parsedRow({ title: "  Artificial intelligence research  " })?.[0]?.title, "  Artificial intelligence research  ");
eq("title length never truncated", parsedRow({ title: "x".repeat(1500) })?.[0]?.title.length, 1500);
eq("cached title never decoded again", validatedOpenAlexMetadata({ ...expected, title: "Artificial intelligence &amp; evidence" }), null);
for (const entity of ["constructor", "toString", "hasOwnProperty"]) {
  eq("entity cannot access prototype members", parsedRow({ title: `Artificial intelligence &${entity};` }), []);
}
eq("nonentity prototype text is preserved", parsedRow({ title: "Artificial intelligence &__proto__;" })?.[0]?.title, "Artificial intelligence &__proto__;");

for (const id of ["https://openalex.org/w10001", "http://openalex.org/W10001", "https://openalex.org/W", "https://openalex.org/W12345678901234567", "https://openalex.org:443/W10001", "https://user@openalex.org/W10001", "https://openalex.org/W10001?x=1", "https://openalex.org/W10001#x", "https://openalex.org/a/../W10001", "https://openalex.org/%5710001", "openalex.org/W10001"]) {
  eq("strict primary work id", parsedRow({ id }), []);
}
for (const doi of ["http://doi.org/10.1234/test", "https://dx.doi.org/10.1234/test", "https://doi.org/10.123/test", "https://doi.org/10.1234567890/test", "https://doi.org/10.1234/", "https://doi.org:443/10.1234/test", "https://user:password@doi.org/10.1234/test", "https://doi.org/10.1234/test?x=1", "https://doi.org/10.1234/test#x", "https://doi.org/10.1234/a/../test", "https://doi.org/10.1234/a/./test", "https://doi.org/10.1234/%2e/test", "https://doi.org/10.1234/test%2Fnext", "https://doi.org/10.1234/test%5Cnext", "https://doi.org/10.1234/test%3Fquery", "https://doi.org/10.1234/test%23hash", "https://doi.org/10.1234/test%2500", "https://doi.org/10.1234/test%00", "https://doi.org/10.1234/test%20", "https://doi.org/10.1234/test%GG", "https://doi.org/10.1234/\u200btest", "https://doi.org/10.1234/é", "https://doi.org/10.1234/test\n", "https://doi.org.evil.invalid/10.1234/test"]) {
  eq("unsafe supplied DOI refused", parsedRow({ doi }), []);
}
const safeEscapedDoi = "https://doi.org/10.1234/Research%28Example%29";
const escaped = parsedRow({ doi: safeEscapedDoi })![0]!;
eq("safe DOI URI preserved exactly", escaped.url, safeEscapedDoi);
eq("safe DOI escapes decode only for identity", openAlexCitationKeys(escaped)[0], "doi.org/10.1234/research(example)");

eq("explicit cadence includes all yesterday", select(), [expected]);
eq("daily noon has no wholly contained prior day", select([expected], { freshness: "pd" }), []);
eq("daily exact midnight contains yesterday", select([expected], { freshness: "pd", now: Date.parse("2026-10-13T00:00:00Z") }), [expected]);
eq("one millisecond after midnight daily refuses partial yesterday", select([expected], { freshness: "pd", now: Date.parse("2026-10-13T00:00:00.001Z") }), []);
eq("no today day admitted", select([{ ...expected, publicationDay: "2026-10-13" }]), []);
eq("no future day admitted", select([{ ...expected, publicationDay: "2026-10-14" }]), []);
eq("weekly oldest partial day excluded", select([{ ...expected, publicationDay: "2026-10-06" }], { freshness: "pw" }), []);
eq("weekly next complete day admitted", select([{ ...expected, publicationDay: "2026-10-07" }], { freshness: "pw" }).length, 1);
eq("weekly midnight oldest day fully admitted", select([{ ...expected, publicationDay: "2026-10-06" }], { freshness: "pw", now: Date.parse("2026-10-13T00:00:00Z") }).length, 1);
eq("monthly oldest partial day excluded", select([{ ...expected, publicationDay: "2026-09-13" }], { freshness: "pm" }), []);
eq("monthly next complete day admitted", select([{ ...expected, publicationDay: "2026-09-14" }], { freshness: "pm" }).length, 1);
for (const freshness of ["2026-02-30to2026-10-13", "2026-10-12to2026-10-11", "2026-10-12to2026-10-14", "2026-09-01to2026-10-13", "invalid"]) {
  eq("existing range policy retained", select([expected], { freshness }), []);
}
eq("reported day remains date only", select()[0]?.publicationDay, "2026-10-12");
eq("no age instant introduced", Object.hasOwn(select()[0]!, "age"), false);
eq("all fixed tokens must match", select([{ ...expected, title: "Artificial research" }]), []);
eq("whole token matching", select([{ ...expected, title: "Artificially intelligence research" }]), []);
eq("word order may vary", select([{ ...expected, title: "Intelligence and artificial research" }]).length, 1);
eq("climate both tokens needed", select([{ ...expected, title: "Climate research" }], {}, "custom:climate change research"), []);
eq("climate both tokens present", select([{ ...expected, title: "Climate change research" }], {}, "custom:climate change research").length, 1);
eq("music research fixed token", select([{ ...expected, title: "Music research" }], {}, "custom:music research").length, 1);
eq("music title partial token refused", select([{ ...expected, title: "Musical research" }], {}, "custom:music research"), []);

const second = { ...expected, workUrl: "https://openalex.org/W10002", url: "https://doi.org/10.1234/Second" };
eq("parser keeps every valid sibling before selector", parseOpenAlexMetadata(envelope([native(), native({ id: second.workUrl, doi: second.url })]))?.length, 2);
eq("selector keeps every valid sibling", select([expected, second]), [expected, second]);
eq("same work ID deduplicated", select([expected, { ...second, workUrl: expected.workUrl }]), [expected]);
eq("same DOI across work ID merge deduplicated", select([expected, { ...second, url: expected.url.toLowerCase() }]), [expected]);
eq("safe escaped DOI aliases deduplicate", select([escaped, { ...second, url: "https://doi.org/10.1234/Research(Example)" }]), [escaped]);
eq("excluded sibling cannot hide later usable sibling", select([expected, second], { excludedLinks: new Set([expected.url]) }), [second]);
const twenty = Array.from({ length: 20 }, (_, index) => ({ ...expected, workUrl: `https://openalex.org/W${index + 1}`, url: `https://doi.org/10.1234/Fixture${index}` }));
eq("twenty unique selector results have no one-item cap", select(twenty).length, 20);
eq("twenty unique native results have no one-item cap", parseOpenAlexMetadata(envelope(twenty.map(row => native({ id: row.workUrl, doi: row.url }))))?.length, 20);
eq("excluded nineteen cannot hide twentieth", select(twenty, { excludedLinks: new Set(twenty.slice(0, 19).map(row => row.url)) }), [twenty[19]]);
for (const prior of [expected.url, expected.url.toLowerCase(), "https://dx.doi.org/10.1234/Offline.Research", "http://doi.org/10.1234/OFFLINE.RESEARCH", "doi.org/10.1234/offline.research", "dx.doi.org/10.1234/offline.research", normalizeUrl(expected.url)!, expected.workUrl, normalizeUrl(expected.workUrl)!]) {
  eq("known absolute or scheme-free alias excludes", select([expected], { excludedLinks: new Set([prior]) }), []);
}
eq("different work id cannot infer unseen DOI", select([expected], { excludedLinks: new Set([second.workUrl]) }), [expected]);
eq("unknown publisher URL cannot invent DOI", select([expected], { excludedLinks: new Set(["https://unknown.invalid/article?id=10.1234/Offline.Research"]) }), [expected]);
eq("unsafe resolver query is no alias", select([expected], { excludedLinks: new Set([`${expected.url}?x=1`]) }), [expected]);
eq("unsafe work query is no alias", select([expected], { excludedLinks: new Set([`${expected.workUrl}?x=1`]) }), [expected]);
eq("safe escaped resolver excludes", select([escaped], { excludedLinks: new Set(["doi.org/10.1234/research(example)"]) }), []);
const plosRecord = { ...expected, url: "https://doi.org/10.1371/journal.pone.0123456" };
const plos = "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0123456";
for (const prior of [plos, normalizeUrl(plos)!, "https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0123456"]) {
  eq("known PLOS DOI alias excludes", select([plosRecord], { excludedLinks: new Set([prior]) }), []);
}
for (const prior of [plos + "&x=1", plos + "#fragment", plos.replace("plosone", "unknown"), plos.replace("journals.plos.org", "user@journals.plos.org"), plos.replace("journals.plos.org", "journals.plos.org:443"), plos.replace("article", "x/../article"), plos.replace("10.1371", "10.9999"), plos.replace("journals.plos.org", "unknown.invalid")]) {
  eq("unsafe or unknown PLOS alias cannot exclude", select([plosRecord], { excludedLinks: new Set([prior]) }), [plosRecord]);
}

for (const key of Object.keys(expected)) {
  const missing = { ...expected };
  delete missing[key as keyof typeof missing];
  eq("cache missing field refused", validatedOpenAlexMetadata(missing), null);
}
for (const value of [null, [], Object.create(expected), { ...expected, body: "unsafe" }, { ...expected, publisher: "other" }, { ...expected, kind: "article" }, { ...expected, dateBasis: "published" }, { ...expected, doiUrl: expected.url }, { ...expected, publicationDay: "2026-02-30" }]) {
  eq("malformed cached object refused", validatedOpenAlexMetadata(value), null);
  eq("malformed cached object never selected", select([value]), []);
}
let getterCalls = 0;
for (const key of Object.keys(expected)) {
  const value = { ...expected };
  Object.defineProperty(value, key, { enumerable: true, get() { getterCalls++; throw new Error("Must not execute getter"); } });
  eq("cache getter refused", validatedOpenAlexMetadata(value), null);
  eq("selector getter refused", select([value]), []);
}
for (const key of Object.keys(native())) {
  const value = native();
  Object.defineProperty(value, key, { enumerable: true, get() { getterCalls++; throw new Error("Must not execute getter"); } });
  eq("native getter fails projection", parseOpenAlexMetadata(envelope([value])), null);
}
const hostileEnvelope = envelope();
Object.defineProperty(hostileEnvelope, "results", { enumerable: true, get() { getterCalls++; throw new Error("Must not execute envelope getter"); } });
eq("envelope getter refused", parseOpenAlexMetadata(hostileEnvelope), null);
const hostileRows = [native()];
Object.defineProperty(hostileRows, "0", { enumerable: true, get() { getterCalls++; throw new Error("Must not execute row getter"); } });
eq("native array getter refused", parseOpenAlexMetadata(envelope(hostileRows)), null);
const hostileIndexes = ["crossref"];
Object.defineProperty(hostileIndexes, "0", { enumerable: true, get() { getterCalls++; throw new Error("Must not execute index getter"); } });
eq("native index getter rejects only row", parsedRow({ indexed_in: hostileIndexes }), []);
const symbolExtra = { ...expected, [Symbol("hidden body")]: "unsafe" };
eq("cache symbol extra refused", validatedOpenAlexMetadata(symbolExtra), null);
const hiddenExtra = { ...expected };
Object.defineProperty(hiddenExtra, "body", { value: "unsafe", enumerable: false });
eq("cache nonenumerable extra refused", validatedOpenAlexMetadata(hiddenExtra), null);
const inheritedNative = Object.assign(Object.create({ body: "unsafe" }), native());
eq("native inherited object refused", parseOpenAlexMetadata(envelope([inheritedNative])), null);
eq("sparse native array refused", parseOpenAlexMetadata(envelope(new Array(1))), null);
for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"]) {
  const hostile = new Proxy({ ...expected }, { [trap]() { throw new Error("Hostile fixture proxy"); } });
  eq("hostile proxy refused safely", validatedOpenAlexMetadata(hostile), null);
}
const revoked = Proxy.revocable({}, {});
revoked.revoke();
eq("revoked proxy safely refused", validatedOpenAlexMetadata(revoked.proxy), null);
eq("no hostile getters executed", getterCalls, 0);
eq("zero network attempts", networkAttempts, 0);

console.log(JSON.stringify({ status: failures.length ? "offline_fail" : "offline_pass", assertions,
  passed: assertions - failures.length, failed: failures.length, failures, networkAttempts }));
if (failures.length) process.exitCode = 1;
