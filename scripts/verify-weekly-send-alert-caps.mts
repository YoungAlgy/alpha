// Verify round 22 finding (alpha-drift-r22-01, 2026-08-14, MEDIUM):
// app/api/cron/weekly-send/route.ts joined several per-subscriber real-email
// lists (backupSharedSentEmails, backupFreshSentEmails, backupStaleSentEmails,
// skippedBlankSubscribers, deferred) completely unbounded into BOTH the
// CRON_SECRET-gated JSON response and the ops-alert email body -- fine on an
// ordinary day, but a genuinely bad run (a systemic outage failing most of
// the subscriber list) could dump thousands of real subscriber emails into
// one alert email and one API response. `failures` already had a
// `.slice(0, 25)` in the JSON summary, but the ops-alert email's own
// `failures.map(...).join("; ")` used the FULL, uncapped array -- two
// independent copies of "the same list, capped" that had already drifted
// apart, which is exactly the kind of sibling-drift bug this session keeps
// finding and fixing by sharing ONE definition instead of two.
//
// The fix computes ONE shared capped slice per list (EMAIL_LIST_CAP = 25)
// and feeds both the JSON summary and the alert email from those same
// slices, plus explicit *Total count fields so a reader never silently
// loses the true total behind a truncated list.
//
// This route needs a real cron secret, a real subscriber table, and drives
// real AI generation calls end-to-end -- not practical to invoke live just
// to prove a string-truncation helper works. Instead: reproduce capList/
// capListLine's exact logic (pure, deterministic, no side effects) and
// cross-check it against the real source so a future edit that changes the
// cap value, the truncation logic, or which fields use it can't drift
// silently.
// Run: npx tsx scripts/verify-weekly-send-alert-caps.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const EMAIL_LIST_CAP = 25;
const capList = (arr: string[]) => arr.slice(0, EMAIL_LIST_CAP);
const capListLine = (arr: string[]) =>
  capList(arr).join(", ") + (arr.length > EMAIL_LIST_CAP ? ` (+${arr.length - EMAIL_LIST_CAP} more)` : "");

console.log("(1) capListLine: pure logic sanity");
{
  check("(1a) under the cap: no truncation suffix", capListLine(["a@x.com", "b@x.com"]) === "a@x.com, b@x.com");
  check("(1b) exactly at the cap: no truncation suffix", capListLine(Array.from({ length: 25 }, (_, i) => `u${i}@x.com`)).endsWith("more)") === false);
  const over = Array.from({ length: 30 }, (_, i) => `u${i}@x.com`);
  const line = capListLine(over);
  check("(1c) over the cap: only 25 real emails appear before the suffix", line.split(", ").length === 25);
  check("(1d) over the cap: the suffix names the correct remainder count", line.endsWith("(+5 more)"));
  check("(1e) empty list produces an empty string, not a stray suffix", capListLine([]) === "");
}

const src = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");

console.log("(2) source: one shared EMAIL_LIST_CAP feeds both surfaces, not two independently hand-copied caps");
{
  check("(2a) EMAIL_LIST_CAP is defined once", (src.match(/const EMAIL_LIST_CAP = /g) ?? []).length === 1);
  check("(2b) capList is defined once, off EMAIL_LIST_CAP", /const capList = \(arr: string\[\]\) => arr\.slice\(0, EMAIL_LIST_CAP\);/.test(src));
  check("(2c) capListLine is defined once, off capList", /const capListLine = /.test(src) && (src.match(/const capListLine = /g) ?? []).length === 1);
}

