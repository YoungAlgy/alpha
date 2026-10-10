// Offline generic fixtures only. No request, reader, account, model or letter.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { govUkNewsCitation, parseGovUkNewsMetadata, selectGovUkNewsMetadata } from "../lib/engine/govuk-news-metadata";

let checks = 0;
const equal = (actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected); checks++; };
const rejects = (work: () => unknown) => { assert.throws(work); checks++; };
const now = Date.parse("2026-10-10T02:00:00Z");
const options = { now, freshness: "pd" as const };
const row = (overrides: Record<string, unknown> = {}) => ({
  title: "Generic AI announcement", link: "/government/news/generic-ai-announcement",
  public_timestamp: "2026-10-10T02:45:00+01:00", format: "news_story",
  description: "DISCARDED_DESCRIPTION", body: "DISCARDED_BODY", author: "DISCARDED_AUTHOR",
  license: "DISCARDED_LICENSE", image: "https://example.invalid/DISCARDED_MEDIA", ...overrides,
});
const parse = (...rows: unknown[]) => parseGovUkNewsMetadata({ results: rows });
const one = parse(row());
equal(one, [{ title: "Generic AI announcement", url: "https://www.gov.uk/government/news/generic-ai-announcement",
  publicTimestamp: "2026-10-10T01:45:00.000Z", format: "news_story", publisher: "govuk",
  kind: "government-announcement-citation-only", timestampMeaning: "published-or-major-update" }]);
equal(selectGovUkNewsMetadata(one, "ai-news", options), one);
equal(parse(row({ format: "press_release", content_store_document_type: "press_release" }))[0]?.format, "press_release");
equal(parse(row({ link: one[0]!.url })), one);
equal(parse(row({ title: '  Generic "AI" announcement  ' }))[0]?.title, '  Generic "AI" announcement  ');
assert.doesNotMatch(JSON.stringify(one), /DISCARDED|description|body|author|license|image|media/); checks++;
equal(Object.keys(one[0]!).sort(), ["title", "url", "publicTimestamp", "format", "publisher", "kind", "timestampMeaning"].sort());

for (const value of [null, [], "{}", {}, { results: null }, { results: {} }, { results: "[]" }]) {
  rejects(() => parseGovUkNewsMetadata(value));
}
equal(parse(null, [], 1, "record", row()).length, 1);
equal(parseGovUkNewsMetadata({ results: [] }), []);
for (const field of ["title", "link", "public_timestamp", "format"]) {
  for (const value of [undefined, null, [], [row()[field as keyof ReturnType<typeof row>]], {}, 1, true]) {
    equal(parse(row({ [field]: value })), []);
  }
  const inherited = Object.create(row());
  equal(parse(inherited), []);
  const accessor = row();
  Object.defineProperty(accessor, field, { get: () => { throw new Error("Accessor was invoked"); } });
  equal(parse(accessor), []);
}
for (const format of ["speech", "Press_release", "news_story,press_release", " news_story"]) equal(parse(row({ format })), []);
for (const value of [undefined, null, [], "press_release", "speech"]) {
  equal(parse(row({ content_store_document_type: value })), []);
}
for (const title of ["", " ", "x".repeat(301), "AI\nannouncement", "AI\u0085announcement", "AI\u202eannouncement",
  "AI\ud800announcement", "AI\ufffdannouncement", "<b>AI</b>", "AI &amp; markets", "AI &#39; news", "AI &unknown; news"]) {
  equal(parse(row({ title })), []);
}
equal(parse(row({ title: "AI & markets" }))[0]?.title, "AI & markets");
equal(parse(row({ title: "AI 😀 announcement" }))[0]?.title, "AI 😀 announcement");
for (const link of ["http://www.gov.uk/government/news/generic-ai-announcement", "//www.gov.uk/government/news/generic-ai-announcement",
  "https://gov.uk/government/news/generic-ai-announcement", one[0]!.url + "/", one[0]!.url + "?q=x", one[0]!.url + "#fragment",
  one[0]!.url.replace("www.gov.uk", "www.gov.uk.example.invalid"), one[0]!.url.replace("www.gov.uk", "user@www.gov.uk"),
  one[0]!.url.replace("www.gov.uk", "www.gov.uk:443"), "/government/news/Upper-case", "/government/news/double--hyphen",
  "/government/news/encoded%2dslug", "/government/news/../news/generic-ai-announcement", "/government/news/generic_ai",
  "/government/publications/generic-ai-announcement", "javascript:alert(1)", " /government/news/generic-ai-announcement"]) {
  equal(parse(row({ link })), []);
}
for (const public_timestamp of ["2026-10-10", "2026-10-10T01:45:00", "2026-10-10t01:45:00z", " 2026-10-10T01:45:00Z",
  "2026-02-29T01:45:00Z", "2026-04-31T01:45:00Z", "2026-10-10T24:00:00Z", "2026-10-10T01:60:00Z",
  "2026-10-10T01:45:60Z", "2026-10-10T01:45:00+0100", "2026-10-10T01:45:00+15:00",
  "2026-10-10T01:45:00+14:01", "2026-10-10T01:45:00+01:60", "2026-10-10T01:45:00-00:00",
  "2026-10-10T01:45:00.0001Z", "0000-01-01T00:00:00Z", "0001-01-01T00:00:00+01:00", "9999-12-31T23:59:59-01:00"]) {
  equal(parse(row({ public_timestamp })), []);
}
equal(parse(row({ public_timestamp: "2024-02-29T01:45:00Z" }))[0]?.publicTimestamp, "2024-02-29T01:45:00.000Z");
equal(parse(row({ public_timestamp: "2026-10-10T01:45:00.12Z" }))[0]?.publicTimestamp, "2026-10-10T01:45:00.120Z");
equal(parse(row({ public_timestamp: "2026-10-10T00:15:00+01:00" }))[0]?.publicTimestamp, "2026-10-09T23:15:00.000Z");
equal(parse(row({ public_timestamp: "2026-10-09T22:15:00-03:30" }))[0]?.publicTimestamp, "2026-10-10T01:45:00.000Z");
equal(parse(row({ public_timestamp: "2026-10-10T01:45:00+14:00" }))[0]?.publicTimestamp, "2026-10-09T11:45:00.000Z");

