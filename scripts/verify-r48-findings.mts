// Verify round 48 findings: 4 confirmed, 4 refuted (out of 8 raw findings
// across 5 dimensions -- 0 UNVERIFIED, falsy-value-handling-audit's first
// outing found nothing at all).
// - components/onboarding/QuestionStep.tsx: the signed-in bounce-to-/inbox
//   mount effect (rendered by every onboarding step past /theme) had zero
//   cancellation guard before router.replace -- the same stale-async-
//   navigation class already fixed for checkout/signin/topics. NOTABLE:
//   the structurally IDENTICAL bug on app/you/page.tsx was raised the same
//   round and REFUTED 3/3 -- respected the split verdict, left that one
//   file unfixed despite sharing the exact same shape.
// - app/settings/accounts/page.tsx: act() tracked in-flight state with a
//   single `busy: string | null` slot shared across every row, with no
//   synchronous ref-based re-entrancy latch either (unlike every other
//   mutating action in this codebase) -- acting on a second row silently
//   un-disabled the first row's still-in-flight button, and a re-click
//   could fire a real second concurrent request, including for the
//   irreversible delete action. Replaced with a Set<string>-based tracker
//   (busyRowsRef for the synchronous guard, busyRows mirrored into state
//   for per-row rendering).
// - README.md + lib/email.ts + lib/brave.ts + app/api/generate/route.ts +
//   app/api/cron/weekly-send/route.ts: README's Deployment section only
//   described 2 of daily-send.yml's actual 3 scheduled cron windows
//   (14:00/15:00 UTC, missing the 18:00 UTC retry added 2026-08-06). Four
//   separate comments across the codebase still attributed retry/timeout
//   behavior to "Vercel" long after the 2026-08-05 migration to Cloudflare
//   Workers (website) + GitHub Actions (the cron trigger) -- reworded each
//   to name the actual current mechanism, including correctly attributing
//   weekly-send's after()/ctx.waitUntil comment to Cloudflare Workers (the
//   same mechanism already documented for sendOpsAlert in
//   app/api/admin/users/route.ts's alpha-drift-r35-03), not a "lambda."
// 4 refuted: an identically-shaped cancellation-guard finding on
// app/signin/page.tsx's OWN session-redirect effect (self-audit-r47,
// refuted 3/3 despite being the same class of bug this round fixed
// elsewhere), the QuestionStep/app/you/page.tsx duplicate noted above,
// a skip()-races-Back finding on QuestionStep (refuted 2/3), and a
// ProfileEditor.tsx save()-cancellation-guard proposal (refuted 3/3).
// alpha-drift-r48-01 through r48-03 (r48-03 spans 5 files), all 2026-08-20.
// Run: npx tsx scripts/verify-r48-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) components/onboarding/QuestionStep.tsx: the signed-in bounce effect now has a cancellation guard");
{
  const src = readFileSync(new URL("../components/onboarding/QuestionStep.tsx", import.meta.url), "utf8");
  check("(1a) a local `cancelled` flag is declared inside the effect", /useEffect\(\(\) => \{\s*\n\s*if \(!supabaseConfigured\(\)\) return;\s*\n\s*let cancelled = false;/.test(src));
  check("(1b) it's checked right after getSession resolves, before router.replace", /const \{ data: \{ session \} \} = await supabaseClient\(\)\.auth\.getSession\(\);\s*\n\s*if \(cancelled\) return;\s*\n\s*if \(session\) router\.replace\("\/inbox" as never\);/.test(src));
  check("(1c) the effect returns a cleanup setting cancelled = true", /return \(\) => \{ cancelled = true; \};\s*\n\s*\}, \[router\]\);/.test(src));
}

