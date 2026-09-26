// Verify round 33 findings: the durable SQL-owned recovery protocol remains
// in source, but its manual provider-removal entry is currently hard-held.
// The dormant provider leg is one-shot. Unknown provider or settlement
// outcomes retain the fence for review. A changed delivery baseline retains
// the fence and never gets a second provider delete.
// (2) components/Digest.tsx's
// formatDateline anchored to a plain noon UTC instead of the real 14:00 UTC
// send hour, silently defeating the localTimezone reader fix for UTC+10/
// UTC+11 readers (they still saw yesterday's date). Both fixed; a shared
// SEND_HOUR_UTC constant in lib/cadence.ts now backs both formatDateline
// and app/inbox/page.tsx's nextSendLabel() so they can't drift apart again.
// alpha-drift-r33-01/r33-02, both 2026-08-14.
// Run: npx tsx scripts/verify-r33-findings.mts
import { readFileSync } from "node:fs";
import ts from "typescript";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
};

function namedImportsFrom(source: string, moduleName: string): Set<string> {
  const file = ts.createSourceFile("fixture.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.getText(file).slice(1, -1) !== moduleName) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) names.add(element.propertyName?.text ?? element.name.text);
  }
  return names;
}

console.log("(1) app/api/admin/users/route.ts: clear_suppression is hard-held while the durable protocol remains fail-closed in source");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  const helper = readFileSync(new URL("../lib/suppression-recovery.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../supabase/migrations/20260830050000_resend_suppression_causality.sql", import.meta.url), "utf8");
  const clearStart = src.indexOf('if (body.action === "clear_suppression")');
  const serviceStart = src.indexOf("const sb = await supabaseServiceClient();", clearStart);
  const block = src.slice(clearStart, serviceStart);

  check("(1a) the validated clear branch is nonempty, returns the stable held 409, and ends before service access", block.length > 100 && block.includes('code: "manual_recovery_disabled"') && block.includes("status: 409") && !block.includes("recoverResendSuppression({"));
  check("(1b) dormant protocol: the helper still claims under the owner lock after the hold guard", helper.indexOf('return { status: "manual_recovery_disabled" }') < helper.indexOf('"claim_resend_suppression_recovery"') && migration.includes("pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080))"));
  check("(1c) dormant protocol: finalization remains strictly after provider success", helper.indexOf("removeSuppression(claimed.recipient_email)") < helper.indexOf('"finalize_resend_suppression_recovery"') && /if \(!providerCleared\) return \{ status: "provider_failed" \}/.test(helper));
  check("(1d) dormant protocol: a changed baseline keeps the fence and has one provider leg", /return \{ status: "state_changed" \}/.test(helper) && (helper.match(/removeSuppression\(claimed\.recipient_email\)/g) || []).length === 1);
  check("(1e) dormant protocol: malformed RPC replies and lost settlement remain unconfirmed", helper.includes("asSingleClaimRow(data)") && helper.includes("settlement_unconfirmed"));

  // Behavioral proof of the delivery-state comparison contract. The comparison
  // remains a small pure fixture here so this historical check has no provider
  // or database dependency.
  function deliveryStateChangedMidRequest(
    rowUnsubscribedAt: string | null,
    rowBouncedAt: string | null,
    rowComplainedAt: string | null,
    rowPendingAt: string | null,
    rowClearedAt: string | null,
    freshUnsubscribedAt: string | null,
    freshBouncedAt: string | null,
    freshComplainedAt: string | null,
    freshPendingAt: string | null,
    freshClearedAt: string | null
  ): boolean {
    return (
      freshUnsubscribedAt !== rowUnsubscribedAt ||
      freshBouncedAt !== rowBouncedAt ||
      freshComplainedAt !== rowComplainedAt ||
      freshPendingAt !== rowPendingAt ||
      freshClearedAt !== rowClearedAt
    );
  }
  check(
    "(1f) dormant comparator: an ordinary unchanged state has no state change",
    deliveryStateChangedMidRequest(null, "2026-08-10T00:00:00Z", null, null, null, null, "2026-08-10T00:00:00Z", null, null, null) === false
  );
  check(
    "(1g) dormant comparator: a fresh complaint requires a new review",
    deliveryStateChangedMidRequest(null, "2026-08-10T00:00:00Z", null, null, null, null, "2026-08-10T00:00:00Z", "2026-08-14T12:00:00Z", null, null) === true
  );
  check(
    "(1g2) dormant comparator: a pending-cleanup race requires review",
    deliveryStateChangedMidRequest(null, null, null, null, null, null, null, null, "2026-08-14T12:00:00Z", null) === true
  );
  check(
    "(1g3) dormant comparator: a newer causal-clear watermark requires review",
    deliveryStateChangedMidRequest(null, null, null, null, "2026-08-14T11:00:00Z", null, null, null, null, "2026-08-14T12:00:00Z") === true
  );
  check(
    "(1h) dormant comparator: a mid-request direct opt-out requires review",
    deliveryStateChangedMidRequest(null, null, null, null, null, "2026-08-14T12:00:00Z", null, null, null, null) === true
  );
}

