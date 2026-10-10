import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { validatedGovUkAttribution } from "@/lib/source-attribution";
import { parseGovUkNewsMetadata, selectGovUkNewsMetadata, type GovUkNewsMetadata } from "./govuk-news-metadata";
import { createPublicSourceCache } from "./public-source-cache";
import { publicSourceWindow } from "./public-source-freshness";
import { readPublicSourceText } from "./public-source-response";
import { durablePublicSourceBudgetEnabled, reservePublicSourceRequest } from "./public-source-budget";
import { durablePublicSourceCircuitEnabled, runPublicSourceAttempt, type PublicSourceAttempt } from "./public-source-circuit";
import { noModelModeEnabled } from "./provider-policy";

const PROVIDER = "govuk-news";
const TOPICS = new Set(["ai-news", "macro-markets", "real-estate"]);
// Exact fixed public metadata request. No topic, profile, reader or contact.
export const GOVUK_NEWS_ENDPOINT = "https://www.gov.uk/api/search.json?count=100&order=-public_timestamp&filter_format=news_story&filter_format=press_release&fields=title,link,public_timestamp,format";

export function govUkNewsFallbackEnabled(): boolean {
  return noModelModeEnabled() &&
    /^(1|true|yes)$/i.test(process.env.ALPHA_GOVUK_NEWS_FALLBACK?.trim() ?? "") &&
    durablePublicSourceBudgetEnabled() && durablePublicSourceCircuitEnabled();
}

export function createGovUkNewsSearch(deps: {
  fetcher?: typeof fetch;
  now?: () => number;
  reserve?: typeof reservePublicSourceRequest;
  attempt?: PublicSourceAttempt;
} = {}) {
  const fetcher = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const reserve = deps.reserve ?? reservePublicSourceRequest;
  const attempt = deps.attempt ?? runPublicSourceAttempt;
  // The raw pool has scalar fields only. Credit objects are rebuilt after each
  // read, so callers cannot mutate metadata shared by another topic or reader.
  const cached = createPublicSourceCache<GovUkNewsMetadata>(now);
  return async (topicId: string, opts: BraveSearchOptions = {}): Promise<BraveResult[]> => {
    if (!TOPICS.has(topicId) || !govUkNewsFallbackEnabled() ||
        !publicSourceWindow(opts.freshness, now())) return [];
    const rows = await cached(PROVIDER, "fixed-latest-news-v1", () => attempt(PROVIDER,
      () => reserve(PROVIDER), async () => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("GOV.UK metadata request timed out"));
          }, 5000);
        });
        const request = async () => {
          const response = await fetcher(GOVUK_NEWS_ENDPOINT, {
            signal: controller.signal, redirect: "error", credentials: "omit",
            cache: "no-store", headers: { Accept: "application/json" },
          });
          if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
            void response.body?.cancel().catch(() => {});
            throw new Error("GOV.UK metadata unavailable or invalid content type");
          }
          return parseGovUkNewsMetadata(JSON.parse(await readPublicSourceText(response, controller.signal)));
        };
        try { return await Promise.race([request(), deadline]); }
        finally { if (timer !== undefined) clearTimeout(timer); }
      }));
    return selectGovUkNewsMetadata(rows, topicId, { now: now(), freshness: opts.freshness })
      .flatMap((record): BraveResult[] => {
        const attribution = validatedGovUkAttribution(record.url, record);
        return attribution ? [{ title: record.title, url: record.url, age: record.publicTimestamp,
          description: "", attribution }] : [];
      });
  };
}

export const govUkNewsSearch = createGovUkNewsSearch();
