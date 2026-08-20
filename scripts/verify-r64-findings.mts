// Verify round 64 findings: 10 raised, 9 confirmed, 1 refuted (self-audit
// found round 63's FirstLetterCelebration reduced-motion gate should have
// kept the caption/glyph visible under a CSS-only override instead of
// hiding them entirely -- refuted 2/1, the panel judged the current
// hide-everything behavior acceptable given the component is aria-hidden
// and pointer-events:none either way). 9 confirmed findings resolve to 7
// distinct fixes (3 of the confirmed findings -- duplicate-code-audit's
// sessionEstablished-gate finding, silent-catch-audit's getSession-error
// finding, and form-validation-consistency-audit's behavioral-fix finding
// -- all converged on the exact same app/inbox/page.tsx code, implemented
// as one coherent change) plus one disclosure-only item (the --rule
// non-text-contrast gap, surfaced for Algy per the same round-55 precedent
// as --accent-ink, not auto-fixed).
// - components/ScrollFadeIn.tsx (accessibility-resweep-newer-code-r12,
//   MEDIUM, 2-1 split): the only scroll-triggered motion in the app (wraps
//   every topic section of the daily digest) had no prefers-reduced-motion
//   check. Reads the media query at useState-init time (not inside the
//   effect, which runs after first paint and would still let the
//   transition play once) so a reduced-motion reader's content renders
//   settled from the very first frame.
// - app/globals.css (accessibility-resweep-newer-code-r12, HIGH, 2-1
//   split): the app's ONLY :focus-visible rules used var(--accent), which
//   fails WCAG 1.4.11's 3:1 non-text floor in 11 of 25 themes including
//   forest (the default). Swapped to var(--ink) rather than the more
//   commonly-reached-for var(--accent-ink) -- one verify vote traced that
//   --accent-ink itself still fails 3:1 in 3 of those 11 themes AND is the
//   exact token round 55's still-pending design-system decision covers,
//   so using it here would add a new consumer ahead of that call. --ink
//   clears both 3:1 and 4.5:1 in all 26 theme blocks with real margin.
// - app/globals.css's --rule token (accessibility-resweep-newer-code-r12,
//   HIGH per the finding, unanimous CONFIRM but explicitly NOT auto-fixed
//   -- all 3 votes recommended disclosure only): the resting-state border
//   color on real form controls (SupportForm inputs, signin's email/OTP
//   fields, ProfileEditor's shared Field factory, AudioToggle) fails 1.4.11
//   in all 25 themes (1.19-1.51:1). Structurally identical in shape to
//   round 55's --accent-ink call -- a systemic, ~80-site design-token
//   decision, not a one-file fix. Surfaced as a 3rd Algy-blocked item, no
//   code change.
// - app/inbox/page.tsx (duplicate-code-audit-r14 + silent-catch-audit-r10
//   + form-validation-consistency-audit-r9, 3 independent findings on the
//   same root cause, implemented once): getSession()'s discarded
//   RESOLVED error used to silently misread a real signed-in subscriber's
//   transient session-check failure as "signed out," falling through to
//   Path 2 and showing "No letter on this device yet... Sign in" to an
//   actively-subscribed reader on the app's highest-traffic page. Fixed
//   behaviorally (routes to the existing loadError screen), matching the
//   file's own r43-02 precedent one call earlier. Separately, the catch
//   block's sessionEstablished gate rested on a traced-and-disproven
//   premise ("getSession() throws for a genuinely signed-out visitor" --
//   it resolves, never throws) -- removed, so the catch now matches its
//   siblings (archive, inbox/[issueId]) and sets loadError unconditionally.
// - app/archive/page.tsx (form-validation-consistency-audit-r9, MEDIUM):
//   same getSession()-error discard in load() -- behavioral fix (routes to
//   the existing "error" state), since the file's own header comment
//   already states the exact rule being violated ("A query error must NOT
//   be masked as 'no letters'"). loadMore()'s identical discard got a
//   log-only fix, since its existing behavior (silent no-op, list intact)
//   already degrades safely.
// - app/inbox/[issueId]/page.tsx (silent-catch-audit-r10 +
//   form-validation-consistency-audit-r9): same discard, routed to the
//   existing loadError state rather than `missing` (whose copy actively
//   implies data loss -- "It might have been deleted" -- worse than the
//   other two files' fallback copy).
// - app/auth/callback/page.tsx (form-validation-consistency-audit-r9,
//   MEDIUM): the "neither flow produced a session" branch silently bounced
//   to `/signin?error=no_session` -- a dead signal app/signin/page.tsx
//   never reads (it has zero useSearchParams calls). Routed through the
//   existing setErr()+redirectTimer friendly-copy path instead, but only
//   when a code or hash was actually present (an expired/already-used
//   link, or the first click of Supabase's double-confirm email change) --
//   a genuinely bare visit to the page keeps the original quiet fallback.
//   Also logs its own getSession() error on the hash-flow path.
// alpha-drift-r64-01 through r64-03, all 2026-08-21.
// Run: npx tsx scripts/verify-r64-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) components/ScrollFadeIn.tsx: reads prefers-reduced-motion at useState-init time, before the effect ever runs");
{
  const src = readFileSync(new URL("../components/ScrollFadeIn.tsx", import.meta.url), "utf8");
  // alpha-drift-r65-01 (2026-08-21, self-audit-r64): this exact
  // useState-init-time shape was the round-64 REGRESSION self-audit
  // caught -- it diverged SSR (always false) from client hydration (true
  // for a reduced-motion visitor), permanently hiding letter content on
  // app/letter + app/sample for that population. Replaced with
  // useState(false) for SSR/client parity plus a matchMedia check inside
  // the effect (which never runs during SSR, so there's no divergence) --
  // loosened to the corrected shape. See verify-r65-findings.mts's (1).
  check("(1a-c) reduced-motion is now read inside the effect (SSR-safe), not at useState-init time", /const \[shown, setShown\] = useState\(false\);/.test(src) && /if \(window\.matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)\.matches\) \{/.test(src));
}

