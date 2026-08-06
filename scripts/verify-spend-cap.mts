// Verifies alpha-spend-cap-01/02 (alpha_full_app_review_2026-08-05.md, round 11
// follow-up) for real:
//   1. topicBlurbPaidCallCount/deepseekCallCount are real, monotonic counters
//      that increase on a genuine Haiku/Sonnet/DeepSeek call — the actual data
//      source weekly-send/route.ts's PAID_CALL_CEILING check reads.
//   2. failedCache genuinely stops a second full-waterfall retry: once a topic
//      hard-fails (every tier exhausted) once in a shared run, a later caller
//      sharing the same failedCache short-circuits BEFORE any provider call —
//      not just before the paid tiers, before Brave search too.
// Run: npx tsx scripts/verify-spend-cap.mts
//
// Same "force every tier invalid" technique as verify-deepseek-fallback.mts /
// verify-groq-fallback.mts (anthropicClient() caches its client at first
// construction, so this must happen before ANY real Anthropic call in this
// process — forced from the very top for that reason).
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();
process.env.ANTHROPIC_API_KEY = "sk-ant-invalid-key-to-force-401";
process.env.GEMINI_API_KEY = "NOT-A-REAL-KEY-forced-failure-test";
process.env.GROQ_API_KEY = "gsk_invalid00000000000000000000000000000000";
process.env.DEEPSEEK_API_KEY = "sk-invalid00000000000000000000000000000000";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const { generateIssue } = await import("../lib/engine/assemble.ts");
const { topicBlurbPaidCallCount } = await import("../lib/engine/topic-blurb.ts");
const { deepseekCallCount } = await import("../lib/engine/deepseek-client.ts");

const weekOf = "2026-06-20";
const profile = {
  firstName: "Test",
  city: "",
  topics: ["ai-news"] as never,
  theme: "forest" as never,
  email: undefined,
};

// --- 1) Every tier forced down: generateTopicBlurb must exhaust all five and
//        throw, and that throw must be reflected as real, counted paid calls
//        (Haiku + Sonnet, at minimum, both invalid-key failures) -----------
console.log("(1) every provider forced invalid — confirm real paid-call attempts are counted");
const before = topicBlurbPaidCallCount() + deepseekCallCount();
const dryCache1 = new Set<string>();
const inFlight1 = new Map();
const failedCache1 = new Set<string>();
const t0 = Date.now();
let firstThrew = false;
try {
  // Pool of 1 topic, letterSize 1 -> selectLetterSections has nothing to
  // backfill from, so a hard-failed sole topic surfaces as a thrown
  // "All topic sections failed to generate" from generateIssue itself
  // (assemble.ts's own check) rather than being silently absorbed.
  await generateIssue(profile, weekOf, 1, "pw", dryCache1, inFlight1, failedCache1);
} catch (e) {
  firstThrew = true;
  console.log(`  (info) generateIssue threw as expected: ${e instanceof Error ? e.message : e}`);
}
const firstElapsedMs = Date.now() - t0;
const afterFirst = topicBlurbPaidCallCount() + deepseekCallCount();
check("(1) generateIssue threw (every tier genuinely exhausted)", firstThrew);
check(
  `(1) real paid-tier calls were counted (before=${before}, after=${afterFirst})`,
  afterFirst > before
);
check(`(1) failedCache recorded the hard failure (dryKey present)`, failedCache1.has("ai-news|2026-06-20|pw"));

// --- 2) SAME failedCache/dryCache/inFlight reused for a second call: must
//        short-circuit before any provider call, not repeat the waterfall --
console.log("(2) second call, same shared caches — must skip straight to the fallback tail with zero new provider calls");
const t1 = Date.now();
let secondThrew = false;
try {
  await generateIssue(profile, weekOf, 1, "pw", dryCache1, inFlight1, failedCache1);
} catch {
  secondThrew = true;
}
const secondElapsedMs = Date.now() - t1;
const afterSecond = topicBlurbPaidCallCount() + deepseekCallCount();
check("(2) second call also fails fast (topic still has nothing to offer)", secondThrew);
check(
  `(2) ZERO new paid-tier calls on the second attempt (afterFirst=${afterFirst}, afterSecond=${afterSecond})`,
  afterSecond === afterFirst
);
// No I/O at all (a Set.has() check vs. a real Brave search + 5 failed
// provider round trips) — expect at least an order of magnitude faster, not
// just "a bit faster" (which could be noise/caching from elsewhere).
check(
  `(2) second call is dramatically faster (first=${firstElapsedMs}ms, second=${secondElapsedMs}ms) — proves NO network calls happened, not just fewer`,
  secondElapsedMs < firstElapsedMs / 5 && secondElapsedMs < 2000
);

// --- 3) A FRESH run (new Sets) must NOT inherit the previous run's verdict —
//        failedCache is scoped per-run, same lifetime as dryCache/inFlight ---
console.log("(3) fresh caches (simulating a new cron run) — must NOT remember yesterday's failure");
const dryCache2 = new Set<string>();
const inFlight2 = new Map();
const failedCache2 = new Set<string>();
const beforeThird = topicBlurbPaidCallCount() + deepseekCallCount();
try {
  await generateIssue(profile, weekOf, 1, "pw", dryCache2, inFlight2, failedCache2);
} catch {
  // expected — same forced-down providers
}
const afterThird = topicBlurbPaidCallCount() + deepseekCallCount();
check(
  `(3) fresh caches DO attempt real calls again (beforeThird=${beforeThird}, afterThird=${afterThird}) — not blacklisted forever`,
  afterThird > beforeThird
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("SPEND-CAP VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL SPEND-CAP ASSERTIONS PASS");
