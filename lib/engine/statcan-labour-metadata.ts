// Pure scalar metadata validation. No request, environment or activation.
// Atom updated is a modification timestamp. It never becomes publication time.
import type { BraveSearchOptions } from "@/lib/brave";
import { parsePublicSourceTimestamp, publicSourceWindow } from "./public-source-freshness";

const ATOM = "http://www.w3.org/2005/Atom";
const XHTML = "http://www.w3.org/1999/xhtml";
const MAX_BYTES = 256 * 1024;
const MAX_RESULTS = 100;
const LICENCE = "https://www.statcan.gc.ca/en/terms-conditions/open-licence";

export type StatCanLabourMetadata = {
  title: string;
  url: string;
  updatedInstant: string;
  dailyLinkDay: string;
  publisher: "Statistics Canada";
  kind: "labour-bulletin-metadata-only";
  dateBasis: "feed-entry-updated";
};

type XmlNode = {
  qualifiedName: string;
  localName: string;
  namespace: string;
  attributes: Map<string, string>;
  namespaces: Map<string, string>;
  parts: (string | XmlNode)[];
};

const invalid = () => new Error("StatCan candidate invalid or unsupported XML");
function xmlText(raw: string): string {
  // Exactly one XML decoding pass. No HTML/entity repair or DTD expansion.
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(raw)) throw invalid();
  return raw.replace(/&(?:#(x[0-9a-fA-F]+|\d+)|(amp|lt|gt|quot|apos));/g, (_, numeric: string | undefined, named: string | undefined) => {
    if (!numeric) return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[named!]!;
    const point = numeric.startsWith("x") ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
    if (!Number.isSafeInteger(point) || !(point === 9 || point === 10 || point === 13 ||
        point >= 0x20 && point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff)) throw invalid();
    return String.fromCodePoint(point);
  });
}

function qualifiedName(raw: string): string[] {
  if (!/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(raw)) throw invalid();
  return raw.split(":");
}

