import { braveConfigured, braveSearch, type BraveResult, type BraveSearchOptions } from "@/lib/brave";
import { youConfigured, youSearch } from "@/lib/you-search";
import { rankAndDedup } from "./source-rank";
import { fetchArticleText, deepReadEnabled } from "./fetch-content";
import { TOPIC_QUERIES, zodiacQueries } from "./topic-queries";
import { getSignal } from "./mock-signals";
import { normalizeUrl } from "./url-guard";
import { geminiConfigured } from "./gemini-client";
import { resolveTopicSignalViaGemini } from "./gemini-search";
import { isCustomTopic, customTopicText, isZodiacTopicId } from "@/lib/topics";
import { cleanField } from "./text-clean";
import type { TopicId, FixedTopicId } from "@/lib/types";
import type { TopicSignal } from "./types";

// How many top sources we fetch in FULL per topic (the deep read), how many
// more we include as headline+link breadth, and how many raw candidates we pull
// per query before ranking down. Deep reads run in parallel and are best-effort.
const DEEP_READ_N = 5;
const MORE_HEADLINES_N = 6;
const PER_QUERY_COUNT = 10;

// cleanField (title/description sanitizer) now lives in ./text-clean, shared
// with gemini-search.ts. The citable allow-set is built from the resolver's
// chosen SOURCE urls only (see fetchLiveSignal's citableUrls below); cleanField
// stripping URLs from title/description fields too means a smuggled link never
// even reaches the model as prose it might copy into a body.

// Resolves a TopicSignal for (topicId, weekOf). Tries Brave Search first
// when configured, falls back to hand-written mock signals otherwise.
// Cache-friendly: blurbs persist to topic_blurbs so every subscriber to a
// topic (including identical custom text) shares the generation cost.

