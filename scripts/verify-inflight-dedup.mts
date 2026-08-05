// Verifies the in-flight de-dup cache added to assemble.ts's genLive (2026-07-29
// review fix): two concurrent generateIssue() calls sharing ONE inFlight Map,
// for the SAME topic, must only perform the underlying search+generation ONCE,
// not twice — this is what actually prevents the cron's fast-fallback layer
// from doubling Brave/You.com/Anthropic spend on a topic the timed-out live
// attempt is still working on in the background.
//
// Method: count REAL network calls (global.fetch) during a single baseline
// generateIssue() call, then compare against two CONCURRENT generateIssue()
// calls (same topic, same weekOf, SHARED inFlight/dryCache) — if de-dup works,
// the shared-run's fetch count should track the single-call baseline, not
// double it. Uses RANDOM synthetic weekOf values each run (not hardcoded —
// caught a real test bug: a hardcoded date meant the SECOND time this script
// ran, the baseline call hit its own leftover topic_blurbs row from the FIRST
// run and short-circuited before ever reaching search, reporting a false
// "0 fetches" pass/fail). Cleans up its own rows afterward so the real
// topic_blurbs table doesn't accumulate test clutter.
// Run: npx tsx scripts/verify-inflight-dedup.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const { generateIssue } = await import("../lib/engine/assemble.ts");
const { supabaseServiceClient } = await import("../lib/supabase/server.ts");

// Random, virtually collision-proof past dates — never the same twice, so
// re-running this script can never accidentally hit its own prior run's
// cached topic_blurbs row (see the bug this caught, in the header comment).
function randomPastIso(): string {
  const year = 1900 + Math.floor(Math.random() * 100);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
const baselineWeekOf = randomPastIso();
const sharedWeekOf = randomPastIso();
// Assigned inside the try block (section 3) but declared here so the
// finally's cleanup can reference it even if section 3 never runs.
let rangeWeekOf = "";

const baseProfile = {
  firstName: "Dedup",
  city: "Testville",
  topics: ["ai-news"] as never,
  jobBlurb: undefined,
  projectBlurb: undefined,
  funBlurb: undefined,
  gender: undefined,
  birthday: undefined,
  theme: "forest" as never,
  email: "dedup-test@example.com",
};

// Count ONLY calls to search-provider endpoints (Brave, You.com, Gemini) —
// the thing resolveTopicSignal's dedup is actually about. Deliberately
// excludes Supabase (DB reads/writes) and generic Anthropic traffic: the
// editor's note makes its OWN separate, never-deduped Anthropic call every
// generateIssue() invocation regardless of topic dedup, and Supabase reads
// legitimately happen once per call — counting those would bury the real
// signal (search-call dedup) under noise that has nothing to do with this fix.
const SEARCH_HOST_RE = /api\.search\.brave\.com|ydc-index\.io|generativelanguage\.googleapis\.com/;
let searchFetchCount = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (SEARCH_HOST_RE.test(url)) searchFetchCount++;
  return realFetch(input, init);
}) as typeof fetch;

