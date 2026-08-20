// Verify round 62 findings: 10 raised, all 10 confirmed by the panel (Opus
// verify stage, per Algy's reminder to route judgment-heavy passes through
// it) and implemented as proposed.
// - app/settings/accounts/page.tsx (self-audit-r61, MEDIUM): round 61's own
//   Promise.allSettled fix in admin/users/route.ts lets a stats-only
//   failure return a real 200 with `stats: null`, but this page's
//   `if (data.stats)` no-op'd on null with no else -- every reload AFTER
//   the first (act()'s own finally block fires one after every admin
//   action) left the PRIOR stats object rendered under a green success
//   message, indistinguishable from fresh. Added a statsStale flag: keeps
//   the last-known numbers visible (doesn't undo r61 by blanking the card
//   again) but dims the card and annotates both the header count and the
//   OPERATIONAL STATE heading so staleness is disclosed, not hidden.
// - app/topics/page.tsx (self-audit-r61, LOW): the round-61 focus-
//   restoration comment cited "accountsHeadingRef/deleteCount" -- but the
//   SAME commit (319874b) renamed that identifier to actionCount in
//   app/settings/accounts/page.tsx, so the comment was stale the moment it
//   shipped. One-word fix.
// - app/support/SupportForm.tsx + 4 siblings (accessibility-resweep-newer-
//   code-r10, MEDIUM): `opacity: 0.6` stacked on the already WCAG-tuned
//   --ink-soft token drops it below the 4.5:1 AA floor in every one of the
//   app's 26 themes (worst: mono ~2.35:1) -- --ink-soft alone already
//   clears 4.5:1 everywhere, so dropping the opacity is the whole fix. The
//   verify panel found 4 structurally identical siblings during
//   verification (app/writing/page.tsx, components/Digest.tsx,
//   components/ProfileEditor.tsx x2) and folded them into the same pass
//   per the standing rule about leaving a sibling behind.
// - scripts/verify-deepseek-fallback.mts (duplicate-code-audit-r12,
//   MEDIUM): section 2's comment claimed "a real blurb can ONLY come from
//   DeepSeek in this state" -- but topic-blurb.ts's real escalation chain
//   runs DeepSeek's draft through the voice-guard and, on a slip, escalates
//   FURTHER to Haiku/Sonnet (both forced down here too), a genuinely harder
//   bar than production ever faces. Its sibling verify-groq-fallback.mts
//   already carries this exact caveat (added when DeepSeek joined the
//   chain) -- this script never got the matching update. Comment/log-line
//   fix only, matching the sibling's established pattern exactly (which
//   still hard-fails on a throw -- this is documentation so a future
//   failure isn't misread as a regression, not a behavior change).
// - app/topics/page.tsx, app/theme/page.tsx, components/ProfileEditor.tsx,
//   components/ThemeApplier.tsx, app/api/generate/route.ts (silent-catch-
//   audit-r8, HIGH x3 + MEDIUM x2): five more discarded-Supabase-{data,
//   error} hydrate/lookup reads, the same recurring class this marathon has
//   swept for 7 straight outings. Each surrounding catch's own comment
//   claimed to cover the failure ("logged, not silent"), but supabase-js
//   resolves rather than throws on a query error, so none of them actually
//   could. ProfileEditor's case is the most severe (real, silent, multi-
//   field DATA CLEARING on a subsequent Save) and got a behavioral fix
//   (blocks Save, not just a log) rather than diagnostics-only, per the
//   panel's explicit recommendation. generate/route.ts's verifyPaid() fix
//   also folded in two sibling gaps the panel found during verification:
//   the empty `catch` above it, and the issue-number lookup 280 lines
//   below (both discarded their errors the identical way).
// - lib/user-sync.ts (form-validation-consistency-audit-r7, HIGH): 6 of 7
//   profile fields in syncUserProfile() were read unconditionally off the
//   merged `state` snapshot instead of gated on "did THIS call's patch
//   actually intend to touch it" -- the exact class round 60 fixed for
//   `topics` alone. A stale second-device localStorage snapshot could
//   silently revert a just-edited city/birthday/gender/blurb back into the
//   DB via an unrelated topics-only save. Mirrored the existing gate onto
//   all 6 remaining fields.
// alpha-drift-r62-01 through r62-10, all 2026-08-20.
// Run: npx tsx scripts/verify-r62-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/settings/accounts/page.tsx: a stats-only load failure is now visibly flagged, not silently rendered as fresh");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(1a) statsStale state is declared", /const \[statsStale, setStatsStale\] = useState\(false\);/.test(src));
  check("(1b) load() sets statsStale false on a real stats payload", /if \(data\.stats\) \{\s*\n\s*setStats\(data\.stats\);\s*\n\s*setStatsStale\(false\);/.test(src));
  check("(1c) load() sets statsStale true when stats is missing", /\} else \{\s*\n[\s\S]{0,250}setStatsStale\(true\);\s*\n\s*\}/.test(src));
  check("(1d) the header count annotates staleness", /\$\{stats\.totalUsers\}\$\{statsStale \? " \(unverified\)" : ""\}/.test(src));
  // alpha-drift-r63-01 (2026-08-21, self-audit-r62) found the opacity dim
  // itself was a real WCAG contrast regression (group opacity composites
  // the --ink-soft text too, dropping it below 4.5:1 in all 26 themes) --
  // replaced with a border-color-only cue. Loosened to allow either shape.
  // See verify-r63-findings.mts's (1).
  check("(1e) the OPERATIONAL STATE card carries a visible staleness cue and annotates on stale stats", (/opacity: statsStale \? 0\.6 : 1,/.test(src) || /borderColor: statsStale \? "var\(--ink-soft\)" : "var\(--rule\)",/.test(src)) && /statsStale && \(/.test(src));
}

