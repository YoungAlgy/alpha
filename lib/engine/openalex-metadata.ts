// Pure OpenAlex citation metadata. No transport, environment, activation or body reads.
import type { BraveSearchOptions } from "@/lib/brave";
import { normalizedNewsTokens } from "./news-topic-tokens";
import { parsePublicSourceTimestamp, publicSourceWindow } from "./public-source-freshness";
import { normalizeUrl } from "./url-guard";

export type OpenAlexMetadata = Readonly<{
  title: string;
  url: string;
  workUrl: string;
  publicationDay: string;
  publisher: "openalex";
  kind: "research-metadata-citation-only";
  dateBasis: "reported-publication-day";
}>;

export const OPENALEX_TOPICS = Object.freeze({
  aiResearch: "artificial intelligence",
  musicResearch: "music",
  climateResearch: "climate change",
} as const);
type Lane = keyof typeof OPENALEX_TOPICS;
const DAY = 86_400_000;
const NATIVE_FIELDS = ["id", "doi", "title", "publication_date", "publication_year", "type", "language", "is_retracted", "indexed_in"];
const CACHE_FIELDS = ["title", "url", "workUrl", "publicationDay", "publisher", "kind", "dateBasis"];

/** These are canonical makeCustomTopic ids. No free-form reader text is queried. */
export function openAlexTopicLane(topicId: string): Lane | undefined {
  switch (topicId) {
    case "custom:artificial intelligence research": return "aiResearch";
    case "custom:music research": return "musicResearch";
    case "custom:climate change research": return "climateResearch";
  }
}

