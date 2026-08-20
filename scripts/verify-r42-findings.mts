// Verify round 42 findings: 7 confirmed, 4 refuted (out of 11 raw findings
// across 5 dimensions -- a real Zod-completeness and a dead-code dimension
// each found nothing/got fully refuted).
// - lib/engine/voice-guard.ts: robust/comprehensive/seamless still missed
//   their -ness noun forms (11th straight self-audit catch on this regex).
//   Deliberately did NOT add vitality/criticality -- see the fix's own
//   comment for why that would compound an already-accepted risk.
// - README.md + docs/SECRETS.md: GEMINI_API_KEY's doc still described the
//   old pre-cost-tiering architecture (Claude-primary, Gemini-fallback),
//   backwards from the real current default (Gemini-primary for topic
//   blurbs since 2026-07-23). Also: the admin panel doc line was missing
//   the clear_suppression action added 2026-08-13.
// - app/api/cron/weekly-send/route.ts: 3+ sibling comments (and one real
//   ops-alert message text) still described "Vercel's hard maxDuration
//   kill" and an "800s cap" after the route's own header comment was
//   correctly updated for the 2026-08-05 GitHub Actions migration.
// - app/auth/callback/page.tsx: raw GoTrue error text reached the UI, the
//   one other place besides app/signin/page.tsx (fixed round 35) where a
//   raw Supabase auth SDK error could surface to a reader.
// - app/inbox/[issueId]/page.tsx: a genuine query failure fell through the
//   same gate as a real not-found, showing "It might have been deleted"
//   for a transient hiccup with no retry affordance -- the same
//   error-vs-empty distinction app/archive/page.tsx already gets right.
// - app/support/SupportForm.tsx: skipped the app's own isValidEmail()
//   pre-check every other email input uses, letting a common typo reach
//   the server and produce a raw Zod validation string mashed into the UI.
// 4 refuted, all genuinely adjudicated: a Stripe checkout.session.completed
// race-condition claim (HIGH severity, refuted 3/3), a topics-route race
// claim (refuted 3/3), and two dead-code claims (GenerationLog interface,
// a Gender re-export) both refuted 3/3.
// alpha-drift-r42-01 through r42-07, all 2026-08-19.
// Run: npx tsx scripts/verify-r42-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) lib/engine/voice-guard.ts: robust/comprehensive/seamless now get the same -ness treatment as their -ly forms");
{
  const src = readFileSync(new URL("../lib/engine/voice-guard.ts", import.meta.url), "utf8");
  check("(1a) robust(?:ly|ness)? covers robustness", /robust\(\?:ly\|ness\)\?/.test(src));
  check("(1b) seamless(?:ly|ness)? covers seamlessness", /seamless\(\?:ly\|ness\)\?/.test(src));
  check("(1c) comprehensive(?:ly|ness)? covers comprehensiveness", /comprehensive\(\?:ly\|ness\)\?/.test(src));
  check("(1d) vitality/criticality deliberately NOT added (documented tradeoff, not an oversight)", !/vital\(\?:ly\|ity\)\?/.test(src) && !/critical\(\?:ly\|ity\)\?/.test(src));

  const { findLexicalTells } = await import("../lib/engine/voice-guard.ts");
  check("(1e) behavioral: 'robustness' now trips a tell", findLexicalTells("The system's robustness held up under load.").length > 0);
  check("(1f) behavioral: 'comprehensiveness' now trips a tell", findLexicalTells("Reviewers praised the report's comprehensiveness.").length > 0);
  check("(1g) behavioral: 'seamlessness' now trips a tell", findLexicalTells("The seamlessness of the integration impressed users.").length > 0);
  check("(1h) behavioral: already-working forms (bare adjective, -ly) still trip -- no regression", findLexicalTells("a robust system").length > 0 && findLexicalTells("robustly tested").length > 0 && findLexicalTells("a comprehensive guide").length > 0 && findLexicalTells("seamless integration").length > 0);
  check("(1i) behavioral: a clean sentence with none of these words still trips nothing", findLexicalTells("The report shows home prices rose slightly last month.").length === 0);
}

