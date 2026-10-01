import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { cleanField } from "./text-clean";
import { hostTier } from "./source-authority";
import { createPublicSourceCache } from "./public-source-cache";
import { freshPublicResults, publicSourceWindow } from "./public-source-freshness";
import { readPublicSourceText } from "./public-source-response";
import { reservePublicSourceRequest } from "./public-source-budget";
import { runPublicSourceAttempt, type PublicSourceAttempt } from "./public-source-circuit";
import { isPublicSourceControlError, PublicSourceControlError } from "./public-source-error-policy";
import { noModelModeEnabled } from "./provider-policy";

// Crossref metadata is openly reusable. Keep this narrow until other topic
// coverage is proven. No custom topic, profile, contact or key is sent.
const ENDPOINT = "https://api.crossref.org/works";
const QUERY = "nutrition";
const MAX_RECORDS = 20;
const SPACING_MS = 1_000;
const MAX_QUEUE_WAIT_MS = 15_000;
const SELECT = "DOI,title,published-online,type,resource,license";
type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function researchMetadataFallbackEnabled(): boolean {
  return noModelModeEnabled() &&
    /^(1|true|yes)$/i.test(process.env.ALPHA_RESEARCH_METADATA_FALLBACK?.trim() ?? "");
}

function publicationDate(value: unknown): number | null {
  if (!object(value) || !Array.isArray(value["date-parts"])) return null;
  const parts = value["date-parts"][0];
  if (!Array.isArray(parts) || parts.length !== 3 ||
      !parts.every(Number.isInteger)) return null;
  const [year, month, day] = parts as number[];
  if (year < 2000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const stamp = Date.UTC(year, month - 1, day);
  const date = new Date(stamp);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day ? stamp : null;
}

function openLicense(value: unknown, now: number): boolean {
  if (!Array.isArray(value)) return false;
  return value.slice(0, 20).some((entry: unknown) => {
    if (!object(entry) || entry["content-version"] !== "vor" || typeof entry.URL !== "string") return false;
    // No TDM-only license, future embargo, unknown grant date or arbitrary URL.
    if (!/^https?:\/\/creativecommons\.org\/licenses\/by(?:-sa)?\/(?:3\.0|4\.0)\/?$/.test(entry.URL)) return false;
    if (!object(entry.start)) return false;
    const starts = publicationDate(entry.start);
    return starts !== null && starts <= now;
  });
}

/** Pure bounded metadata parser. Abstracts, article bodies and images are ignored. */
export function parseResearchMetadata(value: unknown, now: number): BraveResult[] {
  if (!object(value) || value.status !== "ok" || value["message-type"] !== "work-list" ||
      !object(value.message) || !Array.isArray(value.message.items)) {
    throw new Error("Research metadata invalid response");
  }
  return value.message.items.slice(0, MAX_RECORDS).flatMap((item: unknown) => {
    if (!object(item) || item.type !== "journal-article" || !Array.isArray(item.title) ||
        typeof item.title[0] !== "string" || typeof item.DOI !== "string" ||
        !/^10\.[0-9]{4,9}\/[^\s<>]+$/i.test(item.DOI) || item.DOI.length > 300) return [];
    const title = cleanField(item.title[0]);
    if (!/\bnutrition(?:al)?\b/i.test(title) ||
        /^(?:retraction|retracted|withdrawal|withdrawn|correction|corrigendum|erratum)\b/i.test(title) ||
        /\b(?:aquaculture|livestock|poultry|broilers?|cattle|piglets?|swine|ruminants?|canine|feline|veterinary|dairy cows?|plant nutrition|crop nutrition|animal nutrition|fish nutrition|fish feed|rodents?|mice|rats)\b/i.test(title)) return [];
    const published = publicationDate(item["published-online"]);
    if (published === null || !openLicense(item.license, now) ||
        !object(item.resource) || !object(item.resource.primary) ||
        typeof item.resource.primary.URL !== "string" || item.resource.primary.URL.length > 2048) return [];
    try {
      const url = new URL(item.resource.primary.URL);
      url.hostname = url.hostname.replace(/\.$/, "");
      // A DOI wrapper must not hide a publisher from existing paywall/junk filters.
      // Link directly to the supplied publisher page. Do not follow/fetch it here.
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          ["doi.org", "api.crossref.org", "localhost"].includes(url.hostname) ||
          url.hostname.endsWith(".doi.org") ||
          url.hostname.endsWith(".local") || !url.hostname.includes(".") ||
          /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.hostname.includes(":") ||
          hostTier(url.hostname, url.href) === "denied") return [];
      return [{ title: `Research citation: ${title}`, url: url.href,
        description: `Nutrition paper metadata from Crossref. Publisher-supplied online publication date: ${new Date(published).toISOString().slice(0, 10)}. This is a source-linked research reading item.`,
        age: new Date(published).toISOString() }];
    } catch { return []; }
  });
}

