// Verify round 63 findings: 8 raised, 6 confirmed (2 refuted -- a stale
// .env.local credential-rotation claim and a test-harness robustness
// suggestion for verify-url-guard.mts, both respected and left alone). The
// 6 confirmed findings resolve to 5 distinct fixes: two of them
// (app/settings/page.tsx's discarded hydrate/requestTier errors) were
// independently raised by silent-catch-audit-r9 AND
// form-validation-consistency-audit-r8 as the exact same bug -- implemented
// once. First round with zero split votes on any finding (round 62) turned
// out not to be a fluke of that one round -- round 63 also came back
// unanimous on every finding.
// - app/settings/accounts/page.tsx (self-audit-r62, MEDIUM): round 62's own
//   statsStale fix (61c14a2) applied `opacity: statsStale ? 0.6 : 1` to the
//   WHOLE OPERATIONAL STATE card -- group opacity composites background AND
//   text as one layer, dropping --ink-soft below WCAG AA 4.5:1 in all 26
//   themes, directly defeating the fix's own stated intent ("keeps the
//   last-known numbers visible... just flag them as unverified"). Same
//   round, same bug class its own 82f2a00 commit was busy purging
//   elsewhere. Switched to a border-color-only staleness cue -- text stays
//   at full, already-tuned contrast.
// - app/globals.css + components/ProfileEditor.tsx (accessibility-resweep-
//   newer-code-r11, MEDIUM): round 62's opacity-on-ink-soft sweep only
//   pattern-matched inline style={{...}} literals, missing .alpha-kbd-hint
//   (a shared CSS class, used on 4 onboarding pages) and a third
//   ProfileEditor site using a ternary form the round-62 regex didn't
//   match. Same fix: drop the opacity, --ink-soft already clears 4.5:1
//   everywhere on its own.
// - components/FirstLetterCelebration.tsx + app/writing/page.tsx
//   (accessibility-resweep-newer-code-r11, LOW): the first-letter
//   celebration overlay (full-screen scale 0.6->1.3 on an up-to-18rem
//   glyph) had no prefers-reduced-motion guard, inconsistent with the
//   app's own intro-veil convention (app/layout.tsx's INTRO_SCRIPT +
//   globals.css's alpha-intro-active media block) for the structurally
//   identical animation. Gated via matchMedia, mirroring the intro script.
//   Folded in a flagged sibling: app/writing/page.tsx's infinite
//   scale+rotate breathe/settle animation on the ~45s generation-wait
//   screen -- arguably worse (infinite + rotation + longer duration) --
//   gated via a `!important` media-query override (inline-style animation
//   can't be overridden by a plain stylesheet rule).
// - app/theme/page.tsx + lib/user-sync.ts (silent-catch-audit-r9, LOW +
//   folded-in sibling): theme/page.tsx's signed-in-detection getSession()
//   discarded its error -- unlike auth.getUser() (deliberately left alone
//   elsewhere, since signed-out IS its normal error), getSession() returns
//   error:null for a genuine signed-out visitor, so logging here is not
//   noisy. A real failure used to misroute a signed-in reader's Continue
//   into onboarding /name instead of /settings. Two of three verify votes
//   flagged a structurally identical but higher-impact sibling:
//   lib/user-sync.ts's deleteUserAccount() returned `{ ok: true }` on ANY
//   falsy session including a genuine getSession() failure -- reporting a
//   successful account deletion when NOTHING was deleted (the delete
//   fetch never ran), with the caller's `if (!result.ok) alert(...)` never
//   firing. Given real harm (a reader believes they cancelled and are
//   still being billed), fixed behaviorally: a genuine session-check error
//   now returns `{ ok: false, error }` instead of a false `{ ok: true }`.
// - app/settings/page.tsx (silent-catch-audit-r9 + form-validation-
//   consistency-audit-r8, MEDIUM, same bug found twice): the main mount
//   hydrate's row read, its surrounding catch's silent ignore, and
//   requestTier()'s best-effort quota re-read all discarded their errors
//   -- the same class already fixed this round-set at topics/theme/
//   ProfileEditor/ThemeApplier. Folded in a sibling one vote flagged: the
//   "Download my data" handler's getSession() call silently fell into the
//   same degraded local-only export as a genuine "not signed in" result,
//   with no alert, unlike its own sibling !res.ok branch two lines below
//   -- now alerts on a real session-check failure too, so a reader who
//   asked for their FULL data (promised by privacy.tsx) isn't silently
//   handed a device-only subset with no cue.
// alpha-drift-r63-01 through r63-05, all 2026-08-21.
// Run: npx tsx scripts/verify-r63-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/settings/accounts/page.tsx: the OPERATIONAL STATE card uses a border-color cue, not opacity, for staleness");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(1a) opacity is no longer conditionally applied to the card", !/opacity: statsStale \? 0\.6 : 1,/.test(src));
  check("(1b) borderColor now carries the staleness cue instead", /borderColor: statsStale \? "var\(--ink-soft\)" : "var\(--rule\)",/.test(src));
}

