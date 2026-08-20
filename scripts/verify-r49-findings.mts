// Verify round 49 findings: 10 confirmed, 1 refuted, 3 UNVERIFIED (out of 14
// raw findings across 5 dimensions). A mid-round Claude session-limit outage
// killed 11 of 30 verify-agent calls, leaving 3 findings with totalVotes:0 --
// including a HIGH-severity claim (src/worker-entry.ts) that never got
// adversarial review at all. Per this marathon's established discipline for
// a verify-stage infra failure (round 39's lesson), all 3 unverified findings
// were personally re-verified by hand against the real source before acting:
// - src/worker-entry.ts: CONFIRMED true on personal review. public/_headers'
//   own comment confirms the ASSETS binding's default Cache-Control outside
//   /_next/static/* is max-age=0, must-revalidate, NOT no-store; next.config.ts
//   and worker-entry.ts both only forced no-store for /letter specifically.
//   Every other page route (all ~19 statically-prerendered pages, plus
//   /inbox/[issueId]) could carry a freshly-rotated session Set-Cookie on a
//   response a shared cache is permitted to store and replay -- a real
//   session-fixation vector. Broadened the override to every non-static-asset
//   route unconditionally, subsuming the old /letter-only branch.
// - scripts/smoke-test-deploy.mjs: extended with 2 new checks (a
//   representative static page, the one dynamic page shape) so a future
//   regression on the broadened worker-entry.ts fix fails the deploy the same
//   way a /letter or /api/health regression already would.
// - app/writing/page.tsx: CONFIRMED true (this app has run on Cloudflare
//   Workers, not Lambda, since 2026-08-05) -- low-stakes wording fix.
// The 10 automatically-confirmed findings: weekly-send's after() comment
// misattributed itself to Cloudflare Workers/ctx.waitUntil with a broken
// cross-reference (round 48's own rewrite got the architecture backwards);
// lib/brave.ts's monotonic-counter rationale described a GitHub-Actions
// overlapping-run race the workflow's own concurrency group already
// prevents (dropped the framing, led with the real always-true reason); 3
// sibling monotonic-counter comments (you-search.ts, groq-client.ts,
// topic-blurb.ts) still said "warm lambda" and pointed at brave.ts's
// now-different rationale; app/settings/accounts/page.tsx's act() had no
// request-ordering guard, letting two rows' (or a row's vs a search's)
// out-of-order responses clobber fresher state; 3 copies of a dead
// "youngalgy.com rewrite -> internal Vercel hostname" comment
// (generate/route.ts, stripe/checkout/route.ts, stripe/portal/route.ts);
// lib/analytics.ts's PostHog setup comment said "in Vercel env".
// 1 refuted: docs/SECRETS.md missing a JINA_API_KEY row (refuted 2/2 --
// judged real-but-minor, not acted on; left unchanged).
// alpha-drift-r49-01 through r49-08, all 2026-08-20.
// Run: npx tsx scripts/verify-r49-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) src/worker-entry.ts: no-store now applies to every non-static-asset route, not just /letter (personally verified, HIGH)");
{
  const src = readFileSync(new URL("../src/worker-entry.ts", import.meta.url), "utf8");
  check("(1a) the old /letter-specific string check is gone", !/if \(url\.pathname === '\/letter'\) \{/.test(src));
  check("(1b) the tail now branches on isStaticAsset, passing static responses through unchanged", /if \(isStaticAsset\) \{[\s\S]{0,500}?return response/.test(src));
  check("(1c) every other response gets Cache-Control: no-store unconditionally", /const headers = new Headers\(response\.headers\)\s*\n\s*headers\.set\('Cache-Control', 'no-store, must-revalidate'\)\s*\n\s*for \(const cookie of setCookieHeaders\) headers\.append\('Set-Cookie', cookie\)/.test(src));
}

console.log("(2) scripts/smoke-test-deploy.mjs: 2 new checks guard the broadened worker-entry.ts fix");
{
  const src = readFileSync(new URL("../scripts/smoke-test-deploy.mjs", import.meta.url), "utf8");
  check("(2a) a static-page check exists (/settings/accounts)", /name: "\/settings\/accounts is not stale-cached"/.test(src));
  check("(2b) a dynamic-page check exists (/inbox/[issueId]-shaped)", /name: "\/inbox\/\[issueId\] is not stale-cached"/.test(src));
  check("(2c) both are hard failures (not soft warnings)", /name: "\/settings\/accounts is not stale-cached",\s*\n\s*hard: true/.test(src) && /name: "\/inbox\/\[issueId\] is not stale-cached",\s*\n\s*hard: true/.test(src));
}

console.log("(3) app/writing/page.tsx: 'cold Lambda starts' corrected to the real runtime (personally verified, low)");
{
  const src = readFileSync(new URL("../app/writing/page.tsx", import.meta.url), "utf8");
  check("(3a) no longer says 'cold Lambda starts'", !/cold Lambda starts/.test(src));
  check("(3b) now says cold Worker start", /a cold Worker start/.test(src));
}

console.log("(4) app/api/cron/weekly-send/route.ts: after() comment no longer misattributes itself to Cloudflare Workers, and the cross-reference is fixed");
{
  const src = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
  check("(4a) no longer claims this route runs on Cloudflare Workers via ctx.waitUntil", !/so the Workers runtime's ctx\.waitUntil/.test(src));
  check("(4b) the cross-reference now points at the real alpha-drift-r35-03 location", /real alpha-drift-r35-03 tag lives in app\/api\/account\/email\/\s*\n\s*\/\/ reconcile\/route\.ts, not admin\/users\/route\.ts/.test(src));
}

console.log("(5) lib/brave.ts + 3 sibling files: monotonic-counter rationale no longer cites a race the concurrency group prevents");
{
  const braveSrc = readFileSync(new URL("../lib/brave.ts", import.meta.url), "utf8");
  check("(5a) brave.ts no longer cites the GitHub Actions cross-invocation race as the justification", !/two overlapping cron invocations of the same long-running process/.test(braveSrc));
  check("(5b) it now leads with the real, always-true reason (concurrent per-topic calls)", /assemble\.ts batches several topics concurrently via Promise\.all/.test(braveSrc));

  const youSrc = readFileSync(new URL("../lib/you-search.ts", import.meta.url), "utf8");
  check("(5c) you-search.ts no longer says 'warm lambda'", !/warm lambda/.test(youSrc));

  const groqSrc = readFileSync(new URL("../lib/engine/groq-client.ts", import.meta.url), "utf8");
  check("(5d) groq-client.ts no longer says 'warm lambda'", !/warm lambda/.test(groqSrc));

  const blurbSrc = readFileSync(new URL("../lib/engine/topic-blurb.ts", import.meta.url), "utf8");
  check("(5e) topic-blurb.ts no longer says 'warm lambda'", !/warm lambda/.test(blurbSrc));
}

console.log("(6) app/settings/accounts/page.tsx: load() now has a monotonic sequence guard against out-of-order responses");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(6a) loadSeqRef is declared", /const loadSeqRef = useRef\(0\);/.test(src));
  check("(6b) load() captures its own sequence number and defines an isStale() check", /const seq = \+\+loadSeqRef\.current;\s*\n\s*const isStale = \(\) => !mountedRef\.current \|\| seq !== loadSeqRef\.current;/.test(src));
  check("(6c) both post-await checkpoints use isStale(), not just mountedRef", (src.match(/if \(isStale\(\)\) return;/g) ?? []).length >= 2);
  check("(6d) the catch block only sets err when the response is still current", /if \(!isStale\(\)\) setErr\(e instanceof Error \? e\.message : "Couldn't load users\."\);/.test(src));
}

console.log("(7) 3 dead 'internal Vercel hostname' comments corrected to describe the real Cloudflare Workers risk");
{
  const generateSrc = readFileSync(new URL("../app/api/generate/route.ts", import.meta.url), "utf8");
  check("(7a) generate/route.ts no longer blames a youngalgy.com rewrite", !/behind the youngalgy\.com rewrite the\s*\n\s*\/\/ request origin is the internal Vercel hostname/.test(generateSrc));

  const checkoutSrc = readFileSync(new URL("../app/api/stripe/checkout/route.ts", import.meta.url), "utf8");
  check("(7b) stripe/checkout/route.ts no longer says 'raw internal Vercel host'", !/carries the raw internal\s*\n\s*\/\/ Vercel host in req\.url/.test(checkoutSrc));

  const portalSrc = readFileSync(new URL("../app/api/stripe/portal/route.ts", import.meta.url), "utf8");
  check("(7c) stripe/portal/route.ts no longer says 'internal Vercel hostname'", !/req\.url's\s*\n\s*\/\/ origin is the internal Vercel hostname/.test(portalSrc));
}

console.log("(8) lib/analytics.ts: PostHog activation instructions no longer say 'Vercel env'");
{
  const src = readFileSync(new URL("../lib/analytics.ts", import.meta.url), "utf8");
  check("(8a) no longer says 'in Vercel env'", !/in Vercel env\./.test(src));
  check("(8b) now points at wrangler secret put + docs/SECRETS.md", /npx wrangler secret put/.test(src) && /docs\/SECRETS\.md/.test(src));
}

console.log("(9) sanity: the refuted docs/SECRETS.md finding was deliberately left unchanged");
{
  const src = readFileSync(new URL("../docs/SECRETS.md", import.meta.url), "utf8");
  check("(9a) docs/SECRETS.md has no JINA_API_KEY row (refuted 2/2, not acted on)", !/JINA_API_KEY/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R49 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R49 FINDINGS ASSERTIONS PASS");
