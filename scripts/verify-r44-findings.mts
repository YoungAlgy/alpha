// Verify round 44 findings: 3 confirmed, 8 refuted (out of 11 raw findings
// across 5 dimensions -- mutation-authorization-audit found nothing at
// all, a reassuring signal on that specific surface).
// - app/api/admin/users/route.ts: the former clear_suppression final write was
//   a plain check-then-act, unlike grant_free/
//   revoke_free -- the `fresh` re-read only proved nothing had changed AT
//   READ TIME, leaving the window between that read and the write landing
//   still open to a genuine bounce/complaint webhook getting silently
//   clobbered. Folded the fresh snapshot into the UPDATE's WHERE clause.
// - app/settings/page.tsx: "Your topics" and "Email" sections rendered
//   unconditionally (no loading gate), unlike the sibling Billing section
//   on the same page -- a fresh-device or admin-granted reader briefly saw
//   an empty topics list / bare "—" email placeholder before the fetch
//   resolved. Gated both on the same quotaLoaded flag Billing uses.
// - app/archive/page.tsx: the error-state "Try again" button unmounts on
//   retry with no focus restoration -- the identical class already fixed
//   5 times elsewhere in this app, on the page whose own comment is what
//   the round-42/43 loadError fixes cite as their template. NOTABLE: two
//   near-identical findings on app/inbox/page.tsx and
//   app/inbox/[issueId]/page.tsx were reviewed the SAME round and REFUTED
//   2/3 each -- respected that differentiated verdict, left those two
//   unfixed rather than assuming "same shape = same bug."
// alpha-drift-r44-01 through r44-03, all 2026-08-19.
// Run: npx tsx scripts/verify-r44-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
};

console.log("(1) clear_suppression is hard-held while its durable claim protocol remains fail-closed in source");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  const helper = readFileSync(new URL("../lib/suppression-recovery.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../supabase/migrations/20260830050000_resend_suppression_causality.sql", import.meta.url), "utf8");
  const clearStart = src.indexOf('if (body.action === "clear_suppression")');
  const clearEnd = src.indexOf("const sb = await supabaseServiceClient();", clearStart);
  const clearBlock = src.slice(clearStart, clearEnd);
  check("(1a0) the held clear branch was extracted narrowly and is nonempty", clearBlock.length > 100 && clearEnd > clearStart);
  check("(1a) the route returns the stable hold before any direct provider or helper work", clearBlock.includes('code: "manual_recovery_disabled"') && clearBlock.includes("status: 409") && !clearBlock.includes("recoverResendSuppression({") && !clearBlock.includes("removeResendSuppression(") && !clearBlock.includes("suppressionQuery"));
  check("(1b) dormant SQL protocol: the claim stores a fixed comparison snapshot before the provider leg", migration.includes("suppression_recovery_snapshot jsonb") && migration.includes("suppression_recovery_snapshot = public.resend_suppression_recovery_snapshot(to_jsonb(v_user))"));
  check("(1b2) dormant SQL protocol: finalization binds the recovery token and compares the same snapshot", migration.includes("v_user.suppression_recovery_token is distinct from p_recovery_token") && migration.includes("public.resend_suppression_recovery_snapshot(to_jsonb(v_user))") && migration.includes("= v_user.suppression_recovery_snapshot"));
  check("(1b3) dormant SQL protocol: the recovery fence is durable and has no automatic expiry", migration.includes("This fence has no automatic expiry") && migration.includes("suppression_recovery_token is not null"));
  check("(1c) dormant helper returns manual_recovery_disabled before configuration or RPC work", helper.indexOf('return { status: "manual_recovery_disabled" }') > -1 && helper.indexOf('return { status: "manual_recovery_disabled" }') < helper.indexOf("if (!params.providerConfigured)") && helper.indexOf('return { status: "manual_recovery_disabled" }') < helper.indexOf('"claim_resend_suppression_recovery"'));
  check("(1d) the held route makes no provider attempt; dormant helper retains one guarded implementation", !src.includes("recoverResendSuppression({") && (helper.match(/removeSuppression\(claimed\.recipient_email\)/g) || []).length === 1);
  check("(1e) deletion and identity changes are guarded while recovery is unresolved", migration.includes("account deletion blocked by unresolved suppression recovery") && migration.includes("account identity change blocked by unresolved suppression recovery"));

  // Sanity: the sibling grant_free CAS pattern this fix mirrors is
  // unchanged.
  check("(1f) sanity: grant_free still checks both Stripe IDs and detects 0-row updates", /\.is\("stripe_customer_id", null\)\s*\n\s*\.is\("stripe_subscription_id", null\)/.test(src) && /const \{ error, data: updated \} = await grant\s*\n\s*\.select\("id"\);/.test(src));
}

console.log("(2) app/settings/page.tsx: \"Your topics\" and \"Email\" now gate on quotaLoaded like the sibling Billing section");
{
  const src = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(2a) Your topics section now checks !quotaLoaded before rendering real content", /\{!quotaLoaded \? \(\s*\n\s*<p className="alpha-ui text-sm mb-3" style=\{\{ color: "var\(--ink-soft\)" \}\}>\s*\n\s*Loading your topics…/.test(src));
  check("(2b) the real topics IIFE is still the else-branch, unchanged logic", /const all = topics \?\? state\.topics \?\? \[\];/.test(src));
  check("(2c) the Email section now gates EmailChanger on quotaLoaded too", /\{!quotaLoaded \? \(\s*\n\s*<p className="alpha-ui text-sm mb-3" style=\{\{ color: "var\(--ink-soft\)" \}\}>\s*\n\s*Loading…/.test(src));
  check("(2d) EmailChanger itself is unchanged, just conditionally rendered now", /<EmailChanger currentEmail=\{authEmail \|\| state\.email \|\| null\} \/>/.test(src));

  // Sanity: the sibling Billing section's own established quotaLoaded gate
  // (the pattern this fix mirrors) is untouched.
  check("(2e) sanity: Billing's own quotaLoaded gate is untouched", /\{quotaLoaded \? \(\s*\n\s*<>\s*\n\s*<p ref=\{billingHeadingRef\}/.test(src));
}

console.log("(3) app/archive/page.tsx: the error-state Try Again button now restores focus on a successful retry");
{
  const src = readFileSync(new URL("../app/archive/page.tsx", import.meta.url), "utf8");
  check("(3a) archiveHeadingRef and hadErrorRef are declared", /const archiveHeadingRef = useRef<HTMLHeadingElement>\(null\);/.test(src) && /const hadErrorRef = useRef\(false\);/.test(src));
  check("(3b) an effect keyed on state focuses the heading when leaving the error state", /if \(state === "error"\) \{\s*\n\s*hadErrorRef\.current = true;\s*\n\s*return;\s*\n\s*\}\s*\n\s*if \(hadErrorRef\.current\) \{\s*\n\s*archiveHeadingRef\.current\?\.focus\(\);/.test(src));
  check("(3c) the ref is actually attached to the always-present Archive heading", /<h1 ref=\{archiveHeadingRef\} tabIndex=\{-1\} className="alpha-display text-4xl md:text-5xl font-bold tracking-tight mb-10" style=\{\{ outline: "none" \}\}>/.test(src));
  check("(3d) sanity: the error state's own copy and Try again button are untouched", /Couldn&apos;t load your letters\./.test(src) && /onClick=\{\(\) => load\(\)\}/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R44 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R44 FINDINGS ASSERTIONS PASS");