console.log("(3) source: the JSON summary response uses the capped slices, with explicit *Total fields so truncation is never silent");
{
  check("(3a) backupSharedSentEmails in the summary object is the capped slice", /backupSharedSentEmails: cappedBackupSharedSentEmails,/.test(src));
  check("(3b) backupFreshSentEmails in the summary object is the capped slice", /backupFreshSentEmails: cappedBackupFreshSentEmails,/.test(src));
  check("(3c) backupStaleSentEmails in the summary object is the capped slice", /backupStaleSentEmails: cappedBackupStaleSentEmails,/.test(src));
  check("(3d) skippedBlankSubscribers in the summary object is the capped slice, with a total field alongside it", /skippedBlankSubscribers: cappedSkippedBlankSubscribers,\s*\n\s*skippedBlankSubscribersTotal: skippedBlankSubscribers\.length,/.test(src));
  check("(3e) deferred in the summary object is the capped slice, with a total field alongside it", /deferred: cappedDeferred,\s*\n\s*deferredTotal: deferred\.length,/.test(src));
  check("(3f) failures in the summary object is the capped slice, with a total field alongside it (was already sliced, but not paired with a total before this fix)", /failures: cappedFailures,\s*\n\s*failuresTotal: failures\.length,/.test(src));
}

console.log("(4) source: the ops-alert email lines use the SAME capped helper, not a separately hand-written truncation (or no truncation at all)");
{
  check("(4a) backupSharedSentEmails line uses capListLine", /capListLine\(backupSharedSentEmails\)/.test(src));
  check("(4b) backupFreshSentEmails line uses capListLine", /capListLine\(backupFreshSentEmails\)/.test(src));
  check("(4c) backupStaleSentEmails line uses capListLine", /capListLine\(backupStaleSentEmails\)/.test(src));
  check("(4d) skippedBlankSubscribers line uses capListLine", /capListLine\(skippedBlankSubscribers\)/.test(src));
  check("(4e) deferred line uses capListLine", /capListLine\(deferred\)/.test(src));
  // failures.map(...) in the alert line: the r22-01 bug was that this used
  // the FULL array while the JSON summary already capped it -- confirm the
  // alert line now maps over cappedFailures (not the raw `failures`) and
  // still names the true remainder count.
  check("(4f) the alert's failures line maps over cappedFailures, not the raw uncapped array", /cappedFailures\.map\(\(f\) => `\$\{f\.email\} \(\$\{f\.error\}\)`\)\.join\("; "\)/.test(src));
  check("(4g) the alert's failures line still surfaces the true remainder count when truncated", /failures\.length > EMAIL_LIST_CAP \? ` \(\+\$\{failures\.length - EMAIL_LIST_CAP\} more\)` : ""/.test(src));
}

console.log("(7) alpha-drift-r23-04 (found+fixed 2026-08-14, self-audit): the stuck-claim RECLAIM block (runs BEFORE the per-subscriber send loop) shares the SAME cap, not a separately hand-written unbounded list");
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");

  check("(7a) EMAIL_LIST_CAP/capList/capListLine now live near the top of the handler, before the reclaim block, not after it", (() => {
    const capDefIdx = src.indexOf("const EMAIL_LIST_CAP = 25;");
    const reclaimMatch = src.match(/\.from\("issues"\)\s*\.update\(\{ delivered_at: null \}\)/);
    return capDefIdx > -1 && !!reclaimMatch && reclaimMatch.index !== undefined && capDefIdx < reclaimMatch.index;
  })());
  check("(7b) the reclaim block's console.warn uses the capped line, not a raw unbounded join", /RECLAIMED \$\{reclaimed!\.length\} stuck claim\(s\)[^`]*\$\{idsLine\}/.test(src));
  check("(7c) the reclaim block's sendOpsAlert body ALSO uses the capped line", /a prior run likely died between claiming and Resend confirming\. Reclaimed and will be retried this run\. user_id\(s\): \$\{idsLine\}/.test(src));
  check("(7d) idsLine is built via capListLine, not a separately hand-written truncation", /const idsLine = capListLine\(ids\);/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("WEEKLY-SEND-ALERT-CAPS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL WEEKLY-SEND-ALERT-CAPS ASSERTIONS PASS");