console.log("(2) app/topics/page.tsx: the focus-restoration comment now cites the real (renamed) sibling identifier");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
  check("(2a) no longer cites the stale 'deleteCount' name", !/accountsHeadingRef\/deleteCount/.test(src));
  check("(2b) now cites the real 'actionCount' name", /accountsHeadingRef\/actionCount convention already/.test(src));
}

console.log("(3) SupportForm.tsx + 4 siblings: opacity removed from --ink-soft text, restoring the already-tuned WCAG AA floor");
{
  const support = readFileSync(new URL("../app/support/SupportForm.tsx", import.meta.url), "utf8");
  check("(3a) SupportForm's OPTIONAL span no longer carries opacity 0.6", !/opacity: 0\.6 \}\}> · OPTIONAL/.test(support));
  check("(3b) OPTIONAL span still renders, just without the opacity style", /<span> · OPTIONAL<\/span>/.test(support));

  const writing = readFileSync(new URL("../app/writing/page.tsx", import.meta.url), "utf8");
  check("(3c) writing/page.tsx's 'Technical:' line no longer carries opacity 0.7", !/color: "var\(--ink-soft\)", opacity: 0\.7/.test(writing));

  const digest = readFileSync(new URL("../components/Digest.tsx", import.meta.url), "utf8");
  check("(3d) Digest.tsx's disclaimer no longer carries opacity 0.75", !/color: "var\(--ink-soft\)", opacity: 0\.75/.test(digest));

  const editor = readFileSync(new URL("../components/ProfileEditor.tsx", import.meta.url), "utf8");
  check("(3e) ProfileEditor.tsx's gender hint + field hint no longer carry opacity 0.8 (2 sites)", !/color: "var\(--ink-soft\)", opacity: 0\.8/.test(editor));
}

console.log("(4) scripts/verify-deepseek-fallback.mts: section 2 now documents the harder-than-production escalation case, mirroring verify-groq-fallback.mts");
{
  const src = readFileSync(new URL("./verify-deepseek-fallback.mts", import.meta.url), "utf8");
  check("(4a) no longer asserts the unconditional 'can ONLY come from DeepSeek' claim as fact", !/A real blurb can ONLY come from\s*\n\/\/ DeepSeek in this state\.$/m.test(src));
  check("(4b) now documents the harder-than-production escalation case", /genuinely harder bar than\s*\n\/\/ production ever faces/.test(src));
  check("(4c) the console.log line states the honest weaker expectation", /or this run legitimately hit the harder-than-production case/.test(src));
}

console.log("(5) app/topics/page.tsx: signed-in hydrate now logs both the getSession and row-read errors");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
  check("(5a) getSession error is destructured and logged", /const \{ data: \{ session \}, error: sessionErr \} = await sb\.auth\.getSession\(\);/.test(src) && /if \(sessionErr\) console\.warn\("\[topics\] signed-in hydrate getSession failed:", sessionErr\.message\);/.test(src));
  check("(5b) row-read error is destructured and logged", /const \{ data: row, error: rowErr \} = await sb/.test(src) && /if \(rowErr\) console\.warn\("\[topics\] signed-in hydrate row fetch failed:", rowErr\.message\);/.test(src));
}

