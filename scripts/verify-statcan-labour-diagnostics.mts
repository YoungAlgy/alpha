// Focused offline checks for the diagnostic view of StatCan labour metadata.
import assert from "node:assert/strict";

let networkAttempts = 0;
globalThis.fetch = (() => {
  networkAttempts++;
  throw new Error("Offline StatCan diagnostics test forbids network");
}) as typeof fetch;

const { inspectStatCanLabourMetadata: inspect, parseStatCanLabourMetadata: parse } =
  await import("../lib/engine/statcan-labour-metadata");

let assertions = 0;
let passed = 0;
const failedChecks: string[] = [];
function check(name: string, run: () => void) {
  assertions++;
  try { run(); passed++; } catch { failedChecks.push(name); }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, () => assert.deepEqual(actual, expected));
}
function throws(name: string, run: () => unknown) {
  check(name, () => assert.throws(run));
}

const ATOM = "http://www.w3.org/2005/Atom";
const XHTML = "http://www.w3.org/1999/xhtml";
const now = Date.parse("2026-10-10T12:00:00Z");
const instant = "2026-10-09T12:00:00Z";
const url = "https://www.statcan.gc.ca/daily-quotidien/261009/dq261009a-eng.htm";
const title = "Employment indicators";
const options = { now, freshness: "pd" as const, topicId: "macro-markets" };
const feed = (entries: string) => `<feed xmlns="${ATOM}">${entries}</feed>`;
const entry = (fields: string) => `<entry>${fields}</entry>`;
const fields = (headline = title, link = url, updated = instant) =>
  `<title>${headline}</title><updated>${updated}</updated><link href="${link}"/>`;
const item = (headline = title, link = url, updated = instant) => entry(fields(headline, link, updated));
const inspectXml = (xml: string, overrides: Partial<typeof options & { excludedLinks?: ReadonlySet<string> }> = {}) =>
  inspect(xml, { ...options, ...overrides });
const diagnostics = (xml: string, overrides: Partial<typeof options & { excludedLinks?: ReadonlySet<string> }> = {}) =>
  inspectXml(xml, overrides).diagnostics;

// Each fixture below reaches one first-rejection gate after the earlier gates pass.
const gateCases: Array<[string, string, string]> = [
  ["ownership", entry(fields() + "<author><name>Hidden byline</name></author>"), "ownershipRejected"],
  ["required fields", entry(`<title>${title}</title><updated>${instant}</updated>`), "requiredFieldsRejected"],
  ["title shape", item().replace(`<title>${title}</title>`, `<title type="html">${title}</title>`), "titleShapeRejected"],
  ["title safety", item("Employment https://example.invalid"), "titleSafetyRejected"],
  ["URL", item(title, "https://example.invalid/story"), "urlRejected"],
  ["updated timestamp", item(title, url, "2026-10-09"), "updatedRejected"],
  ["day mismatch", item(title, url, "2026-10-10T00:00:00Z"), "dayMismatchRejected"],
  ["topic", item("General news"), "topicRejected"],
  ["stale", item(title, url.replaceAll("261009", "261002"), "2026-10-02T12:00:00Z"), "staleRejected"],
  ["future", item(title, url.replaceAll("261009", "261011"), "2026-10-11T12:00:00Z"), "futureRejected"],
  ["prior link", item(title, url), "priorLinkRejected"],
  ["duplicate", item(title, url.replace("a-eng", "b-eng")) + item(title, url.replace("a-eng", "b-eng")), "duplicateRejected"],
];
const gateOptions = gateCases.map(([name, xml, counter]) => {
  if (name === "prior link") return [name, xml, counter, { excludedLinks: new Set([url]) }] as const;
  return [name, xml, counter, {}] as const;
});
for (const [name, xml, counter, overrides] of gateOptions) {
  const result = inspectXml(feed(xml), overrides);
  eq(`${name} first rejection`, result.diagnostics[counter], 1);
  eq(`${name} rejected item selection count`, result.diagnostics.selected, name === "duplicate" ? 1 : 0);
}

const additive = inspectXml(feed(entry(fields() + "<author>private person</author>") +
  entry(`<title>${title}</title><updated>${instant}</updated>`) +
  item("Employment https://example.invalid") + item(title, "https://example.invalid/x")));
eq("entry count includes rejected entries", additive.diagnostics.entries, 4);
eq("rejection counters add across entries", [additive.diagnostics.ownershipRejected,
  additive.diagnostics.requiredFieldsRejected, additive.diagnostics.titleSafetyRejected,
  additive.diagnostics.urlRejected], [1, 1, 1, 1]);