console.log("(2) app/globals.css: the app's only :focus-visible rules use --ink, not the WCAG-failing --accent or the design-decision-pending --accent-ink");
{
  const src = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  check("(2a) input/textarea focus-visible uses var(--ink)", /border-color: var\(--ink\) !important;\s*\n\s*box-shadow: 0 1px 0 var\(--ink\);/.test(src));
  check("(2b) button/a/[role=button] focus-visible uses var(--ink)", /outline: 2px solid var\(--ink\);/.test(src));
  check("(2c) no focus-visible rule still reads var(--accent) bare", !/:focus-visible \{\s*\n\s*outline: none;\s*\n\s*border-color: var\(--accent\)/.test(src) && !/outline: 2px solid var\(--accent\);/.test(src));
}

console.log("(3) app/inbox/page.tsx: getSession() error routes to loadError, and the false-premised sessionEstablished gate is gone");
{
  const src = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  check("(3a) getSession's error is destructured", /const \{ data: \{ session \}, error: sessionErr \} = await sb\.auth\.getSession\(\);/.test(src));
  check("(3b) a truthy sessionErr routes to loadError, not a silent fall-through", /if \(sessionErr\) \{\s*\n\s*console\.warn\("\[inbox\] getSession failed:", sessionErr\.message\);\s*\n\s*setLoadError\(true\);\s*\n\s*return;\s*\n\s*\}/.test(src));
  check("(3c) sessionEstablished is fully removed", !/sessionEstablished/.test(src) || (src.match(/sessionEstablished/g) ?? []).length === 1);
  check("(3d) the catch sets loadError unconditionally", /console\.warn\("\[inbox\] supabase read failed:", e\);\s*\n\s*if \(mountedRef\.current\) setLoadError\(true\);\s*\n\s*return;/.test(src));
}

console.log("(4) app/archive/page.tsx: load()'s getSession error is behavioral, loadMore()'s is log-only");
{
  const src = readFileSync(new URL("../app/archive/page.tsx", import.meta.url), "utf8");
  check("(4a) load()'s getSession error routes to state \"error\"", /if \(sessionErr\) \{\s*\n\s*console\.warn\("\[archive\] getSession failed:", sessionErr\.message\);\s*\n\s*setState\("error"\);\s*\n\s*return;\s*\n\s*\}/.test(src));
  check("(4b) loadMore()'s getSession error is logged only, no behavior change", /if \(sessionErr\) console\.warn\("\[archive\] loadMore getSession failed:", sessionErr\.message\);/.test(src));
}

console.log("(5) app/inbox/[issueId]/page.tsx: getSession error routes to loadError, not the misleading missing state");
{
  const src = readFileSync(new URL("../app/inbox/[issueId]/page.tsx", import.meta.url), "utf8");
  check("(5a) getSession's error is destructured", /const \{ data: \{ session \}, error: sessionErr \} = await sb\.auth\.getSession\(\);/.test(src));
  check("(5b) a truthy sessionErr sets loadError, not missing", /if \(sessionErr\) \{\s*\n\s*console\.warn\("\[issue\] getSession failed:", sessionErr\.message\);\s*\n\s*setLoadError\(true\);\s*\n\s*return;\s*\n\s*\}/.test(src));
}

console.log("(6) app/auth/callback/page.tsx: the dead ?error=no_session signal now shows friendly copy instead of a silent bounce");
{
  const src = readFileSync(new URL("../app/auth/callback/page.tsx", import.meta.url), "utf8");
  check("(6a) the bare-visit quiet fallback is preserved", /router\.replace\("\/signin" as never\);\s*\n\s*\} catch \(e\) \{/.test(src));
  check("(6b) an attempted-but-failed flow throws into the friendly-copy catch instead", /if \(code \|\| hasHashSession\) \{\s*\n\s*throw new Error\("no_session"\);\s*\n\s*\}/.test(src));
  check("(6c) the synthetic error gets the same friendly copy as the OTP\\/PKCE cases", /e instanceof Error && e\.message === "no_session"/.test(src));
  check("(6d) the hash-flow getSession error is destructured and logged", /const \{ data: \{ session \}, error: sessionErr \} = await sb\.auth\.getSession\(\);\s*\n\s*if \(cancelled\) return;\s*\n\s*if \(sessionErr\) console\.warn\("\[auth\/callback\] getSession failed:", sessionErr\.message\);/.test(src));
  check("(6e) no live router.replace call still produces ?error=no_session (the comment mentioning it historically is fine)", !/router\.replace\("\/signin\?error=no_session"/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R64 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R64 FINDINGS ASSERTIONS PASS");