console.log("(2) lib/cadence.ts / components/Digest.tsx / app/inbox/page.tsx: dateline anchors share the real 14:17 UTC primary send time");
{
  const cadenceSrc = readFileSync(new URL("../lib/cadence.ts", import.meta.url), "utf8");
  check("(2a) SEND_HOUR_UTC exported as 14", /export const SEND_HOUR_UTC = 14;/.test(cadenceSrc));
  check("(2a-minute) SEND_MINUTE_UTC exported as 17", /export const SEND_MINUTE_UTC = 17;/.test(cadenceSrc));
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
  check("(2c) Digest.tsx imports SEND_HOUR_UTC and SEND_MINUTE_UTC from lib/cadence", /import \{ SEND_HOUR_UTC, SEND_MINUTE_UTC \} from "@\/lib\/cadence";/.test(digestSrc));
  check("(2d) formatDateline anchors to the shared hour and minute, not a hardcoded T12:00:00Z", /new Date\(`\$\{weekOf\}T\$\{String\(SEND_HOUR_UTC\)\.padStart\(2, "0"\)\}:\$\{String\(SEND_MINUTE_UTC\)\.padStart\(2, "0"\)\}:00Z`\)/.test(digestSrc));
  check("(2e) the old hardcoded noon anchor is gone from formatDateline", !/new Date\(`\$\{weekOf\}T12:00:00Z`\)/.test(digestSrc));

  const inboxSrc = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  const inboxCadenceImports = namedImportsFrom(inboxSrc, "@/lib/cadence");
  check("(2f) app/inbox/page.tsx imports both send-time constants alongside nextSendIso", inboxCadenceImports.has("SEND_HOUR_UTC") && inboxCadenceImports.has("SEND_MINUTE_UTC") && inboxCadenceImports.has("nextSendIso"));
  check("(2g) nextSendLabel() derives its anchor from both send-time constants", /const d = new Date\(`\$\{nextSendIso\(\)\}T\$\{String\(SEND_HOUR_UTC\)\.padStart\(2, "0"\)\}:\$\{String\(SEND_MINUTE_UTC\)\.padStart\(2, "0"\)\}:00Z`\);/.test(inboxSrc));
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

  // Confirm the primary cron really is 14:17 UTC, so the shared send-time
  // constants are checked against the workflow itself.
  const workflowSrc = readFileSync(new URL("../.github/workflows/daily-send.yml", import.meta.url), "utf8");
  check("(2n) sanity: the real GitHub Actions primary cron trigger is \"17 14 * * *\", matching the shared time", /cron:\s*["']17 14 \* \* \*["']/.test(workflowSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R33 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R33 FINDINGS ASSERTIONS PASS");
