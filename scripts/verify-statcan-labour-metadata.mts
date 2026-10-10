// Focused pure offline tests. Synthetic fixtures never enter product data.
import assert from "node:assert/strict";
import type { StatCanLabourMetadata } from "../lib/engine/statcan-labour-metadata";

let fetchAttempts = 0;
globalThis.fetch = (() => {
  fetchAttempts++;
  throw new Error("Offline StatCan test forbids network");
}) as typeof fetch;

const { parseStatCanLabourMetadata: parse, statCanLabourCitation: citation } =
  await import("../lib/engine/statcan-labour-metadata");

let assertions = 0;
let passed = 0;
const failedChecks: string[] = [];
function check(name: string, run: () => void) {
  assertions++;
  try { run(); passed++; } catch { failedChecks.push(name); }
}
function eq(name: string, actual: unknown, expected: unknown) { check(name, () => assert.deepEqual(actual, expected)); }

const ATOM = "http://www.w3.org/2005/Atom";
const XHTML = "http://www.w3.org/1999/xhtml";
const now = Date.parse("2026-10-10T12:00:00Z");
const instant = "2026-10-09T12:00:00Z";
const original = "https://www.statcan.gc.ca/daily-quotidien/261009/dq261009a-eng.htm";
const alias = "https://www150.statcan.gc.ca/n1/daily-quotidien/261009/dq261009a-eng.htm";
const title = "Employment indicators";
const feed = (entries: string, fields = "") => `<feed xmlns="${ATOM}">${fields}${entries}</feed>`;
const entry = (fields: string) => `<entry>${fields}</entry>`;
const fields = (headline = title, url = original, updated = instant) =>
  `<title>${headline}</title><updated>${updated}</updated><link href="${url}"/>`;
const fixture = (headline = title, url = original, updated = instant) => feed(entry(fields(headline, url, updated)));
const options = { now, freshness: "pd" as const, topicId: "macro-markets" };
const read = (xml: string, overrides: Partial<Parameters<typeof parse>[1]> = {}) => parse(xml, { ...options, ...overrides });
const denied = (name: string, xml: string, overrides: Partial<Parameters<typeof parse>[1]> = {}) =>
  check(name, () => assert.equal(read(xml, overrides).length, 0));
const invalid = (name: string, xml: string) => check(name, () => assert.throws(() => read(xml)));
const raw = read(fixture())[0]!;

eq("plain original record count", read(fixture()).length, 1);
eq("plain original headline", raw.title, title);
eq("original HTTPS link retained", raw.url, original);
eq("strict updated retained", raw.updatedInstant, instant);
eq("written URL calendar", raw.dailyLinkDay, "2026-10-09");
eq("publisher label", raw.publisher, "Statistics Canada");
eq("metadata kind", raw.kind, "labour-bulletin-metadata-only");
eq("honest updated clock label", raw.dateBasis, "feed-entry-updated");
eq("exact output fields", Object.keys(raw).sort(), ["dateBasis", "dailyLinkDay", "kind", "publisher", "title", "updatedInstant", "url"].sort());
eq("no publication key", Object.keys(raw).some(key => /published|publication|pubdate/i.test(key)), false);

