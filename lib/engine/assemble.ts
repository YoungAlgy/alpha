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
  // In-flight de-dup, keyed the SAME as dryCache (topic|weekOf|freshness).
  // CALLER-OWNED, same sharing model as dryCache — the cron passes ONE Map to
  // every generateIssue call in a run (including the fast-fallback backup
  // layer's own call for the SAME subscriber). Closes a real gap found in
  // review (2026-07-29): withDeadline never cancels the underlying work, so a
  // timed-out live attempt keeps searching/generating in the background —
  // without this, the fast-fallback layer's smaller topic slice (a guaranteed
  // prefix-overlap with the orphaned attempt's first wave) would start a
  // FULL SECOND search+generation chain for topics already in flight, paying
  // twice on the exact rate-limited accounts the fallback exists to relieve.
  // A later subscriber reaching the same still-in-flight topic gets the same
  // benefit (closes the related dryCache-staleness gap: a topic slow enough
  // to miss its own deadline previously forced every later subscriber in the
  // batch to redo the identical slow search until it happened to finish).
  // Each caller still races its OWN TOPIC_GEN_DEADLINE_MS against the shared
  // promise (below) rather than inheriting whichever caller started it, so a
  // fresh caller isn't bound by a stale deadline that's already elapsed.
  // ONE divergence from dryCache's sharing model, despite the "same" framing
  // above: dryCache is append-only for the whole run, but an inFlight entry
  // is deliberately evicted once its outcome is anything other than a
  // genuine reusable result (a rejection, or a resolved null that ISN'T a
  // real dry verdict — see genLive's cleanup below) so a later caller gets
  // its own independent attempt instead of inheriting one bad draw for the
  // rest of the run.
  inFlight: Map<string, Promise<TopicBlurb | null>> = new Map(),
  // Topics that HARD-FAILED (exhausted every generation tier, or the search
  // itself threw) this run, keyed the SAME as dryCache. CALLER-OWNED, same
  // sharing model — the cron passes ONE Set to every generateIssue call in
  // its loop (alpha-spend-cap-02, found in review 2026-08-06 — see
  // alpha_full_app_review_2026-08-05.md). Deliberately SEPARATE from
  // dryCache rather than folded into it: dryCache means "genuinely no fresh
  // news," failedCache means "the pipeline itself broke" — conflating them
  // would make a provider outage silently read as a quiet news day in logs.
  // Without this, a topic that fails all five tiers for one subscriber gets
  // retried from scratch — full waterfall, every paid tier included — by
  // that same subscriber's Pass-2 filler attempt, the cron's own Layer-1
  // fast-fallback retry, AND every later subscriber who shares that topic,
  // inverting the cost-sharing property the whole cache system exists for
  // during exactly the highest-cost failure mode (a systemic outage or
  // truncation bug). Scoped to this run only (same lifetime as dryCache/
  // inFlight, freshly created per cron invocation) so a real transient blip
  // isn't blacklisted into tomorrow's run.
  failedCache: Set<string> = new Set<string>(),
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
    if (failedCache.has(dryKey)) return null; // hard-failed earlier this batch — no re-pay

    // Reuse an already-running search+generate for this exact key instead of
    // starting a duplicate one (see inFlight's own comment on generateIssue's
    // signature). The stored promise is the RAW underlying work, NOT
    // deadline-wrapped — each caller (the one that started it, or a later
    // reuser) races its OWN fresh TOPIC_GEN_DEADLINE_MS against this SAME
    // shared promise below, so a late reuser isn't bound by a deadline that's
    // already mostly elapsed for whoever started the work.
    let raw = inFlight.get(dryKey);
    if (!raw) {
      // The WHOLE search+generate path is under one deadline, not just the
      // model call. resolveTopicSignal can itself fall to Gemini's grounded
      // search when Brave is rate-limited (source-resolver.ts) — that
      // fallback has no deadline of its own, so without bounding it here a
      // slow/hung Gemini call could stack on top of a slow Claude call and
      // blow well past what TOPIC_GEN_DEADLINE_MS was meant to cap for this
      // topic's contribution to the parallel wave.
      raw = (async () => {
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
        // Deliberately NOT dryCache.add(dryKey) here — unlike the true
        // "!signal" dry case a few lines up, this is a MODEL OUTPUT quality
        // miss, not "no news this period." A fresh generation attempt (a
        // different model sample, non-deterministic) could easily survive the
        // guards next time, so this must NOT be remembered as a settled
        // verdict for the rest of the run the way genuine dryness is — the
        // cleanup below relies on this NOT being in dryCache to tell the two
        // resolved-null cases apart.
        if (blurb.items.length === 0) return null;
        // AWAITED, not fire-and-forget: this write feeds getRecentlyCitedUrls'
        // cross-send repeat guard (a subscriber never seeing the same article
        // twice within 14 days). An unawaited write here can be silently
        // abandoned once the enclosing request finishes and the platform tears
        // the invocation down — verified live against production data: whole
        // days had ZERO topic_blurbs writes across every topic despite letters
        // generating and delivering fine that day, which is exactly what
        // dropped cache writes look like, and it broke the repeat guard for
        // real (a subscriber was shown the same 2-3 sources re-worded on
        // consecutive days because the exclusion set never saw what she was
        // actually sent). setCachedBlurb itself never throws — it catches its
        // own errors and warns — so this can't turn a real send into a
        // failure; it only makes sure the write gets a real chance to finish.
        await setCachedBlurb(blurb);
        return blurb;
      })();
      // Evict this attempt from inFlight on any outcome that ISN'T a genuine,
      // reusable verdict — otherwise ONE subscriber's bad draw permanently
      // poisons this topic for EVERY later subscriber this run, worse than
      // the pre-fix behavior where each subscriber got its own independent
      // shot. Two such outcomes, found in review (2026-07-29, round 2 — the
      // first shipped without the second, a real gap):
      //   1. REJECTED — generateTopicBlurb's last-resort Sonnet call has no
      //      catch of its own (a truncation, a rate-limit, or a failed retry
      //      all propagate), so this can genuinely throw.
      //   2. RESOLVED to null via the guard-dropped-to-zero-items branch
      //      above — a model-output quality miss, NOT the true "!signal" dry
      //      case a few lines up. It resolves (doesn't throw), so a bare
      //      .catch() alone would never see it; checked here by testing
      //      dryCache, since only the genuine dry case adds to it.
      // A REAL result (a blurb, or a genuinely dry null) is deliberately left
      // cached: harmless either way, since it's already separately recorded
      // (setCachedBlurb / dryCache.add), both checked earlier in this
      // function before inFlight is ever consulted — so re-finding it here
      // for a rare very-late reuser costs nothing and changes nothing.
      raw.then(
        (result) => {
          if (result === null && !dryCache.has(dryKey) && inFlight.get(dryKey) === raw) {
            inFlight.delete(dryKey);
          }
        },
        () => {
          // A genuine hard failure (resolveTopicSignal threw, or
          // generateTopicBlurb exhausted every tier — see failedCache's own
          // comment on generateIssue's signature). Recorded BEFORE the
          // inFlight eviction below so a caller already waiting on this same
          // promise, or one that arrives between these two lines, can't slip
          // through and start its own duplicate full-waterfall retry.
          failedCache.add(dryKey);
          if (inFlight.get(dryKey) === raw) inFlight.delete(dryKey);
        }
      );
      inFlight.set(dryKey, raw);
    }
    return withDeadline(raw, TOPIC_GEN_DEADLINE_MS, `topic-blurb ${id}`);
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
    //
    // EXCEPT failedCache: genFiller runs IMMEDIATELY after genLive returns
    // null for this exact topic — if that null was a genuine hard failure
    // (every generation tier exhausted, not just "no live signal"), the
    // underlying problem is almost always provider-level (an outage, a rate
    // limit, a systemic bug), not content-level — retrying the identical
    // generateTopicBlurb chain with mock signal instead of live signal is
    // very unlikely to succeed and pays the full waterfall again for nothing
    // (alpha-spend-cap-02 — this was one of the three named repeat-payers in
    // the original finding, see generateIssue's failedCache comment).
    const dryKey = `${id}|${weekOf}|${freshness ?? "pw"}`;
    if (failedCache.has(dryKey)) return null;
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
  //
  // KNOWN, NOT-YET-FIXED GAP (round 2 review, 2026-07-29): this call is NOT
  // deduped by inFlight — it's personalized per subscriber (can't be shared
  // the way a topic blurb is), so on a Layer-1 fast-fallback timeout, both the
  // orphaned live attempt (still running detached — withDeadline never
  // cancels it) and the fallback's own generateIssue() call each pay for
  // their own independent editor's-note Anthropic call. inFlight's dedup only
  // covers the search+topic-blurb portion of a timeout's cost, not this one.
  // Real fix needs cancellation threaded into the orphaned attempt (skip this
  // call once a fallback has taken over for that subscriber) — cross-cutting,
  // same complexity class as the AbortController work already deferred for
  // the search+blurb path; not rushing it in. Cost is bounded (one extra
  // Opus call, not a whole search+generation chain) and only recurs on an
  // actual timeout, not every send.
  // alpha-drift-r15-07 (found+fixed 2026-08-06): this call ran the SAME
  // Claude -> Gemini -> Groq -> DeepSeek escalation shape as topic-blurb.ts,
  // but with no withDeadline of its own, unlike every genLive/genFiller call
  // above -- its own worst case is comparable to or worse than one topic
  // blurb (no cancellation on withDeadline means a caller giving up doesn't
  // stop the underlying call: an orphaned generateEditorNote kept running
  // and consuming real Anthropic/DeepSeek spend, counted toward
  // topicBlurbPaidCallCount/deepseekCallCount, for a result that was
  // silently discarded once it eventually resolved). Reuses
  // TOPIC_GEN_DEADLINE_MS -- the existing catch below already has a clean
  // fallback intro, so a timeout here just takes that path instead of a
  // real failure, same as it always could.
  let editorIntro: string;
  try {
    editorIntro = await withDeadline(
      generateEditorNote(user, blurbs, fallbackTopicIds),
      TOPIC_GEN_DEADLINE_MS,
      "editor-note"
    );
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

export function formatWeekOf(iso: string): string {
  // 2026-05-17 → "Sunday, May 17, 2026"
  // Explicit Z anchor + timeZone:'UTC' -- alpha-drift-r14-04 (review
  // 2026-08-06): this was the one date helper in the codebase without a UTC
  // anchor, unlike lib/cadence.ts's own helpers and this exact file's
  // sibling shortWeek() in lib/email.ts. It only ever produced correct
  // output because every runtime that calls generateIssue() (GitHub
  // Actions' ubuntu-latest, Cloudflare Workers) happens to default to UTC --
  // an unenforced assumption, not a guarantee. Without the anchor, a
  // non-UTC TZ env (a CI image change, a misconfigured env var) would
  // silently shift this by a day for any generation happening near local
  // midnight in that runtime's timezone.
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
