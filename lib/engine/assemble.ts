import { generateTopicBlurb } from "./topic-blurb";
import { generateEditorNote } from "./editor-note";
import { resolveTopicSignal, resolveMockSignal } from "./source-resolver";
import { getCachedBlurbs, getRecentlyCitedUrls, setCachedBlurb } from "./blurb-cache";
import { normalizeUrl } from "./url-guard";
import { selectLetterSections } from "./select-sections";
import { topicLabel, mapTopicsForUser, GENERIC_FALLBACK_TOPICS } from "@/lib/topics";
import { withDeadline } from "@/lib/with-deadline";
import type { Issue, UserProfile, TopicId } from "@/lib/types";
import type { TopicBlurb } from "./types";

// Per-topic deadline covering the WHOLE search+generate path (both
// resolveTopicSignal attempts, including its own possible Gemini
// grounded-search fallback, plus generateTopicBlurb, including ITS possible
// Gemini text fallback). The model call is bounded per-attempt (60s) but the
// SDK retry + topic-blurb's parse-retry can stack a single blurb past 2
// minutes, and a Brave rate-limit can add a further ~20s Gemini round trip on
// top. This caps ONE topic so a pathologically slow one is treated as "quiet"
// and BACKFILLED from a fresher backup, rather than dominating the parallel
// wave and forcing the outer route/cron deadline to drop the WHOLE letter.
// The reject lands in selectLetterSections' per-topic .catch → null.
const TOPIC_GEN_DEADLINE_MS = 75_000;

/** The reader's own ranked pool (mains + their picked backups), plus a short
 *  ordered tail of GENERIC_FALLBACK_TOPICS not already in it. Pass 1 in
 *  selectLetterSections only reaches into the tail when the reader's own
 *  topics don't already fill the letter, so a normal day (the overwhelming
 *  common case) costs nothing extra — this only fires the day someone's
 *  actual picks all come up dry, so every reader still gets a full,
 *  freshly-generated letter instead of a stub, and the stand-in section reads
 *  as broadly relevant rather than a narrow topic nobody but them chose.
 *  Exported standalone (no Claude/Brave) so it's unit-testable in isolation. */
export function buildGenerationPool(readerPool: TopicId[]): TopicId[] {
  const extra = GENERIC_FALLBACK_TOPICS.filter((id) => !readerPool.includes(id));
  return [...readerPool, ...extra];
}

