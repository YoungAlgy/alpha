// Verifies the You.com search fallback for real:
//   1. youSearch itself returns real, well-shaped results from the real API.
//   2. fetchLiveSignal's pipeline (shared with Brave) produces a real,
//      guard-passing TopicSignal when driven through youSearch — ranking,
//      per-host cap, paywall/junk filtering, and the citable-URL allow-set
//      all apply identically to the You.com path.
//   3. excludeUrls actually excludes on a second call (the cross-send repeat
//      guard must hold for this provider too).
// Run: npx tsx scripts/verify-you-fallback.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const { youSearch, youConfigured } = await import("../lib/you-search.ts");

// --- 1) Raw client -----------------------------------------------------------
console.log("(1) youSearch raw client");
check("(1) youConfigured() is true (YOU_API_KEY set)", youConfigured());

const raw = await youSearch("AI agent news this week", { count: 5, freshness: "pw" });
check("(1) returns at least one result", raw.length > 0);
check(
  "(1) every result has a real http(s) url",
  raw.every((r) => /^https?:\/\//.test(r.url))
);
check(
  "(1) every result has a non-empty title",
  raw.every((r) => r.title && r.title.length > 0)
);

// --- 2) fetchLiveSignal driven through You.com (source-resolver's shared pipeline) ---
console.log("(2) You.com through the shared ranking/dedup/deep-read pipeline");
// fetchLiveSignal isn't exported — exercise it via the module's internals by
// re-implementing the one-line call the resolver makes, using the SAME
// exported pieces (rankAndDedup, youSearch) so this proves the real
// integration contract (BraveResult-shaped output feeding rankAndDedup)
// rather than a reimplementation.
const { rankAndDedup } = await import("../lib/engine/source-rank.ts");
const queries = ["AI agent news", "AI agent news latest", "AI coding tools this week"];
const perQuery = await Promise.all(queries.map((q) => youSearch(q, { count: 10, freshness: "pw" })));
const ranked = rankAndDedup(perQuery.flat(), 2);
check("(2) ranking pipeline accepts You.com results and returns a shortlist", ranked.length > 0);
check(
  "(2) no denied-tier host survives ranking",
  ranked.every((r) => r.tier !== "denied")
);

// --- 3) excludeUrls actually excludes You.com results, same as Brave's path --
console.log("(3) excludeUrls actually excludes on a second call");
const { normalizeUrl } = await import("../lib/engine/url-guard.ts");
const excludeAll = new Set(
  ranked.map((r) => normalizeUrl(r.url)).filter((n): n is string => n !== null)
);
check("(3) built a non-empty exclude-set from pass (2)'s results", excludeAll.size > 0);
const rankedAgain = rankAndDedup(perQuery.flat(), 2, excludeAll);
const overlap = rankedAgain.some((r) => {
  const n = normalizeUrl(r.url);
  return n !== null && excludeAll.has(n);
});
check("(3) no previously-seen You.com url re-survives with excludeUrls set", !overlap);

// --- 3b) The REAL freshness format production sends, not just "pw" ----------
// Every check above uses freshness:"pw". But the actual cron never sends
// that — sinceLastSendWindow() (lib/cadence.ts) always returns a
// "YYYY-MM-DDtoYYYY-MM-DD" range, the ONLY freshness value production's
// primary path ever passes to a search provider. toYouFreshness's comment in
// lib/you-search.ts claims that range format passes through unchanged and
// works identically on You.com's API — that claim was never actually
// exercised anywhere in this repo (2026-07-29 review finding). Test it for
// real, the same "force it, don't assume" discipline used for Brave's 402
// shape and the end-to-end wiring test below.
console.log("(3b) real production freshness format: a YYYY-MM-DDtoYYYY-MM-DD range");
const { sinceLastSendWindow } = await import("../lib/cadence.ts");
const realRange = sinceLastSendWindow("2026-07-29");
check("(3b) sinceLastSendWindow actually produces a \"to\"-range", /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/.test(realRange));
const rangeResults = await youSearch("AI agent news", { count: 5, freshness: realRange });
check(`(3b) youSearch with a real range (${realRange}) returns results`, rangeResults.length > 0);
check(
  "(3b) range-mode results still have real http(s) urls",
  rangeResults.every((r) => /^https?:\/\//.test(r.url))
);

// --- 4) End-to-end: resolveTopicSignal's REAL trigger wiring ----------------
// Pass (1)-(3) prove youSearch + rankAndDedup work — they do NOT prove
// resolveTopicSignal actually routes to You.com only when Brave is
// rate-limited. Force Brave's EXACT real failure mode deterministically
// (a genuine 429 shape, at the network boundary) rather than relying on
// today's real quota state — mirrors the existing "force a real failure"
// pattern already used in verify-gemini-fallback.mts (an invalid Anthropic
// key to force a real 401). Gemini is deliberately disabled too (env key
// removed) so a returned signal can ONLY have come from the You.com branch,
// isolating this as a real proof of the wiring, not a lucky double-outage.
console.log("(4) resolveTopicSignal end-to-end: Brave forced 429, Gemini disabled");
delete process.env.GEMINI_API_KEY;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("api.search.brave.com")) {
    return new Response(JSON.stringify({ status: 429, code: "RATE_LIMITED" }), { status: 429 });
  }
  return realFetch(input, init);
}) as typeof fetch;

try {
  const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
  const { geminiConfigured } = await import("../lib/engine/gemini-client.ts");
  check("(4) Gemini reports unconfigured (env key removed)", !geminiConfigured());

  const signal = await resolveTopicSignal("ai-news" as never, "2026-07-04", { liveOnly: true });
  // With Brave forced to a real 429 on every query and Gemini structurally
  // unconfigured, a non-empty signal can ONLY have been produced by the
  // You.com branch — this isolation is what makes the assertion below
  // meaningful, not a string match against context (which omits the provider
  // label entirely on the "deep-read succeeded" branch — see the header
  // ternary in fetchLiveSignal — so checking for "You.com" text there would
  // be a false negative on exactly the runs where deep-read worked best).
  check("(4) a signal still came back despite Brave forced down + Gemini off", !!signal);
  check("(4) signal has real citable URLs", (signal?.citableUrls?.size ?? 0) > 0);
  // "Gemini" alone is too weak a marker for an ai-news topic — real articles
  // legitimately discuss Google's Gemini model, which produced a false
  // positive here on the first run. vertexaisearch.cloud.google.com is the
  // grounding-redirect proxy host gemini-search.ts resolves citations through
  // (see resolveRedirect) — a real news article has no reason to ever contain
  // that string, so it's a precise, topic-independent marker that the Gemini
  // fallback path (already structurally disabled via geminiConfigured() in
  // 4a) did not somehow still run.
  check(
    "(4) no Gemini-grounding-proxy artifact in context (proves it wasn't a stale Gemini result)",
    !signal?.context.includes("vertexaisearch")
  );
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("YOU-FALLBACK VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL YOU-FALLBACK ASSERTIONS PASS");