export function createResearchMetadataSearch(deps: {
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  reserve?: typeof reservePublicSourceRequest;
  attempt?: PublicSourceAttempt;
} = {}) {
  const fetcher = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const reserve = deps.reserve ?? reservePublicSourceRequest;
  const attempt = deps.attempt ?? runPublicSourceAttempt;
  const cached = createPublicSourceCache(now);
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let nextAt = 0;
  let blockedUntil = 0;

  async function serial(work: () => Promise<BraveResult[]>): Promise<BraveResult[]> {
    if (queued >= 4) throw new PublicSourceControlError("Research metadata queue full");
    const queuedAt = now();
    queued++;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { cancelled = true; reject(new PublicSourceControlError("Research metadata queue timed out")); }, MAX_QUEUE_WAIT_MS);
    });
    const task = tail.catch(() => {}).then(async () => {
      if (cancelled || now() - queuedAt >= MAX_QUEUE_WAIT_MS) throw new PublicSourceControlError("Research metadata queue timed out");
      if (now() < blockedUntil) throw new PublicSourceControlError("Research metadata cooling down");
      const delay = Math.max(0, nextAt - now());
      if (delay) await sleep(delay);
      if (cancelled || now() - queuedAt >= MAX_QUEUE_WAIT_MS) throw new PublicSourceControlError("Research metadata queue timed out");
      if (now() < blockedUntil) throw new PublicSourceControlError("Research metadata cooling down");
      clearTimeout(timer);
      try { return await work(); }
      catch (error) {
        if (!isPublicSourceControlError(error)) blockedUntil = Math.max(blockedUntil, now() + 60_000);
        throw error;
      }
      finally { nextAt = now() + SPACING_MS; }
    }).finally(() => { queued--; });
    // A timed-out queued caller cannot release the serial lane early or fetch later.
    tail = task.then(() => {}, () => {});
    try { return await Promise.race([task, expired]); }
    finally { clearTimeout(timer); }
  }

  return async function researchMetadataSearch(topicId: string, opts: BraveSearchOptions = {}): Promise<BraveResult[]> {
    const window = publicSourceWindow(opts.freshness, now());
    if (topicId !== "nutrition-food" || !window) return [];
    const start = new Date(window.start).toISOString().slice(0, 10);
    const end = new Date(window.end).toISOString().slice(0, 10);
    const raw = await cached("crossref-research", `${start}|${end}`, () => serial(() => attempt("crossref-research",
      // Reuse the durable publisher ceiling, with independent outage state.
      () => reserve("publisher-rss"), async () => {
      const signal = AbortSignal.timeout(5000);
      const params = new URLSearchParams({ query: QUERY, rows: String(MAX_RECORDS),
        sort: "published-online", order: "desc", select: SELECT,
        filter: `from-online-pub-date:${start},until-online-pub-date:${end},type:journal-article,has-license:true` });
      const response = await fetcher(`${ENDPOINT}?${params}`, {
        signal, redirect: "error", credentials: "omit", cache: "no-store",
        headers: { Accept: "application/json",
          "User-Agent": "Alpha-public-source-metadata/1.0 (https://alpha.everyday.report)" },
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`Research metadata ${response.status}`);
      }
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Research metadata invalid content type");
      }
      const text = await readPublicSourceText(response, signal);
      return parseResearchMetadata(JSON.parse(text), now());
    })));
    return freshPublicResults(raw, opts.freshness, now());
  };
}
export const researchMetadataSearch = createResearchMetadataSearch();
