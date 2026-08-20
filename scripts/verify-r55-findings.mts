// Verify round 55 findings: 10 raised, 10 auto-confirmed by the 3-vote
// panel -- but 2 of those 10 (both --accent-ink-on-link-text findings, on
// components/Digest.tsx and components/EmailChanger.tsx) were personally
// overturned after implementation began, so only 8 are actually fixed here.
// - app/topics/page.tsx (self-audit-r54, 2 confirmed): a 5th live-edit path
//   into `picked` (the curated-topic-suggestion button) never set
//   userEditedRef, so round 54's own hydrate-vs-live-edit guard didn't know
//   about it -- fixed. Separately, that same guard also bundled the
//   unrelated topic_quota hydrate (setTarget) under the picked-only latch,
//   permanently sticking a signed-in subscriber's quota at DEFAULT_TARGET=5
//   after a single early tap, with no server-side minimum-quota check to
//   catch the resulting under-filled save -- split the gate so setTarget
//   runs unconditionally. Also moved addCustom()'s ref assignment past its
//   own validation returns, so a no-op Add attempt doesn't spuriously arm
//   the latch.
// - components/LetterTOC.tsx (accessibility-resweep-newer-code-r3): the
//   letter's sticky section-jump buttons were under the WCAG 2.5.8 24px
//   touch-target minimum -- added the app's established py-2/-my-2 pattern.
// - components/ThemeApplier.tsx + lib/theme.ts + lib/theme-edit-tracker.ts
//   (hydrate-vs-live-edit-race-audit, its debut round): the SAME hydrate-
//   vs-live-edit race round 54 fixed on app/topics/page.tsx and app/theme/
//   page.tsx, but in ThemeApplier (mounted on every route) vs setTheme()
//   (called by ThemeSwitcher and app/theme/page.tsx) -- two separate
//   component trees with no shared useRef to reach for, so this needed a
//   new standalone module-scoped flag instead of a component-local ref.
// - README.md (rls-migration-drift-audit-r4): the "RLS-by-default" claim
//   that support_tickets "has policies scoped to auth.uid()" was stale --
//   its one policy was dropped 2026-08-05 as dead code, so it now has RLS
//   enabled with ZERO policies (all access via service role).
// - app/api/stripe/update-quantity/route.ts (rls-migration-drift-audit-r4):
//   the comment justifying the service-role client blamed a nonexistent
//   "self-read only" RLS restriction -- public.users' self-read policy
//   works fine via the user's own JWT (round 51 already established this
//   for app/api/resume/route.ts). The real reason is the later topic_quota
//   write, a column protect_user_privileged_columns_trg locks for any
//   non-service_role caller.
// - app/welcome/page.tsx + app/you/page.tsx (duplicate-code-audit-r5): both
//   had the identical getSession()-then-router.replace("/inbox") shape as
//   components/onboarding/QuestionStep.tsx, but without QuestionStep's own
//   cancellation guard (added round 48) -- welcome/page.tsx never had one
//   at all; you/page.tsx's comment claimed to "mirror" QuestionStep's guard
//   but that claim went stale the moment QuestionStep's guard was upgraded
//   in round 48. Both now match QuestionStep's real, current shape.
//
// PERSONALLY OVERTURNED (2 of the panel's 10 "CONFIRM" verdicts, not
// implemented): Digest.tsx's primaryRef/legacy-source links and
// EmailChanger's 3 link/button texts, both flagging plain --accent-ink
// link-text contrast. Independently grepped the codebase: this exact
// `color: var(--accent-ink)` + underline pattern is the app's established,
// deliberate link/CTA styling, used on 22+ sites across 25 files (settings/
// page.tsx alone has ~9, signin/page.tsx has 2 more) -- NOT an isolated
// miss on 2-5 sites the way the panel's per-file framing suggested. Rounds
// 21/23/24/25's own --accent-ink sweeps were deliberately scoped to role=
// alert/status TEXT only (scripts/verify-accent-ink-error-text-contrast.mts
// explicitly says so), leaving link/CTA/decorative usages untouched by
// design. Fixing only 2-5 of 22+ structurally identical sites would be an
// arbitrary, inconsistent partial fix, not a real accessibility
// improvement -- and a full 22+-site sweep would be a real, highly-visible,
// unrequested site-wide visual change (removing the accent-gold link-color
// convention everywhere), the kind of design-system-scale decision this
// marathon's established practice (round 28's Cloudflare-isolate
// disclosure, round 34's Billing-Portal handoff) says to disclose for
// Algy's sign-off rather than unilaterally execute in either direction.
// Deliberately left unfixed pending that sign-off -- NOT a miss, NOT a
// silent drop of a confirmed finding.
// alpha-drift-r55-01 through r55-06, all 2026-08-20.
// Run: npx tsx scripts/verify-r55-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/topics/page.tsx: the curated-suggestion button now arms userEditedRef, matching the other 4 live-edit paths");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
  check("(1a) the curated-suggestion onClick sets userEditedRef.current = true before setPicked", /onClick=\{\(\) => \{\s*\n(?:[^\n]*\n){0,6}?\s*userEditedRef\.current = true;\s*\n(?:[^\n]*\n){0,3}?\s*setPicked\(\(p\) => \(p\.includes\(sug\)/.test(src));
  check("(1b) all 5 live-edit call sites (toggle/addCustom/removeAt/move/suggestion) now set the ref -- exactly 5 occurrences", (src.match(/userEditedRef\.current = true;/g) || []).length === 5);
}

console.log("(2) app/topics/page.tsx: setTarget now runs unconditionally on hydrate, decoupled from userEditedRef");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
  check("(2a) setTarget is no longer inside the userEditedRef-gated block", !/if \(!userEditedRef\.current\) \{\s*\n\s*if \(row\?\.topic_quota/.test(src));
  check("(2b) setTarget(clampQuota(...)) now runs before the userEditedRef check, unconditionally", /if \(row\?\.topic_quota && typeof row\.topic_quota === "number"\) \{\s*\n\s*setTarget\(clampQuota\(row\.topic_quota\)\);\s*\n\s*\}\s*\n(?:[^\n]*\n){0,6}?\s*if \(!userEditedRef\.current\) \{/.test(src));
  check("(2c) setPicked(row.topics) is still gated behind userEditedRef", /if \(!userEditedRef\.current\) \{\s*\n(?:[^\n]*\n){0,4}?\s*setPicked\(row\.topics as TopicId\[\]\);/.test(src));
}

console.log("(3) app/topics/page.tsx: addCustom() now arms userEditedRef only after its own validation clears");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
  check("(3a) addCustom() no longer sets the ref as its first statement", !/function addCustom\(\) \{\s*\n\s*userEditedRef\.current = true;/.test(src));
  check("(3b) the ref is set immediately before the real setPicked call, after all 3 validation returns", /userEditedRef\.current = true;\s*\n\s*tap\(\);\s*\n\s*setPicked\(\(prev\) => \[\.\.\.prev, id\]\);/.test(src));
}

console.log("(4) components/LetterTOC.tsx: the section-jump buttons now clear the 24px touch-target minimum");
{
  const src = readFileSync(new URL("../components/LetterTOC.tsx", import.meta.url), "utf8");
  check("(4a) the button carries py-2 -my-2", /className="alpha-ui text-left flex items-center gap-2 text-sm hover:opacity-70 py-2 -my-2"/.test(src));
}

console.log("(5) components/ThemeApplier.tsx + lib/theme.ts: a live theme pick now always wins over a same-mount hydrate response");
{
  const tracker = readFileSync(new URL("../lib/theme-edit-tracker.ts", import.meta.url), "utf8");
  check("(5a) theme-edit-tracker.ts exports markThemeEditedThisLoad and themeEditedThisLoad", /export function markThemeEditedThisLoad/.test(tracker) && /export function themeEditedThisLoad/.test(tracker));
  check("(5b) the tracker module has zero imports (stays bundle-neutral for ThemeApplier)", !/^import /m.test(tracker));

  const themeApplier = readFileSync(new URL("../components/ThemeApplier.tsx", import.meta.url), "utf8");
  // alpha-drift-r56-01 loosened this to allow markThemeEditedThisLoad
  // joining the same import line (round 56 wired it into onStorage too).
  check("(5c) ThemeApplier imports themeEditedThisLoad", /import \{ themeEditedThisLoad(?:, markThemeEditedThisLoad)? \} from "@\/lib\/theme-edit-tracker";/.test(themeApplier));
  // alpha-drift-r61-04 (2026-08-20, duplicate-code-audit-r11) wrapped this
  // into a block to also dispatch alpha-theme-change -- loosened to allow
  // either the single-statement or block form. See verify-r61-findings.mts's (4).
  check("(5d) the hydrate's set(dbTheme) is gated behind !themeEditedThisLoad()", /if \(dbTheme && !themeEditedThisLoad\(\)\) \{?\s*\n?\s*set\(dbTheme\);/.test(themeApplier));

  const themeTs = readFileSync(new URL("../lib/theme.ts", import.meta.url), "utf8");
  check("(5e) lib/theme.ts imports markThemeEditedThisLoad", /import \{ markThemeEditedThisLoad \} from "@\/lib\/theme-edit-tracker";/.test(themeTs));
  check("(5f) setTheme() calls markThemeEditedThisLoad() before its repaint/persist steps", /id = safe;\s*\n(?:[^\n]*\n){0,8}?\s*markThemeEditedThisLoad\(\);\s*\n(?:[^\n]*\n){0,3}?\s*\/\/ 1\. Instant repaint/.test(themeTs));
}

console.log("(6) README.md: support_tickets' RLS description now reflects its real zero-policy state");
{
  const src = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  check("(6a) no longer claims support_tickets has auth.uid()-scoped policies", !/every PII table \(`users`, `issues`, `support_tickets`\) has policies scoped to `auth\.uid\(\)`/.test(src));
  check("(6b) now says support_tickets has zero policies as of 2026-08-05", /support_tickets`?.{0,20}has zero policies as of 2026-08-05/.test(src));
}

console.log("(7) app/api/stripe/update-quantity/route.ts: the service-role comment now cites the real reason (privileged-column trigger, not a nonexistent SELECT restriction)");
{
  const src = readFileSync(new URL("../app/api/stripe/update-quantity/route.ts", import.meta.url), "utf8");
  check("(7a) no longer blames a nonexistent self-read-only SELECT restriction", !/public\.users isn't reachable directly with the user's\s*\n\s*\/\/ JWT on the server because we set policy to self-read only/.test(src));
  check("(7b) now cites protect_user_privileged_columns_trg as the real reason", /protect_user_privileged_columns_trg/.test(src));
}

console.log("(8) app/welcome/page.tsx + app/you/page.tsx: both now match QuestionStep's cancellation-guard shape");
{
  const welcome = readFileSync(new URL("../app/welcome/page.tsx", import.meta.url), "utf8");
  check("(8a) welcome/page.tsx declares a cancelled flag", /let cancelled = false;/.test(welcome));
  check("(8b) welcome/page.tsx checks it before router.replace", /if \(cancelled\) return;\s*\n\s*if \(session\) router\.replace\("\/inbox" as never\);/.test(welcome));
  check("(8c) welcome/page.tsx returns a cleanup setting it true", /return \(\) => \{\s*\n\s*cancelled = true;\s*\n\s*\};/.test(welcome));

  const you = readFileSync(new URL("../app/you/page.tsx", import.meta.url), "utf8");
  check("(8d) you/page.tsx declares a cancelled flag", /let cancelled = false;/.test(you));
  check("(8e) you/page.tsx checks it before router.replace", /if \(cancelled\) return;\s*\n\s*if \(session\) router\.replace\("\/inbox" as never\);/.test(you));
  check("(8f) you/page.tsx returns a cleanup setting it true", /return \(\) => \{ cancelled = true; \};/.test(you));
  check("(8g) the stale 'Mirrors the QuestionStep guard' one-liner is gone", !/\/\/ Mirrors the QuestionStep guard\.\s*\n\s*useEffect/.test(you));
}

console.log("(9) sanity: the 2 personally-overturned --accent-ink-on-links findings were deliberately left unchanged");
{
  const digest = readFileSync(new URL("../components/Digest.tsx", import.meta.url), "utf8");
  check("(9a) Digest.tsx's primaryRef link is unchanged (still --accent-ink)", /var\(--accent-ink\)/.test(digest));

  const emailChanger = readFileSync(new URL("../components/EmailChanger.tsx", import.meta.url), "utf8");
  const accentInkCount = (emailChanger.match(/var\(--accent-ink\)/g) || []).length;
  check("(9b) EmailChanger.tsx still has all 3+ pre-existing --accent-ink link/button occurrences", accentInkCount >= 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R55 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R55 FINDINGS ASSERTIONS PASS");
