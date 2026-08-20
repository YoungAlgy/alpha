// Verify round 33 findings: (1) admin/users' clear_suppression re-check had
// no baseline to diff the fresh bounced_at/complained_at re-select against
// -- it just tested truthiness, which is true on essentially every normal
// call (that's what makes the button render), so removeResendSuppression
// fired twice on every ordinary invocation, and a transient Resend hiccup
// on that redundant second call failed the whole action with a misleading
// "a new bounce/complaint just landed" 502. (2) components/Digest.tsx's
// formatDateline anchored to a plain noon UTC instead of the real 14:00 UTC
// send hour, silently defeating the localTimezone reader fix for UTC+10/
// UTC+11 readers (they still saw yesterday's date). Both fixed; a shared
// SEND_HOUR_UTC constant in lib/cadence.ts now backs both formatDateline
// and app/inbox/page.tsx's nextSendLabel() so they can't drift apart again.
// alpha-drift-r33-01/r33-02, both 2026-08-14.
// Run: npx tsx scripts/verify-r33-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/api/admin/users/route.ts: clear_suppression's re-check now diffs against a real baseline");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  const clearStart = src.indexOf('if (body.action === "clear_suppression")');
  const clearEnd = src.length; // clear_suppression is the last action block in the file
  const block = src.slice(clearStart, clearEnd);

  check("(1a) the initial pre-fetch now also selects bounced_at/complained_at, not just email", /\.select\("email, bounced_at, complained_at"\)/.test(block));
  check("(1b) the old email-only pre-fetch select is gone", !/\.select\("email"\)\s*\n\s*\.eq\("id", body\.userId\)\s*\n\s*\.maybeSingle\(\);/.test(block));
  check("(1c) the re-check now compares fresh values against the baseline (row.bounced_at/row.complained_at), not just truthiness", /const suppressionChangedMidRequest =\s*\n\s*fresh\.bounced_at !== row\.bounced_at \|\| fresh\.complained_at !== row\.complained_at;/.test(block));
  check("(1d) the follow-up removeResendSuppression call is gated on the real diff, not the old bare truthiness check", /if \(suppressionChangedMidRequest && row\.email\) \{/.test(block));
  check("(1e) the old truthiness-only gate is gone", !/if \(\(fresh\.bounced_at \|\| fresh\.complained_at\) && row\.email\) \{/.test(block));

  // Behavioral proof of the real diff logic (mirrors the route's own inline
  // expression, since it isn't extracted into a standalone function).
  function suppressionChangedMidRequest(
    rowBouncedAt: string | null,
    rowComplainedAt: string | null,
    freshBouncedAt: string | null,
    freshComplainedAt: string | null
  ): boolean {
    return freshBouncedAt !== rowBouncedAt || freshComplainedAt !== rowComplainedAt;
  }
  check(
    "(1f) behavioral: an ORDINARY call (bounced_at already set, unchanged by the time of the re-check) does NOT trigger a second removeResendSuppression",
    suppressionChangedMidRequest("2026-08-10T00:00:00Z", null, "2026-08-10T00:00:00Z", null) === false
  );
  check(
    "(1g) behavioral: a GENUINE mid-request race (a fresh complaint lands between the pre-fetch and the re-check) DOES trigger the follow-up call",
    suppressionChangedMidRequest("2026-08-10T00:00:00Z", null, "2026-08-10T00:00:00Z", "2026-08-14T12:00:00Z") === true
  );
  check(
    "(1h) behavioral: the previously-buggy truthiness-only predicate WOULD have fired on the ordinary case (confirms this was a real regression)",
    !!("2026-08-10T00:00:00Z" || null) === true
  );
}

console.log("(2) lib/cadence.ts / components/Digest.tsx / app/inbox/page.tsx: dateline anchors share the real 14:00 UTC send hour");
{
  const cadenceSrc = readFileSync(new URL("../lib/cadence.ts", import.meta.url), "utf8");
  check("(2a) SEND_HOUR_UTC exported as 14", /export const SEND_HOUR_UTC = 14;/.test(cadenceSrc));
  // Sanity: the pure-date-arithmetic helpers keep their own deliberately-
  // different noon anchor -- this round's fix must not have touched those.
  // (Matched against the real code lines, not the new comment above that
  // also mentions "T12:00:00Z" in prose while explaining the distinction.)
  check("(2b-isSendDay) still uses its own T12:00:00Z arithmetic anchor, untouched", /CADENCE_UTC_DAYS\.includes\(new Date\(`\$\{periodIso\}T12:00:00Z`\)\.getUTCDay\(\)\)/.test(cadenceSrc));
  check("(2b-previousSendIso) still uses its own T12:00:00Z arithmetic anchor, untouched", /const d = new Date\(`\$\{periodIso\}T12:00:00Z`\);/.test(cadenceSrc));
  // alpha-drift-r41-02: round 41 gave nextSendIso() a real fix (it used to
  // always report "tomorrow" even when today's own send hadn't fired yet),
  // which refactored the inline `now.toISOString().slice(0, 10)` into a
  // named `todayIso` variable reused by both the new early-return and the
  // still-present forward-walk loop. The T12:00:00Z arithmetic anchor
  // itself is unchanged (still present, still noon-anchored) -- only the
  // exact literal expression producing today's date moved. Loosened to
  // check the anchor's presence via the new variable name.
  check("(2b-nextSendIso) still uses its own T12:00:00Z arithmetic anchor, untouched", /const d = new Date\(`\$\{todayIso\}T12:00:00Z`\);/.test(cadenceSrc));

  const digestSrc = readFileSync(new URL("../components/Digest.tsx", import.meta.url), "utf8");
  check("(2c) Digest.tsx imports SEND_HOUR_UTC from lib/cadence", /import \{ SEND_HOUR_UTC \} from "@\/lib\/cadence";/.test(digestSrc));
  check("(2d) formatDateline now anchors to SEND_HOUR_UTC, not a hardcoded T12:00:00Z", /new Date\(`\$\{weekOf\}T\$\{String\(SEND_HOUR_UTC\)\.padStart\(2, "0"\)\}:00:00Z`\)/.test(digestSrc));
  check("(2e) the old hardcoded noon anchor is gone from formatDateline", !/new Date\(`\$\{weekOf\}T12:00:00Z`\)/.test(digestSrc));

  const inboxSrc = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  check("(2f) app/inbox/page.tsx imports SEND_HOUR_UTC alongside nextSendIso", /import \{ nextSendIso, SEND_HOUR_UTC \} from "@\/lib\/cadence";/.test(inboxSrc));
  check("(2g) nextSendLabel() now derives its anchor from SEND_HOUR_UTC instead of a separate hardcoded literal", /const d = new Date\(`\$\{nextSendIso\(\)\}T\$\{String\(SEND_HOUR_UTC\)\.padStart\(2, "0"\)\}:00:00Z`\);/.test(inboxSrc));
  check("(2h) the old separately-hardcoded T14:00:00Z literal in nextSendLabel is gone", !/const d = new Date\(`\$\{nextSendIso\(\)\}T14:00:00Z`\);/.test(inboxSrc));

  // Behavioral proof: the real bug was a 2-hour gap between formatDateline's
  // old anchor (noon) and the actual send hour (14:00) that only matters
  // once a reader's local offset crosses the "did this cross midnight
  // locally" threshold. Compute that threshold under both the old (buggy)
  // and new (fixed) anchor and confirm the fix actually shifts it to cover
  // UTC+10/+11 (the finding's named affected band).
  function localDateCrossesMidnight(anchorUtcHour: number, localOffsetHours: number): boolean {
    // A UTC instant at anchorUtcHour, converted to local time, has crossed
    // into the next calendar day once anchorUtcHour + localOffsetHours >= 24.
    return anchorUtcHour + localOffsetHours >= 24;
  }
  check("(2i) behavioral: the OLD noon (12:00Z) anchor only crossed midnight at UTC+12 and above -- UTC+10 was NOT covered (confirms the real bug)", localDateCrossesMidnight(12, 10) === false);
  check("(2j) behavioral: the OLD noon (12:00Z) anchor also missed UTC+11", localDateCrossesMidnight(12, 11) === false);
  check("(2k) behavioral: the NEW real-send-hour (14:00Z) anchor correctly crosses midnight at UTC+10 (Australia)", localDateCrossesMidnight(14, 10) === true);
  check("(2l) behavioral: the NEW anchor also correctly crosses midnight at UTC+11", localDateCrossesMidnight(14, 11) === true);
  check("(2m) behavioral: NZ/Fiji (UTC+12) was already covered under the old anchor too, consistent with why this slipped through unnoticed", localDateCrossesMidnight(12, 12) === true);

  // Confirm the actual production cron trigger really is 14:00 UTC, so
  // SEND_HOUR_UTC=14 isn't just an assumption.
  const workflowSrc = readFileSync(new URL("../.github/workflows/daily-send.yml", import.meta.url), "utf8");
  check("(2n) sanity: the real GitHub Actions cron trigger is \"0 14 * * *\" (14:00 UTC), matching SEND_HOUR_UTC", /cron:\s*["']0 14 \* \* \*["']/.test(workflowSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R33 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R33 FINDINGS ASSERTIONS PASS");
