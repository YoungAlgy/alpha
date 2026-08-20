// Verify round 41 findings: smallest, quietest round yet -- 2 confirmed, 4
// refuted (out of only 6 raw findings across 5 dimensions, one dimension
// found nothing at all). Both confirmed findings genuinely adversarially
// verified (3/3 votes each, real infrastructure, no fallback artifact).
// - lib/engine/voice-guard.ts: round 40's own -ly-inflection fix touched
//   robust/comprehensive but skipped the adjacent crucial/vital/critical
//   trio, the identical gap-class for the 10th straight round.
// - lib/cadence.ts: a real, previously-undetected timezone bug --
//   nextSendIso() always reported "tomorrow" even when today's own
//   SEND_HOUR_UTC (14:00Z) send hadn't fired yet, so every /inbox visitor
//   between 00:00-14:00 UTC saw a "next one ships" date one full day late.
//   The same root cause r35-07/r36-02 had worked around (by removing a
//   specific-day claim elsewhere) rather than fixed at its actual source.
// 4 refuted, all genuinely adjudicated: two more colon-lookalike
// characters (small-form/vertical-presentation colons) were judged too
// obscure to be worth the added regex complexity; a subjectLine()
// spam-pattern hardening proposal was refuted (likely as speculative
// hardening without a concrete abuse case); and two identical
// Zod-validation-error semicolon-join findings (support form, checkout
// page) were both refuted -- the semicolon appears only in a rare
// multi-field-validation-failure edge case, not routine reader-facing
// copy.
// alpha-drift-r41-01, r41-02, all 2026-08-19.
// Run: npx tsx scripts/verify-r41-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) lib/engine/voice-guard.ts: crucial/vital/critical now get the same -ly treatment as robust/comprehensive");
{
  const src = readFileSync(new URL("../lib/engine/voice-guard.ts", import.meta.url), "utf8");
  check("(1a) crucial(?:ly)? covers crucially", /crucial\(\?:ly\)\?/.test(src));
  check("(1b) vital(?:ly)? covers vitally", /vital\(\?:ly\)\?/.test(src));
  check("(1c) critical(?:ly)? covers critically", /critical\(\?:ly\)\?/.test(src));

  const { findLexicalTells } = await import("../lib/engine/voice-guard.ts");
  check("(1d) behavioral: 'critically important' now trips a tell", findLexicalTells("this is critically important to understand").length > 0);
  check("(1e) behavioral: 'vitally important' now trips a tell", findLexicalTells("staying hydrated is vitally important").length > 0);
  check("(1f) behavioral: 'matters crucially' now trips a tell", findLexicalTells("this detail matters crucially for the outcome").length > 0);
  check("(1g) behavioral: bare 'crucial'/'vital'/'critical' (already-working forms) still trip a tell -- no regression", findLexicalTells("a crucial detail").length > 0 && findLexicalTells("a vital resource").length > 0 && findLexicalTells("a critical bug").length > 0);
  check("(1h) behavioral: a clean sentence with none of these words still trips nothing", findLexicalTells("The report shows home prices rose slightly last month.").length === 0);
}

console.log("(2) lib/cadence.ts: nextSendIso() no longer reports tomorrow when today's own send hasn't fired yet");
{
  const src = readFileSync(new URL("../lib/cadence.ts", import.meta.url), "utf8");
  check("(2a) nextSendIso now computes today's send instant and checks it", /const todaysSendInstant = new Date\(`\$\{todayIso\}T\$\{String\(SEND_HOUR_UTC\)\.padStart\(2, "0"\)\}:00:00Z`\);/.test(src));
  check("(2b) early-returns todayIso when today is a cadence day and now is still before that instant", /if \(isSendDay\(todayIso\) && now\.getTime\(\) < todaysSendInstant\.getTime\(\)\) \{\s*\n\s*return todayIso;/.test(src));
  check("(2c) the forward-walk loop is still present for the after-send-hour / non-cadence-day case", /for \(let i = 0; i < 7; i\+\+\) \{\s*\n\s*d\.setUTCDate\(d\.getUTCDate\(\) \+ 1\);/.test(src));

  // Behavioral proof against the REAL exported nextSendIso, not a
  // reimplementation -- the exact scenario the finding describes.
  const { nextSendIso } = await import("../lib/cadence.ts");
  check("(2d) behavioral: 6 hours before today's 14:00Z send, nextSendIso correctly returns TODAY (was tomorrow, the exact bug)", nextSendIso(new Date("2026-08-19T08:00:00Z")) === "2026-08-19");
  check("(2e) behavioral: 1 minute before the send instant, still returns TODAY", nextSendIso(new Date("2026-08-19T13:59:00Z")) === "2026-08-19");
  check("(2f) behavioral: at the exact send instant (14:00:00Z), returns TOMORROW (today's send is firing now, not upcoming)", nextSendIso(new Date("2026-08-19T14:00:00Z")) === "2026-08-20");
  check("(2g) behavioral: 1 hour after the send, returns TOMORROW", nextSendIso(new Date("2026-08-19T15:00:00Z")) === "2026-08-20");
  check("(2h) behavioral: late at night, returns TOMORROW", nextSendIso(new Date("2026-08-19T23:59:00Z")) === "2026-08-20");

  const inboxSrc = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  check("(2i) sanity: app/inbox/page.tsx's nextSendLabel() still calls the real exported nextSendIso() unchanged (fix is transparent to callers)", /const d = new Date\(`\$\{nextSendIso\(\)\}T\$\{String\(SEND_HOUR_UTC\)\.padStart\(2, "0"\)\}:00:00Z`\);/.test(inboxSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R41 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R41 FINDINGS ASSERTIONS PASS");