const xhtml = feed(entry(`<title type="xhtml"><div xmlns="${XHTML}">${title}</div></title><updated>${instant}</updated><link href="${original}"/>`));
eq("observed XHTML div plain text", read(xhtml), [raw]);
eq("XHTML whitespace around div", read(xhtml.replace("<div", " \n<div").replace("</div>", "</div> \n")), [raw]);
eq("prefixed XHTML div", read(xhtml.replace(`<div xmlns="${XHTML}">`, `<h:div xmlns:h="${XHTML}">`).replace("</div>", "</h:div>")), [raw]);
const spanTitle = xhtml.replace(title, '<span class="reference-period">Employment</span> indicators');
eq("single inert span and surrounding text preserves headline", read(spanTitle), [raw]);
eq("span with no class preserves headline", read(spanTitle.replace(' class="reference-period"', "")), [raw]);
eq("span around whole title preserves headline", read(xhtml.replace(title, `<span class="reference-period">${title}</span>`)), [raw]);
eq("suffix span preserves source order", read(xhtml.replace(title, 'Employment <span class="reference-period">indicators</span>')), [raw]);
eq("span cannot insert missing whitespace", read(xhtml.replace(title, 'Employment<span class="reference-period">indicators</span>')).length, 0);
denied("multiple title spans rejected", xhtml.replace(title, '<span>Employment</span><span> indicators</span>'));
denied("nested element inside span rejected", xhtml.replace(title, '<span class="reference-period"><b>Employment</b> indicators</span>'));
denied("foreign title span rejected", xhtml.replace(title, '<span xmlns="urn:other">Employment indicators</span>'));
for (const attribute of ['onclick="ignored()"', 'style="display:none"', 'href="https://example.invalid"', 'id="x"']) {
  denied("unapproved span attribute rejected", spanTitle.replace('class="reference-period"', attribute));
}
eq("discarded class cannot supply missing topic", read(xhtml.replace(title, '<span class="employment">General</span> news')).length, 0);
eq("discarded class never reaches metadata", JSON.stringify(read(spanTitle)).includes("reference-period"), false);
eq("span leading space remains at internal boundary", read(xhtml.replace(title, 'Employment<span class="reference-period"> indicators</span>')), [raw]);
eq("span trailing space remains at internal boundary", read(xhtml.replace(title, '<span class="reference-period">Employment </span>indicators')), [raw]);
eq("span whitespace cannot invent an employment token", read(xhtml.replace(title, 'e<span class="reference-period"> mployment</span> indicators')).length, 0);
eq("span boundaries retain exact source headline", read(xhtml.replace(title, 'Employment<span class="reference-period"> indicators </span>update'))[0]?.title, "Employment indicators update");
eq("explicit plain text title", read(fixture().replace("<title>", '<title type="text">')), [raw]);
eq("plain CDATA title", read(fixture().replace(title, `<![CDATA[${title}]]>`)), [raw]);
eq("XML entities decoded once", read(fixture("Employment &amp; unemployment"))[0]?.title, "Employment & unemployment");
eq("numeric XML title entity", read(fixture("Employment &#38; unemployment"))[0]?.title, "Employment & unemployment");
eq("hex XML title entity", read(fixture("Employment &#x26; unemployment"))[0]?.title, "Employment & unemployment");
eq("valid supplementary Unicode", read(fixture("Employment research \u{1f52c}"))[0]?.title, "Employment research \u{1f52c}");

const aliasRecord = read(fixture(title, alias))[0]!;
eq("n1 alias admitted", aliasRecord.url, alias);
eq("original excluded by alias identity", read(fixture(), { excludedLinks: new Set([alias]) }).length, 0);
eq("alias excluded by original identity", read(fixture(title, alias), { excludedLinks: new Set([original]) }).length, 0);
eq("cross-host duplicate identity", read(feed(entry(fields()) + entry(fields(title, alias)))).length, 1);
eq("first original duplicate retained", read(feed(entry(fields()) + entry(fields(title, alias))))[0]?.url, original);
eq("self link ignored beside alternate", read(feed(entry(fields() + '<link rel="self" href="https://example.invalid/ignored"/>'))), [raw]);
eq("explicit alternate link", read(fixture().replace('<link href=', '<link rel="alternate" href=')), [raw]);

denied("non-macro topic", fixture(), { topicId: "mental-health" });
denied("labour costs alone insufficient", fixture("Labour compensation bulletin"));
for (const headline of ["Labour force survey", "Employment insurance", "Employment statistics", "Unemployment indicators", "Labour force update"]) {
  eq(`macro anchor ${headline}`, read(fixture(headline)).length, 1);
}
denied("employment partial token", fixture("Selfemployment statistics"));