const dated = parse(row({ public_timestamp: "2026-10-10T02:01:00Z" }),
  row({ link: "/government/news/generic-old-ai", public_timestamp: "2026-10-08T01:00:00Z" }));
equal(dated.length, 2); // Date selection never narrows the raw cached pool.
equal(selectGovUkNewsMetadata(dated, "ai-news", options), []);
equal(selectGovUkNewsMetadata(dated, "ai-news", { ...options, now: now + 60_000 }).length, 1);
equal(selectGovUkNewsMetadata(dated, "ai-news", { ...options, freshness: "pw" }).length, 1);
for (const freshness of ["py", "garbage", "2026-02-29to2026-03-01", "2026-10-11to2026-10-11"]) {
  equal(selectGovUkNewsMetadata(one, "ai-news", { ...options, freshness: freshness as never }), []);
}
equal(selectGovUkNewsMetadata(one, "ai-news", { ...options, now: NaN }), []);
equal(selectGovUkNewsMetadata(parse(row({ public_timestamp: "2026-10-09T02:00:00Z" })), "ai-news", options).length, 1);
equal(selectGovUkNewsMetadata(parse(row({ public_timestamp: "2026-10-09T01:59:59Z" })), "ai-news", options).length, 0);
equal(selectGovUkNewsMetadata(parse(row({ public_timestamp: "2026-10-10T02:00:00Z" })), "ai-news", options).length, 1);

for (const title of ["Artificial intelligence announcement", "AI announcement", "Large language models announcement", "LLM announcement", "Machine learning announcement"]) {
  equal(selectGovUkNewsMetadata(parse(row({ title })), "ai-news", options).length, 1);
}
for (const title of ["Rail announcement", "Air travel announcement", "Said announcement", "Technology announcement"]) {
  equal(selectGovUkNewsMetadata(parse(row({ title })), "ai-news", options).length, 0);
}
for (const title of ["Inflation announcement", "Interest-rate announcement", "Recession announcement", "GDP announcement", "Economic growth announcement", "Central banks announcement", "Monetary policy announcement"]) {
  equal(selectGovUkNewsMetadata(parse(row({ title })), "macro-markets", options).length, 1);
}
for (const title of ["Grade inflation announcement", "Gum recession announcement", "Hairline recession announcement", "Generic budget announcement"]) {
  equal(selectGovUkNewsMetadata(parse(row({ title })), "macro-markets", options).length, 0);
}
for (const title of ["Housing announcement", "Mortgages announcement", "Homebuyer announcement", "Housebuilders announcement", "Housebuilding announcement", "Property market announcement", "Rental market announcement"]) {
  equal(selectGovUkNewsMetadata(parse(row({ title })), "real-estate", options).length, 1);
}
for (const title of ["Housing Benefit eligibility announcement", "Housing-benefit payments announcement", "Housing benefits support announcement"]) {
  equal(selectGovUkNewsMetadata(parse(row({ title })), "real-estate", options).length, 0);
}
equal(selectGovUkNewsMetadata(parse(row({ title: "Housing market supply announcement" })), "real-estate", options).length, 1);
equal(selectGovUkNewsMetadata(parse(row({ title: "Social housing construction announcement" })), "real-estate", options).length, 1);
for (const topic of ["personal-finance", "sustainability", "music", "nutrition-food", "mental-health", "construction-tech", "custom:AI", ""]) {
  equal(selectGovUkNewsMetadata(one, topic, options), []);
}
equal(selectGovUkNewsMetadata(parse(row({ title: "Unrelated announcement", description: "AI inflation housing" })), "ai-news", options), []);
const repeats = parse(row(), row({ public_timestamp: "2026-10-10T02:00:00Z" }));
equal(repeats.length, 2);
equal(selectGovUkNewsMetadata(repeats, "ai-news", options).length, 1);
equal(selectGovUkNewsMetadata(repeats, "ai-news", { ...options, excludedLinks: new Set([one[0]!.url]) }), []);
equal(selectGovUkNewsMetadata(repeats, "ai-news", { ...options, excludedLinks: new Set([row().link]) }), []);
const pool = Array.from({ length: 100 }, (_, index) => row({ link: `/government/news/generic-ai-${index}` }));
equal(parseGovUkNewsMetadata({ results: pool }).length, 100);
rejects(() => parseGovUkNewsMetadata({ results: [...pool, null] }));
rejects(() => parseGovUkNewsMetadata({ results: [...Array(100).fill(null), row()] }));
const poolRecords = parseGovUkNewsMetadata({ results: pool });
equal(selectGovUkNewsMetadata(poolRecords, "ai-news", { ...options, excludedLinks: new Set(poolRecords.slice(0, 99).map(record => record.url)) })[0]?.url,
  "https://www.gov.uk/government/news/generic-ai-99");
