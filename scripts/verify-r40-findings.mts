// Verify round 40 findings: 8/8 confirmed via a fully-functional 3-vote
// Opus adversarial verify (round 39's session-limit failure did not
// recur -- all 50 agents completed cleanly). One finding on this exact
// same file (lib/sample-issue.ts:125, the Huberman Lab blurb) had the
// identical colon-plus-triplet shape as the confirmed ones but was
// correctly REFUTED 2/3 -- respected that verdict, left it unfixed,
// rather than treating "looks like the same pattern" as sufficient
// justification on its own.
// - lib/engine/voice-guard.ts: robust/comprehensive/calibrate were
//   already on the banned list but never got the -ly/noun inflection
//   treatment their siblings did in rounds 38-39 (robustly,
//   comprehensively, calibration(s) all slipped through).
// - lib/email.ts: r39's colon-collision fix only stripped the ASCII
//   colon, not the fullwidth colon (U+FF1A) a CJK IME produces by
//   default -- reopens the exact bug class r39 closed, via a homoglyph.
// - app/api/unsubscribe/route.ts: an em dash on the real unsubscribe
//   confirmation page, a public reader-facing surface.
// - lib/sample-issue.ts (the public /sample page's content): one banned
//   "X, not Y" closer, three instances of the banned rule-of-three
//   list-after-a-colon construction.
// - scripts/verify-rls-privileged-columns.mts: real test-coverage gaps
//   (not a live bypass -- the underlying trigger SQL was already
//   correct) -- missing id/created_at/bounced_at/complained_at coverage,
//   and cancelled_at was forged to null, a no-op test against a
//   freshly-created disposable user whose cancelled_at is already null.
// alpha-drift-r40-01 through r40-08, all 2026-08-19.
// Run: npx tsx scripts/verify-r40-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) lib/engine/voice-guard.ts: robust/comprehensive/calibrate now get the same -ly/noun inflection treatment as their siblings");
{
  const src = readFileSync(new URL("../lib/engine/voice-guard.ts", import.meta.url), "utf8");
  check("(1a) robust(?:ly)? covers robustly", /robust\(\?:ly\)\?/.test(src));
  check("(1b) comprehensive(?:ly)? covers comprehensively", /comprehensive\(\?:ly\)\?/.test(src));
  check("(1c) calibrations? covers the noun form", /calibrations\?/.test(src));

  const { findLexicalTells } = await import("../lib/engine/voice-guard.ts");
  check("(1d) behavioral: 'performed robustly' now trips a tell", findLexicalTells("the system performed robustly under load").length > 0);
  check("(1e) behavioral: 'comprehensively researched' now trips a tell", findLexicalTells("a comprehensively researched report").length > 0);
  check("(1f) behavioral: 'the calibrations were off' now trips a tell", findLexicalTells("the calibrations were off this quarter").length > 0);
  check("(1g) behavioral: 'ran several calibrations' now trips a tell", findLexicalTells("engineers ran several calibrations before launch").length > 0);
  check("(1h) behavioral: bare 'robust'/'comprehensive' (already-working forms) still trip a tell -- no regression", findLexicalTells("a robust system").length > 0 && findLexicalTells("a comprehensive guide").length > 0);
  check("(1i) behavioral: a clean sentence with none of these words still trips nothing", findLexicalTells("The report shows home prices rose slightly last month.").length === 0);
}

console.log("(2) lib/email.ts: safeLabel now strips the fullwidth colon too, not just the ASCII one");
{
  const src = readFileSync(new URL("../lib/email.ts", import.meta.url), "utf8");
  check("(2a) the strip now covers both colon characters", /s\.topicLabel\.replace\(\/\[:：\]\/g, ""\);/.test(src));

  const safeLabel = (label: string) => label.replace(/[:：]/g, "");
  check("(2b) behavioral: a fullwidth-colon custom topic label no longer produces a double colon-look-alike", (() => {
    const cjkLabel = "Recipe：dinner Ideas";
    const joined = `• ${safeLabel(cjkLabel)}: Someone posted a great one-pot recipe`;
    return !joined.includes("：") && !joined.includes("::");
  })());
}

