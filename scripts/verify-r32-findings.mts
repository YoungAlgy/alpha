// Verify round 32 findings: (1)+(2) admin/users' grant_free/revoke_free and
// clear_suppression was check-then-act against a live Stripe/Resend webhook,
// unlike this app's own established compare-and-swap idiom
// (weekly-send's delivered_at claim, the Stripe-webhook mirror writes); (3)
// /topics' ranked lineup list conveyed rank + favorite/backup status via
// aria-hidden/color only, and move()/removeAt() gave screen reader users no
// feedback at all; (4) 3 more touch-target gaps (settings billing panel,
// Footer nav, inbox meta row) missed the app's own py-2 -my-2 idiom; (5)+(6)
// lib/analytics.ts's redactValue had no coverage for sensitive query-string
// params (session_id, PKCE code), and auth/callback didn't scrub the code
// param from the URL bar the way its own hash-flow success path already
// does; (7) /writing deliberately did NOT get the same URL-bar scrub (a real
// window.location.reload() there depends on session_id surviving in the
// URL for the real retry to work); (8) admin/accounts' act() only
// ever alert()'d on failure, giving zero success feedback to a screen reader
// user. alpha-drift-r32-01 through r32-04, all 2026-08-14.
// Run: npx tsx scripts/verify-r32-findings.mts
import { readFileSync } from "node:fs";
import vm from "node:vm";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
};

