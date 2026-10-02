import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { validatedPlosAttribution } from "@/lib/source-attribution";
import { cleanField } from "./text-clean";
import { createPublicSourceCache } from "./public-source-cache";
import { freshPublicResults, publicSourceWindow } from "./public-source-freshness";
import { readPublicSourceText } from "./public-source-response";
import { reservePublicSourceRequest } from "./public-source-budget";
import { runPublicSourceAttempt, type PublicSourceAttempt } from "./public-source-circuit";
import { noModelModeEnabled } from "./provider-policy";

const ENDPOINT = "https://api.plos.org/search";
const FIELDS = "id,title_display,publication_date,author_display,article_type,journal,copyright";
const MAX_RECORDS = 20;
const TOPICS = ["nutrition-food", "mental-health", "ai-news"] as const;
type Topic = typeof TOPICS[number];
type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function plosMetadataFallbackEnabled(): boolean {
  return noModelModeEnabled() &&
    /^(1|true|yes)$/i.test(process.env.ALPHA_PLOS_METADATA_FALLBACK?.trim() ?? "") &&
    /^(1|true|yes)$/i.test(process.env.ALPHA_DURABLE_SOURCE_BUDGET?.trim() ?? "") &&
    /^(1|true|yes)$/i.test(process.env.ALPHA_DURABLE_SOURCE_COOLDOWN?.trim() ?? "");
}

function publicationDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.exec(value);
  if (!match) return null;
  const date = Date.parse(value.includes("T") ? value : `${match[1]}T00:00:00.000Z`);
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === match[1]
    ? new Date(date).toISOString() : null;
}

function authors(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim() || /[\x00-\x1f\x7f]/.test(raw)) return null;
    const name = cleanField(raw).replace(/\s+/g, " ").trim();
    if (!name || name.length > 200) return null;
    const key = name.toLocaleLowerCase("en-US");
    if (!seen.has(key)) { names.push(name); seen.add(key); }
  }
  const joined = names.join(", ");
  return joined && joined.length <= 200 ? joined : null;
}

function openCopyright(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 1000 ||
      /all rights reserved|non.?commercial|no.?deriv(?:atives|s)?|share.?alike|\bCC\s*BY[-\s]*(?:NC|ND|SA)\b|\b(?:[0-3]|[5-9])\.\d\b/i.test(value)) return false;
  // Current PLOS policy is CC BY 4.0. Never relabel an explicit older or
  // restrictive grant. No paper body or third-party media is requested.
  return /creative\s+commons\s+attribution(?:\s+(?:license|4\.0))?\b/i.test(value) ||
    /\bCC\s*BY\s*(?:4\.0)?\b/i.test(value);
}

function topicMatches(topic: Topic, title: string): boolean {
  if (/\b(?:retraction|retracted|withdrawal|withdrawn|correction|corrigendum|erratum)\b/i.test(title)) return false;
  if (topic === "nutrition-food") return /\bnutrition(?:al)?\b/i.test(title) &&
    !/\b(?:aquaculture|livestock|poultry|broilers?|cattle|piglets?|swine|ruminants?|canine|feline|veterinary|dairy cows?|plant nutrition|crop nutrition|animal nutrition|fish nutrition|fish feed|rodents?|mice|rats)\b/i.test(title);
  if (topic === "mental-health") return /\bmental[ -]+health\b/i.test(title);
  return /\bartificial[ -]+intelligence\b/i.test(title);
}

function plosUrl(doi: unknown): string | null {
  if (typeof doi !== "string" || doi.length > 100) return null;
  const match = /^10\.1371\/journal\.(pone|pmed|pdig|pmnh)\.(\d{7})$/i.exec(doi);
  if (!match) return null;
  const journal = { pone: "plosone", pmed: "plosmedicine", pdig: "digitalhealth", pmnh: "mentalhealth" }[match[1].toLowerCase() as "pone" | "pmed" | "pdig" | "pmnh"];
  return `https://journals.plos.org/${journal}/article?id=10.1371/journal.${match[1].toLowerCase()}.${match[2]}`;
}

