// Verify round 45 findings: 4 confirmed, 7 refuted (out of 11 raw findings
// across 5 dimensions -- self-audit-r44 found nothing at all, a reassuring
// signal that round 44's fixes shipped clean).
// - components/EmailChanger.tsx: the Cancel button had no busy guard,
//   unlike the Send confirmation button right next to it -- a reader
//   canceling while updateUser() was still in flight could get the
//   confirmation panel silently reopened (and focus stolen) by the earlier
//   call's late success, well after they believed they'd backed out.
// - app/api/admin/users/route.ts: grant_free grants access without treating an
//   administrator approval as a delivery-policy recovery. It preserves the
//   bounce, complaint, unsubscribe, pending-review, and causal watermark
//   state, and never calls the provider cleanup endpoint. Manual recovery is
//   currently hard-held pending late-event ordering and terminal resolution.
// - app/topics/page.tsx: a failed save's error message was never cleared
//   by any of the mutating actions a reader would naturally take to try to
//   fix it (toggle/removeAt/move/addCustom), so the sticky status bar kept
//   showing a stale failure instead of live pick-count progress.
// - app/settings/accounts/page.tsx: a page-level load error (e.g. "Sign in
//   first.") was never cleared by a subsequent successful load, so a
//   transient auth-cookie-hydration 401 on mount could leave a permanently
//   stuck error banner sitting above a fully correct, freshly-loaded user
//   list.
// 7 refuted, all genuinely adjudicated: a failed-account-deletion local-
// state-clearing claim, an admin sr-only-success/blocking-alert()
// inconsistency claim, two "document the deliberate no-rate-limit
// decision" proposals for the Stripe/Resend webhooks, a ProfileEditor
// required-field-indicator gap, and two "clear the error on edit" gaps
// (signin page, support form) were all refuted 3/3 (or 2/3 for the
// deletion claim).
// alpha-drift-r45-01 through r45-04, all 2026-08-19.
// Run: npx tsx scripts/verify-r45-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
};

console.log("(1) components/EmailChanger.tsx: Cancel is now disabled during the in-flight submit(), matching Send confirmation");
{
  const src = readFileSync(new URL("../components/EmailChanger.tsx", import.meta.url), "utf8");
  check("(1a) the Cancel button now has disabled={busy}", /disabled=\{busy\}\s*\n\s*onClick=\{\(\) => \{\s*\n\s*setEditing\(false\);/.test(src));
  check("(1b) it also dims to match the Send confirmation button's busy styling", /style=\{\{ color: "var\(--ink-soft\)", opacity: busy \? 0\.5 : 1 \}\}/.test(src));
}

console.log("(2) app/api/admin/users/route.ts: grant_free grants access while preserving delivery policy under the hard recovery hold");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  const grantStart = src.indexOf('if (body.action === "grant_free")');
  const grantEnd = src.indexOf('if (body.action === "revoke_free")', grantStart);
  const grant = src.slice(grantStart, grantEnd);
  const clearGuardStart = src.indexOf('if (body.action === "clear_suppression")');
  const postGuardServiceStart = src.indexOf(
    "const sb = await supabaseServiceClient();",
    clearGuardStart
  );
  check("(2a0) grant_free extraction is nonempty and ends at revoke_free", grantStart > -1 && grantEnd > grantStart && grant.length > 500 && !grant.includes('if (body.action === "revoke_free")'));
  check("(2a) grant_free still validates its canonical normalized email before access is granted", /const normalizedEmail = existing\.email\?\.toLowerCase\(\)\.trim\(\);/.test(grant) && /normalizedEmail !== existing\.email/.test(grant));
  check("(2b) grant_free makes no provider unsuppression call", !grant.includes("removeResendSuppression("));
  check("(2c) its only profile update changes access fields, never delivery-policy fields", /\.update\(\{\s*subscribed_at: grantedAt,\s*access_requested_at: null,\s*access_granted_at: grantedAt,\s*cancelled_at: null,\s*\}\)/.test(grant) && !/\b(?:unsubscribed_at|bounced_at|complained_at|suppression_cleanup_pending_at|delivery_suppression_cleared_at)\s*:/.test(grant));
  check("(2d) the access update keeps its wide state compare-and-swap guards", /\.eq\("email", existing\.email\)/.test(grant) && /grant = existing\.subscribed_at/.test(grant) && /grant = existing\.cancelled_at/.test(grant) && /grant = existing\.access_requested_at/.test(grant) && /grant = existing\.access_granted_at/.test(grant) && /grant = existing\.unsubscribed_at/.test(grant) && /grant = existing\.bounced_at/.test(grant) && /grant = existing\.complained_at/.test(grant) && /grant = existing\.suppression_cleanup_pending_at/.test(grant) && /grant = existing\.delivery_suppression_cleared_at/.test(grant));
  check("(2e) grant_free has no separate cleanup write that could retire a pending review marker", (grant.match(/\.update\(\{/g) || []).length === 1);
  check("(2f) the old raw-email await-and-discard provider call is gone", !/await removeResendSuppression\(existing\.email\)/.test(grant));

  check("(2g) clear_suppression remains validated but returns the stable hard-hold response before any provider helper import", src.includes('"clear_suppression",') && src.includes('code: "manual_recovery_disabled"') && clearGuardStart > -1 && clearGuardStart < postGuardServiceStart && !src.includes('from "@/lib/suppression-recovery"') && !src.includes('from "@/lib/email"'));
}

console.log("(3) app/topics/page.tsx: a failed save's error is now cleared by every action a reader would take to fix it");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
  // alpha-drift-r54-02 (2026-08-20) prepended `userEditedRef.current = true;`
  // as the literal first statement in toggle()/removeAt()/move() -- these
  // regexes loosened to allow that new line before the saveError clear,
  // same relative order otherwise.
  check("(3a) toggle() clears saveError", /function toggle\(id: TopicId\) \{\s*\n(?:\s*userEditedRef\.current = true;\s*\n)?\s*if \(saveError\) setSaveError\(null\);/.test(src));
  check("(3b) removeAt() clears saveError", /function removeAt\(id: TopicId\) \{\s*\n(?:\s*userEditedRef\.current = true;\s*\n)?\s*if \(saveError\) setSaveError\(null\);/.test(src));
  check("(3c) move() clears saveError", /if \(to < 0 \|\| to >= picked\.length\) return;\s*\n(?:\s*userEditedRef\.current = true;\s*\n)?\s*if \(saveError\) setSaveError\(null\);/.test(src));
  check("(3d) addCustom()'s success path clears saveError", /setCustomText\(""\);\s*\n\s*setCustomErr\(null\);\s*\n\s*if \(saveError\) setSaveError\(null\);/.test(src));
}

console.log("(4) app/settings/accounts/page.tsx: a page-level load error is now cleared at the start of every new load() attempt");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(4a) load() now clears err before starting a new fetch", /async function load\(opts\?: \{[\s\S]{0,400}\}\): Promise<AdminUserRow\[\] \| null> \{[\s\S]{0,900}if \(err\) setErr\(null\);/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R45 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R45 FINDINGS ASSERTIONS PASS");