console.log("(2) app/settings/accounts/page.tsx: per-row busy tracking replaces the single shared busy slot");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(2a) busyRowsRef (synchronous) and busyRows (React state) both declared as Set<string>", /const busyRowsRef = useRef<Set<string>>\(new Set\(\)\);\s*\n\s*const \[busyRows, setBusyRows\] = useState<Set<string>>\(new Set\(\)\);/.test(src));
  check("(2b) act() bails synchronously if this row is already in flight", /async function act\([\s\S]{0,220}?\) \{\s*\n\s*if \(confirmMsg && !confirm\(confirmMsg\)\) return;\s*\n\s*if \(busyRowsRef\.current\.has\(userId\)\) return;\s*\n\s*busyRowsRef\.current\.add\(userId\);\s*\n\s*setBusyRows\(new Set\(busyRowsRef\.current\)\);/.test(src));
  check("(2c) the finally block removes this row from both the ref and the mirrored state", /busyRowsRef\.current\.delete\(userId\);\s*\n\s*setBusyRows\(new Set\(busyRowsRef\.current\)\);/.test(src));
  check("(2d) per-row isBusy now reads from the Set, not a single-slot comparison", /const isBusy = busyRows\.has\(u\.id\);/.test(src));
  check("(2e) the page-level search/clear guards now check the ref's size, not a single busy slot", /function runSearch\(e: React\.FormEvent\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*if \(busyRowsRef\.current\.size > 0\) return;/.test(src) && /function clearSearch\(\) \{\s*\n\s*if \(busyRowsRef\.current\.size > 0\) return;/.test(src));
  check("(2f) the old single-slot `busy`/`setBusy` state is gone entirely", !/const \[busy, setBusy\] = useState/.test(src));
}

console.log("(3) README.md now documents all 3 daily-send cron windows");
{
  const src = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  check("(3a) the Deployment section names 14:00, 15:00, and 18:00 UTC", /14:00 UTC primary \+ 15:00 UTC and 18:00 UTC retries/.test(src));
}

console.log("(4) stale 'Vercel' platform references reworded to the actual current hosts across 4 files");
{
  const emailSrc = readFileSync(new URL("../lib/email.ts", import.meta.url), "utf8");
  check("(4a) lib/email.ts's idempotency-key comment no longer says 'a Vercel cron retry'", !/a Vercel cron retry racing the scheduled run/.test(emailSrc) && /GitHub Actions retry cron/.test(emailSrc));

  const braveSrc = readFileSync(new URL("../lib/brave.ts", import.meta.url), "utf8");
  check("(4b) lib/brave.ts's monotonic-counter comment no longer says 'the same warm lambda (a Vercel retry'", !/the same warm lambda \(a Vercel/.test(braveSrc) && /GitHub Actions retry cron racing the 14:00 UTC primary run/.test(braveSrc));

  const generateSrc = readFileSync(new URL("../app/api/generate/route.ts", import.meta.url), "utf8");
  check("(4c) app/api/generate/route.ts no longer says \"waiting for Vercel's hard 504\"", !/waiting for Vercel's hard 504/.test(generateSrc) && /Cloudflare Workers' own hard timeout/.test(generateSrc));

  const weeklySendSrc = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
  check("(4d) weekly-send's after() comment no longer says 'Vercel is told to keep this invocation's lambda alive'", !/so Vercel is told to keep this invocation's lambda alive/.test(weeklySendSrc) && /ctx\.waitUntil/.test(weeklySendSrc) && /this route runs on Cloudflare Workers, not\s*\n\s*\/\/ Vercel/.test(weeklySendSrc));
}

console.log("(5) sanity: the refuted app/you/page.tsx and app/signin/page.tsx findings were deliberately left unchanged (differentiated verdicts, not misses)");
{
  const youSrc = readFileSync(new URL("../app/you/page.tsx", import.meta.url), "utf8");
  check("(5a) app/you/page.tsx's getSession bounce-effect is unchanged from before round 48 (no cancelled guard added)", /const \{ data: \{ session \} \} = await/.test(youSrc));

  const signinSrc = readFileSync(new URL("../app/signin/page.tsx", import.meta.url), "utf8");
  check("(5b) app/signin/page.tsx's session-redirect effect still has no cancelledRef check before router.replace(\"/inbox\") (only sendCode/verifyCode do)", /if \(session\) \{[\s\S]{0,250}?router\.replace\("\/inbox" as never\);/.test(signinSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R48 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R48 FINDINGS ASSERTIONS PASS");