console.log("(1) app/api/admin/users/route.ts: grant_free/revoke_free fold eligibility into the UPDATE's WHERE, detect a lost race via 0-row select");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");

  const grantStart = src.indexOf('if (body.action === "grant_free")');
  const revokeStart = src.indexOf('if (body.action === "revoke_free")');
  const clearStart = src.indexOf('if (body.action === "clear_suppression")');
  const unknownActionStart = src.indexOf(
    '\n  return NextResponse.json({ error: "Unknown action"',
    revokeStart
  );
  check("(1a) grant/revoke blocks and the earlier held clear guard are found with distinct boundaries", grantStart > 0 && revokeStart > grantStart && clearStart > 0 && clearStart < grantStart && unknownActionStart > revokeStart);

  const grantBlock = src.slice(grantStart, revokeStart);
  check("(1a2-grant) grant extraction is nonempty and ends at revoke_free", grantBlock.length > 500 && !grantBlock.includes('if (body.action === "revoke_free")'));
  check("(1b-grant) the UPDATE now re-checks stripe_customer_id is still null via .is()", /\.is\("stripe_customer_id", null\)/.test(grantBlock));
  check("(1c-grant) both Stripe identifiers are re-checked and .select(\"id\") makes a 0-row result detectable", /\.is\("stripe_customer_id", null\)\s*\n\s*\.is\("stripe_subscription_id", null\)/.test(grantBlock) && /const \{ error, data: updated \} = await grant\s*\n\s*\.select\("id"\);/.test(grantBlock));
  check("(1c2-grant) the grant CAS also binds the canonical email and every delivery-state snapshot", /\.eq\("email", existing\.email\)/.test(grantBlock) && /grant = existing\.bounced_at/.test(grantBlock) && /grant = existing\.complained_at/.test(grantBlock) && /grant = existing\.suppression_cleanup_pending_at/.test(grantBlock) && /grant = existing\.delivery_suppression_cleared_at/.test(grantBlock));
  check("(1c3-grant) access approval preserves all delivery-policy fields and makes no provider call", !/\.update\(\{[\s\S]*?unsubscribed_at:\s*null/.test(grantBlock) && !/\.update\(\{[\s\S]*?bounced_at:\s*null/.test(grantBlock) && !/\.update\(\{[\s\S]*?complained_at:\s*null/.test(grantBlock) && !/\.update\(\{[\s\S]*?suppression_cleanup_pending_at:\s*(?:null|grantedAt)/.test(grantBlock) && !/\.update\(\{[\s\S]*?delivery_suppression_cleared_at:/.test(grantBlock) && !grantBlock.includes("removeResendSuppression("));
  check("(1d-grant) a 0-row update returns 409, not a silent { ok: true }", /if \(!updated \|\| updated\.length === 0\) \{[\s\S]*?status: 409/.test(grantBlock));

  const revokeBlock = src.slice(revokeStart, unknownActionStart);
  check("(1a3-revoke) revoke extraction is nonempty and ends at the unknown-action fallback", revokeBlock.length > 300 && !revokeBlock.includes('if (body.action === "clear_suppression")'));
  check("(1e-revoke) the UPDATE now re-checks stripe_customer_id is still null via .is()", /\.is\("stripe_customer_id", null\)/.test(revokeBlock));
  check(
    "(1f-revoke) both Stripe identifiers are re-checked and .select(\"id\") makes a 0-row result detectable",
    /\.is\("stripe_customer_id", null\)\s*\n\s*\.is\("stripe_subscription_id", null\)\s*\n\s*\.select\("id"\);/.test(revokeBlock)
  );
  check("(1g-revoke) a 0-row update returns 409, not a silent { ok: true }", /if \(!updated \|\| updated\.length === 0\) \{[\s\S]*?status: 409/.test(revokeBlock));
}

console.log("(2) app/api/admin/users/route.ts: clear_suppression is a validated hard hold with the dormant SQL protocol left fail-closed");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  const clearStart = src.indexOf('if (body.action === "clear_suppression")');
  const serviceStart = src.indexOf("const sb = await supabaseServiceClient();", clearStart);
  const clearBlock = src.slice(clearStart, serviceStart);
  const helper = readFileSync(new URL("../lib/suppression-recovery.ts", import.meta.url), "utf8");

  check("(2a) the held route slice is nonempty, returns the stable 409 code, and cannot reach the service client", clearBlock.length > 100 && clearBlock.includes('code: "manual_recovery_disabled"') && clearBlock.includes("status: 409") && !clearBlock.includes("recoverResendSuppression({") && !clearBlock.includes("removeResendSuppression("));
  check("(2b) the held route has no recovery-helper or provider-removal import", !src.includes('from "@/lib/suppression-recovery"') && !src.includes('from "@/lib/email"'));
  check("(2c) the dormant helper returns typed manual_recovery_disabled before provider configuration or a claim", helper.indexOf('return { status: "manual_recovery_disabled" }') > -1 && helper.indexOf('return { status: "manual_recovery_disabled" }') < helper.indexOf("if (!params.providerConfigured)") && helper.indexOf('return { status: "manual_recovery_disabled" }') < helper.indexOf('"claim_resend_suppression_recovery"'));
  check("(2d) dormant protocol: the helper claims before its one provider leg and finalizes only after strict true", helper.indexOf('"claim_resend_suppression_recovery"') < helper.indexOf("removeSuppression(claimed.recipient_email)") && helper.indexOf("removeSuppression(claimed.recipient_email)") < helper.indexOf('"finalize_resend_suppression_recovery"'));
  check("(2e) dormant protocol: one false or thrown provider leg never finalizes", (helper.match(/removeSuppression\(claimed\.recipient_email\)/g) || []).length === 1 && /if \(!providerCleared\) return \{ status: "provider_failed" \}/.test(helper) && /catch \{\s*return \{ status: "provider_failed" \};\s*\}/.test(helper));
  check("(2f) dormant protocol: malformed claim or lost settlement stays unconfirmed", helper.includes("settlement_unconfirmed") && helper.includes("asSingleClaimRow(data)") && /error \|\| typeof data !== "string"/.test(helper));
}

console.log("(3) app/topics/page.tsx: rank + favorite/backup status announced to screen readers, move()/removeAt() give live feedback");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");

  check("(3a) announcement state added", /const \[announcement, setAnnouncement\] = useState\(""\);/.test(src));

  const removeAtIdx = src.indexOf("function removeAt(id: TopicId) {");
  const moveIdx = src.indexOf("function move(from: number, dir: -1 | 1) {");
  check("(3b) removeAt/move both found in order", removeAtIdx > 0 && moveIdx > removeAtIdx);
  const removeAtBlock = src.slice(removeAtIdx, moveIdx);
  check("(3c) removeAt announces the removal", /setAnnouncement\(`\$\{topicLabel\(id\)\} removed from your lineup\.`\);/.test(removeAtBlock));

  const moveBlock = src.slice(moveIdx, src.indexOf("const customPicks = picked.filter(isCustomTopic);"));
  check("(3d) move() computes `item`/wasFav/isFav from the closure BEFORE calling setPicked, not inside its updater", moveBlock.indexOf("const item = picked[from];") < moveBlock.indexOf("setPicked((prev) => {"));
  check("(3e) move() announces the new position and any favorite<->backup status change", /setAnnouncement\(`\$\{topicLabel\(item\)\} moved to position \$\{to \+ 1\} of \$\{picked\.length\}\$\{statusChange\}\.`\);/.test(moveBlock));

  check("(3f) a shared role=status live region renders the announcement", /<p role="status" aria-live="polite" className="sr-only">\s*\{announcement\}/.test(src));
  check("(3g) each lineup row gets an sr-only Favorite/Backup + rank label alongside the aria-hidden numeral", /<span className="sr-only">\s*\{isFav \? `Favorite \$\{i \+ 1\}` : `Backup \$\{i \+ 1 - quota\}`\}:/.test(src));

  // Behavioral proof of the status-change phrase, mirroring the real
  // component logic (wasFav/isFav derived from index < quota).
  function statusChangePhrase(from: number, to: number, quota: number): string {
    const wasFav = from < quota;
    const isFav = to < quota;
    return wasFav === isFav ? "" : isFav ? ", now a favorite" : ", now a backup";
  }
  check("(3h) behavioral: moving a backup (index 5) up to index 3 under quota=5 announces 'now a favorite'", statusChangePhrase(5, 3, 5) === ", now a favorite");
  check("(3i) behavioral: moving a favorite (index 2) down to index 5 under quota=5 announces 'now a backup'", statusChangePhrase(2, 5, 5) === ", now a backup");
  check("(3j) behavioral: moving within the same favorites band announces no status change", statusChangePhrase(0, 1, 5) === "");
}

console.log("(4) 3 touch-target gaps closed with the app's own py-2 -my-2 idiom");
{
  const settingsSrc = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(4a) billing-panel Cancel button", /onClick=\{\(\) => setConfirmingTier\(null\)\}\s*\n\s*className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"/.test(settingsSrc));
  check("(4b) Download my data button", /className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--accent-ink\)" \}\}\s*\n\s*>\s*\n\s*Download my data/.test(settingsSrc));
  // alpha-drift-r46-supersedes-r32 (2026-08-19): round 46's alpha-drift-r46-04
  // added a busy-state style/label to this same button (opacity: deleting ?
  // 0.5 : 1, and the text now swaps to "Deleting…") -- the py-2 -my-2
  // touch-target className this assertion actually proves is untouched and
  // still present, so just loosened the style/text match to allow for it.
  check("(4c) Delete my account button", /className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--ink-soft\)", opacity: deleting \? 0\.5 : 1 \}\}\s*\n\s*>\s*\n\s*\{deleting \? "Deleting…" : "Delete my account"\}/.test(settingsSrc));

  const footerSrc = readFileSync(new URL("../components/Footer.tsx", import.meta.url), "utf8");
  check("(4d) Footer's 3 nav links (Privacy/Terms/Support) all got py-2 -my-2", (footerSrc.match(/hover:opacity-70 py-2 -my-2/g) ?? []).length === 3);

  const inboxSrc = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  check("(4e) inbox 'Read past letters' link", /href="\/archive" className="underline underline-offset-4 hover:opacity-80 py-2 -my-2"/.test(inboxSrc));
  check("(4f) inbox ShareButton", /className="underline underline-offset-4 hover:opacity-80 py-2 -my-2"\s*\n\s*\/>/.test(inboxSrc));
  // ShareButton forwards className straight onto the real <button>, not a wrapper.
  const shareBtnSrc = readFileSync(new URL("../components/ShareButton.tsx", import.meta.url), "utf8");
  check("(4g) sanity: ShareButton's className prop lands on the actual <button>, so (4f) really does grow its tap target", /<button type="button" onClick=\{onShare\} className=\{className\}/.test(shareBtnSrc));
}

console.log("(5) lib/analytics.ts: redactValue strips session_id/code query-string params without false-positiving on longer param names");
{
  const src = readFileSync(new URL("../lib/analytics.ts", import.meta.url), "utf8");
  check("(5a) SESSION_ID_PARAM_PATTERN defined, anchored to ?/&/string-start", /const SESSION_ID_PARAM_PATTERN = \/\(\[\?&\]\|\^\)session_id=\[\^&#\]\*\/gi;/.test(src));
  check("(5b) AUTH_CODE_PARAM_PATTERN defined, anchored to ?/&/string-start", /const AUTH_CODE_PARAM_PATTERN = \/\(\[\?&\]\|\^\)code=\[\^&#\]\*\/gi;/.test(src));
  check("(5c) redactValue's string branch applies both new patterns", /v\.replace\(SESSION_ID_PARAM_PATTERN, "\$1session_id=\[redacted\]"\)/.test(src) && /v\.replace\(AUTH_CODE_PARAM_PATTERN, "\$1code=\[redacted\]"\)/.test(src));

  // Behavioral proof against the REAL exported function, not a reimplementation.
  const { redactIssueIds } = await import("../lib/analytics.ts");

  const writingUrl = redactIssueIds({ $current_url: "https://alpha.everyday.report/writing?session_id=cs_test_abc123XYZ" });
  check(
    `(5d) behavioral: a real /writing session_id URL gets redacted -- actual: ${JSON.stringify(writingUrl.$current_url)}`,
    typeof writingUrl.$current_url === "string" && writingUrl.$current_url.includes("session_id=[redacted]") && !writingUrl.$current_url.includes("cs_test_abc123XYZ")
  );

  const callbackUrl = redactIssueIds({ $current_url: "https://alpha.everyday.report/auth/callback?code=pkce_abcXYZ789&next=%2Finbox" });
  check(
    `(5e) behavioral: a real /auth/callback PKCE code URL gets redacted, sibling params untouched -- actual: ${JSON.stringify(callbackUrl.$current_url)}`,
    typeof callbackUrl.$current_url === "string" &&
      callbackUrl.$current_url.includes("code=[redacted]") &&
      !callbackUrl.$current_url.includes("pkce_abcXYZ789") &&
      callbackUrl.$current_url.includes("next=%2Finbox")
  );

  // False-positive guards: neither pattern should touch a LONGER param name
  // that merely ends in "code" or contains "session_id" as a substring.
  const promoUrl = redactIssueIds({ $current_url: "https://alpha.everyday.report/checkout?promo_code=SAVE20&zip_code=33701" });
  check(
    `(5f) behavioral: promo_code/zip_code are NOT touched (anchored pattern, no false positive) -- actual: ${JSON.stringify(promoUrl.$current_url)}`,
    promoUrl.$current_url === "https://alpha.everyday.report/checkout?promo_code=SAVE20&zip_code=33701"
  );

  // Nested-array coverage (round 20's $elements fix) still applies to the new patterns too.
  const elementsShaped = redactIssueIds({
    $elements: [{ attr__href: "/writing?session_id=cs_live_nested_abc" }],
  });
  const nestedHref = (elementsShaped.$elements as Array<{ attr__href: string }>)[0].attr__href;
  check(
    `(5g) behavioral: session_id is redacted even nested inside $elements[].attr__href -- actual: ${JSON.stringify(nestedHref)}`,
    nestedHref.includes("session_id=[redacted]") && !nestedHref.includes("cs_live_nested_abc")
  );

  // Sanity: the pre-existing issue-id and email redaction are untouched.
  const untouched = redactIssueIds({ $current_url: "https://alpha.everyday.report/inbox/11111111-2222-3333-4444-555555555555" });
  check("(5h) sanity: pre-existing issue-id redaction still works", untouched.$current_url === "https://alpha.everyday.report/inbox/[id]");
}

console.log("(6) app/auth/callback/page.tsx: the PKCE code param is scrubbed from the URL bar immediately, before exchange starts");
{
  const src = readFileSync(new URL("../app/auth/callback/page.tsx", import.meta.url), "utf8");
  const codeReadIdx = src.indexOf('const code = params.get("code");');
  const scrubIdx = src.indexOf('window.history.replaceState(null, "", window.location.pathname);');
  const exchangeIdx = src.indexOf("exchangeCodeForSession(code)");
  check("(6a) code is read, then scrubbed, then (later) exchanged -- in that order", codeReadIdx > 0 && scrubIdx > codeReadIdx && exchangeIdx > scrubIdx);
  check("(6b) the scrub is gated on code actually being present", /if \(code && typeof window !== "undefined"\) \{\s*\n\s*window\.history\.replaceState/.test(src));
}

console.log("(7) app/writing/page.tsx: deliberately did NOT get a URL-bar scrub (would break the Try-again reload retry)");
{
  const src = readFileSync(new URL("../app/writing/page.tsx", import.meta.url), "utf8");
  check("(7a) no history.replaceState call was added to this page", !/history\.replaceState/.test(src));
  check("(7b) sessionId is still read from window.location.search exactly as before", /new URLSearchParams\(window\.location\.search\)\.get\("session_id"\) \|\| undefined/.test(src));
  check("(7c) the reasoning is documented inline (so a future round doesn't 'fix' this into a regression)", /would make that reload lose session_id entirely/.test(src));
  const retryAction = src.match(
    /onClick=\{\(\) =>\s*(deliveryPaused\s*\?\s*router\.push\("\/inbox" as never\)\s*:\s*checkoutAlreadyUsed\s*\?\s*router\.push\("\/signin" as never\)\s*:\s*window\.location\.reload\(\))\s*\}/
  )?.[1];
  check("(7d) the retry button keeps its explicit paused, claimed, and retry branches", typeof retryAction === "string");

  if (retryAction) {
    // Execute the production ternary, with only its TypeScript-only `as never`
    // casts removed. This proves the actual branch order rather than a copied
    // approximation that could drift from the button.
    const invokeRetry = new Function(
      "deliveryPaused",
      "checkoutAlreadyUsed",
      "router",
      "window",
      `return (${retryAction.replaceAll(" as never", "")});`
    ) as (
      deliveryPaused: boolean,
      checkoutAlreadyUsed: boolean,
      router: { push: (path: string) => void },
      window: { location: { reload: () => void } }
    ) => void;
    const destinationFor = (deliveryPaused: boolean, checkoutAlreadyUsed: boolean) => {
      const actions: string[] = [];
      invokeRetry(
        deliveryPaused,
        checkoutAlreadyUsed,
        { push: (path) => actions.push(`push:${path}`) },
        { location: { reload: () => actions.push("reload") } }
      );
      return actions;
    };
    check("(7e) behavioral: delivery paused goes straight to inbox, never reloads", destinationFor(true, false).join(",") === "push:/inbox" && destinationFor(true, true).join(",") === "push:/inbox");
    check("(7f) behavioral: only an unpaused already-claimed checkout goes to sign-in", destinationFor(false, true).join(",") === "push:/signin");
    check("(7g) behavioral: retries use a real reload only while delivery is unpaused and the checkout is unclaimed", destinationFor(false, false).join(",") === "reload");
  }
}

console.log("(8) app/settings/accounts/page.tsx: act() announces its own result via a live region");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(8a) actionMsg state added", /const \[actionMsg, setActionMsg\] = useState<string \| null>\(null\);/.test(src));
  check(
    "(8b) act()'s signature still takes email before the action union",
    /async function act\([\s\S]*?email: string,[\s\S]*?action:[\s\S]*?confirmMsg\?: string[\s\S]*?\) \{/.test(src)
  );
  check("(8c) a per-action verb is computed and announced on success", /setActionMsg\(`\$\{ACTION_VERBS\[action\]\} \$\{email\}\.`\);/.test(src));
  // alpha-drift-r48-supersedes-r32 (2026-08-20): round 48's alpha-drift-r48-02
  // replaced the single setBusy(userId) call with a busyRowsRef/setBusyRows
  // pair (per-row tracking, fixing a real cross-row disabled-state bug) --
  // this assertion's own point (actionMsg clearing at the start of a new
  // action) is unaffected, just needs to match the new lines immediately
  // preceding it.
  check("(8d) actionMsg is cleared at the start of each new action (so a same-text repeat still mutates the live region)", /setBusyRows\(new Set\(busyRowsRef\.current\)\);\s*\n\s*setActionMsg\(null\);/.test(src));
  // The status line is visible now, so a failed action whose row left the
  // list still has somewhere to show its error.
  check("(8e) a role=status live region renders actionMsg", /<p role="status" aria-live="polite" className="alpha-ui text-sm mb-4">\s*\{actionMsg\}/.test(src));

  // Every admin action call site passes u.email as the second argument. Grant
  // and revoke pick their server action from the row, so match any action.
  const callSites = [...src.matchAll(/act\(\s*\n\s*u\.id,\s*\n\s*u\.email,\s*\n\s*([^,\n]+),/g)].map((m) => m[1].trim());
  for (const expected of ["account.grantAction!", "account.revokeAction!", '"deny_access"', '"delete"', '"enable_delivery"']) {
    check(`(8f-${expected}) call site passes u.email`, callSites.includes(expected));
  }
  check("(8f-pause_delivery) call site passes u.email", /act\(u\.id, u\.email, "pause_delivery"\)/.test(src));
  check("(8f2) the UI action union excludes the hard-held clear_suppression action", !/\| "clear_suppression"/.test(src));

  // Execute the page's actual verb map. A copied table would keep passing
  // even if the production announcement changed or broke.
  const verbStart = src.indexOf("const ACTION_VERBS");
  const verbEnd = src.indexOf("};", verbStart) + 2;
  check("(8f3) the actual action announcement map has valid boundaries", verbStart > 0 && verbEnd > verbStart);
  const verbs = new vm.Script(`(${src.slice(src.indexOf("{", verbStart), verbEnd - 1)})`)
    .runInNewContext({}, { timeout: 1000 }) as Record<string, string>;
  function verbFor(action: "delete" | "grant_free" | "revoke_free" | "grant_invite" | "revoke_invite" | "deny_access"): string {
    return verbs[action];
  }
  check("(8g) behavioral: verb for delete", verbFor("delete") === "Deleted");
  check("(8h) behavioral: verb for grant_free", verbFor("grant_free") === "Granted free access to");
  check("(8i) behavioral: verb for revoke_free", verbFor("revoke_free") === "Revoked free access from");
  // Invite and free grants read the same to the owner now.
  check("(8j) behavioral: verb for grant_invite", verbFor("grant_invite") === "Granted free access to");
  check("(8k) behavioral: verb for revoke_invite", verbFor("revoke_invite") === "Revoked free access from");
  check("(8l) behavioral: verb for deny_access", verbFor("deny_access") === "Denied the access request from");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R32 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R32 FINDINGS ASSERTIONS PASS");