console.log("(2) README.md + docs/SECRETS.md: GEMINI_API_KEY's doc now matches the real cost-tiered architecture (Gemini primary for blurbs)");
{
  const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  check("(2a) the old 'Claude down' framing is gone", !/GEMINI_API_KEY=\s*# search \+ generation fallback tier \(Brave rate-limited, or Claude down\)/.test(readmeSrc));
  check("(2b) replaced with the real PRIMARY-tier framing", /PRIMARY generation tier for/.test(readmeSrc) && /topic blurbs/.test(readmeSrc));
  check("(2c) editor's-note's opposite tier order is disclosed too", /Editor's-note generation still tries Claude first/.test(readmeSrc));
  check("(2d) admin panel doc now lists clear_suppression", /grant free subscription, revoke free, clear delivery suppression, delete\./.test(readmeSrc));

  const secretsSrc = readFileSync(new URL("../docs/SECRETS.md", import.meta.url), "utf8");
  check("(2e) SECRETS.md's Gemini row no longer says 'Claude-down generation fallback'", !/the Claude-down generation fallback simultaneously/.test(secretsSrc));
  check("(2f) replaced with the real PRIMARY-tier framing", /the PRIMARY generation tier for topic blurbs/.test(secretsSrc));

  const topicBlurbSrc = readFileSync(new URL("../lib/engine/topic-blurb.ts", import.meta.url), "utf8");
  check("(2g) sanity: the real code comment this fix is matching is unchanged", /Gemini drafts every topic blurb by default/.test(topicBlurbSrc));
}

console.log("(3) app/api/cron/weekly-send/route.ts: stale Vercel-platform comments updated to match the 2026-08-05 GitHub Actions migration");
{
  const src = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
  check("(3a) PERSIST_AND_SEND_DEADLINE_MS's comment no longer cites Vercel's kill mechanism", !/park the whole per-subscriber loop until\s*\n\/\/ Vercel's hard maxDuration kill/.test(src));
  check("(3b) CRON_SAFETY_MARGIN_MS's comment no longer cites the stale 800s cap", !/can approach the 800s maxDuration cap/.test(src));
  check("(3c) the 'silent Vercel kill' phrasing is gone from both sibling comments", !/silent Vercel kill/.test(src));
  check("(3d) the real ops-alert message text no longer blames 'Vercel's time cap'", !/pressing against Vercel's time cap/.test(src));
  check("(3e) replaced with a reference to the real GitHub Actions ceiling", /GitHub Actions workflow's own `curl/.test(src) || /GitHub Actions workflow's 1500s curl budget/.test(src));

  // Sanity: the historically-accurate comments explaining WHY maxDuration
  // no longer means a Vercel directive are untouched (they're correct as
  // context, not stale).
  check("(3f) sanity: the maxDuration declaration's own explanatory comment is untouched", /This value no longer means what its name implies\. It WAS a Vercel Pro/.test(src));
}

console.log("(4) app/auth/callback/page.tsx: no longer shows GoTrue's raw vendor error text");
{
  const src = readFileSync(new URL("../app/auth/callback/page.tsx", import.meta.url), "utf8");
  // alpha-drift-r43-01: round 43 added a second import (isInvalidOrExpiredPkceError)
  // on the same line, since the OTP classifier alone never matched this
  // page's real exchangeCodeForSession error shapes -- see
  // verify-r43-findings.mts section (1) for that fix's own coverage.
  // Loosened to check the OTP import is present, not the exact single-name
  // import line.
  check("(4a) imports isInvalidOrExpiredOtpError from the shared helper", /import \{ isInvalidOrExpiredOtpError,? ?[^}]*\} from "@\/lib\/gotrue-errors";/.test(src));
  check("(4b) the old raw e.message passthrough is gone", !/setErr\(e instanceof Error \? e\.message : "Sign-in failed"\);/.test(src));
  check("(4c) friendly copy is used instead, classified via the shared helper", /isInvalidOrExpiredOtpError\(shape\)/.test(src) && /That link didn't work/.test(src));
  check("(4d) the real error is still logged for debugging", /console\.warn\("\[auth\/callback\] sign-in failed:"/.test(src));
}

console.log("(5) app/inbox/[issueId]/page.tsx: a genuine query failure is now distinguished from a real not-found");
{
  const src = readFileSync(new URL("../app/inbox/[issueId]/page.tsx", import.meta.url), "utf8");
  check("(5a) a new loadError state exists", /const \[loadError, setLoadError\] = useState\(false\);/.test(src));
  check("(5b) the issues-query error branch sets loadError, separate from the not-found fallthrough", /if \(error\) \{\s*\n\s*setLoadError\(true\);\s*\n\s*return;\s*\n\s*\}/.test(src));
  check("(5c) the catch block also sets loadError, not missing", /console\.warn\("\[issue\] fetch failed:", e\);\s*\n\s*if \(!stale\(\)\) setLoadError\(true\);/.test(src));
  check("(5d) a distinct loadError UI block exists with a Try again button", /Couldn&apos;t load that letter\./.test(src) && /onClick=\{\(\) => load\(\)\}/.test(src));
  check("(5e) the original missing UI's copy is untouched (still correct for the genuine not-found case)", /It might have been deleted, or you may need to sign in\./.test(src));

  // Sanity: the issueId-staleness guard this fix's own refactor had to
  // preserve (an older fetch for a PREVIOUS issueId must not overwrite a
  // newer one) is still present, just reshaped around forIssueId/stale().
  check("(5f) sanity: the per-fetch issueId staleness guard survived the refactor into load()", /const stale = \(\) => activeIssueIdRef\.current !== forIssueId \|\| !mountedRef\.current;/.test(src));
}

console.log("(6) app/support/SupportForm.tsx: now pre-checks email validity like every other email input in the app");
{
  const src = readFileSync(new URL("../app/support/SupportForm.tsx", import.meta.url), "utf8");
  check("(6a) imports isValidEmail", /import \{ isValidEmail \} from "@\/lib\/validate-email";/.test(src));
  // alpha-drift-r57-09 hoisted email.trim() into a named `cleanEmail` (also
  // used for the fetch body, not just this check) -- loosened to allow
  // either shape.
  check("(6b) submit() checks it before ever hitting the network", /if \(!isValidEmail\((?:email\.trim\(\)|cleanEmail)\)\) \{\s*\n\s*setStatus\("error"\);\s*\n\s*setError\("That doesn't look like an email\. Check for a typo\."\);/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R42 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R42 FINDINGS ASSERTIONS PASS");
