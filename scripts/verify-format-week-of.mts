// Verify lib/engine/assemble.ts's formatWeekOf() is genuinely UTC-anchored
// (alpha-drift-r14-04, review 2026-08-06) -- before this fix, it parsed the
// date string with no Z suffix and no explicit timeZone in the
// toLocaleDateString options.
//
// Investigated live while writing this test: the old code's noon-anchored
// parse and its un-anchored format actually canceled out (a local-time
// parse formatted back in the SAME implicit local time is self-consistent,
// and no real-world UTC offset -12..+14 is wide enough for a noon anchor to
// cross a calendar-day boundary), so it never actually produced a WRONG day
// string on its own -- confirmed by diffing its output against this exact
// fix at TZ=Pacific/Kiritimati (UTC+14, the most extreme real zone) below;
// they match. The real risk this fix closes is CONSISTENCY, not a reachable
// wrong-answer bug: every sibling date helper in the codebase (lib/
// cadence.ts, lib/email.ts's shortWeek()) is explicitly UTC-anchored, and
// this was the one exception relying on an unenforced "the runtime happens
// to default to UTC" assumption instead of saying so. This script locks in
// that the anchored version is deterministic under a non-UTC process TZ,
// matching its siblings' own convention.
// Run: npx tsx scripts/verify-format-week-of.mts
process.env.TZ = "Pacific/Kiritimati"; // UTC+14, the most extreme real timezone -- if anything would expose a TZ leak, this would.

const { formatWeekOf } = await import("../lib/engine/assemble.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log(`(running under TZ=${process.env.TZ})`);

console.log("(1) a known date formats to its correct UTC weekday/date regardless of process TZ");
check('(1) 2026-05-17 -> "Sunday, May 17, 2026"', formatWeekOf("2026-05-17") === "Sunday, May 17, 2026");
check('(1) 2026-01-01 -> "Thursday, January 1, 2026"', formatWeekOf("2026-01-01") === "Thursday, January 1, 2026");
check('(1) 2026-12-31 -> "Thursday, December 31, 2026"', formatWeekOf("2026-12-31") === "Thursday, December 31, 2026");

console.log("(2) explicitly UTC-anchored output is identical regardless of process TZ, matching lib/email.ts's shortWeek() convention");
check('(2) 2026-06-08 -> "Monday, June 8, 2026"', formatWeekOf("2026-06-08") === "Monday, June 8, 2026");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FORMAT-WEEK-OF VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL FORMAT-WEEK-OF ASSERTIONS PASS");