/** Small bounded XML subset, private to this candidate. Never dereference markup. */
function atomDocument(xml: string): XmlNode {
  if (typeof xml !== "string" || xml.length > MAX_BYTES || new TextEncoder().encode(xml).byteLength > MAX_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(xml) || /[\p{Cs}]/u.test(xml)) throw invalid();
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let cursor = 0;
  let nodes = 0;
  let declarationSeen = false;
  const append = (text: string) => {
    if (!stack.length) { if (text.trim()) throw invalid(); }
    else stack.at(-1)!.parts.push(text);
  };
  while (cursor < xml.length) {
    const next = xml.indexOf("<", cursor);
    const textEnd = next < 0 ? xml.length : next;
    const text = xml.slice(cursor, textEnd);
    if (text.includes("]]>")) throw invalid();
    append(xmlText(text));
    cursor = textEnd;
    if (next < 0) break;
    if (xml.startsWith("<!--", cursor)) {
      const end = xml.indexOf("-->", cursor + 4);
      if (end < 0 || xml.slice(cursor + 4, end).includes("--")) throw invalid();
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", cursor)) {
      const end = xml.indexOf("]]>", cursor + 9);
      if (end < 0 || !stack.length) throw invalid();
      append(xml.slice(cursor + 9, end));
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", cursor)) {
      const end = xml.indexOf("?>", cursor + 2);
      if (end < 0 || root || declarationSeen || xml.slice(0, cursor).trim() ||
          !/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["'](?:UTF-8|utf-8)["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>$/.test(xml.slice(cursor, end + 2))) throw invalid();
      declarationSeen = true;
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", cursor)) throw invalid();
    let end = cursor + 1;
    let quote = "";
    for (; end < xml.length; end++) {
      const char = xml[end]!;
      if (quote) { if (char === quote) quote = ""; }
      else if (char === "'" || char === '"') quote = char;
      else if (char === "<") throw invalid();
      else if (char === ">") break;
    }
    if (end === xml.length || quote) throw invalid();
    const tag = xml.slice(cursor + 1, end);
    cursor = end + 1;
    if (tag.startsWith("/")) {
      if (!/^\/[A-Za-z_][\w:.-]*\s*$/.test(tag) || stack.at(-1)?.qualifiedName !== tag.slice(1).trim()) throw invalid();
      stack.pop();
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const content = selfClosing ? tag.slice(0, -1) : tag;
    const name = content.match(/^[A-Za-z_][\w:.-]*/)?.[0];
    if (!name) throw invalid();
    const segments = qualifiedName(name);
    const attributes = new Map<string, string>();
    let offset = name.length;
    while (offset < content.length) {
      if (!/\s/.test(content[offset]!)) throw invalid();
      while (/\s/.test(content[offset] ?? "")) offset++;
      if (offset === content.length) break;
      const match = content.slice(offset).match(/^([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/);
      if (!match || match[3]!.includes("<") || attributes.has(match[1]!) || attributes.size >= 32) throw invalid();
      qualifiedName(match[1]!);
      attributes.set(match[1]!, xmlText(match[3]!));
      offset += match[0].length;
    }
    const inheritedNamespaces = stack.at(-1)?.namespaces ?? new Map([["xml", "http://www.w3.org/XML/1998/namespace"]]);
    // Share unchanged scopes. Bound every changed scope before retaining it.
    const declaresNamespace = [...attributes.keys()].some(key => key === "xmlns" || key.startsWith("xmlns:"));
    const namespaces = declaresNamespace ? new Map(inheritedNamespaces) : inheritedNamespaces;
    for (const [key, value] of attributes) {
      if (key === "xmlns") {
        if (value === "http://www.w3.org/2000/xmlns/" || value === "http://www.w3.org/XML/1998/namespace") throw invalid();
        namespaces.set("", value);
      }
      else if (key.startsWith("xmlns:")) {
        const prefix = key.slice(6);
        if (!value || prefix === "xmlns" || value === "http://www.w3.org/2000/xmlns/" ||
            prefix === "xml" && value !== "http://www.w3.org/XML/1998/namespace" ||
            prefix !== "xml" && value === "http://www.w3.org/XML/1998/namespace") throw invalid();
        namespaces.set(prefix, value);
      }
    }
    if (namespaces.size > 32) throw invalid();
    const prefix = segments.length === 2 ? segments[0]! : "";
    if (prefix && !namespaces.has(prefix)) throw invalid();
    const expandedAttributes = new Set<string>();
    for (const key of attributes.keys()) {
      if (key === "xmlns" || key.startsWith("xmlns:")) continue;
      const attributeParts = qualifiedName(key);
      const attributePrefix = attributeParts.length === 2 ? attributeParts[0]! : "";
      if (attributePrefix && !namespaces.has(attributePrefix)) throw invalid();
      const expanded = `${attributePrefix ? namespaces.get(attributePrefix) : ""}|${attributeParts.at(-1)}`;
      if (expandedAttributes.has(expanded)) throw invalid();
      expandedAttributes.add(expanded);
    }
    const node: XmlNode = { qualifiedName: name, localName: segments.at(-1)!, namespace: namespaces.get(prefix) ?? "", attributes, namespaces, parts: [] };
    if (++nodes > 10_000 || stack.length >= 24) throw invalid();
    if (stack.length) stack.at(-1)!.parts.push(node);
    else { if (root) throw invalid(); root = node; }
    if (!selfClosing) stack.push(node);
  }
  if (!root || stack.length || root.localName !== "feed" || root.namespace !== ATOM) throw invalid();
  return root;
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.parts.filter((part): part is XmlNode => typeof part !== "string" && part.localName === name);
}
function one(node: XmlNode, name: string): XmlNode | undefined {
  const fields = children(node, name);
  return fields.length === 1 && fields[0]!.namespace === ATOM ? fields[0] : undefined;
}
function plain(node: XmlNode): string | undefined {
  return node.parts.every(part => typeof part === "string") ? node.parts.join("").trim() : undefined;
}
function titleText(node: XmlNode): string | undefined {
  const type = node.attributes.get("type") ?? "text";
  if (type === "text") return plain(node);
  if (type !== "xhtml") return;
  const pieces = node.parts.filter(part => typeof part !== "string" || part.trim());
  if (pieces.length !== 1 || typeof pieces[0] === "string") return;
  const div = pieces[0];
  // Admit plain text or the observed single text-only XHTML span. No HTML cleaner.
  if (div.localName !== "div" || div.namespace !== XHTML ||
      [...div.attributes.keys()].some(key => key !== "xmlns" && !key.startsWith("xmlns:"))) return;
  const direct = plain(div);
  if (direct !== undefined) return direct;
  const spans = div.parts.filter((part): part is XmlNode => typeof part !== "string");
  if (spans.length !== 1) return;
  const span = spans[0]!;
  if (span.localName !== "span" || span.namespace !== XHTML ||
      [...span.attributes.keys()].some(key => key !== "class" && key !== "xmlns" && !key.startsWith("xmlns:"))) return;
  // Class is discarded. It never supplies a topic signal or reaches any renderer.
  if (!span.parts.every(part => typeof part === "string")) return;
  const inner = span.parts.join("");
  // Preserve source order and existing text exactly. Insert no words or spacing.
  return div.parts.map(part => typeof part === "string" ? part : inner).join("").trim();
}
function safeTitle(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 300 && !!value.trim() &&
    !/[\p{C}<>\ufffd\ufffe\uffff]/u.test(value) && !/(?:https?:\/\/|javascript:|data:)/i.test(value) &&
    !/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(value);
}
function story(value: unknown): { url: string; day: string; key: string } | undefined {
  if (typeof value !== "string" || value.length > 500) return;
  const match = value.match(/^https:\/\/(?:www\.statcan\.gc\.ca\/daily-quotidien|www150\.statcan\.gc\.ca\/n1\/daily-quotidien)\/(\d{6})\/(dq(\d{6})[a-z][a-z0-9-]*-eng\.htm)$/);
  if (!match || match[1] !== match[3]) return;
  const day = `20${match[1]!.slice(0, 2)}-${match[1]!.slice(2, 4)}-${match[1]!.slice(4, 6)}`;
  const midnight = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) return;
  try { if (new URL(value).href !== value) return; } catch { return; }
  return { url: value, day, key: `${match[1]}/${match[2]}` };
}
function strictUpdated(value: unknown): number {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || value.endsWith("-00:00")) return NaN;
  const zone = value.slice(-6);
  if (!value.endsWith("Z") && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4)) > 59 ||
      Number(zone.slice(1, 3)) === 14 && zone.slice(4) !== "00")) return NaN;
  return parsePublicSourceTimestamp(value);
}
function record(title: unknown, urlValue: unknown, updated: unknown): StatCanLabourMetadata | undefined {
  const url = story(urlValue);
  if (!safeTitle(title) || !url || !Number.isFinite(strictUpdated(updated)) || (updated as string).slice(0, 10) !== url.day) return;
  return { title, url: url.url, updatedInstant: updated as string, dailyLinkDay: url.day,
    publisher: "Statistics Canada", kind: "labour-bulletin-metadata-only", dateBasis: "feed-entry-updated" };
}
export function validatedStatCanLabourMetadata(value: unknown): StatCanLabourMetadata | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const own = (key: string) => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; };
    const parsed = record(own("title"), own("url"), own("updatedInstant"));
    return parsed && own("dailyLinkDay") === parsed.dailyLinkDay && own("publisher") === parsed.publisher &&
      own("kind") === parsed.kind && own("dateBasis") === parsed.dateBasis ? parsed : undefined;
  } catch { return; }
}