function ownData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return null;
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) return null;
    result[key] = descriptor.value;
  }
  // getOwnPropertyDescriptors preserves symbol keys too, but its typed result does not.
  if (Reflect.ownKeys(value).length !== Object.keys(result).length) return null;
  return result;
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
/** Ordinary dense arrays only. Never execute user-supplied getters or iterators. */
function dataArray(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max ||
      Reflect.ownKeys(descriptors).length !== length + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    result.push(descriptor.value);
  }
  return result;
}
function calendarDay(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  return parsePublicSourceTimestamp(`${value}T00:00:00Z`);
}
export function openAlexCompletedDayBounds(now: number): { start: string; end: string } | null {
  try {
    if (!Number.isFinite(now)) return null;
    const today = new Date(now).toISOString().slice(0, 10);
    const midnight = calendarDay(today);
    if (!Number.isFinite(midnight)) return null;
    const start = new Date(midnight - 7 * DAY).toISOString().slice(0, 10);
    const end = new Date(midnight - DAY).toISOString().slice(0, 10);
    return Number.isFinite(calendarDay(start)) && Number.isFinite(calendarDay(end)) ? { start, end } : null;
  } catch { return null; }
}
export function openAlexQueryUrl(lane: Lane, now: number): string | null {
  if (!Object.hasOwn(OPENALEX_TOPICS, lane)) return null;
  const bounds = openAlexCompletedDayBounds(now);
  if (!bounds) return null;
  const url = new URL("https://api.openalex.org/works");
  url.search = new URLSearchParams({
    "search.title": OPENALEX_TOPICS[lane],
    filter: `from_publication_date:${bounds.start},to_publication_date:${bounds.end},type:article,language:en,is_retracted:false,has_doi:true`,
    sort: "publication_date:desc", select: NATIVE_FIELDS.join(","), page: "1", per_page: "20",
  }).toString();
  return url.href;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "\u2013", mdash: "\u2014", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d", hellip: "\u2026",
});
function safeTitle(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1500 && !!value.trim() &&
    !/[\p{C}<>\ufffd\ufffe\uffff]/u.test(value) &&
    !/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(value) &&
    !/(?:https?:\/\/|javascript:|data:)/i.test(value);
}
function nativeTitle(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1500) return null;
  // Exactly one pass. Remaining encoded markup/entities are refused, never decoded later.
  const decoded = value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (raw, entity: string) => {
    if (!entity.startsWith("#")) {
      const key = entity.toLowerCase();
      return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key]! : raw;
    }
    const hex = entity[1]?.toLowerCase() === "x";
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isSafeInteger(point) && point > 0 && point <= 0x10ffff &&
      !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "\ufffd";
  });
  return safeTitle(decoded) ? decoded : null;
}
function primaryUrl(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/openalex\.org\/W\d{1,16}$/.test(value);
}
/** Preserve the supplied safe URI. Its comparison identity is separate and casefolded. */
function doi(value: unknown): { url: string; key: string } | null {
  if (typeof value !== "string" || value.length > 500 ||
      !/^https:\/\/doi\.org\/10\.\d{4,9}\/[^\s<>"'`{}\[\]\\|^?#]+$/.test(value) ||
      /[^\x21-\x7e]/.test(value)) return null;
  let unsafeEscape = false;
  const decoded = value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => {
    const point = Number.parseInt(hex, 16);
    const char = String.fromCharCode(point);
    // No escaped separators, controls, whitespace, double escapes or dot repair.
    if (point < 0x21 || point > 0x7e || /[.\/\\%?#<>"'`{}\[\]|^:]/.test(char)) unsafeEscape = true;
    return char;
  });
  if (unsafeEscape || /%(?![0-9a-f]{2})/i.test(value) ||
      decoded.split("/").some(segment => segment === "." || segment === "..")) return null;
  try {
    const url = new URL(value);
    if (url.href !== value || url.username || url.password || url.port || url.search || url.hash) return null;
    return { url: value, key: decoded.slice("https://".length).toLowerCase() };
  } catch { return null; }
}
function makeMetadata(title: unknown, workUrl: unknown, url: unknown, publicationDay: unknown): OpenAlexMetadata | null {
  if (!safeTitle(title) || !primaryUrl(workUrl) || !doi(url) || !Number.isFinite(calendarDay(publicationDay))) return null;
  return Object.freeze({ title, url: url as string, workUrl, publicationDay: publicationDay as string,
    publisher: "openalex", kind: "research-metadata-citation-only", dateBasis: "reported-publication-day" });
}
export function validatedOpenAlexMetadata(value: unknown): OpenAlexMetadata | null {
  try {
    const row = ownData(value);
    if (!row || !exact(row, CACHE_FIELDS) || row.publisher !== "openalex" ||
        row.kind !== "research-metadata-citation-only" || row.dateBasis !== "reported-publication-day") return null;
    return makeMetadata(row.title, row.workUrl, row.url, row.publicationDay);
  } catch { return null; }
}

/** Projection drift invalidates the response. Malformed scalar rows cannot become citations. */
export function parseOpenAlexMetadata(value: unknown): OpenAlexMetadata[] | null {
  try {
    const envelope = ownData(value);
    const meta = envelope && ownData(envelope.meta);
    const rows = envelope && dataArray(envelope.results, 20);
    if (!meta || !rows || !Number.isSafeInteger(meta.count) || (meta.count as number) < rows.length ||
        meta.page !== 1 || meta.per_page !== 20) return null;
    const projected: OpenAlexMetadata[] = [];
    for (const value of rows) {
      const row = ownData(value);
      if (!row || !exact(row, NATIVE_FIELDS)) return null;
      const indexes = dataArray(row.indexed_in, 10);
      const title = nativeTitle(row.title);
      const parsed = title && makeMetadata(title, row.id, row.doi, row.publication_date);
      if (!parsed || row.publication_year !== Number(parsed.publicationDay.slice(0, 4)) ||
          row.type !== "article" || row.language !== "en" || row.is_retracted !== false || !indexes ||
          !indexes.every(index => typeof index === "string" && /^[a-z0-9_-]{1,32}$/.test(index))) continue;
      projected.push(parsed);
    }
    return projected;
  } catch { return null; }
}

/** Both identities must be retained for later citation-history exclusion. */
export function openAlexCitationKeys(record: OpenAlexMetadata): string[] {
  const parsed = validatedOpenAlexMetadata(record);
  return parsed ? [doi(parsed.url)!.key, normalizeUrl(parsed.workUrl)!] : [];
}
function excludedKeys(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 1000) return [];
  // Only known identity families may use the internal scheme-free history format.
  const candidate = /^(?:openalex\.org\/|(?:dx\.)?doi\.org\/|journals\.plos\.org\/)/i.test(value)
    ? `https://${value}` : value;
  const primary = candidate.match(/^https:\/\/openalex\.org\/w\d{1,16}$/i);
  if (primary) return [candidate.slice(8).toLowerCase()];
  const resolver = candidate.match(/^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/.+)$/i);
  if (resolver) {
    const parsed = doi(`https://doi.org/${resolver[1]}`);
    return parsed ? [parsed.key] : [];
  }
  // Fixed PLOS article paths and a sole DOI id parameter. No publisher-wide guessing.
  const plos = candidate.match(/^https:\/\/journals\.plos\.org\/(plosone|plosbiology|plosmedicine|plosgenetics|plospathogens|ploscompbiol|plosntds|plosclimate|ploswater|plossustainabilitytransformation|plosdigitalhealth|digitalhealth|mentalhealth|plosglobalpublichealth)\/article\?id=([^&#]+)$/);
  if (!plos) return [];
  try {
    const id = decodeURIComponent(plos[2]!);
    if (!/^10\.1371\/journal\.[a-z]+\.[a-z0-9]+$/i.test(id)) return [];
    const parsed = doi(`https://doi.org/${id}`);
    return parsed ? [parsed.key] : [];
  } catch { return []; }
}

/** The entire reported UTC day must be closed and inside the existing source window. */
export function selectOpenAlexMetadata(rows: readonly unknown[], topicId: string, options: {
  now: number;
  freshness?: BraveSearchOptions["freshness"];
  excludedLinks?: ReadonlySet<string>;
}): OpenAlexMetadata[] {
  try {
    const lane = openAlexTopicLane(topicId);
    const window = publicSourceWindow(options.freshness, options.now);
    const boundedRows = dataArray(rows, 20);
    if (!lane || !window || !boundedRows) return [];
    const excluded = new Set<string>();
    for (const value of options.excludedLinks ?? []) for (const key of excludedKeys(value)) excluded.add(key);
    const wanted = normalizedNewsTokens(OPENALEX_TOPICS[lane]);
    const seenIds = new Set<string>();
    const seenDois = new Set<string>();
    const selected: OpenAlexMetadata[] = [];
    for (const row of boundedRows) {
      const parsed = validatedOpenAlexMetadata(row);
      if (!parsed) continue;
      const dayStart = calendarDay(parsed.publicationDay);
      const dayEnd = dayStart + DAY - 1;
      const [doiKey, idKey] = openAlexCitationKeys(parsed);
      if (dayStart < window.start || dayEnd > window.end || dayStart + DAY > options.now ||
          !wanted.every(token => normalizedNewsTokens(parsed.title).includes(token)) ||
          excluded.has(idKey!) || excluded.has(doiKey!) || seenIds.has(idKey!) || seenDois.has(doiKey!)) continue;
      seenIds.add(idKey!);
      seenDois.add(doiKey!);
      selected.push(parsed);
    }
    return selected;
  } catch { return []; }
}
