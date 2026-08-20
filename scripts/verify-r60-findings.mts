// Verify round 60 findings: 10 raised, all 10 confirmed by the panel and
// implemented as proposed (one detail deviated: the suggested fix's
// pointer at scripts/verify-weekly-send-alert-caps.mts for the new Gemini
// counter was wrong -- that script is scoped to email-list truncation
// caps, unrelated to rate-limit counters. Coverage for the new counter
// lives here instead, in this round's own script, matching how every
// other round-specific fix in this marathon is verified.)
// - app/inbox/page.tsx (accessibility-resweep-newer-code-r8, MEDIUM x3):
//   "Contact support," "Sign out," and "I'm new, start fresh" all had no
//   touch-target padding.
// - app/signin/page.tsx (accessibility-resweep-newer-code-r8, MEDIUM x2):
//   "Resend code" and "Use different email" had the same gap.
// - lib/engine/gemini-client.ts + app/api/cron/weekly-send/route.ts
//   (duplicate-code-audit-r10, HIGH): Gemini -- the PRIMARY, first-tried
//   generation tier -- had no rate-limited/quota-exhausted counter, unlike
//   its four siblings (Brave/You.com/Groq/DeepSeek), leaving a sustained
//   Gemini-only outage completely invisible to the weekly ops-alert.
//   Incremented directly in callGemini() (the one shared error path for
//   every caller) rather than threaded as a per-caller callback -- Gemini's
//   raw-REST client has no shared helper to hook into the way the OpenAI-
//   compatible providers do, so this is the correct centralization point.
// - lib/stripe-cancel.ts (silent-catch-audit-r6, HIGH): the internal
//   stripe_customer_id re-lookup inside cleanUpStripeCustomerBeforeDelete
//   discarded its error -- a second consecutive DB failure on the account-
//   deletion Stripe-cleanup path silently skipped subscription cancellation
//   with zero trace, after the auth user was already irreversibly deleted.
//   Now logs AND pages ops (this is the one failure mode on this path with
//   no later reconciliation that would ever catch it otherwise).
// - app/api/stripe/checkout/route.ts (silent-catch-audit-r6, MEDIUM): the
//   active-subscription pre-check discarded its error with zero logging --
//   functionally fine (documented fail-open), but a permanently broken
//   query would make the double-charge guard invisibly dead forever. Now
//   logged, still fails open.
// - app/api/admin/users/route.ts (silent-catch-audit-r6, MEDIUM): all 3
//   reads inside gatherStats() discarded their errors, so a DB hiccup
//   silently rendered the admin dashboard's subscriber counts as 0/
//   incomplete with a normal 200 response. Now each logs and throws; GET's
//   Promise.all is wrapped in try/catch to return the same clean 500 JSON
//   shape its sibling usersQuery error path already used. This also makes
//   weekly-send/route.ts's own "Same fix, same reasoning as gatherStats()"
//   comment true again (it was false before this fix).
// - lib/user-sync.ts + lib/onboarding-state.ts (form-validation-
//   consistency-audit-r5, HIGH): syncUserProfile()'s direct browser write
//   to users.topics had zero poolCap enforcement and no way to tell a
//   field THIS call meant to touch from one merely present in a possibly-
//   stale localStorage snapshot -- so any unrelated onboarding-state save
//   (a profile field in Settings) could silently resurrect a pre-downgrade,
//   over-cap topics pool the server had already correctly truncated.
//   syncUserProfile now takes the original, unmerged `patch` alongside the
//   merged `state`, and only writes topics when the patch itself explicitly
//   included it.
// alpha-drift-r60-01 through r60-10, all 2026-08-20.
// Run: npx tsx scripts/verify-r60-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/inbox/page.tsx: 3 controls now clear the 24px touch-target minimum");
{
  const src = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  check("(1a) 'Contact support' is padded", /underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--ink-soft\)" \}\}\s*\n\s*>\s*\n\s*Contact support/.test(src));
  check("(1b) 'Sign out' is padded", /underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--ink-soft\)" \}\}\s*\n\s*>\s*\n\s*Sign out/.test(src));
  check("(1c) \"I'm new, start fresh\" is padded", /underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--ink-soft\)" \}\}\s*\n\s*>\s*\n\s*I&apos;m new, start fresh/.test(src));
}