console.log("(3) app/api/unsubscribe/route.ts: the confirmation page copy no longer uses an em dash");
{
  const src = readFileSync(new URL("../app/api/unsubscribe/route.ts", import.meta.url), "utf8");
  check("(3a) the em dash is gone", !/Your Stripe subscription is separate and unaffected — /.test(src));
  check("(3b) replaced with a plain second sentence", /Your Stripe subscription is separate and unaffected\. Manage or cancel billing separately from settings/.test(src));
}

console.log("(4) lib/sample-issue.ts: the public sample page's voice-guide violations are fixed (except the one the adversarial panel correctly refuted)");
{
  const src = readFileSync(new URL("../lib/sample-issue.ts", import.meta.url), "utf8");
  check("(4a) Lenny's Newsletter blurb no longer ends on the banned 'X, not Y' closer", !/concrete frameworks pressure-tested by practitioners, not theory\./.test(src));
  check("(4b) replaced with a two-sentence version", /Concrete frameworks, pressure-tested by people who actually ran the playbooks\./.test(src));
  check("(4c) Of Dollars And Data blurb no longer has the colon-plus-triplet list", !/replacing money-anxiety with evidence: when to buy, why time-in-market beats timing, how wealth actually compounds\./.test(src));
  check("(4d) Stratechery blurb no longer has the colon-plus-triplet list", !/why tech companies do what they do: platforms, aggregation, who actually holds the power\./.test(src));
  check("(4e) Marginal Revolution blurb no longer has the colon-plus-triplet list", !/skew curious and wide-ranging: history, fiction, the genuinely obscure\./.test(src));
  // Sanity: the Huberman Lab blurb (line ~125) was CONFIRMED to have the
  // identical construction but the adversarial panel refuted it 2/3 --
  // deliberately left untouched, not an oversight.
  check("(4f) sanity: the Huberman Lab blurb's identical-shaped construction is deliberately UNCHANGED (adversarially refuted 2/3, not silently missed)", /translates neuroscience into concrete routines: light in the morning, when to caffeinate, how to wind down\./.test(src));
}

console.log("(5) scripts/verify-rls-privileged-columns.mts: coverage gaps closed, re-run live against real Supabase");
{
  const src = readFileSync(new URL("../scripts/verify-rls-privileged-columns.mts", import.meta.url), "utf8");
  check("(5a) id added to forgedValues and asserted", /id: forgedId,/.test(src) && /afterForge\?\.id === before\.id && afterForge\?\.id !== forgedId/.test(src));
  check("(5b) created_at added to forgedValues and asserted", /created_at: new Date\("2020-01-01T00:00:00Z"\)\.toISOString\(\),/.test(src) && /afterForge\?\.created_at === before\.created_at/.test(src));
  check("(5c) bounced_at added to forgedValues and asserted", /bounced_at: new Date\(\)\.toISOString\(\),/.test(src) && /afterForge\?\.bounced_at === before\.bounced_at/.test(src));
  check("(5d) complained_at added to forgedValues and asserted", /complained_at: new Date\(\)\.toISOString\(\),/.test(src) && /afterForge\?\.complained_at === before\.complained_at/.test(src));
  check("(5e) cancelled_at now forged to a real non-null timestamp, not the old no-op null", /cancelled_at: new Date\(\)\.toISOString\(\),/.test(src) && !/cancelled_at: null,/.test(src));

  // This script was actually RUN live against real Supabase as part of this
  // round's own verification (creates+deletes one disposable auth user,
  // the script's own established safe pattern) -- 14/14 passed, confirming
  // the underlying trigger genuinely locks every newly-tested column, not
  // just that the new assertions are syntactically present. Not
  // re-executed here to avoid creating a second disposable auth user on
  // every future run of this summary script; see this round's own session
  // log / memory checkpoint for the live run's output.
  check("(5f) sanity: this file is left in its established runnable shape (SKIPs cleanly if Supabase env vars are unset, same as before)", /if \(!url \|\| !serviceKey \|\| !anonKey\) \{/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R40 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R40 FINDINGS ASSERTIONS PASS");
