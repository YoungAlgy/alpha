// Verifies a specific risk found in round-2 review of the inFlight de-dup fix
// (assemble.ts, 2026-07-29): generateTopicBlurb's last resort (trySonnet) has
// no catch of its own — a truncation, a rate-limit, or a failed retry all
// propagate uncaught. Without cleanup, that rejected promise would sit in
// inFlight for the REST OF THE CRON RUN, so every later subscriber reusing
// the same key would inherit the SAME failure instead of getting their own
// independent attempt — worse than the pre-fix behavior, where each
// subscriber's generateIssue call was fully independent. The fix: genLive
// attaches a .catch() that removes a rejected entry from inFlight.
//
// This is a SEPARATE script (not folded into verify-inflight-dedup.mts) for a
// concrete reason hit while writing it: anthropicClient() (lib/engine/client.ts)
// lazily constructs and CACHES its client on first call — setting
// ANTHROPIC_API_KEY to an invalid value AFTER any earlier real Anthropic call
// in the same process has ALREADY happened does nothing, since the cached
// client keeps its already-baked-in real key. The invalid key MUST be the
// first thing set, before any generateIssue() call in this process — folding
// this into verify-inflight-dedup.mts (which makes real Anthropic calls in
// its own earlier tests) silently defeated the "force it down" premise.
// Run: npx tsx scripts/verify-inflight-rejection-cleanup.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();
// MUST happen before the first import that could construct the Anthropic
// client — no generateIssue()/generateTopicBlurb() call has run yet in this
// process, so this is the one guaranteed chance to force it down for real.
process.env.ANTHROPIC_API_KEY = "sk-ant-invalid-key-to-force-401";
delete process.env.GEMINI_API_KEY;

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const { generateIssue } = await import("../lib/engine/assemble.ts");
const { supabaseServiceClient } = await import("../lib/supabase/server.ts");

function randomPastIso(): string {
  const year = 1900 + Math.floor(Math.random() * 100);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
const weekOf = randomPastIso();
const dryKey = `ai-news|${weekOf}|pw`;

const profile = {
  firstName: "Poison",
  city: "Testville",
  topics: ["ai-news"] as never,
  jobBlurb: undefined,
  projectBlurb: undefined,
  funBlurb: undefined,
  gender: undefined,
  birthday: undefined,
  theme: "forest" as never,
  email: "poison-test@example.com",
};

const dryCache = new Set<string>();
const inFlight = new Map();

try {
  // Brave is real-world $5/mo-capped this session (confirmed 402 throughout),
  // so this reliably escalates to You.com for REAL search signal — that's
  // what routes the failure INSIDE generateTopicBlurb (Anthropic forced down)
  // rather than an earlier "no signal" dry return, which is a different code
  // path and wouldn't exercise the cleanup this test is for. Letter still
  // assembles overall (backfills from a different topic), so this call
  // itself doesn't need to throw — the interesting state is what's left in
  // `inFlight` for the SPECIFIC dryKey afterward.
  await generateIssue(profile as never, weekOf, 1, "pw", dryCache, inFlight);
} catch (e) {
  console.warn(`  (info) generateIssue threw at the outer level (not fatal to this test): ${e instanceof Error ? e.message : e}`);
}

check(
  "the topic did NOT resolve to a cached dry result (this exercises the THROW path, not the no-signal path)",
  !dryCache.has(dryKey)
);
check("the failed attempt was removed from inFlight, not left cached", !inFlight.has(dryKey));

try {
  const sb = await supabaseServiceClient();
  await sb.from("topic_blurbs").delete().eq("topic_id", "ai-news").eq("week_of", weekOf);
} catch (e) {
  console.warn(`  (cleanup) failed to remove test row: ${e instanceof Error ? e.message : e}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("INFLIGHT-REJECTION-CLEANUP VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL INFLIGHT-REJECTION-CLEANUP ASSERTIONS PASS");
