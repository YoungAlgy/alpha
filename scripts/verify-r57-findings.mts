// Verify round 57 findings: 12 raised, 11 confirmed, 1 refuted.
// NOTE: 2 of the 11 confirmed fixes (lib/engine/source-rank.ts +
// lib/engine/url-guard.ts's MIRROR_SUBDOMAIN_RE dedup, and app/auth/
// callback/page.tsx's stale-citation comment fix) were found already
// applied to the working tree when this script was written -- a Workflow
// verify-stage subagent wrote directly to the real repo during its own
// "verify by testing the fix" process, unprompted by any explicit
// instruction to edit files. Both diffs were reviewed, confirmed correct
// and minimal, and kept (only retagged from a colliding alpha-drift-r57-01
// to r57-05/r57-06 respectively) rather than redone from scratch. Worth
// remembering as a real, observed behavior of this session's Workflow
// subagents -- not a sandboxed read-only verify step in practice.
// - components/ThemeApplier.tsx (self-audit-r56, HIGH): round 56's onStorage
//   fix armed the shared theme-edited flag on ANY write to the
//   alpha-onboarding localStorage key, not just an actual theme change --
//   an unrelated cross-tab profile/topics save could wrongly suppress the
//   DB-authoritative theme hydrate for the rest of that tab's life. Now
//   only arms the flag (and repaints) when the resolved theme actually
//   differs from what's currently applied.
// - app/inbox/page.tsx + app/inbox/[issueId]/page.tsx + app/archive/page.tsx
//   (accessibility-resweep-newer-code-r5): all 3 loadError blocks are
//   exclusively failure copy, wrongly on role="status" -- flipped to
//   role="alert", matching round 56's EmailChanger/resumeErr fixes.
// - app/settings/changelog/page.tsx (accessibility-resweep-newer-code-r5):
//   the month-group heading used the contrast-failing --accent-ink on
//   plain informational text -- swapped to --ink-soft.
// - lib/engine/source-rank.ts + lib/engine/url-guard.ts (duplicate-code-
//   audit-r7): source-rank.ts's hostOf() hand-rolled a www.-only strip
//   instead of reusing url-guard.ts's normalizeUrl's full mirror-subdomain
//   handling -- now shares the exported MIRROR_SUBDOMAIN_RE.
// - app/auth/callback/page.tsx (duplicate-code-audit-r7): the alpha-drift-
//   r53-05 comment miscited checkout's stripeErr and signin's err as
//   role="status" siblings -- both have been role="alert" since round
//   23/24. Rewrote the comment; ALSO re-touched this round after the
//   inbox/archive role=alert fixes above made its "inbox stays status"
//   claim stale again within the same round.
// - lib/theme.ts (silent-catch-audit-r3, MEDIUM): setTheme()'s DB persist
//   discarded the Supabase .update() response's `error` field entirely, so
//   the catch's own "Logged, not silent" comment was aspirational -- a
//   resolved {data:null, error} (the actual default failure mode) never
//   reached the catch. Now destructures and logs it.
// - components/ThemeApplier.tsx (silent-catch-audit-r3, LOW): the signed-in
//   hydrate's outer catch was bare -- also this file's sole gate for the
//   email-reconcile trigger, so a thrown failure here silently skipped
//   that too. Now logs via console.warn.
// - components/ProfileEditor.tsx + app/api/account/profile/route.ts
//   (form-validation-consistency-audit-r2, HIGH): city was required in
//   Settings' profile editor (client AND server) despite being optional
//   everywhere else in the app (DB schema, checkout gate, generate schema,
//   webhook insert) -- a real, code-comment-anticipated direct-checkout
//   user could reach Settings with city="" and get Save permanently
//   disabled with zero explanation. Loosened city to optional in both
//   files, matching the rest of the app; added a visible required-field
//   indicator (mirroring SupportForm.tsx's Field) so a future blocked Save
//   is never silent again.
// - app/support/SupportForm.tsx (form-validation-consistency-audit-r2,
//   LOW): validated a trimmed email copy but sent the raw untrimmed state
//   to the server -- now trims before both the check and the fetch body.
// REFUTED (1): a 2nd, independent report of the exact same auth/callback
// comment fix from accessibility-resweep-newer-code-r5 -- by the time its
// verify votes ran, duplicate-code-audit-r7's version of the same fix had
// already landed in the working tree, so there was nothing left to change.
// A genuinely new refutation shape for this marathon: "already fixed by a
// sibling finding earlier in the same round," not a reachability/severity
// call.
// alpha-drift-r57-01 through r57-09, all 2026-08-20.
// Run: npx tsx scripts/verify-r57-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) components/ProfileEditor.tsx + app/api/account/profile/route.ts: city is now optional everywhere, with a visible required-field indicator");
{
  const editor = readFileSync(new URL("../components/ProfileEditor.tsx", import.meta.url), "utf8");
  check("(1a) requiredFilled no longer checks city", /const requiredFilled = form\.firstName\.trim\(\)\.length > 0;/.test(editor));
  check("(1b) Field accepts a required prop", /required\?: boolean;/.test(editor));
  // alpha-drift-r58-02 recolored this from --accent-ink (WCAG-failing) to
  // --ink -- loosened to allow either, this assertion only cares that the
  // asterisk itself renders.
  check("(1c) the required asterisk renders when required is true", /\{required && <span style=\{\{ color: "var\(--(?:accent-ink|ink)\)" \}\}> \*<\/span>\}/.test(editor));
  check("(1d) First name is marked required", /label="First name"[\s\S]{0,200}?required/.test(editor));

  const route = readFileSync(new URL("../app/api/account/profile/route.ts", import.meta.url), "utf8");
  check("(1e) city no longer goes through cleanRequired", !/const city = cleanRequired\(body\.city/.test(route));
  check("(1f) the empty-city 400 branch is gone", !/Add your city so the letter can flag what's nearby\./.test(route));
  check("(1g) city now goes through cleanOptional in the updates object", /city: cleanOptional\(body\.city, LIMITS\.city\),/.test(route));
}

console.log("(2) components/ThemeApplier.tsx: onStorage only arms the theme-edited flag on an actual theme change");
{
  const src = readFileSync(new URL("../components/ThemeApplier.tsx", import.meta.url), "utf8");
  check("(2a) onStorage compares the resolved theme against the currently-applied one before acting", /if \(next && next !== document\.documentElement\.getAttribute\("data-theme"\)\) \{\s*\n\s*markThemeEditedThisLoad\(\);\s*\n\s*set\(next\);\s*\n\s*\}/.test(src));
}

console.log("(3) app/inbox/page.tsx + app/inbox/[issueId]/page.tsx + app/archive/page.tsx: loadError blocks now use role=\"alert\"");
{
  const inbox = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  check("(3a) inbox's loadError h1 is role=\"alert\"", /role="alert">\s*\n\s*Couldn&apos;t load your letters\./.test(inbox));

  const issue = readFileSync(new URL("../app/inbox/[issueId]/page.tsx", import.meta.url), "utf8");
  check("(3b) inbox/[issueId]'s loadError h1 is role=\"alert\"", /role="alert">\s*\n\s*Couldn&apos;t load that letter\./.test(issue));

  const archive = readFileSync(new URL("../app/archive/page.tsx", import.meta.url), "utf8");
  check("(3c) archive's error block is role=\"alert\"", /role="alert" className="space-y-4">/.test(archive));
}

console.log("(4) app/settings/changelog/page.tsx: the month-group heading no longer uses --accent-ink");
{
  const src = readFileSync(new URL("../app/settings/changelog/page.tsx", import.meta.url), "utf8");
  check("(4a) the h2 now uses --ink-soft", /\{month\.toUpperCase\(\)\}/.test(src) && /style=\{\{ color: "var\(--ink-soft\)" \}\}\s*\n\s*>\s*\n\s*\{month\.toUpperCase\(\)\}/.test(src));
}

console.log("(5) lib/engine/source-rank.ts + lib/engine/url-guard.ts: hostOf() now shares MIRROR_SUBDOMAIN_RE");
{
  const guard = readFileSync(new URL("../lib/engine/url-guard.ts", import.meta.url), "utf8");
  check("(5a) MIRROR_SUBDOMAIN_RE is now exported", /export const MIRROR_SUBDOMAIN_RE = \/\^\(\?:www\|amp\|m\|mobile\)\\\.\/;/.test(guard));

  const rank = readFileSync(new URL("../lib/engine/source-rank.ts", import.meta.url), "utf8");
  check("(5b) source-rank.ts imports it", /import \{ normalizeUrl, MIRROR_SUBDOMAIN_RE \} from "\.\/url-guard";/.test(rank));
  check("(5c) hostOf() uses it instead of a hand-rolled www.-only regex", /\.replace\(MIRROR_SUBDOMAIN_RE, ""\)/.test(rank));
}

console.log("(6) app/auth/callback/page.tsx: the stale alpha-drift-r53-05 citation is corrected, and its own follow-on fix is also current post-inbox/archive");
{
  const src = readFileSync(new URL("../app/auth/callback/page.tsx", import.meta.url), "utf8");
  check("(6a) no longer claims checkout/signin's err are role=\"status\" siblings", !/unlike every sibling "here's what\s*\n\s*happened" status text/.test(src));
  check("(6b) cites the r56-02 EmailChanger convention correctly", /r56-02/.test(src));
  check("(6c) no longer claims inbox's loadError h1 stays role=\"status\" (flipped to alert this same round)", !/The one genuine role="status" sibling is app\/inbox\/page\.tsx's/.test(src));
}

console.log("(7) lib/theme.ts: setTheme()'s DB persist no longer discards a resolved error");
{
  const src = readFileSync(new URL("../lib/theme.ts", import.meta.url), "utf8");
  check("(7a) the update() call now destructures error", /const \{ error \} = await sb\.from\("users"\)\.update\(\{ theme: id \}\)\.eq\("id", user\.id\);/.test(src));
  check("(7b) a resolved error is logged", /if \(error\) console\.warn\("\[setTheme\] DB persist failed:", error\.message\);/.test(src));
}

console.log("(8) components/ThemeApplier.tsx: the signed-in hydrate's outer catch is no longer bare");
{
  const src = readFileSync(new URL("../components/ThemeApplier.tsx", import.meta.url), "utf8");
  check("(8a) the catch now captures and logs the error", /console\.warn\("\[ThemeApplier\] signed-in hydrate failed:", e instanceof Error \? e\.message : e\);/.test(src));
}

console.log("(9) app/support/SupportForm.tsx: email is now trimmed before both validation and send");
{
  const src = readFileSync(new URL("../app/support/SupportForm.tsx", import.meta.url), "utf8");
  check("(9a) cleanEmail is derived once and validated", /const cleanEmail = email\.trim\(\);\s*\n\s*if \(!isValidEmail\(cleanEmail\)\) \{/.test(src));
  check("(9b) the fetch body sends the trimmed copy", /body: JSON\.stringify\(\{ name, email: cleanEmail, message \}\),/.test(src));
}

console.log("(10) sanity: the refuted duplicate auth/callback finding correctly resulted in no separate change (already fixed by its sibling)");
{
  const src = readFileSync(new URL("../app/auth/callback/page.tsx", import.meta.url), "utf8");
  // Only one alpha-drift-r53-05/r57-xx comment block should exist here, not two competing rewrites.
  check("(10a) exactly one alpha-drift-r53-05 tag remains (not duplicated by a second, conflicting rewrite)", (src.match(/alpha-drift-r53-05/g) || []).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R57 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R57 FINDINGS ASSERTIONS PASS");