const offset = "2026-10-09T23:30:00-04:00";
eq("offset day distinct from UTC day admitted", read(fixture(title, original, offset)).length, 1);
eq("written date retained over UTC conversion", read(fixture(title, original, offset))[0]?.dailyLinkDay, "2026-10-09");
eq("offset exact instant retained", read(fixture(title, original, offset))[0]?.updatedInstant, offset);
denied("same UTC day wrong written date", fixture(title, original, "2026-10-10T00:30:00+04:00"));
denied("wrong encoded directory day", fixture(title, original.replace("/261009/", "/261008/")));
denied("different directory and filename", fixture(title, original.replace("dq261009", "dq261008")));
denied("URL day differs updated day", fixture(title, original.replaceAll("261009", "261008")));
denied("future updated timestamp", fixture(title, original.replaceAll("261009", "261011"), "2026-10-11T12:00:00Z"));
denied("stale rolling-day timestamp", fixture(title, original, "2026-10-09T11:59:59Z"));
eq("rolling-day boundary inclusive", read(fixture()).length, 1);
eq("rolling-week older daily item", read(fixture(title, original.replaceAll("261009", "261004"), "2026-10-04T12:00:00Z"), { freshness: "pw" }).length, 1);
denied("stale rolling-week timestamp", fixture(title, original.replaceAll("261009", "261002"), "2026-10-02T12:00:00Z"), { freshness: "pw" });
denied("invalid now", fixture(), { now: NaN });

for (const badDate of ["2026-02-30T12:00:00Z", "2026-13-09T12:00:00Z", "2026-10-09T24:00:00Z", "2026-10-09T12:60:00Z", "2026-10-09T12:00:60Z", "2026-10-09", "2026-10-09T12:00:00", "Fri, 09 Oct 2026 12:00:00 +0000", "2026-10-09T12:00:00-00:00", "2026-10-09T12:00:00+14:01", "2026-10-09T12:00:00+15:00", "2026-10-09T12:00:00.1234Z"]) {
  denied(`strict date rejection ${badDate}`, fixture(title, original, badDate));
}
eq("millisecond precision accepted", read(fixture(title, original, "2026-10-09T12:00:00.001Z")).length, 1);
denied("impossible URL calendar", fixture(title, original.replaceAll("261009", "260230"), "2026-02-28T12:00:00Z"));
denied("missing updated", feed(entry(`<title>${title}</title><link href="${original}"/>`)));
denied("published cannot replace updated", feed(entry(`<title>${title}</title><published>${instant}</published><link href="${original}"/>`)));
eq("published value ignored without clock fabrication", read(feed(entry(fields() + '<published>1900-01-01T00:00:00Z</published>'))), [raw]);

for (const duplicate of [`<title>${title}</title>`, "<title/>", `<updated>${instant}</updated>`, "<updated/>", `<link href="${original}"/>`, "<link/>"]) {
  denied(`duplicate required field ${duplicate.split(/[ >]/)[0]}`, feed(entry(fields() + duplicate)));
}
for (const name of ["title", "updated", "link"]) {
  const foreign = name === "title" ? `<f:title xmlns:f="urn:other">${title}</f:title>` : name === "updated" ? `<f:updated xmlns:f="urn:other">${instant}</f:updated>` : `<f:link xmlns:f="urn:other" href="${original}"/>`;
  denied(`foreign duplicate ${name}`, feed(entry(fields() + foreign)));
  denied(`foreign single ${name}`, feed(entry(fields().replace(new RegExp(name === "link" ? '<link[^>]*/>' : `<${name}>[^<]*</${name}>`), foreign))));
}
invalid("foreign entry namespace", feed(`<entry xmlns="urn:other">${fields()}</entry>`));
denied("nested title cannot replace direct title", feed(entry(`<summary><title>${title}</title></summary><updated>${instant}</updated><link href="${original}"/>`)));
denied("nested link body rejected", feed(entry(fields().replace(/<link[^>]*\/>/, `<link href="${original}"><span>ignored</span></link>`))));
denied("URL text body rejected", feed(entry(`<title>${title}</title><updated>${instant}</updated><link>${original}</link>`)));
denied("href plus text rejected", fixture().replace('<link href=', '<link href=').replace('"/></entry>', '">ignored</link></entry>'));

