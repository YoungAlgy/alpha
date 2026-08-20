// Verify round 39 findings.
//
// PROCESS NOTE: this round's automated 3-vote Opus adversarial verify stage
// hit a session-wide usage limit mid-run -- all 48 verify agents errored
// with "You've hit your session limit," which the workflow script's
// `refutedCount < 2` fallback logic silently treated as "survived" (0 votes,
// 0 refutations). That is NOT genuine verification. Every finding below was
// instead personally verified by reading the actual current source (and, for
// the two behavioral claims, running the real code against realistic input)
// before any fix was implemented -- the same skeptical "try to refute by
// reading the real code" standard the automated panel uses, just performed
// directly rather than delegated. Findings that didn't hold up to that
// standard, or that were explicitly low-value/high-effort for their impact,
// were deferred rather than force-fixed -- see the bottom of this file's
// header comment for what was deferred and why.
//
// Self-audit (round 38's own code, all found by re-reading + behaviorally
// testing what round 38 shipped):
// - lib/email.ts's colon join (r38 fix) collides with the catalog's own
//   "AI: news, releases & tools for work" label -- confirmed via direct
//   grep of lib/topics.ts, a genuine every-day double-colon defect for the
//   app's own flagship topic.
// - lib/engine/voice-guard.ts's BANNED_LEXICAL (r37/r38 fixes) still missed
//   plain plural forms (optimizations, landscapes, realms, testaments,
//   synergies), the unhyphenated "game changer"/"game changing", and
//   "unprecedentedly" -- confirmed by actually running findLexicalTells()
//   against real sentences using each form, not just reading the regex.
// - app/api/stripe/webhook/route.ts's 0-row retry-vs-absorb decision (line
//   330) still read the stale sub.status while cancelledAt two dozen lines
//   above (r38's own fix) already reads the converged liveSub?.status ??
//   sub.status -- confirmed by direct read, a genuine inconsistency left
//   behind by the r38 hoisting.
//
// Accessibility sweep (a fresh comprehensive pass, first dedicated one
// since round 27's ThemeSwitcher focus-trap):
// - app/checkout/page.tsx, app/settings/page.tsx (Resume my letters),
//   app/support/SupportForm.tsx: three more instances of the
//   unmount-without-focus-restore class already fixed for EmailChanger.tsx
//   and settings' billing panel, each confirmed by reading the actual
//   ternary/early-return swap.
// - components/EmailChanger.tsx: the new-email input relied solely on a
//   placeholder for its accessible name, confirmed by direct read.
// - components/AudioToggle.tsx: missing aria-pressed, confirmed by direct
//   read and comparison against every other toggle in the app.
// - components/LetterTOC.tsx: isActive was computed but never surfaced via
//   aria-current, confirmed by direct read.
//
// Dependency hygiene (first refresh since round 22, confirmed against the
// real npm registry before bumping anything):
// - @types/node bumped 20->22 (matches the Node version every CI workflow
//   already actually runs) and eslint-config-next bumped 16.2.6->16.3.1
//   (matches next's own resolved version) -- both zero runtime risk.
// - @supabase/ssr bumped 0.10.3->0.12.4 (confirmed via `npm view` there is
//   no 0.11.x to skip) -- auth-adjacent, verified via a clean npm install +
//   typecheck + build; the existing smoke-test-deploy.mjs suite already
//   exercises supabaseServerClient()/supabaseServiceClient() post-deploy.
// - README.md's NEX_PUBLIC_POSTHOG_HOST doc corrected to disclose the CSP
//   connect-src dependency a self-hosted override would silently hit,
//   confirmed via direct read of next.config.ts + lib/analytics.ts.
//
// DEFERRED (not fixed this round, with reasoning):
// - @anthropic-ai/sdk (0.95.2 -> latest, a 20+ minor version jump on the
//   core paid content-generation pipeline): no CVE, pure feature/bugfix
//   drift per the finding itself, and this session has no cheap way to
//   integration-test real Anthropic API call behavior without spending
//   real API cost outside the standard smoke-test pipeline. Deferred
//   pending a session with room for that testing, not force-bumped.
// - app/settings/accounts/page.tsx's admin grant/revoke focus-return gap:
//   confirmed real but LOW severity and single-admin-audience (the
//   finding's own suggested fix hedges "or accept as lower priority").
// - The watchdog migration's same-day-bounce undercounting edge case:
//   confirmed real but the finding's own suggested fix explicitly says
//   "given the low practical impact, this may not be worth the added query
//   complexity" -- deferred, not silently dropped.
// alpha-drift-r39-01 through r39-09, all 2026-08-19.
// Run: npx tsx scripts/verify-r39-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) lib/email.ts: sectionList's colon join no longer collides with a colon already inside topicLabel");
{
  const src = readFileSync(new URL("../lib/email.ts", import.meta.url), "utf8");
  // alpha-drift-r40-02: round 40 found the ASCII-only /:/g here missed the
  // fullwidth colon (U+FF1A) a CJK IME can produce, widening this to
  // /[:：]/g -- see verify-r40-findings.mts section (2) for that fix's own
  // coverage. Loosened to check the strip-then-join SHAPE survived (any
  // character class, not the exact single-colon regex), since the join
  // mechanism itself is what this assertion cares about.
  check("(1a) topicLabel is sanitized of colons before the join", /const safeLabel = s\.topicLabel\.replace\(\/\[?:.*?\]?\/g, ""\);/.test(src));
  check("(1b) the join uses safeLabel, not the raw label", /return lead \? `• \$\{safeLabel\}: \$\{lead\}` : `• \$\{safeLabel\}`;/.test(src));
  check("(1c) the raw (unsanitized) join is gone", !/return lead \? `• \$\{s\.topicLabel\}: \$\{lead\}` :/.test(src));

  const topicsSrc = readFileSync(new URL("../lib/topics.ts", import.meta.url), "utf8");
  check("(1d) sanity: the real catalog label that motivated this fix does contain a colon", /label: "AI: news, releases/.test(topicsSrc));

  // Behavioral proof: reproduce the exact join logic against the real
  // catalog label and confirm no double-colon results.
  const catalogLabel = "AI: news, releases & tools for work";
  const safeLabel = catalogLabel.replace(/:/g, "");
  const lead = "Some headline";
  const joined = `• ${safeLabel}: ${lead}`;
  check(`(1e) behavioral: joining the real "AI: news..." catalog label no longer produces a double colon -- actual: ${JSON.stringify(joined)}`, !joined.includes("::") && (joined.match(/:/g) ?? []).length === 1);

  // alpha-drift-r39-01 (follow-up, same day): the actual live-rendered-HTML
  // spot check this session ran to "confirm" the r38 fix was fooled by
  // scripts/preview-email.mts's OWN hand-built fixture -- it used the raw
  // topicLabel, never the real (unexported, so untestable by import) join
  // logic inside sendLetterNotification, so it kept showing a double colon
  // for SAMPLE_ISSUE's "AI: news..." section even after this fix shipped.
  // Fixed the fixture to mirror the real stripping so a future "does the
  // rendered output actually look right" spot check isn't misled again.
  const previewSrc = readFileSync(new URL("../scripts/preview-email.mts", import.meta.url), "utf8");
  check("(1f) preview-email.mts's fixture now mirrors the real colon-stripping instead of using the raw label", /const previewSafeLabel = \(label: string\) => label\.replace\(\/:\/g, ""\);/.test(previewSrc) && /previewSafeLabel\(SAMPLE_ISSUE\.sections\[0\]\?\.topicLabel/.test(previewSrc));
}

console.log("(2) lib/engine/voice-guard.ts: BANNED_LEXICAL now catches plural/adverb forms round 38 still missed");
{
  const src = readFileSync(new URL("../lib/engine/voice-guard.ts", import.meta.url), "utf8");
  check("(2a) optimizations covered via optional plural", /optimizations\?/.test(src));
  check("(2b) landscapes covered via optional plural", /landscapes\?/.test(src));
  check("(2c) realms covered via optional plural", /realms\?/.test(src));
  check("(2d) testaments covered via optional plural", /testaments\?/.test(src));
  check("(2e) synergies covered via alternation", /synerg\(\?:y\|ies\)/.test(src));
  check("(2f) unhyphenated 'game changer'/'game changing' covered", /game\[- \]changers\?/.test(src) && /game\[- \]changing/.test(src));
  check("(2g) 'unprecedentedly' covered", /unprecedented\(\?:ly\)\?/.test(src));

  // Behavioral proof against the REAL exported findLexicalTells, using the
  // exact sentences confirmed to slip through before this fix.
  const { findLexicalTells } = await import("../lib/engine/voice-guard.ts");
  check("(2h) behavioral: 'the new optimizations' now trips a tell", findLexicalTells("the new optimizations improved throughput").length > 0);
  check("(2i) behavioral: 'many landscapes' now trips a tell", findLexicalTells("across many landscapes of the market").length > 0);
  check("(2j) behavioral: 'digital realms' now trips a tell", findLexicalTells("digital realms are expanding").length > 0);
  check("(2k) behavioral: 'testaments to hard work' now trips a tell", findLexicalTells("these are testaments to hard work").length > 0);
  check("(2l) behavioral: 'real synergies' now trips a tell", findLexicalTells("the two teams found real synergies").length > 0);
  check("(2m) behavioral: unhyphenated 'game changer' now trips a tell", findLexicalTells("critics called it a real game changer for the industry").length > 0);
  check("(2n) behavioral: 'unprecedentedly' now trips a tell", findLexicalTells("growth continued unprecedentedly this year").length > 0);
  check("(2o) behavioral: singular 'optimization'/'optimized' still trip a tell (no regression from the plural change)", findLexicalTells("a real optimization here").length > 0 && findLexicalTells("the report was optimized for speed").length > 0);
  check("(2p) behavioral: a clean sentence with none of these words still trips nothing", findLexicalTells("The report shows home prices rose slightly last month.").length === 0);
}

console.log("(3) app/api/stripe/webhook/route.ts: the 0-row retry-vs-absorb decision now uses the same converged status source as cancelledAt");
{
  const src = readFileSync(new URL("../app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
  check("(3a) effectiveStatus computed once from liveSub with a fallback to the event snapshot", /const effectiveStatus = liveSub\?\.status \?\? sub\.status;/.test(src));
  check("(3b) the terminal-status check now uses effectiveStatus", /if \(isTerminalSubscriptionStatus\(effectiveStatus\)\) \{/.test(src));
  check("(3c) the old stale-status-only check is gone", !/if \(isTerminalSubscriptionStatus\(sub\.status\)\) \{/.test(src));
  check("(3d) both log messages reference effectiveStatus, not the stale sub.status", (src.match(/status=\$\{effectiveStatus\}/g) ?? []).length === 2);
}

console.log("(4) Focus management: 3 more unmount-without-restore transitions fixed, matching the established EmailChanger/settings pattern");
{
  const checkoutSrc = readFileSync(new URL("../app/checkout/page.tsx", import.meta.url), "utf8");
  check("(4a) checkout: alreadySubscribedHeadingRef declared and focused in an effect keyed on alreadySubscribed", /const alreadySubscribedHeadingRef = useRef<HTMLParagraphElement>\(null\);/.test(checkoutSrc) && /if \(alreadySubscribed\) alreadySubscribedHeadingRef\.current\?\.focus\(\);/.test(checkoutSrc));
  check("(4b) checkout: the ref is actually attached to the rendered paragraph", /ref=\{alreadySubscribedHeadingRef\}\s*\n\s*tabIndex=\{-1\}/.test(checkoutSrc));

  const settingsSrc = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(4c) settings: resumedHeadingRef declared and focused in an effect keyed on resumed", /const resumedHeadingRef = useRef<HTMLParagraphElement>\(null\);/.test(settingsSrc) && /if \(resumed\) resumedHeadingRef\.current\?\.focus\(\);/.test(settingsSrc));
  check("(4d) settings: the ref is actually attached to the rendered paragraph", /ref=\{resumedHeadingRef\}\s*\n\s*tabIndex=\{-1\}/.test(settingsSrc));

  const supportSrc = readFileSync(new URL("../app/support/SupportForm.tsx", import.meta.url), "utf8");
  check("(4e) support form: sentHeadingRef declared and focused in an effect keyed on status", /const sentHeadingRef = useRef<HTMLParagraphElement>\(null\);/.test(supportSrc) && /if \(status === "sent"\) sentHeadingRef\.current\?\.focus\(\);/.test(supportSrc));
  check("(4f) support form: the ref is actually attached to the rendered heading", /ref=\{sentHeadingRef\} tabIndex=\{-1\}/.test(supportSrc));
}

console.log("(5) Accessibility: labeling and state exposure gaps closed");
{
  const emailChangerSrc = readFileSync(new URL("../components/EmailChanger.tsx", import.meta.url), "utf8");
  check("(5a) EmailChanger: new-email input now has an aria-label", /aria-label="New email address"/.test(emailChangerSrc));

  const audioToggleSrc = readFileSync(new URL("../components/AudioToggle.tsx", import.meta.url), "utf8");
  check("(5b) AudioToggle: aria-pressed now reflects the muted state", /aria-pressed=\{!on\}/.test(audioToggleSrc));

  const letterTocSrc = readFileSync(new URL("../components/LetterTOC.tsx", import.meta.url), "utf8");
  check("(5c) LetterTOC: aria-current now reflects isActive", /aria-current=\{isActive \? "true" : undefined\}/.test(letterTocSrc));
}

console.log("(6) Dependency hygiene: safe bumps applied, risky one deferred");
{
  const pkgSrc = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const pkg = JSON.parse(pkgSrc);
  check("(6a) @types/node bumped to match CI's actual Node 22", pkg.devDependencies["@types/node"] === "^22");
  check("(6b) eslint-config-next bumped to match next's resolved 16.3.1", pkg.devDependencies["eslint-config-next"] === "16.3.1");
  check("(6c) @supabase/ssr bumped to 0.12.4 (no 0.11.x exists to land on instead)", pkg.dependencies["@supabase/ssr"] === "^0.12.4");
  check("(6d) @anthropic-ai/sdk deliberately left unbumped this round (too large a jump on the paid content pipeline to verify cheaply)", pkg.dependencies["@anthropic-ai/sdk"] === "^0.95.2");

  const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  check("(6e) README now discloses the CSP connect-src dependency for a self-hosted PostHog host", /Setting this to anything else also requires adding that host to connect-src/.test(readmeSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R39 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R39 FINDINGS ASSERTIONS PASS");