const shapes = feed(
  item().replace(`<title>${title}</title>`, `<title type="xhtml"><div xmlns="${XHTML}">${title}</div></title>`) +
  item().replace(`<title>${title}</title>`, `<title type="xhtml"><div xmlns="${XHTML}"><span>${title}</span></div></title>`) +
  item().replace(`<title>${title}</title>`, `<title type="xhtml"><div xmlns="${XHTML}" class="x">${title}</div></title>`),
);
const shapeDiagnostics = diagnostics(shapes);
eq("title shape aggregate reasons", [shapeDiagnostics.titleShapes.divTextOnly,
  shapeDiagnostics.titleShapes.divHasElements, shapeDiagnostics.titleShapes.divHasForbiddenAttributes], [2, 1, 1]);
eq("title shape child tag counters initialized", shapeDiagnostics.titleShapes.divChildTags,
  { p: 0, span: 1, br: 0, a: 0, em: 0, strong: 0, b: 0, other: 0 });
eq("title shape namespace counters initialized", shapeDiagnostics.titleShapes.divChildNamespaces,
  { xhtml: 1, atom: 0, other: 0 });

const spanShapes = feed(
  item().replace(`<title>${title}</title>`, `<title type="xhtml"><div xmlns="${XHTML}">Employment <span class="SECRET_CLASS_VALUE">indicators</span> update</div></title>`) +
  item().replace(`<title>${title}</title>`, `<title type="xhtml"><div xmlns="${XHTML}"><span class="SECRET_CLASS_VALUE" style="SECRET_STYLE_VALUE" id="SECRET_ID_VALUE" lang="SECRET_LANG_VALUE" data-secret="SECRET_OTHER_VALUE"><b>nested</b></span></div></title>`),
);
const spanResult = inspectXml(spanShapes);
const spanDiagnostics = spanResult.diagnostics.titleShapes;
eq("mixed div and span structure aggregates", [spanDiagnostics.divMixedTextWithElement,
  spanDiagnostics.spanTextOnly, spanDiagnostics.spanHasElements], [1, 1, 1]);
eq("span child and attribute kind counts", [spanDiagnostics.divChildTags.span,
  spanDiagnostics.divChildTags.b, spanDiagnostics.spanAttributes], [2, 0,
  { namespace: 0, class: 2, style: 1, id: 1, lang: 1, other: 1 }]);
eq("single inert span preserves source text without class value", spanResult.items[0]?.title, "Employment indicators update");
check("hostile span attribute values absent from diagnostic JSON", () => {
  assert.doesNotMatch(JSON.stringify(spanDiagnostics), /SECRET_CLASS_VALUE|SECRET_STYLE_VALUE|SECRET_ID_VALUE|SECRET_LANG_VALUE|SECRET_OTHER_VALUE/);
});

const accepted = feed(item() + item("Employment insurance", url.replace("a-eng", "b-eng")));
const parsed = parse(accepted, options);
const inspected = inspect(accepted, options);
eq("selection parity with parser", inspected.items, parsed);
eq("accepted and selected agree", [inspected.diagnostics.metadataValid, inspected.diagnostics.selected], [2, parsed.length]);

const capXml = feed(Array.from({ length: 102 }, (_, index) =>
  item(title, url.replace("a-eng", `a${index}-eng`))).join(""));
const capped = inspect(capXml, options);
eq("cap selection matches parser", capped.items, parse(capXml, options));
eq("cap deferred counts unevaluated entries after cap", capped.diagnostics.capDeferred, 2);
eq("cap selected reaches parser limit", capped.diagnostics.selected, 100);

const disabled = inspect(accepted, { ...options, topicId: "other" });
eq("disabled selection has no items", disabled.items, []);
eq("disabled selection claims no unevaluated metadata validity", [disabled.diagnostics.metadataValid,
  disabled.diagnostics.topicRejected, disabled.diagnostics.selectionDisabled], [0, 0, 2]);

const privateXml = feed(entry(fields("PRIVATE_HEADLINE_9384", url, instant) +
  `<author><name>PRIVATE_BYLINE_9384</name></author><summary>PRIVATE_BODY_9384</summary>`));
const serializedDiagnostics = JSON.stringify(inspectXml(privateXml).diagnostics);
check("diagnostic JSON excludes headline, link, updated, byline and body", () => {
  assert.doesNotMatch(serializedDiagnostics, /PRIVATE_HEADLINE_9384|PRIVATE_BYLINE_9384|PRIVATE_BODY_9384|statcan\.gc\.ca|2026-10-09/);
});

throws("foreign entry namespace remains a document guard", () => inspectXml(feed(`<entry xmlns="urn:foreign">${fields()}</entry>`)));
throws("malformed XML remains a document guard", () => inspectXml(feed(`<entry>${fields()}</entry bad>`)));
throws("multiple feed roots remain a document guard", () => inspectXml(feed("") + feed("")));

eq("no network calls", networkAttempts, 0);
console.log(JSON.stringify({ status: failedChecks.length ? "offline_fail" : "offline_pass",
  assertions, passed, failed: failedChecks.length, failedChecks, networkAttempts }));
if (failedChecks.length) process.exitCode = 1;