for (const badTitle of ["", " ", "&lt;script&gt;Employment&lt;/script&gt;", "&amp;lt;script&amp;gt;Employment", "Employment javascript:alert(1)", "Employment data:text/html,test", "Employment https://example.invalid", "Employment &#9; indicators", "Employment &#xFFFD;", "Employment " + "x".repeat(301)]) {
  denied(`unsafe title case ${badTitle.length}`, fixture(badTitle));
}
denied("CDATA markup title rejected", fixture("<![CDATA[<script>Employment</script>]]>"));
denied("plain title with element rejected", fixture("<b>Employment</b>"));
denied("HTML title type rejected", fixture().replace("<title>", '<title type="html">'));
denied("XHTML nested formatting rejected", xhtml.replace(title, `<b>${title}</b>`));
denied("XHTML child must div", xhtml.replaceAll("div", "span"));
denied("XHTML namespace required", xhtml.replace(XHTML, "urn:other"));
denied("XHTML foreign script child rejected", xhtml.replace(title, '<script>Employment</script>'));
denied("XHTML div unsafe attributes rejected", xhtml.replace('<div xmlns=', '<div onclick="ignored()" xmlns='));
denied("XHTML multiple div rejected", xhtml.replace('</div>', `</div><div xmlns="${XHTML}">Employment</div>`));
denied("XHTML text plus div rejected", xhtml.replace('<div xmlns=', 'Employment<div xmlns='));
for (const entity of ["&nbsp;", "&bogus;", "&#0;", "&#xD800;", "&#x110000;", "&#xFFFF;"]) invalid(`invalid XML entity ${entity}`, fixture(`Employment ${entity}`));

for (const url of [original.replace("https:", "http:"), original.replace("www.statcan.gc.ca", "statcan.gc.ca"), original.replace("www.statcan.gc.ca", "www.statcan.gc.ca.evil.invalid"), original.replace("www.statcan.gc.ca", "www150.statcan.gc.ca"), alias.replace("/n1/", "/"), original + "?tracking=1", original + "#fragment", original.replace("www.statcan.gc.ca", "name:pass@www.statcan.gc.ca"), original.replace("www.statcan.gc.ca", "www.statcan.gc.ca:443"), original.replace("/daily-quotidien/", "/DAILY-QUOTIDIEN/"), original.replace("/261009/", "/20261009/"), original.replace("dq261009a", "dq261009A"), original.replace("-eng.htm", "-fra.htm"), original.replace("a-eng.htm", "a%2deng.htm"), original.replace("/261009/", "/x/../261009/"), "javascript:alert(1)", "https://127.0.0.1/daily-quotidien/261009/dq261009a-eng.htm", "/daily-quotidien/261009/dq261009a-eng.htm", "not-a-url"]) {
  denied(`unsafe link case ${url.length}`, fixture(title, url));
}

const dropped = feed(entry(fields() + '<summary>DISCARDED_SUMMARY</summary><content type="html">DISCARDED_CONTENT</content><description>DISCARDED_DESCRIPTION</description><id>DISCARDED_IDENTIFIER</id>'), '<author><name>DISCARDED_FEED_BYLINE</name></author><rights>DISCARDED_FEED_RIGHTS</rights>');
eq("body and feed byline discarded", read(dropped), [raw]);
check("body text absent from projected JSON", () => assert.doesNotMatch(JSON.stringify(read(dropped)), /DISCARDED|summary|description|content|author/));
for (const owned of ["author", "contributor", "rights", "source"]) {
  denied(`entry ownership rejected ${owned}`, feed(entry(fields() + `<${owned}>DISCARDED</${owned}>`)));
  denied(`foreign entry ownership rejected ${owned}`, feed(entry(fields() + `<f:${owned} xmlns:f="urn:other">DISCARDED</f:${owned}>`)));
}

const hundredEntries = Array.from({ length: 100 }, (_, index) => entry(fields(title, original.replace("a-eng", `a${index}-eng`))));
const hundredExclusions = new Set(Array.from({ length: 100 }, (_, index) => alias.replace("a-eng", `a${index}-eng`)));
eq("100 excluded cannot hide 101st", read(feed(hundredEntries.join("") + entry(fields())), { excludedLinks: hundredExclusions }), [raw]);
eq("100 selected cap", read(feed(hundredEntries.join("") + entry(fields()))).length, 100);
eq("all 100 selected identities distinct", new Set(read(feed(hundredEntries.join("") + entry(fields()))).map(row => row.url)).size, 100);
invalid("foreign entry after 100 selected still rejects whole feed", feed(hundredEntries.join("") + '<entry xmlns="urn:other"/>'));
check("foreign envelope checked before topic exclusion", () => assert.throws(() => read(feed(hundredEntries.join("") + '<entry xmlns="urn:other"/>'), { topicId: "other" })));