/** The two official Daily URL families identify the same exact story. */
export function statCanLabourStoryKey(url: unknown): string | undefined {
  return story(url)?.key;
}

function excludedStoryKey(value: unknown): string | undefined {
  const absolute = statCanLabourStoryKey(value);
  if (absolute || typeof value !== "string") return absolute;
  // Resolver history contains normalizeUrl's exact scheme-free host/path key.
  // Accept only these two fixed internal forms, never a generic URL repair.
  if (value.startsWith("statcan.gc.ca/daily-quotidien/")) return statCanLabourStoryKey(`https://www.${value}`);
  if (value.startsWith("www150.statcan.gc.ca/n1/daily-quotidien/")) return statCanLabourStoryKey(`https://${value}`);
}

/** Validate the whole bounded XML envelope before retaining scalar metadata.
 * Date, labour relevance, duplicates and reader exclusions remain downstream.
 */
export function parseStatCanLabourPool(xml: string): StatCanLabourMetadata[] {
  const entries = children(atomDocument(xml), "entry");
  if (entries.some(entry => entry.namespace !== ATOM)) throw invalid();
  const pool: StatCanLabourMetadata[] = [];
  for (const entry of entries) {
    if (["source", "author", "contributor", "rights"].some(name => children(entry, name).length)) continue;
    const title = one(entry, "title");
    const updated = one(entry, "updated");
    const links = children(entry, "link").filter(link => !link.attributes.has("rel") || link.attributes.get("rel") === "alternate");
    if (!title || !updated || links.length !== 1 || links[0]!.namespace !== ATOM || plain(links[0]!) !== "") continue;
    const parsed = record(titleText(title), links[0]!.attributes.get("href"), plain(updated));
    if (parsed) pool.push(parsed);
  }
  // Scalar credit keys can expand beyond the XML input size. Reject the whole
  // projected pool before caching rather than silently hiding later siblings.
  if (new TextEncoder().encode(JSON.stringify(pool)).byteLength > MAX_BYTES) {
    throw new Error("StatCan labour invalid or oversized metadata pool");
  }
  return pool;
}