export async function generateIssue(
  user: UserProfile,
  weekOf: string,
  // How many sections the reader's letter holds (what they pay for). Their
  // `topics` is the ranked POOL — we fill the letter with the top topics that
  // have fresh info and use backups for any that are quiet. Defaults to the
  // whole pool (every caller that doesn't rank a deeper pool gets today's
  // behavior: every topic generated, in order).
  letterSize?: number,
  // Recency window for the live search. Defaults to past-week (the single
  // weekly letter). The multi-send cadence passes a "since the last letter"
  // date range so a topic with no NEW info reads as empty and gets backfilled
  // from a fresher one instead of repeating the same news across sends.
  freshness?: import("@/lib/brave").BraveSearchOptions["freshness"],
  // Topics that came back DRY this invocation, keyed (topic, period, window).
  // CALLER-OWNED, not module state: the cron creates ONE Set and passes it to
  // every subscriber's generateIssue call in its loop, so a dry topic re-spends
  // its 3 Brave queries (x2 with the wide retry) only ONCE per shared batch,
  // not once per subscriber — the multiplier that pushes daily-cadence search
  // volume past the free tier. Positive results don't need this (the blurb
  // cache already dedupes them); only dryness was uncached.
  //
  // Passing nothing (the onboarding /api/generate path, one subscriber per
  // call) defaults to a fresh Set scoped to just this call. A PRIOR module-
  // level Set here leaked a dry verdict from one subscriber's onboarding call
  // into a LATER, unrelated subscriber's onboarding call on the same warm
  // serverless instance — a stale/wrong "no news" skip with no connection to
  // that reader's actual search.
  dryCache: Set<string> = new Set<string>(),
): Promise<Issue> {
  // Map the pickable "zodiac" topic to the reader's per-sign id, dropping it when
  // there's no birthday (see mapTopicsForUser). If the WHOLE pool maps to empty
  // (only reachable via a raw DB write — the product gates zodiac on a birthday,
  // and the cron skip-checks the effective pool), fail fast with a clear reason
  // instead of the generic "all sections failed" downstream.
  const pool = mapTopicsForUser(user.topics, user.birthday);
  if (pool.length === 0) {
    throw new Error("No usable topics after mapping (e.g. zodiac with no birthday)");
  }
  // NOTE: size is driven by the reader's OWN pool length (or their paid
  // letterSize), never the fallback-extended genPool below — the fallback
  // tail exists to fill slots the reader's own topics leave empty, not to
  // grow the letter itself.
  const size = Math.max(1, letterSize ?? pool.length);

  // The pool actually searched/generated against: the reader's pool plus a
  // generic fallback tail (see buildGenerationPool) so a dry day never leaves
  // a slot empty or falls back to a topic nobody but them picked.
  const genPool = buildGenerationPool(pool);

  // ONE round trip each for the whole pool's cache reads and its recently-
  // cited URLs, instead of one per topic inside genLive's per-wave calls below.
  // The cited-URL lookback (14 days) feeds the resolver's exclusion set: a
  // letter never re-covers an article this topic already cited — the fix for
  // a subscriber seeing the same articles across letters, and what makes the
  // wider-window retry below safe (older-but-uncovered is still new to HER).
  // Covers genPool (not just the reader's own topics) so a fallback topic's
  // cache/exclusion set is warm too, in case another subscriber already
  // triggered it today.
  const CITED_LOOKBACK_DAYS = 14;
  const sinceIso = new Date(
    Date.parse(`${weekOf}T12:00:00Z`) - CITED_LOOKBACK_DAYS * 86400000
  ).toISOString().slice(0, 10);
  const [cachedBlurbs, citedRaw] = await Promise.all([
    getCachedBlurbs(genPool as TopicId[], weekOf),
    getRecentlyCitedUrls(genPool as TopicId[], sinceIso, weekOf),
  ]);
  // Normalize once to the url-guard identity the resolver compares against.
  const citedByTopic = new Map<string, Set<string>>();
  for (const [tid, urls] of citedRaw) {
    const set = new Set<string>();
    for (const u of urls) {
      const n = normalizeUrl(u);
      if (n) set.add(n);
    }
    if (set.size > 0) citedByTopic.set(tid, set);
  }

  // Generate a topic's section from FRESH live signal. Returns null WITHOUT a
  // model call when the topic has nothing new this period, so the selector can
  // skip it and reach for a backup. A cache hit = already generated this
  // period = include it. The per-(topic, week_of) cache is the cost unlock:
  // one generation per topic-week, shared across every subscriber to it.
  async function genLive(topicId: string): Promise<TopicBlurb | null> {
    const id = topicId as TopicId;
    const cached = cachedBlurbs.get(id) ?? null;
    // Treat a cached blurb with no items as a miss. A section whose links all
    // got guard-dropped when it was generated isn't worth a slot, so it must
    // never be served (to this reader or any later one) and the topic should
    // backfill instead.
    if (cached && cached.items.length > 0) return { ...cached, topicLabel: topicLabel(id) };
    const dryKey = `${id}|${weekOf}|${freshness ?? "pw"}`;
    if (dryCache.has(dryKey)) return null; // searched dry earlier this batch — no re-search

    // The WHOLE search+generate path is under one deadline, not just the model
    // call. resolveTopicSignal can itself fall to Gemini's grounded search when
    // Brave is rate-limited (source-resolver.ts) — that fallback has no deadline
    // of its own, so without wrapping it here a slow/hung Gemini call could
    // stack on top of a slow Claude call and blow well past what
    // TOPIC_GEN_DEADLINE_MS was meant to cap for this topic's contribution to
    // the parallel wave.
    return withDeadline(
      (async () => {
        const excludeUrls = citedByTopic.get(id);
        let signal = await resolveTopicSignal(id, weekOf, { liveOnly: true, freshness, excludeUrls });
        // Dry in the tight since-last-send window? Retry ONCE at past-week before
        // giving up the slot. With the exclusion set filtering out everything
        // already cited, whatever the wide pass finds is guaranteed new to the
        // reader — this keeps daily letters full of real articles instead of
        // sliding into the static filler (whose repeats a subscriber noticed).
        if (!signal && freshness && freshness !== "pw") {
          signal = await resolveTopicSignal(id, weekOf, { liveOnly: true, freshness: "pw", excludeUrls });
        }
        if (!signal) {
          dryCache.add(dryKey);
          return null; // no fresh signal — skip, no model call
        }
        const blurb = await generateTopicBlurb(id, weekOf, signal);
        // Only cache a real section. If the guard dropped every link (0 items),
        // don't cache the empty result — otherwise every later subscriber to this
        // topic would read the empty blurb back as a "hit" and ship a link-less
        // section. Return null so the selector backfills this topic instead.
        if (blurb.items.length === 0) return null;
        setCachedBlurb(blurb).catch(() => undefined);
        return blurb;
      })(),
      TOPIC_GEN_DEADLINE_MS,
      `topic-blurb ${id}`
    );
  }

  // Last-resort filler from the curated mock (catalog topics only) — keeps the
  // letter full when the whole ranked pool was quiet this period.
  //
  // NOTE: mock blurbs are intentionally NOT written to the shared cache. The
  // cache is the "live, fresh this period" store that genLive reads first; if a
  // mock blurb landed there, the NEXT subscriber's genLive would read it back
  // and treat evergreen filler as fresh signal (so that topic would never
  // backfill for anyone after the first dry user). Generating mock per-user is
  // cheap and rare (only fires when a reader's WHOLE pool is dry) and keeps
  // every reader's "thin topic -> fresher backup" behavior independent.
  async function genFiller(topicId: string): Promise<TopicBlurb | null> {
    const id = topicId as TopicId;
    // No cache read: genFiller only runs when genLive already returned null (no
    // live blurb cached this period), so a lookup here always misses. Mock
    // blurbs are deliberately never cached (see the note above), so generate it.
    const signal = resolveMockSignal(id, weekOf);
    if (!signal) return null;
    const blurb = await withDeadline(
      generateTopicBlurb(id, weekOf, signal),
      TOPIC_GEN_DEADLINE_MS,
      `topic-filler ${id}`
    );
    return blurb.items.length > 0 ? blurb : null;
  }

  // Pick the letter's sections from the ranked pool: top fresh topics first,
  // backups for the quiet ones, filler only as a last resort. Each generator
  // is individually error-trapped inside the selector, so one failed topic is
  // treated as "quiet" and backfilled rather than sinking the whole letter.
  const selection = await selectLetterSections(genPool, size, genLive, genFiller);
  const blurbs = selection.chosen.map((c) => c.value);
  if (selection.skippedDry.length > 0) {
    console.warn(
      `[assemble] ${weekOf}: skipped ${selection.skippedDry.length} quiet topic(s): ${selection.skippedDry.join(", ")}`
    );
  }
  if (blurbs.length === 0) {
    throw new Error("All topic sections failed to generate");
  }

  // Sections whose topicId isn't in the reader's OWN pool came from the
  // generic-fallback tail (buildGenerationPool) — a stand-in shown because
  // their real topics were quiet, not something they chose. The editor's note
  // needs this so it doesn't force a "this connects to your city/job" touch
  // onto a topic the reader never picked (see generateEditorNote's own
  // fallbackTopicIds param).
  const fallbackTopicIds = new Set(
    blurbs.filter((b) => !pool.includes(b.topicId as TopicId)).map((b) => b.topicId)
  );

  // Step 2 — personalized editor's note weaving the sections. If it fails,
  // fall back to a clean standalone intro rather than sinking the letter.
  let editorIntro: string;
  try {
    editorIntro = await generateEditorNote(user, blurbs, fallbackTopicIds);
  } catch (e) {
    console.warn(`[assemble] editor note failed, using fallback intro: ${e instanceof Error ? e.message : e}`);
    const labels = blurbs.map((b) => b.topicLabel.toLowerCase());
    const list =
      labels.length > 1
        ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
        : labels[0];
    editorIntro = `A few things worth your time today, across ${list}. Dig into whatever pulls at you and let the rest wait.`;
  }

  // Step 3 — assemble Issue
  const issue: Issue = {
    id: `${user.firstName.toLowerCase()}-${weekOf}`,
    volume: 1,
    number: 1,
    weekOf: formatWeekOf(weekOf),
    recipientFirstName: user.firstName,
    recipientCity: user.city,
    editorIntro,
    sections: blurbs.map((b) => ({
      topicId: b.topicId,
      topicLabel: b.topicLabel,
      intro: b.intro,
      items: b.items.map((it) => ({
        kind: it.kind,
        headline: it.headline,
        body: it.body,
        primaryRef: it.primaryRef,
        supplementaryRefs: it.supplementaryRefs,
      })),
    })),
  };

  return issue;
}

function formatWeekOf(iso: string): string {
  // 2026-05-17 → "Sunday, May 17, 2026"
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