// Shared try/warn/fall-through shape for the two SECONDARY fallback tiers
// (Gemini, You.com) below — both are "attempt, return on success, log and
// fall through on any failure," differing only in the call and the label.
// Brave itself stays inline in resolveTopicSignal: it also needs to set
// rateLimitedThisTopic as a side effect, which doesn't fit this shape cleanly.
async function tryFallback(
  topicId: string,
  label: string,
  fn: () => Promise<TopicSignal | undefined>
): Promise<TopicSignal | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[source-resolver] ${label} failed for ${topicId}:`, e);
    return undefined;
  }
}

// A custom ("your own thing") topic has no catalog query set — derive a few
// from the user's free text. freshness:"pw" at the call site handles recency.
function customQueries(topicId: string): string[] {
  const t = customTopicText(topicId);
  if (!t) return [];
  return [t, `${t} news`, `${t} latest`];
}

export async function resolveTopicSignal(
  topicId: TopicId,
  weekOf: string,
  opts?: {
    liveOnly?: boolean;
    freshness?: BraveSearchOptions["freshness"];
    /** normalizeUrl-keyed URLs already cited in this topic's recent letters —
     *  excluded from candidates so a letter never re-covers an article the
     *  reader was already sent (the cross-send repeat guard). */
    excludeUrls?: Set<string>;
  }
): Promise<TopicSignal | undefined> {
  const custom = isCustomTopic(topicId);
  // A per-sign zodiac id ("zodiac-leo") builds its search from the sign, not the
  // catalog query table. Custom topics use the reader's free text. Everything
  // else is a catalog topic.
  const queries = custom
    ? customQueries(topicId)
    : isZodiacTopicId(topicId)
      ? zodiacQueries(topicId)
      : TOPIC_QUERIES[topicId as FixedTopicId];

  if (braveConfigured() && queries && queries.length > 0) {
    // Track whether THIS topic's OWN queries got rate-limited, via a
    // per-call callback (lib/brave.ts's onRateLimited) rather than the
    // module-level braveRateLimitedCount(). Multiple topics run concurrently
    // in a generation wave (assemble.ts batches several via Promise.all), so
    // a shared counter's before/after delta can't tell "MY queries 429'd"
    // apart from "a DIFFERENT topic's queries 429'd while mine were running"
    // — that would misroute a genuinely quiet topic (Brave fine, nothing new)
    // into the Gemini fallback instead of the existing backup-topic behavior.
    let rateLimitedThisTopic = false;
    try {
      const live = await fetchLiveSignal(
        topicId,
        queries,
        weekOf,
        opts?.freshness,
        opts?.excludeUrls,
        () => { rateLimitedThisTopic = true; }
      );
      if (live) return live;
    } catch (e) {
      console.warn(`[source-resolver] Brave failed for ${topicId}:`, e);
      // fall through to mock (fixed topics only)
    }
    // Gemini's grounded search and You.com are both genuinely separate
    // providers from Brave — worth trying ONLY when Brave's OWN quota is the
    // actual problem. A topic that came back dry because Brave is fine but
    // there is truly nothing new should still fall through to a fresher
    // backup topic (the existing dry-topic behavior in select-sections.ts),
    // not get force-filled here.
    if (rateLimitedThisTopic) {
      if (geminiConfigured()) {
        console.warn(`[source-resolver] Brave rate-limited for ${topicId}, trying Gemini grounded search`);
        const grounded = await tryFallback(topicId, "Gemini grounded search", () =>
          resolveTopicSignalViaGemini(topicId, weekOf, queries.join("; "), opts?.excludeUrls)
        );
        if (grounded) return grounded;
      }
      // You.com is tried LAST, after Gemini — Gemini's grounded search is a
      // richer signal (a synthesized answer, not just headlines) when it
      // works. But Gemini's free tier has been observed persistently
      // exhausted in real production (2026-07-29 incident), so without this
      // a Brave+Gemini double-outage leaves a topic with nothing at all —
      // exactly what happened that day. You.com shares Brave's per-query
      // result shape, so it reuses the SAME ranking/dedup pipeline — with
      // deep-read OFF (see fetchLiveSignal's deepRead param): this branch
      // only fires as the 3rd-tier last resort, and in the cron it's most
      // often reached from inside the fast-fallback layer racing a tight
      // deadline, so snippet-only headlines (same as the "MORE THIS WEEK"
      // breadth list elsewhere) trade a bit of prose depth for guaranteed speed.
      if (youConfigured()) {
        console.warn(`[source-resolver] Brave rate-limited for ${topicId}, trying You.com search`);
        const viaYou = await tryFallback(topicId, "You.com search", () =>
          fetchLiveSignal(
            topicId,
            queries,
            weekOf,
            opts?.freshness,
            opts?.excludeUrls,
            undefined,
            youSearch,
            "You.com Search",
            false
          )
        );
        if (viaYou) return viaYou;
      }
    }
  }
  // liveOnly: caller wants to know if this topic has FRESH signal this period
  // (the ranked-pool selector skips topics with nothing new and backfills from
  // a backup that does). Return undefined when there's no live signal.
  if (opts?.liveOnly) return undefined;
  // Custom topics have no curated mock — if Brave gave nothing, return
  // undefined so assemble drops just this section (the letter still ships).
  if (custom) return undefined;
  return getSignal(topicId, weekOf) || getSignal(topicId);
}

// Last-resort filler for a topic with no fresh live signal (catalog topics
// only — customs have no mock). Used to keep a letter full when the whole
// ranked pool was quiet that period.
export function resolveMockSignal(topicId: TopicId, weekOf: string): TopicSignal | undefined {
  if (isCustomTopic(topicId)) return undefined;
  return getSignal(topicId, weekOf) || getSignal(topicId);
}

async function fetchLiveSignal(
  topicId: string,
  queries: string[],
  weekOf: string,
  // Recency window. Defaults to past-week (the single weekly letter). The
  // multi-send cadence passes a "since the last letter" date range so a topic
  // with nothing NEW in the last few days comes back empty and the ranked-pool
  // selector backfills it from a fresher topic instead of repeating stale news.
  freshness: BraveSearchOptions["freshness"] = "pw",
  excludeUrls?: Set<string>,
  // Fires once per 429 among THIS topic's own queries — see the caller's
  // comment on rateLimitedThisTopic in resolveTopicSignal.
  onRateLimited?: () => void,
  // Pluggable search provider — defaults to Brave. Passing youSearch here
  // reuses this entire ranking/dedup/deep-read pipeline for the You.com
  // fallback tier instead of duplicating it (both return the same BraveResult
  // shape: real discrete per-result URLs, unlike Gemini's synthesized answer).
  search: (q: string, opts: BraveSearchOptions) => Promise<BraveResult[]> = braveSearch,
  providerLabel = "Brave Search",
  // Full-text deep-read (below) adds a real multi-second tax (up to
  // DEEP_READ_N parallel article fetches, each individually bounded but
  // still additive latency before this call can return). Fine for the
  // primary Brave path, which has no tight caller-side deadline racing it —
  // but You.com only ever runs as the 3rd-tier LAST RESORT (see
  // resolveTopicSignal), specifically inside the cron's fast-fallback layer
  // racing FAST_FALLBACK_DEADLINE_MS. That tier already has snippet-only
  // headlines working fine elsewhere in this same function (the "MORE THIS
  // WEEK" breadth list) — trading prose depth for guaranteed speed is the
  // right call for a tier whose whole reason to exist is racing a deadline.
  deepRead = true
): Promise<TopicSignal | undefined> {
  if (!queries || queries.length === 0) return undefined;

  // 1. Cast a wide net — every query in parallel, more candidates than we'll
  //    use, so the ranker has something to choose from. Brave/You.com both
  //    allow bursts.
  const perQuery = await Promise.all(
    queries.map(async (q) => {
      try {
        return await search(q, { count: PER_QUERY_COUNT, freshness, onRateLimited });
      } catch (e) {
        console.warn(
          `[source-resolver] ${providerLabel} query failed (${topicId}): "${q}": ${e instanceof Error ? e.message : e}`
        );
        return [];
      }
    })
  );

  // 2. Dedup + diversity-rank into a shortlist, dropping anything this topic
  //    already cited recently (the cross-send repeat guard — Brave's freshness
  //    window alone re-surfaces the same article across sends when a page's
  //    date metadata is off) BEFORE the per-host cap is applied — rankAndDedup
  //    takes excludeUrls directly so an already-cited article can't consume a
  //    host's cap slot and starve out a legitimate new one from the same host.
  //    Compare on the SAME normalizeUrl identity the citable allow-set uses so
  //    a match can't be dodged by a fragment.
  const ranked = rankAndDedup(perQuery.flat(), 2, excludeUrls);
  if (ranked.length === 0) {
    console.warn(`[source-resolver] live signal for ${topicId} had 0 results — falling back to mock`);
    return undefined;
  }
  // Deep-read TRUSTED sources only — reading an unknown/neutral domain risks
  // amplifying junk (a confident write-up of an unreliable page is the worst
  // failure mode for a "get ahead of the curve" letter). Neutral sources still
  // appear as citable headlines below and the model writes about them from
  // snippets, which is safe. If no trusted source is fresh this period, the
  // section degrades to snippet-only — the old, safe behavior.
  const deep = ranked.filter((s) => s.tier === "trusted").slice(0, DEEP_READ_N);
  const deepUrls = new Set(deep.map((s) => s.url));
  const more = ranked.filter((s) => !deepUrls.has(s.url)).slice(0, MORE_HEADLINES_N);

  // 3. Read the top trusted sources IN FULL (parallel, best-effort). A failed /
  //    timed-out / non-article fetch falls back to that source's snippet, so the
  //    letter is written from real article text where possible and never blocks.
  const contents = deepReadEnabled() && deepRead
    ? await Promise.all(deep.map((s) => fetchArticleText(s.url).catch(() => null)))
    : deep.map(() => null);
  const readCount = contents.filter(Boolean).length;

  // 4. Build the signal: full-text trusted sources + a breadth list of headlines.
  //    CITABLE URLs are built EXPLICITLY from the resolver's chosen SOURCE urls
  //    (citableUrls below) — NOT by regex-scanning the context, because a third
  //    party controls a source's title/description and could otherwise smuggle a
  //    URL into the citable set. Defense in depth: fetched bodies have every URL
  //    stripped (fetch-content.sanitizeContent), and title/description run through
  //    cleanField (tags + URLs removed), so the ONLY urls in the context are the
  //    curated SOURCE / —url tokens anyway.
  const deepBlocks = deep.map((s, i) => {
    const host = s.host || s.meta_url?.hostname || "";
    const age = s.age ? ` · ${s.age}` : "";
    const body = contents[i] || `(full text unavailable — snippet: ${cleanField(s.description)})`;
    return `[${i + 1}] ${cleanField(s.title)}\n    ${host}${age}\n    SOURCE: ${s.url}\n\n${body}`;
  });
  const moreBlocks = more.map((s) => {
    const host = s.host || s.meta_url?.hostname || "";
    const age = s.age ? `, ${s.age}` : "";
    return `- ${cleanField(s.title)} (${host}${age}) — ${s.url}\n  ${cleanField(s.description)}`;
  });

  const subject = isCustomTopic(topicId) ? customTopicText(topicId) : topicId;
  const parts: string[] = [];
  if (deepBlocks.length > 0) {
    parts.push(
      `=== TOP SOURCES (full text — read these and surface the real insight) ===\n\n${deepBlocks.join("\n\n----------\n\n")}`
    );
  }
  parts.push(
    `=== ${deepBlocks.length > 0 ? "MORE THIS WEEK" : "THIS WEEK"} (headlines + links) ===\n\n${moreBlocks.join("\n\n") || "(none)"}`
  );
  const header =
    deep.length > 0
      ? `Recent signal for ${subject} (as of ${weekOf}), gathered live and READ IN FULL where possible (${readCount}/${deep.length} trusted sources fetched). You have the ACTUAL article text for the top sources below — read it and surface the real insight, do not just paraphrase a headline.`
      : `Recent signal for ${subject} (as of ${weekOf}), gathered live from ${providerLabel}. Headlines and snippets only this period.`;
  const context = `${header}\n\n${parts.join("\n\n")}\n\nAll URLs labeled SOURCE or listed above are real and citable. Do NOT invent URLs.`;

  // The citable allow-set = the resolver's chosen SOURCE urls ONLY (deep + more),
  // each normalized DIRECTLY via the url-guard's normalizeUrl. Built from the
  // explicit url fields, NEVER by scanning text: regex-scanning would truncate a
  // path containing ')' (URL_RE stops there), silently dropping a real link like
  // Pitchfork /albums/x-(super-deluxe)/. Keying each url the same way isAllowedUrl
  // does guarantees a legit source link always matches, while an attacker-
  // controlled title/description URL still can't enter the set.
  const citableUrls = new Set(
    [...deep, ...more]
      .map((s) => normalizeUrl(s.url))
      .filter((n): n is string => n !== null)
  );

  // No real URLs this period → "no live signal" so the caller falls back to the
  // curated mock (which always has real URLs). Without this the strict URL guard
  // would drop every link and ship a link-less section.
  if (citableUrls.size === 0) {
    console.warn(`[source-resolver] live signal for ${topicId} had 0 URLs — falling back to mock`);
    return undefined;
  }

  return { topicId: topicId as TopicId, weekOf, context, citableUrls };
}