for (const xml of ["", "<feed>", "<rss/>", '<feed xmlns="urn:other"/>', feed("") + feed(""), "not XML" + feed(""), feed("") + "trailing", '<!DOCTYPE feed>' + feed(""), '<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///private">]>' + feed(""), feed(entry(fields())).replace('</entry>', '</other>'), feed('<entry></entry bad>'), feed('<entry a="1"a="2"/>'), feed('<entry a=unquoted/>'), feed('<entry a="1" a="2"/>'), feed('<entry a="<"/>'), feed('<entry><u:title>Employment</u:title></entry>'), feed('<entry xmlns:u=""/>'), feed('<entry xmlns:xml="urn:wrong"/>'), feed('<entry xmlns:xmlns="urn:wrong"/>'), feed('<entry xmlns:u="http://www.w3.org/2000/xmlns/"/>'), feed('<entry xmlns:u="http://www.w3.org/XML/1998/namespace"/>'), feed('<entry xmlns:a="urn:one" xmlns:b="urn:one" a:value="1" b:value="2"/>'), feed('<entry><a:b:c/></entry>'), feed('<entry><!-- bad -- comment --></entry>'), feed('<entry><![CDATA[unterminated</entry>'), feed('<entry>bad ]]&gt;</entry>').replace(']]&gt;', ']]>')]) {
  invalid(`malformed XML case ${xml.length}`, xml);
}
invalid("reserved namespace URI as default", feed('<entry xmlns="http://www.w3.org/XML/1998/namespace"/>'));
invalid("xmlns namespace URI as default", feed('<entry xmlns="http://www.w3.org/2000/xmlns/"/>'));
invalid("reserved default namespace on ignored descendant", feed('<ignored xmlns="http://www.w3.org/XML/1998/namespace"/>'));
invalid("xmlns default namespace on ignored descendant", feed('<ignored xmlns="http://www.w3.org/2000/xmlns/"/>'));
const rootBindings = Array.from({ length: 30 }, (_, index) => `xmlns:n${index}="urn:fixture:${index}"`).join(" ");
const boundedScope = fixture().replace(`<feed xmlns="${ATOM}">`, `<feed xmlns="${ATOM}" ${rootBindings}>`);
eq("32 inherited namespace bindings allowed", read(boundedScope), [raw]);
invalid("33rd inherited binding rejected independently of attributes", boundedScope.replace('<entry>', '<entry xmlns:extra="urn:extra">'));
const scopeA = Array.from({ length: 15 }, (_, index) => `xmlns:a${index}="urn:a:${index}"`).join(" ");
const scopeB = Array.from({ length: 15 }, (_, index) => `xmlns:b${index}="urn:b:${index}"`).join(" ");
invalid("nested namespace amplification capped", feed(`<ignored ${scopeA}><ignored ${scopeB}><ignored xmlns:c="urn:c"/></ignored></ignored>`));
const manyUnchangedScopes = feed(hundredEntries.join("")).replace(`<feed xmlns="${ATOM}">`, `<feed xmlns="${ATOM}" ${rootBindings}>`);
eq("unchanged bounded namespace scopes reused across entries", read(manyUnchangedScopes).length, 100);
const inheritedXhtmlFields = `<title type="xhtml"><h:div>${title}</h:div></title><updated>${instant}</updated><link href="${original}"/>`;
const rebindDoesNotLeak = feed(entry(inheritedXhtmlFields.replace('<h:div>', '<h:div xmlns:h="urn:other">')) + entry(inheritedXhtmlFields)).replace(`<feed xmlns="${ATOM}">`, `<feed xmlns="${ATOM}" xmlns:h="${XHTML}">`);
eq("changed child namespace scope cannot mutate sibling inheritance", read(rebindDoesNotLeak), [raw]);
invalid("XML declaration must precede root", feed('<?xml version="1.0"?>'));
invalid("non-XML processing instruction rejected", '<?other value?>' + feed(""));
eq("ordinary XML declaration accepted", read('<?xml version="1.0" encoding="UTF-8"?>' + fixture()), [raw]);
invalid("too many nodes", feed('<ignored/>'.repeat(10_000)));
invalid("too deep XML", feed(entry('<ignored>'.repeat(23) + '</ignored>'.repeat(23))));
invalid("too many attributes", feed('<entry ' + Array.from({ length: 33 }, (_, index) => `a${index}="x"`).join(" ") + '/>'));
invalid("string byte cap", " ".repeat(256 * 1024 + 1));
invalid("UTF-8 byte cap independently of character count", feed(entry('<summary>' + "é".repeat(140_000) + '</summary>')));
invalid("forbidden XML control", fixture().replace(title, "Employment\u0000"));
invalid("unpaired surrogate rejected", fixture().replace(title, "Employment\ud800"));