console.log("(2) app/signin/page.tsx: 2 buttons now clear the touch-target minimum");
{
  const src = readFileSync(new URL("../app/signin/page.tsx", import.meta.url), "utf8");
  check("(2a) 'Resend code' button is padded", /className="underline underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{\s*\n\s*color: "var\(--accent-ink\)",/.test(src));
  check("(2b) 'Use different email' button is padded", /className="underline underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ opacity: busy \? 0\.5 : 1, cursor: busy \? "default" : "pointer" \}\}/.test(src));
}

console.log("(3) lib/engine/gemini-client.ts: Gemini now has a rate-limited/quota-exhausted counter, matching its 4 siblings");
{
  const src = readFileSync(new URL("../lib/engine/gemini-client.ts", import.meta.url), "utf8");
  check("(3a) geminiRateLimitedCount is exported", /export function geminiRateLimitedCount\(\): number \{\s*\n\s*return rateLimitedCount;\s*\n\s*\}/.test(src));
  check("(3b) callGemini increments it on a 429 or 402", /if \(res\.status === 429 \|\| res\.status === 402\) rateLimitedCount \+= 1;/.test(src));
}

console.log("(4) app/api/cron/weekly-send/route.ts: geminiRateLimited is now wired into the baseline/delta/trigger/message/summary-line, matching its 4 siblings");
{
  const src = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
  check("(4a) geminiRateLimitedCount is imported", /import \{ geminiRateLimitedCount \} from "@\/lib\/engine\/gemini-client";/.test(src));
  check("(4b) a geminiBaseline is snapshotted", /const geminiBaseline = geminiRateLimitedCount\(\);/.test(src));
  check("(4c) geminiRateLimited delta is computed", /const geminiRateLimited = geminiRateLimitedCount\(\) - geminiBaseline;/.test(src));
  check("(4d) geminiRateLimited is in the summary object", /braveRateLimited,\s*\n\s*youRateLimited,\s*\n\s*geminiRateLimited,\s*\n\s*groqRateLimited,/.test(src));
  check("(4e) geminiRateLimited is in the alert trigger condition", /geminiRateLimited > 0 \|\|\s*\n\s*groqRateLimited > 0/.test(src));
  check("(4f) geminiRateLimited has its own message line", /Gemini \(the PRIMARY, first-tried generation tier for every topic blurb\) returned 429 or 402/.test(src));
  check("(4g) geminiRateLimited is in the short-summary log line", /\$\{geminiRateLimited > 0 \? ", Gemini quota hit" : ""\}/.test(src));
}

console.log("(5) lib/stripe-cancel.ts: the internal customer-id re-lookup now logs and pages ops on a real DB error");
{
  const src = readFileSync(new URL("../lib/stripe-cancel.ts", import.meta.url), "utf8");
  check("(5a) sendOpsAlert is imported", /import \{ sendOpsAlert \} from "\.\/email";/.test(src));
  check("(5b) error is destructured and checked", /const \{ data: row, error: rowErr \} = await svc/.test(src));
  check("(5c) a real error logs via console.warn", /console\.warn\(`\$\{logPrefix\} stripe_customer_id re-lookup failed, cannot verify\/cancel any Stripe subscription:`, rowErr\.message\);/.test(src));
  check("(5d) a real error also pages ops", /sendOpsAlert\(\s*\n\s*"alpha: possible orphaned Stripe subscription after account delete",/.test(src));
}

console.log("(6) app/api/stripe/checkout/route.ts: the active-subscription pre-check now logs a real DB error while still failing open");
{
  const src = readFileSync(new URL("../app/api/stripe/checkout/route.ts", import.meta.url), "utf8");
  check("(6a) error is destructured", /const \{ data: existing, error: existingError \} = await sb/.test(src));
  check("(6b) a real error is logged", /console\.warn\("\[stripe\/checkout\] active-subscription pre-check query failed, allowing checkout:", existingError\.message\);/.test(src));
  check("(6c) checkout still proceeds regardless (fail-open preserved)", /if \(existingError\) \{\s*\n\s*console\.warn\("\[stripe\/checkout\][^\n]*\n\s*\}\s*\n\s*if \(shouldBlockDoubleSubscription\(existing\)\)/.test(src));
}

console.log("(7) app/api/admin/users/route.ts: gatherStats()'s 3 reads now check + throw on error, caught by GET into a clean 500");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  check("(7a) the paginated users-page read checks error", /const \{ data: page, error: pageError \} = await sb/.test(src));
  check("(7b) the latest-issue read checks error", /const \{ data: latestIssues, error: latestIssuesError \} = await sb/.test(src));
  check("(7c) the issue-count read checks error", /const \{ count, error: countError \} = await sb/.test(src));
  check("(7d) all 3 throw once logged", (src.match(/throw new Error\(`gatherStats/g) || []).length === 3);
  // alpha-drift-r61-01 (2026-08-20, self-audit-r60) replaced the coupled
  // Promise.all + try/catch with Promise.allSettled, since the try/catch
  // form discarded a successful user-list fetch whenever ONLY gatherStats()
  // failed -- loosened to check for the current decoupled handling instead
  // of the exact old try/catch shape. See verify-r61-findings.mts's (1).
  check("(7e) GET decouples usersQuery from gatherStats() so a stats failure can't discard a successful user list (superseded by r61-01)", /Promise\.allSettled\(\[usersQuery, gatherStats\(\)\]\)/.test(src) && /console\.error\("\[admin\/users\] gatherStats failed:"/.test(src));
}

console.log("(8) lib/user-sync.ts + lib/onboarding-state.ts: syncUserProfile now only writes topics when THIS call's patch explicitly included it");
{
  const sync = readFileSync(new URL("../lib/user-sync.ts", import.meta.url), "utf8");
  check("(8a) syncUserProfile now accepts a second patch parameter", /export async function syncUserProfile\(state: OnboardingState, patch: Partial<OnboardingState>\): Promise<void> \{/.test(sync));
  check("(8b) the topics write is gated on 'topics' in patch", /if \("topics" in patch && Array\.isArray\(state\.topics\) && state\.topics\.length > 0\) \{/.test(sync));

  const onb = readFileSync(new URL("../lib/onboarding-state.ts", import.meta.url), "utf8");
  check("(8c) the call site passes patch alongside next", /syncUserProfile\(next, patch\);/.test(onb));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R60 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R60 FINDINGS ASSERTIONS PASS");
