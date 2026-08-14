// Verify round 23 finding (alpha-drift-r23-05, 2026-08-14): the nightly
// Stripe/Supabase reconciliation script (scripts/reconcile-stripe-vs-
// supabase.mts, run via .github/workflows/stripe-reconcile.yml) joined its
// `findings` array -- one entry per desynced user, scaling with however
// many users a systemic webhook failure or schema-drift bug affects --
// completely unbounded into the ops-alert email body. Same bug class round
// 22 fixed in weekly-send/route.ts. Fixed by capping the EMAIL only (with a
// real remainder count); the console.log'd summary is deliberately left
// uncapped since a GitHub Actions log isn't a deliverability/readability
// concern and is where someone would actually go for the full list.
//
// This script makes real Stripe + Supabase calls end-to-end (no synthetic
// data), so this verify script doesn't re-run it live -- instead it
// confirms the capping logic itself with real array-slicing behavior, and
// confirms via source inspection that findingsCount/summary.findings (the
// full-detail path) are untouched while only the alert body is capped.
// Run: npx tsx scripts/verify-reconcile-findings-cap.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) the cap math itself, reproduced with real array slicing (not asserted numbers)");
{
  const FINDINGS_CAP = 25;
  type Finding = { type: string; stripeCustomerId: string; detail: string; userId?: string };
  const makeFindings = (n: number): Finding[] =>
    Array.from({ length: n }, (_, i) => ({ type: "access_mismatch", stripeCustomerId: `cus_${i}`, detail: `desync #${i}` }));

  const buildBody = (findings: Finding[]) =>
    findings.slice(0, FINDINGS_CAP).map((f) => `- [${f.type}] ${f.detail} (stripe customer ${f.stripeCustomerId}${f.userId ? `, user ${f.userId}` : ""})`).join("\n") +
    (findings.length > FINDINGS_CAP ? `\n\n(+${findings.length - FINDINGS_CAP} more not shown -- see the full findings list in this run's own GitHub Actions log)` : "");

  const small = makeFindings(5);
  check("(1a) under the cap: no truncation suffix, all entries present", !buildBody(small).includes("more not shown") && buildBody(small).split("\n- [").length === 5);

  const exact = makeFindings(25);
  check("(1b) exactly at the cap: no truncation suffix", !buildBody(exact).includes("more not shown"));

  const over = makeFindings(200);
  const overBody = buildBody(over);
  check("(1c) over the cap: exactly 25 findings appear before the suffix", overBody.split("\n- [").length === 25);
  check("(1d) over the cap: the remainder count is correct (200 - 25 = 175)", overBody.includes("(+175 more not shown"));
}

console.log("(2) source: the alert body is capped, but findingsCount and the console.log'd summary.findings are NOT");
{
  const src = readFileSync(new URL("../scripts/reconcile-stripe-vs-supabase.mts", import.meta.url), "utf8");
  check("(2a) FINDINGS_CAP is defined", /const FINDINGS_CAP = 25;/.test(src));
  check("(2b) the alert body's map() uses findings.slice(0, FINDINGS_CAP), not the raw array", /findings\.slice\(0, FINDINGS_CAP\)\.map\(/.test(src));
  check("(2c) the alert body appends a remainder count when truncated", /findings\.length > FINDINGS_CAP \? `\\n\\n\(\+\$\{findings\.length - FINDINGS_CAP\} more not shown/.test(src));
  check("(2d) findingsCount in the summary object still reflects the TRUE total, not a capped one", /findingsCount: findings\.length,/.test(src));
  check("(2e) the console.log'd summary.findings is the FULL array, not a capped slice (deliberately, per this fix's own reasoning)", /findings,\s*\n\};\s*\nconsole\.log\(JSON\.stringify\(summary/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("RECONCILE-FINDINGS-CAP VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL RECONCILE-FINDINGS-CAP ASSERTIONS PASS");
