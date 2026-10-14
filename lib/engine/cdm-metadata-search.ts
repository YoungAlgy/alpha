import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { cdmTopicSupported, parseCdmMetadataPool, selectCdmMetadata, type CdmFeedRecord } from "./cdm-metadata";
import { createPublicSourceCache } from "./public-source-cache";
import { publicSourceWindow } from "./public-source-freshness";
import { readPublicSourceText } from "./public-source-response";
import { durablePublicSourceBudgetEnabled, reservePublicSourceRequest } from "./public-source-budget";
import { durablePublicSourceCircuitEnabled, runPublicSourceAttempt, type PublicSourceAttempt } from "./public-source-circuit";
import { noModelModeEnabled } from "./provider-policy";

const PROVIDER = "cdm-music";
export const CDM_METADATA_ENDPOINT = "https://cdm.link/feed/";
export function cdmMetadataFallbackEnabled(): boolean {
  return noModelModeEnabled() && /^(1|true|yes)$/i.test(process.env.ALPHA_CDM_METADATA_FALLBACK?.trim() ?? "") &&
    durablePublicSourceBudgetEnabled() && durablePublicSourceCircuitEnabled();
}
export function createCdmMetadataSearch(deps: {
  fetcher?: typeof fetch; now?: () => number;
  reserve?: typeof reservePublicSourceRequest; attempt?: PublicSourceAttempt;
} = {}) {
  const fetcher = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const reserve = deps.reserve ?? reservePublicSourceRequest;
  const attempt = deps.attempt ?? runPublicSourceAttempt;
  // Cache completeness too. A later reader who excludes the valid partial pool
  // must not turn the same rejected rows into a healthy-empty source verdict.
  const cached = createPublicSourceCache<{ rows: CdmFeedRecord[]; incomplete: boolean }>(now,
    snapshots => snapshots[0]?.rows.length ? 5 * 60_000 : 60_000);
  return async (topicId: string, opts: BraveSearchOptions = {}, excludedLinks?: ReadonlySet<string>): Promise<BraveResult[]> => {
    if (!cdmTopicSupported(topicId) || !cdmMetadataFallbackEnabled() || !publicSourceWindow(opts.freshness, now())) return [];
    const snapshots = await cached(PROVIDER, "fixed-editorial-metadata-v1", () => attempt(PROVIDER,
      () => reserve(PROVIDER), async () => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("CDM metadata request timed out")); }, 5000);
        });
        const request = async () => {
          const response = await fetcher(CDM_METADATA_ENDPOINT, { signal: controller.signal, redirect: "error",
            credentials: "omit", cache: "no-store", headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
          const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
          if (response.status !== 200 || !["application/rss+xml", "application/xml", "text/xml"].includes(mime ?? "")) {
            void response.body?.cancel().catch(() => {});
            throw new Error("CDM metadata unavailable or invalid content type");
          }
          let incomplete = false;
          const rows = parseCdmMetadataPool(await readPublicSourceText(response, controller.signal), () => { incomplete = true; });
          if (incomplete && !rows.length) throw new Error("CDM metadata response has no validated records");
          return [{ rows, incomplete }];
        };
        try { return await Promise.race([request(), deadline]); }
        finally { if (timer !== undefined) clearTimeout(timer); }
      }));
    const snapshot = snapshots[0]!;
    if (snapshot.incomplete) { try { opts.onIncompleteResults?.(); } catch { /* Preserve valid partial work. */ } }
    return selectCdmMetadata(snapshot.rows, topicId, { now: now(), freshness: opts.freshness, excludedLinks })
      .map(record => ({ title: record.title, url: record.url, description: "", age: record.publishedAt, attribution: record }));
  };
}
export const cdmMetadataSearch = createCdmMetadataSearch();
