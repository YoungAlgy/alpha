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
}

export async function selectLetterSections<T>(
  pool: string[],
  letterSize: number,
  genLive: (topicId: string) => Promise<T | null>,
  genFiller: (topicId: string) => Promise<T | null>
): Promise<SelectionResult<T>> {
  const size = Math.max(1, Math.floor(letterSize));
  const chosen: ChosenSection<T>[] = [];
  const live = (id: string) => genLive(id).catch(() => null);
  const filler = (id: string) => genFiller(id).catch(() => null);

  // Pass 1 — walk the pool in rank order, in parallel waves sized to what's
  // still needed, keeping topics that produced FRESH content. Common case
  // (top topics are all fresh) = a single wave of `size`, no backups touched.
  let cursor = 0;
  while (chosen.length < size && cursor < pool.length) {
    const needed = size - chosen.length;
    const start = cursor;
    const batch = pool.slice(start, start + needed);
    cursor += batch.length;
    const results = await Promise.all(batch.map(live));
    batch.forEach((topicId, k) => {
      const value = results[k];
      if (value != null && chosen.length < size) {
        chosen.push({ topicId, rank: start + k, value, source: "live" });
      }
    });
  }

  const skippedDry = pool.filter((id) => !chosen.some((c) => c.topicId === id));

  // Pass 2 — last resort. The pool's live signal didn't fill the letter (a
  // quiet period). Fill remaining slots with filler for the top dry topics so
  // the reader still gets a full letter.
  const usedFiller: string[] = [];
  if (chosen.length < size) {
    for (let rank = 0; rank < pool.length && chosen.length < size; rank++) {
      const topicId = pool[rank];
      if (chosen.some((c) => c.topicId === topicId)) continue;
      const value = await filler(topicId);
      if (value != null) {
        chosen.push({ topicId, rank, value, source: "filler" });
        usedFiller.push(topicId);
      }
    }
  }

  chosen.sort((a, b) => a.rank - b.rank);
  return {
    chosen,
    skippedDry: skippedDry.filter((id) => !usedFiller.includes(id)),
    usedFiller,
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
