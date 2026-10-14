import assert from "node:assert/strict";

let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("Offline CDM verifier forbids fetch"); };

const { validatedCdmMetadata, parseCdmMetadataPool, cdmTopicSupported, selectCdmMetadata } =
  await import("../lib/engine/cdm-metadata.ts");
const { normalizeUrl } = await import("../lib/engine/url-guard.ts");

let assertions = 0;
const failures: string[] = [];
function check(name: string, action: () => void) {
  assertions++;
  try { action(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : "failed"}`); }
}
function eq(name: string, actual: unknown, expected: unknown) { check(name, () => assert.deepEqual(actual, expected)); }

const now = Date.parse("2026-10-13T12:00:00.000Z");
const topic = "custom:music production";
const metadata = (overrides: Record<string, unknown> = {}) => ({
  publisher: "cdm",
  kind: "music-production-metadata",
  title: "Music production: a practical studio guide",
  url: "https://cdm.link/2026/10/12/music-production-studio-guide/",
  author: "Casey Example",
  publishedAt: "2026-10-12T09:30:00.000Z",
  dateBasis: "feed-pubdate",
  ...overrides,
});
const record = (overrides: { metadata?: Record<string, unknown>; categories?: string[] } = {}) => ({
  metadata: metadata(overrides.metadata),
  categories: overrides.categories ?? ["Music Production"],
});
const select = (rows: readonly unknown[] = [record()], options: Record<string, unknown> = {}, topicId = topic) =>
  selectCdmMetadata(rows, topicId, { now, freshness: "pw", ...options });
const item = (options: {
  title?: string; link?: string; date?: string; author?: string; categories?: string[]; extra?: string;
} = {}) => `<item><title>${options.title ?? "Music production: a practical studio guide"}</title>` +
  `<link>${options.link ?? "https://cdm.link/2026/10/12/music-production-studio-guide/"}</link>` +
  `<pubDate>${options.date ?? "Mon, 12 Oct 2026 09:30:00 +0000"}</pubDate>` +
  `<dc:creator>${options.author ?? "Casey Example"}</dc:creator>` +
  (options.categories ?? ["Music Production"]).map(category => `<category>${category}</category>`).join("") +
  `${options.extra ?? ""}</item>`;
const feed = (items: string[]) => `<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>${items.join("")}</channel></rss>`;
const refusedXml = (xml: string) => { try { return parseCdmMetadataPool(xml); } catch { return []; } };
const expected = {
  publisher: "cdm", kind: "music-production-metadata",
  title: "Music production: a practical studio guide",
  url: "https://cdm.link/2026/10/12/music-production-studio-guide/",
  author: "Casey Example", publishedAt: "2026-10-12T09:30:00.000Z", dateBasis: "feed-pubdate",
};

eq("only the exact custom lane is supported", cdmTopicSupported(topic), true);
for (const id of ["music", "music production", "custom:music", "custom:music-production", "custom:Music Production",
  "custom:music production tips", "custom:music production ", "custom:country music", "constructor", "__proto__", ""]) {
  eq("topic aliases and malformed ids are closed", cdmTopicSupported(id), false);
  eq("unsupported topic selects nothing", select([record()], {}, id), []);
}

eq("valid cached attribution is projected", validatedCdmMetadata(metadata()), expected);
eq("cache result contains only approved metadata", Object.keys(validatedCdmMetadata(metadata()) ?? {}).sort(),
  ["author", "dateBasis", "kind", "publishedAt", "publisher", "title", "url"].sort());
eq("null prototype data record is accepted", validatedCdmMetadata(Object.assign(Object.create(null), metadata())), expected);
for (const value of [null, undefined, false, 0, "text", [], new Date(), Object.create(metadata()),
  { ...metadata(), body: "discarded article body" }, { ...metadata(), image: "https://cdm.link/image.jpg" },
  { ...metadata(), publisher: "other" }, { ...metadata(), kind: "article" }, { ...metadata(), dateBasis: "guessed" },
  { ...metadata(), author: "" }, { ...metadata(), title: "   " }]) {
  eq("invalid or extra-field cached metadata is refused", validatedCdmMetadata(value), undefined);
  eq("invalid cached metadata cannot be selected", select([value]), []);
}
for (const key of Object.keys(expected)) {
  const missing = { ...expected };
  delete missing[key as keyof typeof missing];
  eq("missing metadata field is refused", validatedCdmMetadata(missing), undefined);
}
for (const [key, value] of Object.entries({
  publisher: "cdm", kind: "music-production-metadata", dateBasis: "feed-pubdate",
  title: "Music production guide", url: "https://cdm.link/2026/10/12/a/", author: "Casey Example",
  publishedAt: "2026-10-12T09:30:00.000Z",
})) {
  const hostile = metadata();
  Object.defineProperty(hostile, key, { enumerable: true, get() { throw new Error("metadata getter ran"); } });
  eq("metadata accessors are refused without executing them", validatedCdmMetadata(hostile), undefined);
}
for (const key of ["body", "description", "image", "audio", "media", "excerpt", "content:encoded"]) {
  const extra = { ...metadata(), [key]: "discarded fixture payload" };
  eq("unexpected content fields are refused", validatedCdmMetadata(extra), undefined);
}
eq("metadata symbol fields are refused", validatedCdmMetadata({ ...metadata(), [Symbol("hidden")]: "body" }), undefined);

for (const url of ["http://cdm.link/2026/10/12/a/", "https://cdm.link.evil.invalid/2026/10/12/a/",
  "https://user@cdm.link/2026/10/12/a/", "https://cdm.link:443/2026/10/12/a/",
  "https://cdm.link/2026/10/12/a/?utm_source=x", "https://cdm.link/2026/10/12/a/#fragment",
  "https://cdm.link/2026/10/12/../a/", "https://cdm.link/2026/10/12/a%2fb/", "https://cdm.link/",
  "https://www.cdm.link/2026/10/12/a/", "https://cdm.link/2026/10/12/a/?", "https://cdm.link/2026/10/12/a/#"]) {
  eq("unsafe or non-single CDM URL is refused", validatedCdmMetadata(metadata({ url })), undefined);
}
for (const title of ["", "   ", "Music production <script>", "Music production https://bad.invalid", "Music production\u0000guide",
  "Music production \ufffd", "Music production &amp; guide"]) {
  eq("unsafe title is refused without rewriting", validatedCdmMetadata(metadata({ title })), undefined);
}
for (const author of ["", "  ", "Casey\nExample", "Casey <Writer>", "https://bad.invalid", "Casey\u0000Example"]) {
  eq("unsafe byline is refused without rewriting", validatedCdmMetadata(metadata({ author })), undefined);
}

eq("direct RSS fields form one attributed record", parseCdmMetadataPool(feed([item()])), [{ metadata: expected, categories: ["Music Production"] }]);
eq("single lowercase slug paths are valid", validatedCdmMetadata(metadata({ url: "https://cdm.link/music-production-studio-guide/" }))?.url,
  "https://cdm.link/music-production-studio-guide/");
eq("safe source title and byline are preserved exactly", parseCdmMetadataPool(feed([item({
  title: "Music production: guide for small studios", author: "Casey J. Example",
})]))[0]?.metadata,
  { ...expected, title: "Music production: guide for small studios", author: "Casey J. Example" });
eq("XML entity escaping resolves once and preserves the decoded source title", parseCdmMetadataPool(feed([item({ title: "Music production &amp; sound" })]))[0]?.metadata.title,
  "Music production & sound");
eq("only direct item fields are read", parseCdmMetadataPool(feed([item({ extra: "<nested><title>Music production spoof</title><link>https://cdm.link/2026/10/12/spoof/</link></nested>" })])).length, 1);
eq("duplicate direct title rejects the ambiguous item", parseCdmMetadataPool(feed([item({ extra: "<title>Music production duplicate</title>" })])), []);
eq("nested metadata cannot replace direct values", parseCdmMetadataPool(feed([`<item><title><b>Music production guide</b></title><link>https://cdm.link/2026/10/12/a/</link><pubDate>Mon, 12 Oct 2026 09:30:00 +0000</pubDate><dc:creator>Casey Example</dc:creator><category>Music Production</category></item>`])), []);
eq("malformed XML rejects the entire document", refusedXml(feed([item()]).replace("</item>", "")), []);
eq("DTD and entity declarations are refused", refusedXml(`<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///private">]>${feed([item({ title: "&x;" })])}`), []);
eq("oversized XML is refused", refusedXml(feed([item()]) + " ".repeat(256 * 1024)), []);
eq("invalid siblings do not erase a later valid row", parseCdmMetadataPool(feed([
  item({ link: "https://evil.invalid/2026/10/12/a/" }), item({ link: "https://cdm.link/2026/10/12/second-track/" }),
])).map(row => row.metadata.url), ["https://cdm.link/2026/10/12/second-track/"]);

for (const date of ["12 Oct 2026", "Mon, 12 Oct 2026 09:30:00", "Mon, 12 Oct 2026 09:30:00 XYZ",
  "Mon, 32 Oct 2026 09:30:00 +0000", "Mon, 29 Feb 2026 09:30:00 +0000", "Mon, 12 Foo 2026 09:30:00 +0000",
  "Mon, 12 Oct 2026 24:30:00 +0000", "Mon, 12 Oct 2026 09:30:00 +2460", "2026-10-12T09:30:00"]) {
  eq("partial, impossible, or unzoned dates are rejected", parseCdmMetadataPool(feed([item({ date })])), []);
}
eq("zoned timestamp is normalized to UTC", parseCdmMetadataPool(feed([item({ date: "Mon, 12 Oct 2026 15:00:00 +0530" })]))[0]?.metadata.publishedAt,
  "2026-10-12T09:30:00.000Z");
eq("raw metadata pool retains stale and future timestamps for selection-time checks",
  parseCdmMetadataPool(feed([item({ date: "Mon, 01 Jan 2001 00:00:00 +0000" }), item({
    link: "https://cdm.link/2026/10/14/future/", date: "Wed, 14 Oct 2026 09:30:00 +0000",
  })])).length, 2);
eq("valid XML pool has a hard 100-record cap", parseCdmMetadataPool(feed(Array.from({ length: 101 }, (_, index) => item({
  link: `https://cdm.link/2026/10/12/fixture-${index}/`,
})))).length, 100);
eq("category collection has a hard 20-value cap", parseCdmMetadataPool(feed([item({
  categories: Array.from({ length: 21 }, (_, index) => `Music Production ${index}`),
})])), []);
for (const marker of ["<rights>CC BY 4.0</rights>", "<license>CC BY 4.0</license>", "<copyright>All rights reserved</copyright>"]) {
  eq("per-item rights markers reject an item", parseCdmMetadataPool(feed([item({ extra: marker })])), []);
}
eq("XML response is not retained in projected metadata", JSON.stringify(parseCdmMetadataPool(feed([item({
  extra: "<description>PRIVATE_BODY_FIXTURE discard this image and audio</description>",
})]))).includes("PRIVATE_BODY_FIXTURE"), false);

const stale = record({ metadata: { publishedAt: "2026-10-01T09:30:00.000Z" } });
const future = record({ metadata: { publishedAt: "2026-10-13T12:00:00.001Z", url: "https://cdm.link/2026/10/13/future/" } });
const justFuture = record({ metadata: { publishedAt: "2026-10-13T12:00:00.000Z", url: "https://cdm.link/2026/10/13/now/" } });
eq("stale metadata is excluded", select([stale]), []);
eq("future metadata is excluded", select([future]), []);
eq("publication timestamp equal to the selection clock remains current", select([justFuture]), [justFuture.metadata]);
eq("fresh metadata selection returns only metadata", select(), [expected]);
for (const categories of [["Promoted"], ["Deals"]]) {
  eq("promoted and deals feed categories are excluded", select([record({ categories })]), []);
}
for (const title of ["Promoted music production gear guide", "Music production deals this week"]) {
  eq("promoted and deals titles are excluded", select([record({ metadata: { title } })]), []);
}
eq("unrelated title and category do not establish topic fit", select([record({
  metadata: { title: "New jazz record review" }, categories: ["Interviews"],
})]), []);
eq("music genre alone does not alias the production lane", select([record({
  metadata: { title: "New jazz album review" }, categories: ["Music"],
})]), []);
eq("music tech category is explicit topic evidence", select([record({
  metadata: { title: "An interview with a producer" }, categories: ["Music tech"],
})]).length, 1);

const second = record({ metadata: {
  title: "Music production: mastering a home recording", url: "https://cdm.link/2026/10/12/home-recording-mastering/",
} });
eq("selector caps at one item", select([record(), second]), [expected]);
eq("prior normalized link is excluded before one-item cap", select([record(), second], {
  excludedLinks: new Set([normalizeUrl(expected.url)!]),
}), [second.metadata]);
eq("prior exact link is excluded before one-item cap", select([record(), second], {
  excludedLinks: new Set([expected.url]),
}), [second.metadata]);
eq("invalid first candidate does not hide later valid candidate", select([
  record({ metadata: { url: "https://evil.invalid/item" } }), second,
]), [second.metadata]);
eq("same destination is emitted at most once", select([record(), record()]), [expected]);
eq("invalid freshness window selects nothing", select([record()], { freshness: "invalid" }), []);
eq("nonfinite clock selects nothing", select([record()], { now: Number.NaN }), []);

eq("zero network attempts", networkAttempts, 0);
console.log(JSON.stringify({ status: failures.length ? "offline_fail" : "offline_pass", assertions,
  passed: assertions - failures.length, failed: failures.length, failures, networkAttempts }));
if (failures.length) process.exitCode = 1;