try {
  // --- Baseline: ONE generateIssue() call, fresh weekOf, fresh caches --------
  console.log(`(1) baseline: single generateIssue() call, cost of ONE real generation (weekOf=${baselineWeekOf})`);
  searchFetchCount = 0;
  await generateIssue(baseProfile as never, baselineWeekOf, 1, "pw", new Set(), new Map());
  const baselineCount = searchFetchCount;
  check("(1) baseline made at least one real search-provider call", baselineCount > 0);
  console.log(`  (info) baseline search-provider fetch count: ${baselineCount}`);

  // --- Shared: TWO CONCURRENT generateIssue() calls, SAME topic/weekOf, ------
  // SAME shared inFlight + dryCache — the exact shape of the cron's live
  // attempt + fast-fallback layer racing on the same subscriber's topics.
  console.log(`(2) two CONCURRENT generateIssue() calls sharing one inFlight map (weekOf=${sharedWeekOf})`);
  searchFetchCount = 0;
  const sharedDryCache = new Set<string>();
  const sharedInFlight = new Map();
  const [issueA, issueB] = await Promise.all([
    generateIssue(baseProfile as never, sharedWeekOf, 1, "pw", sharedDryCache, sharedInFlight),
    generateIssue(baseProfile as never, sharedWeekOf, 1, "pw", sharedDryCache, sharedInFlight),
  ]);
  const sharedCount = searchFetchCount;
  console.log(`  (info) shared-run search-provider fetch count: ${sharedCount} (baseline was ${baselineCount})`);

  check("(2) both concurrent calls returned a real issue", !!issueA && !!issueB);
  check(
    "(2) both issues cover the same topic",
    issueA.sections[0]?.topicId === "ai-news" && issueB.sections[0]?.topicId === "ai-news"
  );
  // The real assertion: de-dup means the SECOND call's search was reused, not
  // repeated — so two concurrent calls for the SAME topic should cost the
  // SAME number of search-provider calls as one call, not double it. Small
  // margin (+2) absorbs a legitimate non-dedup edge (e.g. the wide-freshness
  // retry firing for one call and not the other due to timing) without
  // masking an actual doubling.
  check(
    `(2) shared-run search cost tracks ONE generation, not two (${sharedCount} <= ${baselineCount + 2})`,
    sharedCount <= baselineCount + 2
  );
  check(
    "(2) shared-run search cost is NOT roughly double the baseline (the exact bug this fixes)",
    sharedCount < baselineCount * 1.8
  );

  // --- 3) Dedup must also hold for the REAL production freshness format ----
  // Every check above used freshness="pw". But production never sends that —
  // the cron always computes freshness via sinceLastSendWindow() (lib/cadence.ts),
  // which is ALWAYS a "YYYY-MM-DDtoYYYY-MM-DD" range, never "pw" — and genLive's
  // IIFE has a SECOND resolveTopicSignal call specifically for non-"pw" values
  // (the wide-freshness retry, assemble.ts lines ~181-183), which only fires
  // when the narrow window comes up dry. Round-2 review found this exact test
  // only ever exercised "pw", so the wide-retry branch's dedup was never
  // verified — a future regression there (e.g. a key mismatch between the
  // narrow and wide attempts) could pass this file forever.
  // MUST stay inside this try block — an earlier version moved section (3)
  // outside, AFTER the finally below had already restored the real
  // (unwrapped) fetch, so its own fetch-counting silently measured nothing.
  // MUST use the SAME weekOf for baseline and shared-concurrent — an earlier
  // version used two DIFFERENT random dates and got a false failure (15 vs 8
  // fetches): whether the wide-retry fires at all depends on whether the
  // narrow window happens to find signal, which varies per date independent
  // of any dedup bug, so comparing costs across two different dates isn't a
  // valid comparison. Using one date for both, with the baseline's DB-cache
  // row deleted before the shared run, isolates the ONLY thing that should
  // differ: how many concurrent callers there were.
  console.log(`(3) dedup with the REAL range-format freshness production actually sends`);
  const { sinceLastSendWindow } = await import("../lib/cadence.ts");
  rangeWeekOf = randomPastIso();
  const rangeFreshness = sinceLastSendWindow(rangeWeekOf);
  check(
    `(3) sinceLastSendWindow actually produces a "to"-range (${rangeFreshness})`,
    /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/.test(rangeFreshness)
  );

  searchFetchCount = 0;
  await generateIssue(baseProfile as never, rangeWeekOf, 1, rangeFreshness, new Set(), new Map());
  const rangeBaselineCount = searchFetchCount;
  check("(3) range-format baseline made at least one real search-provider call", rangeBaselineCount > 0);

  // Remove the baseline's own topic_blurbs row before the shared-concurrent
  // run for the SAME (topic, weekOf) — otherwise the shared run would just
  // hit a DB cache HIT immediately (0 fetches either way), which would prove
  // nothing about dedup at all, in either direction.
  const sbMid = await supabaseServiceClient();
  await sbMid.from("topic_blurbs").delete().eq("topic_id", "ai-news").eq("week_of", rangeWeekOf);

  searchFetchCount = 0;
  const rangeSharedDryCache = new Set<string>();
  const rangeSharedInFlight = new Map();
  const [rangeIssueA, rangeIssueB] = await Promise.all([
    generateIssue(baseProfile as never, rangeWeekOf, 1, rangeFreshness, rangeSharedDryCache, rangeSharedInFlight),
    generateIssue(baseProfile as never, rangeWeekOf, 1, rangeFreshness, rangeSharedDryCache, rangeSharedInFlight),
  ]);
  const rangeSharedCount = searchFetchCount;
  console.log(
    `  (info) range-format (same date ${rangeWeekOf} both times): baseline=${rangeBaselineCount}, shared-concurrent=${rangeSharedCount}`
  );
  check("(3) both range-format concurrent calls returned a real issue", !!rangeIssueA && !!rangeIssueB);
  check(
    `(3) range-format shared-run cost tracks ONE generation, not two (${rangeSharedCount} <= ${rangeBaselineCount + 2})`,
    rangeSharedCount <= rangeBaselineCount + 2
  );
  check(
    "(3) range-format shared-run cost is NOT roughly double the baseline",
    rangeSharedCount < rangeBaselineCount * 1.8
  );
} finally {
  globalThis.fetch = realFetch;
  // Best-effort cleanup — don't leave test rows in the real topic_blurbs
  // table. Never throws past this point; a failed cleanup doesn't fail the
  // test (the rows are harmless clutter keyed to random 1900s-1999s dates no
  // real cron run will ever query).
  try {
    const sb = await supabaseServiceClient();
    await sb
      .from("topic_blurbs")
      .delete()
      .eq("topic_id", "ai-news")
      .in("week_of", [baselineWeekOf, sharedWeekOf, rangeWeekOf].filter(Boolean));
  } catch (e) {
    console.warn(`  (cleanup) failed to remove test rows: ${e instanceof Error ? e.message : e}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("INFLIGHT-DEDUP VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL INFLIGHT-DEDUP ASSERTIONS PASS");