equal(selectGovUkNewsMetadata([...poolRecords, one[0]!], "ai-news", options), []);

const citation = govUkNewsCitation(one[0]!);
assert.ok(citation?.includes(`[Generic AI announcement](${one[0]!.url})`)); checks++;
assert.ok(citation?.includes("Source: GOV.UK, United Kingdom. Published or updated: 2026-10-10T01:45:00.000Z.")); checks++;
assert.ok(citation?.includes("Contains public sector information licensed under the Open Government Licence v3.0.")); checks++;
assert.ok(citation?.includes("https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/")); checks++;
assert.doesNotMatch(citation!, /DISCARDED|author|original publication|originally published|Crown copyright/i); checks++;
const quoted = parse(row({ title: 'AI "quoted" [headline](https://example.invalid) *news* \\ end' }))[0]!;
const quotedCitation = govUkNewsCitation(quoted)!;
assert.ok(quotedCitation.startsWith('[AI "quoted" \\[headline\\]\\(https://example.invalid\\) \\*news\\* \\\\ end](')); checks++;
equal(quoted.title, 'AI "quoted" [headline](https://example.invalid) *news* \\ end');

// Cached records can be forged or mutated. Both selectors and credit revalidate.
for (const change of [
  { title: "<b>AI injected</b>" }, { title: "AI &amp; injected" }, { title: ["AI array"] },
  { url: one[0]!.url + "?q=x" }, { url: "/government/news/generic-ai-announcement" },
  { publicTimestamp: "2026-02-29T01:45:00.000Z" }, { publicTimestamp: "2026-10-10T01:45:00Z" },
  { publicTimestamp: "2026-10-10T02:45:00+01:00" }, { publicTimestamp: [one[0]!.publicTimestamp] },
  { publisher: "invented" }, { kind: "summary" }, { timestampMeaning: "original-publication" },
  { format: "speech" }, { content_store_document_type: "press_release" },
]) {
  const forged = { ...one[0]!, ...change } as never;
  equal(govUkNewsCitation(forged), undefined);
  equal(selectGovUkNewsMetadata([forged], "ai-news", options), []);
}
const mutated = { ...one[0]! };
mutated.title = "unsafe\nAI title";
equal(govUkNewsCitation(mutated), undefined);
equal(selectGovUkNewsMetadata([mutated], "ai-news", options), []);
const cachedWithBody = { ...one[0]!, body: "DISCARDED_CACHE_BODY", author: "DISCARDED_CACHE_AUTHOR" };
assert.doesNotMatch(JSON.stringify(selectGovUkNewsMetadata([cachedWithBody], "ai-news", options)), /DISCARDED_CACHE/); checks++;
assert.doesNotMatch(govUkNewsCitation(cachedWithBody)!, /DISCARDED_CACHE/); checks++;

const source = readFileSync(new URL("../lib/engine/govuk-news-metadata.ts", import.meta.url), "utf8");
assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|https?\.request\s*\(|source-resolver|createClient\s*\(/); checks++;
console.log(`GOV.UK pure metadata candidate: ${checks} offline checks passed.`);
