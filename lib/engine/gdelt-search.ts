import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { parsePublicFeedXml } from "./public-feed-search";
import { readPublicSourceText } from "./public-source-response";
import { reservePublicSourceRequest } from "./public-source-budget";
import { runPublicSourceAttempt, type PublicSourceAttempt } from "./public-source-circuit";
import { isPublicSourceControlError, PublicSourceControlError } from "./public-source-error-policy";

// The public DOC API is a best-effort source after Google News RSS. It has no
// account key, but still needs a small request budget and an outage cooldown.
const ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const MAX_RESULTS = 10;
const CACHE_SIZE = 64;
const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_SPACING_MS = 5_000;
const MAX_QUEUE_WAIT_MS = 15_000;
const MAX_PENDING_REQUESTS = 4;
const FAILURE_COOLDOWN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

type Clock = () => number;
type Sleep = (ms: number) => Promise<void>;

export function gdeltFallbackEnabled(): boolean {
  const raw = process.env.ALPHA_GDELT_FALLBACK?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// The caller supplies a topic phrase, never a GDELT expression. Quoting a
// stripped phrase prevents custom topics from adding API search operators.
function safePhrase(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

function utcDay(raw: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const timestamp = Date.parse(`${raw}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === raw
    ? timestamp
    : null;
}

function freshnessWindow(
  freshness: BraveSearchOptions["freshness"],
  now: number
): { start: number; end: number } | null {
  if (!Number.isFinite(now)) return null;
  if (!freshness || freshness === "pw") return { start: now - 7 * 86_400_000, end: now };
  if (freshness === "pd") return { start: now - 86_400_000, end: now };
  if (freshness === "pm") return { start: now - 30 * 86_400_000, end: now };
  // A year-wide public query would be too broad for a last-resort news tier.
  if (freshness === "py") return null;
  const range = freshness.match(/^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/);
  if (!range) return null;
  const start = utcDay(range[1]);
  const endDay = utcDay(range[2]);
  if (start === null || endDay === null || endDay < start) return null;
  const oldestAllowed = now - 30 * 86_400_000;
  const today = new Date(now).toISOString().slice(0, 10);
  if (start < oldestAllowed || range[2] > today) return null;
  // Brave's date range includes its last UTC calendar day. Keep the same
  // meaning while refusing windows wider than this public source budget.
  const end = Math.min(now, endDay + 86_400_000 - 1);
  if (end < start || end - start > 30 * 86_400_000) return null;
  return { start, end };
}

function gdeltDate(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function usableArticleUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.port && host.includes(".") && host !== "localhost" &&
      !host.endsWith(".local") && !/^\d+(?:\.\d+){3}$/.test(host) &&
      !host.includes(":");
  } catch {
    return false;
  }
}

export interface GdeltSearchDependencies {
  fetcher?: typeof fetch;
  now?: Clock;
  sleep?: Sleep;
  reserve?: typeof reservePublicSourceRequest;
  attempt?: PublicSourceAttempt;
}

/** A process-local client; export the factory so every network edge is testable offline. */
export function createGdeltSearch(deps: GdeltSearchDependencies = {}) {
  const fetcher: typeof fetch = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const reserve = deps.reserve ?? reservePublicSourceRequest;
  const attempt = deps.attempt ?? runPublicSourceAttempt;
  const cache = new Map<string, { expiresAt: number; results: BraveResult[] }>();
  const inFlight = new Map<string, Promise<BraveResult[]>>();
  let nextRequestAt = 0;
  let cooldownUntil = 0;

  return async function search(query: string, opts: BraveSearchOptions = {}): Promise<BraveResult[]> {
    const phrase = safePhrase(query);
    const window = freshnessWindow(opts.freshness, now());
    if (!phrase || !window) return [];
    const key = `${phrase.toLowerCase()}|${opts.freshness ?? "pw"}`;
    const stillFresh = (results: BraveResult[]): BraveResult[] => results
      .filter((result) => {
        const published = result.age ? Date.parse(result.age) : NaN;
        return Number.isFinite(published) && published >= window.start &&
          published <= window.end && published <= now();
      })
      .map((result) => ({ ...result }));
    const cached = cache.get(key);
    if (cached) {
      if (cached.expiresAt > now()) {
        cache.delete(key);
        cache.set(key, cached);
        return stillFresh(cached.results);
      }
      cache.delete(key);
    }
    const pending = inFlight.get(key);
    if (pending) return stillFresh(await pending);
    if (now() < cooldownUntil) throw new PublicSourceControlError("GDELT public search is cooling down");
    if (inFlight.size >= MAX_PENDING_REQUESTS) throw new PublicSourceControlError("GDELT public search queue is full");

    const work = (async (): Promise<BraveResult[]> => {
      const queuedAt = now();
      const checkWaiting = () => {
        if (now() - queuedAt >= MAX_QUEUE_WAIT_MS) throw new PublicSourceControlError("GDELT public search queue timed out");
        if (now() < cooldownUntil) throw new PublicSourceControlError("GDELT public search is cooling down");
      };

      const params = new URLSearchParams({
        query: `"${phrase}" sourcelang:english`,
        mode: "artlist",
        format: "rss",
        maxrecords: String(MAX_RESULTS),
        startdatetime: gdeltDate(window.start),
        enddatetime: gdeltDate(window.end),
      });
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await attempt("gdelt", async () => {
          // Admission and budget latency count toward the queue deadline.
          checkWaiting();
          await reserve("gdelt");
        }, async () => {
          // Keep the final claim and fetch invocation in the same synchronous
          // turn. A delayed reserve-to-work callback must recheck all guards.
          while (true) {
            checkWaiting();
            const delay = nextRequestAt - now();
            if (delay <= 0) break;
            await sleep(Math.min(delay, MAX_QUEUE_WAIT_MS - (now() - queuedAt)));
          }
        timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        nextRequestAt = now() + REQUEST_SPACING_MS;
        const response = await fetcher(`${ENDPOINT}?${params}`, {
          headers: { Accept: "application/rss+xml, application/xml, text/xml" },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new Error(`GDELT public search ${response.status}`);
        }
        const xml = await readPublicSourceText(response, controller.signal);
        if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml) || !/<\/rss\s*>/i.test(xml)) {
          throw new Error("GDELT public search returned invalid RSS");
        }
        const results = parsePublicFeedXml(xml)
          .filter((result) => {
            const published = result.age ? Date.parse(result.age) : NaN;
            return usableArticleUrl(result.url) && Number.isFinite(published) &&
              published >= window.start && published <= window.end && published <= now();
          })
          .map((result) => ({ ...result, description: "" }));
        cache.set(key, { expiresAt: now() + CACHE_TTL_MS, results });
        while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
        return results;
        });
      } catch (error) {
        if (!isPublicSourceControlError(error)) {
          cooldownUntil = Math.max(cooldownUntil, now() + FAILURE_COOLDOWN_MS);
        }
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    inFlight.set(key, work);
    try {
      return stillFresh(await work);
    } finally {
      if (inFlight.get(key) === work) inFlight.delete(key);
    }
  };
}

export const gdeltSearch = createGdeltSearch();
