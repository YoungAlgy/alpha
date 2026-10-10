// Pure metadata contract. Request controls and rendering live in separate modules.
import type { BraveSearchOptions } from "@/lib/brave";
import { parsePublicSourceTimestamp, publicSourceWindow } from "./public-source-freshness";

const MAX_POOL = 100;
const ORIGIN = "https://www.gov.uk";
const STORY_PATH = /^\/government\/news\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LICENSE = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/";
const AI = /\b(?:artificial intelligence|AI|large language models?|LLMs?|machine learning)\b/i;
const MACRO = /\b(?:inflation|interest[ -]+rates?|recession|GDP|economic growth|central banks?|monetary policy)\b/i;
const NON_MACRO = /\b(?:grade[ -]+inflation|gum[ -]+recession|hairline[ -]+recession)\b/i;
const HOUSING = /\b(?:housing|mortgages?|homebuyers?|housebuilders?|housebuilding|property market|rental market)\b/i;
const NON_HOUSING_MARKET = /\bhousing[ -]+benefits?\b/i;

export type GovUkNewsMetadata = {
  title: string;
  url: string;
  publicTimestamp: string;
  format: "news_story" | "press_release";
  publisher: "govuk";
  kind: "government-announcement-citation-only";
  timestampMeaning: "published-or-major-update";
};

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// JSON scalar values only. Accessor/inherited fields cannot supply metadata.
function ownValue(row: Record<string, unknown>, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(row, key);
  return field && "value" in field ? field.value : undefined;
}

function safeTitle(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 300 &&
    !!value.trim() && !/[\p{Cc}\p{Cf}\p{Cs}<>\ufffd\ufffe\uffff]/u.test(value) &&
    !/&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/.test(value);
}

function canonicalUrl(value: unknown, allowBasePath = false): string | undefined {
  if (typeof value !== "string" || value.length > 500) return;
  // Only this exact API base path can be expanded. URL normalization must not
  // repair ports, credentials, dot segments, escapes, queries or route variants.
  if (allowBasePath && STORY_PATH.test(value)) return ORIGIN + value;
  if (!value.startsWith(ORIGIN + "/") || !STORY_PATH.test(value.slice(ORIGIN.length))) return;
  try {
    const parsed = new URL(value);
    if (parsed.href === value && parsed.origin === ORIGIN && !parsed.username &&
        !parsed.password && !parsed.port && !parsed.search && !parsed.hash) return value;
  } catch { /* Invalid metadata is discarded. */ }
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  // Require an explicit known zone and exact calendar/time syntax. Do not trim,
  // infer a zone, accept unknown -00:00, or silently truncate sub-millisecond data.
  const match = value.match(/^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || match[1] === "0000" || match[2] === "-00:00") return;
  const zone = match[2]!;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 14 ||
      (Number(zone.slice(1, 3)) === 14 && zone.slice(4) !== "00"))) return;
  const instant = parsePublicSourceTimestamp(value);
  if (!Number.isFinite(instant)) return;
  const canonical = new Date(instant).toISOString();
  // Offset conversion can cross outside the four-digit year representation.
  if (/^[0-9]{4}-/.test(canonical) && !canonical.startsWith("0000-")) return canonical;
}

function metadata(row: Record<string, unknown>, cached: boolean): GovUkNewsMetadata | undefined {
  const title = ownValue(row, "title");
  const url = canonicalUrl(ownValue(row, cached ? "url" : "link"), !cached);
  const rawTimestamp = ownValue(row, cached ? "publicTimestamp" : "public_timestamp");
  const publicTimestamp = canonicalTimestamp(rawTimestamp);
  const format = ownValue(row, "format");
  if (!safeTitle(title) || !url || !publicTimestamp ||
      (format !== "news_story" && format !== "press_release")) return;
  if (Object.hasOwn(row, "content_store_document_type") &&
      ownValue(row, "content_store_document_type") !== format) return;
  if (cached && (rawTimestamp !== publicTimestamp || ownValue(row, "publisher") !== "govuk" ||
      ownValue(row, "kind") !== "government-announcement-citation-only" ||
      ownValue(row, "timestampMeaning") !== "published-or-major-update")) return;
  // Fresh objects deliberately omit all body/media/byline/licence payload fields.
  return { title, url, publicTimestamp, format, publisher: "govuk",
    kind: "government-announcement-citation-only", timestampMeaning: "published-or-major-update" };
}

/** Reconstruct a cached citation record without trusting its TypeScript shape. */
export function validatedGovUkNewsMetadata(value: unknown): GovUkNewsMetadata | undefined {
  return plainObject(value) ? metadata(value, true) : undefined;
}

/** Keep the bounded raw metadata pool before any date/topic/reader selection. */
export function parseGovUkNewsMetadata(value: unknown): GovUkNewsMetadata[] {
  if (!plainObject(value)) throw new Error("GOV.UK candidate invalid metadata envelope");
  const rows = ownValue(value, "results");
  if (!Array.isArray(rows) || rows.length > MAX_POOL) {
    throw new Error("GOV.UK candidate invalid or oversized metadata pool");
  }
  const result: GovUkNewsMetadata[] = [];
  for (const row of rows) {
    const parsed = plainObject(row) ? metadata(row, false) : undefined;
    if (parsed) result.push(parsed);
  }
  return result;
}

/** Recheck cached metadata, current age, exact topic and canonical repeat links. */
export function selectGovUkNewsMetadata(rows: readonly GovUkNewsMetadata[], topicId: string, options: {
  now: number;
  freshness?: BraveSearchOptions["freshness"];
  excludedLinks?: ReadonlySet<string>;
}): GovUkNewsMetadata[] {
  if (!Array.isArray(rows) || rows.length > MAX_POOL) return [];
  const window = publicSourceWindow(options.freshness, options.now);
  const matcher = topicId === "ai-news" ? AI : topicId === "macro-markets" ? MACRO :
    topicId === "real-estate" ? HOUSING : undefined;
  if (!window || !matcher) return [];
  const excluded = new Set<string>();
  for (const link of options.excludedLinks ?? []) {
    const url = canonicalUrl(link, true);
    if (url) excluded.add(url);
  }
  const seen = new Set<string>();
  const selected: GovUkNewsMetadata[] = [];
  for (const row of rows) {
    const parsed = validatedGovUkNewsMetadata(row);
    if (!parsed) continue;
    const instant = Date.parse(parsed.publicTimestamp);
    if (instant < window.start || instant > window.end || !matcher.test(parsed.title) ||
        (topicId === "macro-markets" && NON_MACRO.test(parsed.title)) ||
        (topicId === "real-estate" && NON_HOUSING_MARKET.test(parsed.title)) ||
        seen.has(parsed.url) || excluded.has(parsed.url)) continue;
    seen.add(parsed.url);
    selected.push(parsed);
    if (selected.length === MAX_POOL) break;
  }
  return selected;
}

/** Citation-only public metadata credit. No author or full-article grant inferred. */
export function govUkNewsCitation(record: GovUkNewsMetadata): string | undefined {
  const parsed = validatedGovUkNewsMetadata(record);
  if (!parsed) return;
  // Display the original title verbatim while preventing Markdown link injection.
  const title = parsed.title.replace(/[\\`*_[\]{}()!|]/g, "\\$&");
  return `[${title}](${parsed.url})\n\nSource: GOV.UK, United Kingdom. Published or updated: ${parsed.publicTimestamp}. ` +
    `Public metadata credit only. Contains public sector information licensed under the Open Government Licence v3.0. ` +
    `[Open Government Licence v3.0](${LICENSE}) ` +
    `This credit does not clear article text, media or third-party rights.`;
}
