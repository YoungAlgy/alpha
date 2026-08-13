// Ranked-pool letter selection.
//
// A reader pays for a LETTER SIZE (sections per issue) and ranks a deeper POOL
// of topics. Each issue we fill the letter with their highest-ranked topics
// that have FRESH info this period, skip any that are quiet, and pull from the
// next-ranked backup so the letter is always full. As a last resort (the whole
// pool was quiet) we fill remaining slots with filler so the reader still gets
// a complete letter rather than a stub.
//
// This orchestration is the risky part, so it takes the two generators as
// arguments (live + filler) and is generic over the section type — it can be
// unit-tested with stubs, no Claude/Brave. Cost stays ≈ letterSize: dry topics
// return null from genLive WITHOUT generating a blurb (no model call), so each
// slot costs one generation whether it ends up live or filler.

export type SectionSource = "live" | "filler";

export interface ChosenSection<T> {
  topicId: string;
  rank: number; // index in the pool (0 = top)
  value: T;
  source: SectionSource;
}

export interface SelectionResult<T> {
  chosen: ChosenSection<T>[]; // in rank order
  skippedDry: string[]; // topics with no fresh info this period, not used
  usedFiller: string[]; // topics filled from the last-resort filler
  // alpha-drift-r17-11/12 (found+fixed 2026-08-07): topics whose Pass-1 live
  // candidate had real, fresh content but got rejected for citing a URL an
  // earlier-chosen section of this SAME letter already used -- distinct
  // from skippedDry (genuinely no fresh signal) so callers can log/report
  // them accurately instead of misreporting a real-content-but-deduped
  // topic as "quiet."
  dedupedByUrl: string[];
}

/** Every URL a candidate section cites (normalized), for the cross-topic
 *  dedup below — a candidate collides if ANY of its URLs was already used
 *  by an earlier-chosen section of this same letter (a topic-blurb can hold
 *  several items, so this isn't just "the one headline article"). Optional
 *  and generic-friendly: callers that pass nothing get today's behavior
 *  unchanged. */
export type UrlExtractor<T> = (value: T) => string[];