/** Rebuild safe metadata and recheck current date/topic/alias exclusions before cap. */
export function selectStatCanLabourMetadata(rows: readonly StatCanLabourMetadata[], topicId: string, options: {
  now: number;
  freshness?: BraveSearchOptions["freshness"];
  excludedLinks?: ReadonlySet<string>;
}): StatCanLabourMetadata[] {
  const window = publicSourceWindow(options.freshness, options.now);
  if (!Array.isArray(rows) || !window || topicId !== "macro-markets") return [];
  const excluded = new Set([...options.excludedLinks ?? []].map(excludedStoryKey).filter((key): key is string => !!key));
  const seen = new Set<string>();
  const selected: StatCanLabourMetadata[] = [];
  for (const row of rows) {
    const parsed = validatedStatCanLabourMetadata(row);
    if (!parsed) continue;
    const instant = strictUpdated(parsed.updatedInstant);
    const key = statCanLabourStoryKey(parsed.url)!;
    if (instant < window.start || instant > window.end ||
        !/\b(?:labour force survey|employment insurance|employment|unemployment|labour force)\b/i.test(parsed.title) ||
        excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    selected.push(parsed);
    if (selected.length === MAX_RESULTS) break;
  }
  return selected;
}

type StatCanOptions = {
  now: number; freshness?: BraveSearchOptions["freshness"]; topicId: string; excludedLinks?: ReadonlySet<string>;
};

function diagnosticCounters(entries: number) {
  return {
    entries, ownershipRejected: 0, requiredFieldsRejected: 0, titleShapeRejected: 0,
    titleSafetyRejected: 0, urlRejected: 0, updatedRejected: 0, dayMismatchRejected: 0,
    metadataValid: 0, topicRejected: 0, staleRejected: 0, futureRejected: 0,
    priorLinkRejected: 0, duplicateRejected: 0, selected: 0, capDeferred: 0, selectionDisabled: 0,
    ownershipMarkers: { author: 0, contributor: 0, rights: 0, source: 0 },
    titleShapes: {
      divTextOnly: 0, divHasElements: 0, divHasForbiddenAttributes: 0,
      divMixedTextWithElement: 0,
      spanTextOnly: 0, spanHasElements: 0,
      spanAttributes: { namespace: 0, class: 0, style: 0, id: 0, lang: 0, other: 0 },
      divChildTags: { p: 0, span: 0, br: 0, a: 0, em: 0, strong: 0, b: 0, other: 0 },
      divChildNamespaces: { xhtml: 0, atom: 0, other: 0 },
    },
    updatePrecision: { none: 0, oneToThree: 0, fourToNine: 0, other: 0 },
  };
}

/** Fixed counts only. Do not put text, URLs, attribute values or clocks in diagnostics. */
export function inspectStatCanLabourMetadata(xml: string, options: StatCanOptions) {
  const root = atomDocument(xml);
  const entries = children(root, "entry");
  // Check the whole envelope even when the selected-result cap is reached.
  if (entries.some(entry => entry.namespace !== ATOM)) throw invalid();
  const diagnostics = diagnosticCounters(entries.length);
  // Independent structural counts do not claim later selection gates passed.
  for (const entry of entries) {
    for (const name of ["author", "contributor", "rights", "source"] as const) {
      if (children(entry, name).length) diagnostics.ownershipMarkers[name]++;
    }
    const title = one(entry, "title");
    if (title?.attributes.get("type") === "xhtml") {
      for (const div of children(title, "div").filter(node => node.namespace === XHTML)) {
        if (div.parts.every(part => typeof part === "string")) diagnostics.titleShapes.divTextOnly++;
        else diagnostics.titleShapes.divHasElements++;
        if (div.parts.some(part => typeof part !== "string") && div.parts.some(part => typeof part === "string" && !!part.trim())) diagnostics.titleShapes.divMixedTextWithElement++;
        if ([...div.attributes.keys()].some(key => key !== "xmlns" && !key.startsWith("xmlns:"))) diagnostics.titleShapes.divHasForbiddenAttributes++;
        for (const part of div.parts) {
          if (typeof part === "string") continue;
          const tag = part.localName;
          const known = ["p", "span", "br", "a", "em", "strong", "b"].includes(tag);
          diagnostics.titleShapes.divChildTags[known ? tag as "p" | "span" | "br" | "a" | "em" | "strong" | "b" : "other"]++;
          diagnostics.titleShapes.divChildNamespaces[part.namespace === XHTML ? "xhtml" : part.namespace === ATOM ? "atom" : "other"]++;
          if (part.localName === "span" && part.namespace === XHTML) {
            if (part.parts.every(piece => typeof piece === "string")) diagnostics.titleShapes.spanTextOnly++;
            else diagnostics.titleShapes.spanHasElements++;
            for (const key of part.attributes.keys()) {
              const kind = key === "xmlns" || key.startsWith("xmlns:") ? "namespace" :
                ["class", "style", "id", "lang"].includes(key) ? key as "class" | "style" | "id" | "lang" : "other";
              diagnostics.titleShapes.spanAttributes[kind]++;
            }
          }
        }
      }
    }
    const updated = one(entry, "updated");
    const clock = updated && plain(updated);
    const shape = clock?.match(/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/);
    if (!shape) diagnostics.updatePrecision.other++;
    else if (!shape[1]) diagnostics.updatePrecision.none++;
    else diagnostics.updatePrecision[shape[1].length <= 3 ? "oneToThree" : shape[1].length <= 9 ? "fourToNine" : "other"]++;
  }
  const window = publicSourceWindow(options.freshness, options.now);
  if (!window || options.topicId !== "macro-markets") {
    diagnostics.selectionDisabled = entries.length;
    return { items: [] as StatCanLabourMetadata[], diagnostics };
  }
  const seen = new Set<string>();
  const excluded = new Set([...options.excludedLinks ?? []].map(excludedStoryKey).filter((key): key is string => !!key));
  const results: StatCanLabourMetadata[] = [];
  for (const entry of entries) {
    // Feed-level institution credit does not clear a separately owned entry.
    if (["source", "author", "contributor", "rights"].some(name => children(entry, name).length)) { diagnostics.ownershipRejected++; continue; }
    const title = one(entry, "title");
    const updated = one(entry, "updated");
    const links = children(entry, "link").filter(link => !link.attributes.has("rel") || link.attributes.get("rel") === "alternate");
    if (!title || !updated || links.length !== 1 || links[0]!.namespace !== ATOM || plain(links[0]!) !== "") { diagnostics.requiredFieldsRejected++; continue; }
    const headline = titleText(title);
    if (headline === undefined) { diagnostics.titleShapeRejected++; continue; }
    if (!safeTitle(headline)) { diagnostics.titleSafetyRejected++; continue; }
    const url = story(links[0]!.attributes.get("href"));
    if (!url) { diagnostics.urlRejected++; continue; }
    const clock = plain(updated);
    if (!Number.isFinite(strictUpdated(clock))) { diagnostics.updatedRejected++; continue; }
    if (clock!.slice(0, 10) !== url.day) { diagnostics.dayMismatchRejected++; continue; }
    const parsed = record(headline, url.url, clock)!;
    diagnostics.metadataValid++;
    const instant = strictUpdated(parsed.updatedInstant);
    const key = story(parsed.url)!.key;
    const labour = /\b(?:labour force survey|employment insurance|employment|unemployment|labour force)\b/i.test(parsed.title);
    if (!labour) { diagnostics.topicRejected++; continue; }
    if (instant < window.start) { diagnostics.staleRejected++; continue; }
    if (instant > window.end) { diagnostics.futureRejected++; continue; }
    if (excluded.has(key)) { diagnostics.priorLinkRejected++; continue; }
    if (seen.has(key)) { diagnostics.duplicateRejected++; continue; }
    seen.add(key);
    results.push(parsed);
    if (results.length === MAX_RESULTS) break;
  }
  diagnostics.selected = results.length;
  const firstRejected = diagnostics.ownershipRejected + diagnostics.requiredFieldsRejected + diagnostics.titleShapeRejected +
    diagnostics.titleSafetyRejected + diagnostics.urlRejected + diagnostics.updatedRejected + diagnostics.dayMismatchRejected;
  diagnostics.capDeferred = entries.length - firstRejected - diagnostics.metadataValid;
  return { items: results, diagnostics };
}

/** Original title/link plus explicit updated evidence, never a new-publication claim. */
export function parseStatCanLabourMetadata(xml: string, options: StatCanOptions): StatCanLabourMetadata[] {
  return inspectStatCanLabourMetadata(xml, options).items;
}

/** Separate credit and honest clock label for a future explicitly reviewed renderer. */
export function statCanLabourCitation(value: StatCanLabourMetadata): string | undefined {
  const parsed = validatedStatCanLabourMetadata(value);
  if (!parsed) return;
  const title = parsed.title.replace(/[\\`*_[\]{}()!|]/g, "\\$&");
  return `[${title}](${parsed.url})\n\nCanadian labour bulletin metadata. Feed entry updated: ${parsed.updatedInstant}. ` +
    `Daily link day: ${parsed.dailyLinkDay}. Original publication time is unproven. ` +
    `Adapted from Statistics Canada, The Daily, ${parsed.dailyLinkDay}. ` +
    `This does not constitute an endorsement by Statistics Canada of this product. ` +
    `[Statistics Canada Open Licence](${LICENCE}) ` +
    `Original headline and link only. Article text, media and third-party material are excluded.`;
}