const cited = citation(raw)!;
check("citation explicitly updated", () => assert.match(cited, /Feed entry updated: 2026-10-09T12:00:00Z/));
check("citation refuses publication inference", () => assert.match(cited, /Original publication time is unproven/));
check("citation product reference-date credit", () => assert.match(cited, /Adapted from Statistics Canada, The Daily, 2026-10-09/));
check("citation no endorsement", () => assert.match(cited, /does not constitute an endorsement/));
check("citation exact license link", () => assert.match(cited, /\[Statistics Canada Open Licence\]\(https:\/\/www\.statcan\.gc\.ca\/en\/terms-conditions\/open-licence\)/));
check("citation excludes text media third parties", () => assert.match(cited, /Article text, media and third-party material are excluded/));
const markdownTitle = "Employment [sample](case) * _ ` \\ { } ! |";
const escaped = read(fixture(markdownTitle))[0]!;
eq("citation markdown title escaped", citation(escaped)?.split("\n")[0], `[${markdownTitle.replace(/[\\`*_[\]{}()!|]/g, "\\$&")}](${original})`);

const citeUnknown = (value: unknown) => citation(value as StatCanLabourMetadata);
for (const value of [undefined, null, false, 1, "text", [], new Date(), Object.create({ title }), () => {}, { ...raw, publisher: "Other" }, { ...raw, kind: "article" }, { ...raw, dateBasis: "published" }, { ...raw, dailyLinkDay: "2026-10-10" }, { ...raw, title: "<script>Employment</script>" }, { ...raw, url: "https://example.invalid" }, { ...raw, updatedInstant: "2026-10-09" }]) {
  eq("malformed cache denied", citeUnknown(value), undefined);
}
eq("null prototype cache supported", citeUnknown(Object.assign(Object.create(null), raw)), cited);
let getterCalls = 0;
for (const key of Object.keys(raw)) {
  const value = { ...raw };
  Object.defineProperty(value, key, { get() { getterCalls++; throw new Error("Test getter must not run"); }, enumerable: true });
  eq(`cached field getter denied ${key}`, citeUnknown(value), undefined);
}
eq("cached getters never invoked", getterCalls, 0);
const proxy = new Proxy({}, { getPrototypeOf() { throw new Error("Test proxy prototype trap"); } });
check("cached hostile proxy safely denied", () => assert.equal(citeUnknown(proxy), undefined));
const descriptorsProxy = new Proxy({ ...raw }, { getOwnPropertyDescriptor() { throw new Error("Test descriptor trap"); } });
check("cached hostile descriptor trap safely denied", () => assert.equal(citeUnknown(descriptorsProxy), undefined));
const revoked = Proxy.revocable({}, {});
revoked.revoke();
check("cached revoked proxy safely denied", () => assert.equal(citeUnknown(revoked.proxy), undefined));
eq("zero network attempts", fetchAttempts, 0);

console.log(JSON.stringify({ status: failedChecks.length ? "offline_fail" : "offline_pass", assertions, passed, failed: failedChecks.length, failedChecks, networkAttempts: fetchAttempts }));
if (failedChecks.length) process.exitCode = 1;