console.log("(2) app/globals.css + components/ProfileEditor.tsx: opacity removed from 2 more --ink-soft sites round 62's regex missed");
{
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  check("(2a) .alpha-kbd-hint no longer carries opacity: 0.7", !/color: var\(--ink-soft\);\s*\n\s*opacity: 0\.7;\s*\n\}/.test(css));

  const editor = readFileSync(new URL("../components/ProfileEditor.tsx", import.meta.url), "utf8");
  check("(2b) ProfileEditor's ternary-form opacity (Zodiac/birthday hint) is gone", !/opacity: \(form\.birthday\.length > 0 && !birthdayValid\) \|\| \(hasZodiac && !form\.birthday\) \? 1 : 0\.8,/.test(editor));
}

console.log("(3) components/FirstLetterCelebration.tsx + app/writing/page.tsx: both large-amplitude full-screen animations now respect prefers-reduced-motion");
{
  const celebration = readFileSync(new URL("../components/FirstLetterCelebration.tsx", import.meta.url), "utf8");
  check("(3a) the effect checks matchMedia before setting visible", /if \(typeof window !== "undefined" && window\.matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)\.matches\) return;/.test(celebration));
  check("(3b) the check sits before setVisible(true)", /matches\) return;\s*\n\s*setVisible\(true\);/.test(celebration));

  const writing = readFileSync(new URL("../app/writing/page.tsx", import.meta.url), "utf8");
  check("(3c) the writing-mark span carries an identifying className", /alpha-display alpha-writing-mark text-7xl md:text-8xl font-bold inline-block/.test(writing));
  check("(3d) a reduced-motion media query disables the animation", /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.alpha-writing-mark \{ animation: none !important; \}\s*\n\s*\}/.test(writing));
}

console.log("(4) app/theme/page.tsx + lib/user-sync.ts: getSession() errors now logged/reported instead of misread as \"signed out\"");
{
  const theme = readFileSync(new URL("../app/theme/page.tsx", import.meta.url), "utf8");
  check("(4a) theme/page.tsx's getSession error is destructured and logged", /const \{ data: \{ session \}, error: sessionErr \} = await sb\.auth\.getSession\(\);/.test(theme) && /if \(sessionErr\) console\.warn\("\[theme\] signed-in hydrate getSession failed:", sessionErr\.message\);/.test(theme));

  const sync = readFileSync(new URL("../lib/user-sync.ts", import.meta.url), "utf8");
  check("(4b) deleteUserAccount's getSession error is destructured", /const \{ data: \{ session \}, error: sessionErr \} = await sb\.auth\.getSession\(\);/.test(sync));
  check("(4c) a genuine error now returns ok:false instead of a false ok:true", /if \(sessionErr\) \{\s*\n\s*return \{ ok: false, error: `Couldn't verify your session: \$\{sessionErr\.message\}` \};\s*\n\s*\}/.test(sync));
  check("(4d) the genuine-no-session case still returns ok:true unchanged", /if \(!session\) return \{ ok: true \};/.test(sync));
}

console.log("(5) app/settings/page.tsx: 4 discarded-error sites fixed (mount hydrate row read, its catch, requestTier's re-read, and the export handler's getSession)");
{
  const src = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(5a) the mount hydrate's row-read error is destructured and logged", /const \{ data: row, error: rowErr \} = await sb\s*\n\s*\.from\("users"\)\s*\n\s*\.select\("topic_quota, topics, subscribed_at, cancelled_at, stripe_customer_id, unsubscribed_at"\)/.test(src) && /if \(rowErr\) console\.warn\("\[settings\] hydrate row fetch failed:", rowErr\.message\);/.test(src));
  check("(5b) the surrounding catch now logs a thrown failure", /\} catch \(e\) \{\s*\n\s*\/\/ alpha-drift-r63-05: logged, not silent/.test(src));
  check("(5c) requestTier's quota re-read error is destructured and logged", /const \{ data: row, error: rowErr \} = await sb\s*\n\s*\.from\("users"\)\s*\n\s*\.select\("topic_quota"\)/.test(src) && /if \(rowErr\) console\.warn\("\[settings\] requestTier quota re-read failed:", rowErr\.message\);/.test(src));
  check("(5d) requestTier's own catch also logs now", /console\.warn\("\[settings\] requestTier hydrate threw:", e instanceof Error \? e\.message : e\);/.test(src));
  check("(5e) the export handler's getSession error is destructured and alerts on a real failure", /const \{ data: \{ session \}, error: sessionErr \} = await sb\.auth\.getSession\(\);\s*\n\s*if \(sessionErr\) \{/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R63 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R63 FINDINGS ASSERTIONS PASS");
