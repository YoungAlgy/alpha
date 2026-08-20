// Verify round 50 findings: 4 confirmed, 5 refuted (out of 9 raw findings
// across 5 dimensions -- 0 UNVERIFIED, verify stage worked cleanly).
// - lib/analytics.ts: self-audit-r49 caught round 49's OWN fix here being
//   wrong -- it replaced a dead "Vercel env" claim with an equally wrong
//   "wrangler secret put" instruction for a build-time-inlined client var,
//   which has zero effect on an already-built bundle. Corrected to point at
//   the WSL deploy checkout's own build-time env file, matching
//   scripts/verify-build-env.mjs's own documented @next/env precedence.
// - app/api/stripe/update-quantity/route.ts: a header comment said the
//   catalog has 27 topics; it's had 38 since before this marathon started
//   (README.md already had the correct count).
// - app/api/unsubscribe/route.ts + scripts/smoke-test-deploy.mjs: the
//   unsubscribe token is a permanent, never-expiring credential (unlike
//   /letter's 90-day TTL), but every response here lacked a Referrer-Policy,
//   letting the token leak via Referer on same-origin navigation to
//   /welcome or /settings (next.config.ts's site-wide
//   strict-origin-when-cross-origin sends the FULL URL as Referer on
//   same-origin nav). Added Referrer-Policy: no-referrer to every HTML
//   response plus rel="noreferrer" on the outbound links (belt and
//   suspenders). Separately, the smoke test's own "invalid unsubscribe
//   token" check queried the wrong param (?t= instead of ?token=),
//   silently testing the "no token" path instead of the "malformed token"
//   path -- fixed to the real param name.
// 5 refuted, all genuinely adjudicated: 3 identically-shaped "Try Again
// needs a re-entrancy guard" findings on app/inbox/[issueId]/page.tsx,
// app/inbox/page.tsx, and app/archive/page.tsx (all refuted 3/3, despite
// matching the exact class of bug app/settings/accounts/page.tsx's own
// round-49 loadSeqRef fix closed -- a genuine split verdict, respected, not
// "completing the set"), a proposal to add a cache-header smoke check for
// /api/unsubscribe (refuted 3/3 -- src/worker-entry.ts's round-49 fix
// already covers it unconditionally regardless of a dedicated test), and a
// support-form email-header-injection claim (refuted 3/3 -- Resend's JSON
// API doesn't construct raw SMTP headers from these fields the way the
// finding assumed).
// alpha-drift-r50-01 through r50-04, all 2026-08-20.
// Run: npx tsx scripts/verify-r50-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) lib/analytics.ts: production activation instructions no longer claim wrangler secret put works for this build-time client var");
{
  const src = readFileSync(new URL("../lib/analytics.ts", import.meta.url), "utf8");
  check("(1a) the old 'wrangler secret put NEXT_PUBLIC_POSTHOG_KEY for production' instruction is gone", !/`npx wrangler secret put\s*\n\/\/ NEXT_PUBLIC_POSTHOG_KEY` for production/.test(src));
  check("(1b) it now points at the WSL deploy checkout's build-time env file", /WSL deploy checkout's own build-time env file/.test(src));
  check("(1c) it references verify-build-env.mjs as the authoritative precedence source", /scripts\/verify-build-env\.mjs/.test(src));
}

console.log("(2) app/api/stripe/update-quantity/route.ts: catalog size corrected from stale 27 to the real 38");
{
  const src = readFileSync(new URL("../app/api/stripe/update-quantity/route.ts", import.meta.url), "utf8");
  check("(2a) no longer says 'Catalog has 27 topics'", !/Catalog has 27 topics/.test(src));
  check("(2b) now says 38", /Catalog has 38 topics/.test(src));
}

console.log("(3) app/api/unsubscribe/route.ts: every HTML response now sets Referrer-Policy: no-referrer, and outbound links carry rel=noreferrer");
{
  const src = readFileSync(new URL("../app/api/unsubscribe/route.ts", import.meta.url), "utf8");
  check("(3a) a shared NO_REFERRER_HEADERS constant is declared", /const NO_REFERRER_HEADERS = \{ "Referrer-Policy": "no-referrer" \} as const;/.test(src));
  check("(3b) it's spread into all 4 HTML response header objects", (src.match(/\.\.\.NO_REFERRER_HEADERS/g) ?? []).length === 4);
  check("(3c) the 'Back to alpha.' link has rel=noreferrer", /href="\$\{escapeHtml\(`\$\{appOrigin\(\)\}\/welcome`\)\}" rel="noreferrer"/.test(src));
  check("(3d) both /settings links in the success page have rel=noreferrer", (src.match(/href="\$\{settingsUrl\}" rel="noreferrer"/g) ?? []).length === 2);
}

console.log("(4) scripts/smoke-test-deploy.mjs: the unsubscribe check now queries the real 'token' param, not 't'");
{
  const src = readFileSync(new URL("../scripts/smoke-test-deploy.mjs", import.meta.url), "utf8");
  check("(4a) the invalid-unsubscribe-token check now uses ?token=", /\/api\/unsubscribe\?token=smoke-test-invalid-token-\$\{Date\.now\(\)\}/.test(src));
  check("(4b) the old wrong param name is gone", !/\/api\/unsubscribe\?t=smoke-test-invalid-token/.test(src));
}

console.log("(5) sanity: the 3 refuted Try-Again re-entrancy findings were deliberately left unchanged (differentiated verdict, not a miss)");
{
  const issueIdSrc = readFileSync(new URL("../app/inbox/[issueId]/page.tsx", import.meta.url), "utf8");
  check("(5a) inbox/[issueId]'s load() still has no loadSeqRef (only activeIssueIdRef)", !/loadSeqRef/.test(issueIdSrc));

  const inboxSrc = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  check("(5b) inbox/page.tsx's load() still has no loadSeqRef", !/loadSeqRef/.test(inboxSrc));

  const archiveSrc = readFileSync(new URL("../app/archive/page.tsx", import.meta.url), "utf8");
  check("(5c) archive/page.tsx's load() still has no loadSeqRef", !/loadSeqRef/.test(archiveSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R50 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R50 FINDINGS ASSERTIONS PASS");
