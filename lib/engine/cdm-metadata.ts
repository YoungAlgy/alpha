// CDM headlines only. No article, summary, audio or artwork is retained.
import type { BraveSearchOptions } from "@/lib/brave";
import { cleanField } from "./text-clean";
import { directChildValues, rssItemBlocks } from "./rss-xml";
import { parsePublicSourceTimestamp, publicSourceWindow } from "./public-source-freshness";
import { normalizeUrl } from "./url-guard";
import { MAX_PUBLIC_SOURCE_BYTES } from "./public-source-response";

export interface CdmMetadata {
  publisher: "cdm";
  kind: "music-production-metadata";
  title: string;
  url: string;
  author: string;
  publishedAt: string;
  dateBasis: "feed-pubdate";
}
export interface CdmFeedRecord { metadata: CdmMetadata; categories: string[] }
const FIELDS = ["publisher", "kind", "title", "url", "author", "publishedAt", "dateBasis"];
const MAX_POOL = 100;
const PRODUCTION = /\b(?:synth(?:esizer)?s?|eurorack|midi|ableton|fl studio|audio mastering|music production|digital audio workstation|recording studio)\b/i;

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function scalar(value: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined;
}
function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 2 && value.length <= max &&
    !/[\p{C}<>\ufffd]/u.test(value) && !/https?:\/\//i.test(value) && cleanField(value) === value;
}
function canonicalStory(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500 || /[\p{C}<>\\?#]/u.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.href !== value || url.protocol !== "https:" || url.hostname !== "cdm.link" ||
        url.username || url.password || url.port || url.search || url.hash) return false;
    if (!/^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(url.pathname) &&
        !/^\/\d{4}\/\d{2}\/(?:\d{2}\/)?[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(url.pathname)) return false;
    return !["feed", "comments", "about", "privacy", "contact", "advertising"].includes(url.pathname.split("/")[1]!);
  } catch { return false; }
}

/** Saved/cache metadata must have exact own fields, without executable accessors. */
export function validatedCdmMetadata(value: unknown): CdmMetadata | undefined {
  try {
    if (!plain(value)) return;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== FIELDS.length || keys.some(key => typeof key !== "string" || !FIELDS.includes(key))) return;
    if (scalar(value, "publisher") !== "cdm" || scalar(value, "kind") !== "music-production-metadata" ||
        scalar(value, "dateBasis") !== "feed-pubdate") return;
    const title = scalar(value, "title"), url = scalar(value, "url"), author = scalar(value, "author");
    const publishedAt = scalar(value, "publishedAt");
    if (!safeText(title, 300) || !safeText(author, 150) || !canonicalStory(url) || typeof publishedAt !== "string") return;
    const time = parsePublicSourceTimestamp(publishedAt);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== publishedAt) return;
    return { publisher: "cdm", kind: "music-production-metadata", title, url, author, publishedAt, dateBasis: "feed-pubdate" };
  } catch { return; }
}
function one(block: string, field: string): string | undefined {
  const values = directChildValues(block, field, true, "CDM RSS");
  return values.length === 1 ? values[0] : undefined;
}

/** Validate the whole envelope first. Only bounded scalar metadata enters cache. */
export function parseCdmMetadataPool(xml: string, onIncomplete?: () => void): CdmFeedRecord[] {
  if (Buffer.byteLength(xml, "utf8") > MAX_PUBLIC_SOURCE_BYTES) throw new Error("CDM RSS too large");
  const items: CdmFeedRecord[] = [];
  const seen = new Set<string>();
  const incomplete = () => { try { onIncomplete?.(); } catch { /* Optional diagnostics cannot discard safe metadata. */ } };
  const blocks = rssItemBlocks(xml, Number.MAX_SAFE_INTEGER, "CDM RSS");
  for (const [index, block] of blocks.entries()) {
    // A separate item rights notice needs its own qualification. Do not silently
    // substitute the website's general license for an item-specific restriction.
    if (["copyright", "license", "dc:rights", "rights", "cc:license", "creativecommons:license", "dcterms:rights"].some(field => directChildValues(block, field, true, "CDM RSS").length)) { incomplete(); continue; }
    const date = parsePublicSourceTimestamp(one(block, "pubdate"));
    if (!Number.isFinite(date)) { incomplete(); continue; }
    const metadata = validatedCdmMetadata({ publisher: "cdm", kind: "music-production-metadata",
      title: one(block, "title"), url: one(block, "link"), author: one(block, "dc:creator"),
      publishedAt: new Date(date).toISOString(), dateBasis: "feed-pubdate" });
    if (!metadata) { incomplete(); continue; }
    const rawCategories = directChildValues(block, "category", true, "CDM RSS");
    if (rawCategories.length > 20 || rawCategories.some(category => !safeText(category, 100))) { incomplete(); continue; }
    const categories = [...new Set(rawCategories)];
    const key = normalizeUrl(metadata.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({ metadata, categories });
    if (items.length >= MAX_POOL) { if (index < blocks.length - 1) incomplete(); break; }
  }
  if (Buffer.byteLength(JSON.stringify(items), "utf8") > MAX_PUBLIC_SOURCE_BYTES) throw new Error("CDM metadata pool too large");
  return items;
}

// Never map artist names, genres or arbitrary profile text into this lane.
export function cdmTopicSupported(topicId: string): boolean { return topicId === "custom:music production"; }

export function selectCdmMetadata(rows: CdmFeedRecord[], topicId: string, opts: {
  now: number; freshness?: BraveSearchOptions["freshness"]; excludedLinks?: ReadonlySet<string>;
}): CdmMetadata[] {
  if (!cdmTopicSupported(topicId) || !Array.isArray(rows) || rows.length > MAX_POOL) return [];
  const window = publicSourceWindow(opts.freshness, opts.now);
  if (!window) return [];
  for (const row of rows) {
    if (!plain(row)) continue;
    const metadata = validatedCdmMetadata(scalar(row, "metadata"));
    const categories = scalar(row, "categories");
    if (!metadata || !Array.isArray(categories) || categories.length > 20 || categories.some(category => !safeText(category, 100))) continue;
    const names = new Set(categories.map(category => category.toLowerCase()));
    if (names.has("promoted") || names.has("deals") || /\b(?:promoted|sponsored|advertorial|deals)\b/i.test(metadata.title) ||
        (!names.has("music tech") && !PRODUCTION.test(metadata.title))) continue;
    const date = parsePublicSourceTimestamp(metadata.publishedAt);
    const key = normalizeUrl(metadata.url);
    if (date < window.start || date > window.end || !key || opts.excludedLinks?.has(key) || opts.excludedLinks?.has(metadata.url)) continue;
    return [metadata];
  }
  return [];
}