/** Parse only fixed metadata fields. Extra API fields never enter a result. */
export function parsePlosMetadata(value: unknown): BraveResult[] {
  if (!object(value) || !object(value.response) || !Array.isArray(value.response.docs) ||
      !Number.isInteger(value.response.numFound) || (value.response.numFound as number) < 0 ||
      (value.responseHeader !== undefined && (!object(value.responseHeader) || value.responseHeader.status !== 0))) {
    throw new Error("PLOS metadata invalid response");
  }
  return value.response.docs.slice(0, MAX_RECORDS).flatMap((doc: unknown) => {
    if (!object(doc) || typeof doc.title_display !== "string" ||
        typeof doc.article_type !== "string" || !/^research article$/i.test(doc.article_type.trim()) ||
        !openCopyright(doc.copyright)) return [];
    const title = cleanField(doc.title_display);
    if (!title || title.length > 300 || !TOPICS.some(topic => topicMatches(topic, title))) return [];
    const date = publicationDate(doc.publication_date);
    const author = authors(doc.author_display);
    const url = plosUrl(doc.id);
    if (!date || !author || !url) return [];
    const attribution = validatedPlosAttribution(url, author, date);
    if (!attribution) return [];
    return [{ title: `PLOS research citation: ${title}`, url,
      description: `PLOS research reading metadata. Publication date: ${date.slice(0, 10)}. No findings or advice are summarized.`,
      age: date, attribution }];
  });
}

export function createPlosMetadataSearch(deps: {
  fetcher?: typeof fetch;
  now?: () => number;
  reserve?: typeof reservePublicSourceRequest;
  attempt?: PublicSourceAttempt;
} = {}) {
  const fetcher = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const reserve = deps.reserve ?? reservePublicSourceRequest;
  const attempt = deps.attempt ?? runPublicSourceAttempt;
  const cached = createPublicSourceCache(now);
  return async function plosMetadataSearch(topicId: string, opts: BraveSearchOptions = {}): Promise<BraveResult[]> {
    if (!TOPICS.includes(topicId as Topic)) return [];
    const window = publicSourceWindow(opts.freshness, now());
    if (!window) return [];
    const start = new Date(window.start).toISOString().slice(0, 10);
    const end = new Date(window.end).toISOString().slice(0, 10);
    const raw = await cached("plos-research", `${start}|${end}`, () => attempt("plos-research",
      () => reserve("plos-research"), async () => {
        const signal = AbortSignal.timeout(5000);
        const params = new URLSearchParams({
          // Whole public days share one raw pool. Downstream rolling-window
          // filtering still rejects future and out-of-range metadata.
          q: `title:(nutrition OR "mental health" OR "artificial intelligence") AND article_type:"Research Article" AND publication_date:[${start}T00:00:00.000Z TO ${end}T23:59:59.999Z]`,
          rows: String(MAX_RECORDS), sort: "publication_date desc", wt: "json", fl: FIELDS,
        });
        const response = await fetcher(`${ENDPOINT}?${params}`, {
          signal, redirect: "error", credentials: "omit", cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new Error(`PLOS metadata ${response.status}`);
        }
        if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
          void response.body?.cancel().catch(() => {});
          throw new Error("PLOS metadata invalid content type");
        }
        const text = await readPublicSourceText(response, signal);
        return parsePlosMetadata(JSON.parse(text));
      }));
    const eligible = raw.filter(result => topicMatches(topicId as Topic,
      result.title.slice("PLOS research citation: ".length)));
    return freshPublicResults(eligible, opts.freshness, now()).map(result => ({
      ...result, attribution: result.attribution ? { ...result.attribution } : undefined,
    }));
  };
}

export const plosMetadataSearch = createPlosMetadataSearch();