export async function selectLetterSections<T>(
  rawPool: string[],
  letterSize: number,
  genLive: (topicId: string) => Promise<T | null>,
  genFiller: (topicId: string) => Promise<T | null>,
  // alpha-drift-r16-12 (found+fixed 2026-08-07): getRecentlyCitedUrls (in
  // lib/engine/blurb-cache.ts, upstream of genLive) only excludes a TOPIC's
  // OWN citations from PRIOR periods -- nothing stopped two DIFFERENT
  // topics in the SAME letter from independently surfacing and citing the
  // identical article (concretely reachable: GENERIC_FALLBACK_TOPICS
  // co-locates personal-finance + macro-markets, and a shared Fed-rate/
  // jobs story is exactly the kind of piece both would plausibly cite the
  // same day). Fixing this at generation time would mean threading one
  // subscriber's own-letter context into the SHARED per-topic-week cache/
  // inFlight promise that every OTHER subscriber with that topic reuses
  // verbatim -- exactly the cost-sharing property this whole cache system
  // exists for, and this function would break it. Fixing it HERE instead
  // (selection time, per subscriber) leaves that shared generation/cache
  // model completely untouched: a URL-colliding candidate just isn't
  // CHOSEN for this one subscriber's letter, backfilling from the next-
  // ranked topic exactly like a dry (no-fresh-content) topic already does
  // -- the underlying blurb is still cached and still serves every other
  // subscriber whose own letter has no collision.
  extractUrls?: UrlExtractor<T>
): Promise<SelectionResult<T>> {
  const usedUrls = new Set<string>();
  const isUrlCollision = (value: T): boolean => {
    if (!extractUrls) return false;
    return extractUrls(value).some((u) => usedUrls.has(u));
  };
  const recordUrls = (value: T): void => {
    if (!extractUrls) return;
    for (const u of extractUrls(value)) usedUrls.add(u);
  };
  // alpha-drift-r16-11 (found+fixed 2026-08-07): defense-in-depth against a
  // duplicate topic id anywhere in the pool -- Pass 1 below had no dedup
  // check at all (Pass 2's `!chosen.some(...)` guard only protects itself,
  // and even that only checks against already-CHOSEN items, not other
  // entries gathered into the same candidates batch). A duplicate id could
  // otherwise occupy two section slots in one letter with the identical
  // cached blurb (genLive's inFlight map returns the SAME promise for a
  // repeated id). Deduping the pool up front, ranking-order preserved,
  // closes every path into this function at once -- the write-path
  // validation gap this round also fixed (app/api/generate/route.ts), plus
  // any already-affected user's historically-written duplicate, plus any
  // future write path that might reintroduce one.
  const pool = Array.from(new Set(rawPool));
  const size = Math.max(1, Math.floor(letterSize));
  const chosen: ChosenSection<T>[] = [];
  const live = (id: string) => genLive(id).catch(() => null);
  const filler = (id: string) => genFiller(id).catch(() => null);
  // Which pool ids Pass 1 actually generated against — distinct from "not
  // chosen." A pool longer than `size` (e.g. a generic-fallback tail appended
  // past the reader's own topics) often has entries the cursor never reaches
  // once earlier topics already filled the letter; those were never checked,
  // so they are not "quiet" and must not be reported as skippedDry.
  const attempted = new Set<string>();
  // alpha-drift-r17-11 (found+fixed 2026-08-07): a topic rejected here for a
  // URL collision was never added to `chosen`, so Pass 2's own dedup check
  // (`!chosen.some(...)`) didn't see it either -- Pass 2 would pick the
  // IDENTICAL topic id back up as a filler candidate and pay for a second
  // real generation call, contradicting this file's own "cost stays ≈
  // letterSize" invariant (one live call already happened AND got
  // discarded, purely for citing an already-used URL). Track these
  // separately so Pass 2 can exclude them too.
  const dedupedByUrl = new Set<string>();

  // Pass 1 — walk the pool in rank order, in parallel waves sized to what's
  // still needed, keeping topics that produced FRESH content. Common case
  // (top topics are all fresh) = a single wave of `size`, no backups touched.
  let cursor = 0;
  while (chosen.length < size && cursor < pool.length) {
    const needed = size - chosen.length;
    const start = cursor;
    const batch = pool.slice(start, start + needed);
    cursor += batch.length;
    batch.forEach((id) => attempted.add(id));
    const results = await Promise.all(batch.map(live));
    batch.forEach((topicId, k) => {
      const value = results[k];
      if (value == null || chosen.length >= size) return;
      if (isUrlCollision(value)) {
        dedupedByUrl.add(topicId);
        return;
      }
      chosen.push({ topicId, rank: start + k, value, source: "live" });
      recordUrls(value);
    });
  }

  const skippedDry = pool.filter(
    (id) => attempted.has(id) && !chosen.some((c) => c.topicId === id) && !dedupedByUrl.has(id)
  );

  // Pass 2 — last resort. The pool's live signal didn't fill the letter (a
  // quiet period). Fill remaining slots with filler for the top dry topics so
  // the reader still gets a full letter. PARALLEL waves like pass 1 — the old
  // sequential walk meant a fully-dry pool (an everyday event at daily
  // cadence's 1-day windows) could not fit even two 75s-deadline filler
  // generations inside the cron's 110s per-user budget, and the reader got NO
  // letter instead of a filler letter.
  const usedFiller: string[] = [];
  let fillCursor = 0;
  while (chosen.length < size && fillCursor < pool.length) {
    const candidates: Array<{ topicId: string; rank: number }> = [];
    while (candidates.length < size - chosen.length && fillCursor < pool.length) {
      const topicId = pool[fillCursor];
      if (!chosen.some((c) => c.topicId === topicId) && !dedupedByUrl.has(topicId)) {
        candidates.push({ topicId, rank: fillCursor });
      }
      fillCursor++;
    }
    if (candidates.length === 0) break;
    const results = await Promise.all(candidates.map((c) => filler(c.topicId)));
    candidates.forEach((c, k) => {
      const value = results[k];
      if (value != null && chosen.length < size && !isUrlCollision(value)) {
        chosen.push({ topicId: c.topicId, rank: c.rank, value, source: "filler" });
        usedFiller.push(c.topicId);
        recordUrls(value);
      }
    });
  }

  chosen.sort((a, b) => a.rank - b.rank);
  return {
    chosen,
    skippedDry: skippedDry.filter((id) => !usedFiller.includes(id)),
    usedFiller,
    dedupedByUrl: Array.from(dedupedByUrl),
  };
}

/** How many free backup topics a reader can rank below their favorites. Fixed,
 *  so buying a 5-topic bundle adds 5 favorites and keeps the same 5 backups
 *  (not double them). */
export const BACKUP_SLOTS = 5;

/** Hard ceiling on the topic pool — the max quota tier (5 bundles). Bounds
 *  generation cost and the size of a topics array written straight to the DB. */
export const CATALOG_MAX = 25;

/** The bounded topic pool: the letter size plus a fixed 5 backups, never more
 *  than the catalog max. Bounds generation cost + guards against a topics array
 *  written straight to the DB (the RLS trigger allows the column).
 *  e.g. quota 5 -> 10, quota 10 -> 15, quota 20 -> 25 (quota 25 caps at the
 *  catalog max, so the top tier carries no backups). */
export function poolCap(letterSize: number, catalogMax = CATALOG_MAX): number {
  const size = Math.max(1, Math.floor(letterSize));
  return Math.min(catalogMax, size + BACKUP_SLOTS);
}
