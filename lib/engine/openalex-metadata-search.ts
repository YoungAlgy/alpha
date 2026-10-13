import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { openAlexCompletedDayBounds, openAlexQueryUrl, openAlexTopicLane, parseOpenAlexMetadata,
  selectOpenAlexMetadata, validatedOpenAlexMetadata, type OpenAlexMetadata } from "./openalex-metadata";
import { createPublicSourceCache } from "./public-source-cache";
import { publicSourceWindow } from "./public-source-freshness";
import { readPublicSourceText } from "./public-source-response";
import { durablePublicSourceBudgetEnabled, reservePublicSourceRequest } from "./public-source-budget";
import { durablePublicSourceCircuitEnabled, runPublicSourceAttempt, type PublicSourceAttempt } from "./public-source-circuit";
import { noModelModeEnabled } from "./provider-policy";

const PROVIDER = "openalex-research";
interface Pool { rows: OpenAlexMetadata[]; incomplete: boolean }

export function openAlexMetadataFallbackEnabled(): boolean {
  return noModelModeEnabled() && /^(1|true|yes)$/i.test(process.env.ALPHA_OPENALEX_METADATA_FALLBACK?.trim() ?? "") &&
    durablePublicSourceBudgetEnabled() && durablePublicSourceCircuitEnabled();
}

export function createOpenAlexMetadataSearch(deps: {
  fetcher?: typeof fetch;
  now?: () => number;
  reserve?: typeof reservePublicSourceRequest;
  attempt?: PublicSourceAttempt;
  timeoutMs?: number;
} = {}) {
  const fetcher = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const reserve = deps.reserve ?? reservePublicSourceRequest;
  const attempt = deps.attempt ?? runPublicSourceAttempt;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  // Cache only a bounded validated metadata pool, never selected reader work.
  // Incomplete status survives a cache hit. Raw projection/abstracts stay out.
  const cached = createPublicSourceCache<Pool>(now, pools => pools[0]?.rows.length ? 300_000 : 60_000);
  return async (topicId: string, opts: BraveSearchOptions = {}, excludedLinks?: ReadonlySet<string>): Promise<BraveResult[]> => {
    const at = now();
    const lane = openAlexTopicLane(topicId);
    if (!lane || !openAlexMetadataFallbackEnabled()) return [];
    const bounds = openAlexCompletedDayBounds(at);
    const window = publicSourceWindow(opts.freshness, at);
    if (!bounds || !window) return [];
    // An uncertain publication day cannot be squeezed into a partial day.
    const latestStart = Date.parse(`${bounds.end}T00:00:00Z`);
    const earliestAllowed = Math.ceil(window.start / 86_400_000) * 86_400_000;
    if (earliestAllowed > latestStart || earliestAllowed + 86_400_000 - 1 > window.end) return [];
    const endpoint = openAlexQueryUrl(lane, at);
    if (!endpoint) return [];
    const pools = await cached(PROVIDER, `${lane}|${bounds.start}|${bounds.end}`, () => attempt(PROVIDER,
      () => reserve(PROVIDER), async () => {
        const controller = new AbortController();
        let expired = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            controller.abort();
            reject(new Error("OpenAlex metadata request timed out"));
          }, timeoutMs);
        });
        const request = async (): Promise<Pool[]> => {
          const response = await fetcher(endpoint, { signal: controller.signal, redirect: "error", credentials: "omit",
            cache: "no-store", headers: { Accept: "application/json" } });
          if (expired || response.status !== 200 ||
              response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
            void response.body?.cancel().catch(() => {});
            throw new Error("OpenAlex metadata unavailable or invalid content type");
          }
          const raw: unknown = JSON.parse(await readPublicSourceText(response, controller.signal));
          const rows = parseOpenAlexMetadata(raw);
          if (!rows) throw new Error("OpenAlex metadata envelope or projection is invalid");
          const nativeRows = (raw as { results: unknown[] }).results;
          const count = (raw as { meta: { count: number } }).meta.count;
          if (nativeRows.length && !rows.length) throw new Error("OpenAlex metadata contains no valid scalar rows");
          return [{ rows, incomplete: rows.length !== nativeRows.length || nativeRows.length < Math.min(count, 20) }];
        };
        try { return await Promise.race([request(), deadline]); }
        finally { if (timer !== undefined) clearTimeout(timer); }
      }));
    const pool = pools[0];
    if (!pool) return [];
    if (pool.incomplete) opts.onIncompleteResults?.();
    return selectOpenAlexMetadata(pool.rows, topicId, { now: at, freshness: opts.freshness, excludedLinks })
      .flatMap((record): BraveResult[] => {
        const attribution = validatedOpenAlexMetadata(record);
        return attribution ? [{ title: record.title, url: record.url, age: record.publicationDay,
          description: "", attribution }] : [];
      });
  };
}

export const openAlexMetadataSearch = createOpenAlexMetadataSearch();
