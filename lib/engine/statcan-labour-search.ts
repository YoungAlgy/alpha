import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { parseStatCanLabourPool, selectStatCanLabourMetadata, validatedStatCanLabourMetadata, type StatCanLabourMetadata } from "./statcan-labour-metadata";
import { createPublicSourceCache } from "./public-source-cache";
import { publicSourceWindow } from "./public-source-freshness";
import { readPublicSourceText } from "./public-source-response";
import { durablePublicSourceBudgetEnabled, reservePublicSourceRequest } from "./public-source-budget";
import { durablePublicSourceCircuitEnabled, runPublicSourceAttempt, type PublicSourceAttempt } from "./public-source-circuit";
import { noModelModeEnabled } from "./provider-policy";

const PROVIDER = "statcan-labour";
// One fixed institutional Atom feed. No reader, profile, topic or contact data.
export const STATCAN_LABOUR_ENDPOINT = "https://www150.statcan.gc.ca/n1/rss/dai-quo/14-eng.atom";

export function statCanLabourFallbackEnabled(): boolean {
  return noModelModeEnabled() &&
    /^(1|true|yes)$/i.test(process.env.ALPHA_STATCAN_LABOUR_FALLBACK?.trim() ?? "") &&
    durablePublicSourceBudgetEnabled() && durablePublicSourceCircuitEnabled();
}

export function createStatCanLabourSearch(deps: {
  fetcher?: typeof fetch;
  now?: () => number;
  reserve?: typeof reservePublicSourceRequest;
  attempt?: PublicSourceAttempt;
} = {}) {
  const fetcher = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const reserve = deps.reserve ?? reservePublicSourceRequest;
  const attempt = deps.attempt ?? runPublicSourceAttempt;
  // All valid scalar records share the five-minute cache. No selected window or
  // reader exclusion enters it. Every read rebuilds its own credit object.
  const cached = createPublicSourceCache<StatCanLabourMetadata>(now);
  return async (topicId: string, opts: BraveSearchOptions = {}, excludedLinks?: ReadonlySet<string>): Promise<BraveResult[]> => {
    if (topicId !== "macro-markets" || !statCanLabourFallbackEnabled() ||
        !publicSourceWindow(opts.freshness, now())) return [];
    const rows = await cached(PROVIDER, "fixed-labour-atom-v1", () => attempt(PROVIDER,
      () => reserve(PROVIDER), async () => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("StatCan labour metadata request timed out"));
          }, 5000);
        });
        const request = async () => {
          const response = await fetcher(STATCAN_LABOUR_ENDPOINT, {
            signal: controller.signal, redirect: "error", credentials: "omit",
            cache: "no-store", headers: { Accept: "application/atom+xml" },
          });
          if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/atom+xml") {
            void response.body?.cancel().catch(() => {});
            throw new Error("StatCan labour metadata unavailable or invalid content type");
          }
          return parseStatCanLabourPool(await readPublicSourceText(response, controller.signal));
        };
        try { return await Promise.race([request(), deadline]); }
        finally { if (timer !== undefined) clearTimeout(timer); }
      }));
    return selectStatCanLabourMetadata(rows, topicId, { now: now(), freshness: opts.freshness, excludedLinks })
      .flatMap((record): BraveResult[] => {
        const attribution = validatedStatCanLabourMetadata(record);
        return attribution ? [{ title: record.title, url: record.url, age: record.updatedInstant,
          description: "", attribution }] : [];
      });
  };
}

export const statCanLabourSearch = createStatCanLabourSearch();