console.log("(6) app/theme/page.tsx: signed-in hydrate now logs its row-read error");
{
  const src = readFileSync(new URL("../app/theme/page.tsx", import.meta.url), "utf8");
  check("(6a) row-read error is destructured and logged", /const \{ data: row, error: rowErr \} = await sb/.test(src) && /if \(rowErr\) console\.warn\("\[theme\] signed-in hydrate row fetch failed:", rowErr\.message\);/.test(src));
}

console.log("(7) components/ProfileEditor.tsx: a hydrate failure now blocks Save (not just logs) since the real harm is silent data clearing");
{
  const src = readFileSync(new URL("../components/ProfileEditor.tsx", import.meta.url), "utf8");
  check("(7a) hydrateFailed state is declared", /const \[hydrateFailed, setHydrateFailed\] = useState\(false\);/.test(src));
  check("(7b) row-read error is destructured, logged, and sets hydrateFailed", /const \{ data: row, error: rowErr \} = await sb/.test(src) && /console\.warn\("\[ProfileEditor\] signed-in hydrate row fetch failed:", rowErr\.message\);/.test(src) && /setHydrateFailed\(true\);/.test(src));
  check("(7c) canSave is gated on !hydrateFailed", /const canSave = dirty && requiredFilled && birthdayValid && !busy && !hydrateFailed;/.test(src));
  check("(7d) a visible role=alert banner explains the block", /hydrateFailed && \(\s*\n\s*<p role="alert"/.test(src));
}

console.log("(8) components/ThemeApplier.tsx: the users theme/email read now logs its error (getUser() deliberately left alone -- signed-out is its normal case)");
{
  const src = readFileSync(new URL("../components/ThemeApplier.tsx", import.meta.url), "utf8");
  check("(8a) the users read error is destructured and logged", /const \{ data, error: rowErr \} = await sb/.test(src) && /if \(rowErr\) console\.warn\("\[ThemeApplier\] signed-in hydrate row fetch failed:", rowErr\.message\);/.test(src));
  check("(8b) auth.getUser() is deliberately untouched (still a bare destructure)", /const \{\s*\n\s*data: \{ user \},\s*\n\s*\} = await sb\.auth\.getUser\(\);/.test(src) || /const \{ data: \{ user \} \} = await sb\.auth\.getUser\(\);/.test(src));
}

console.log("(9) app/api/generate/route.ts: verifyPaid's subscription check + its empty catch + the sibling issue-number lookup all now log their errors");
{
  const src = readFileSync(new URL("../app/api/generate/route.ts", import.meta.url), "utf8");
  check("(9a) the subscription lookup error is destructured and logged", /const \{ data, error: subErr \} = await svc/.test(src) && /if \(subErr\) console\.warn\("\[generate\] verifyPaid subscription lookup failed:", subErr\.message\);/.test(src));
  check("(9b) the empty catch above it now logs a real thrown failure", /catch \(e\) \{\s*\n\s*\/\/ alpha-drift-r62-09: logged, not silent/.test(src));
  check("(9c) the issue-number lookup's error is destructured and re-thrown into its existing catch", /const \{ count, error: countErr \} = await sb/.test(src) && /if \(countErr\) throw countErr;/.test(src));
}

console.log("(10) lib/user-sync.ts: all 6 remaining profile fields are now gated on \"field\" in patch, mirroring the existing topics gate");
{
  const src = readFileSync(new URL("../lib/user-sync.ts", import.meta.url), "utf8");
  for (const field of ["firstName", "city", "jobBlurb", "projectBlurb", "funBlurb", "birthday", "gender"]) {
    check(`(10) "${field}" in patch gate is present`, new RegExp(`if \\("${field}" in patch\\) \\{`).test(src));
  }
  // The topics gate (round 60) must still be intact and untouched.
  check("(10) the existing topics gate is unchanged", /if \("topics" in patch && Array\.isArray\(state\.topics\) && state\.topics\.length > 0\) \{/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R62 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R62 FINDINGS ASSERTIONS PASS");
