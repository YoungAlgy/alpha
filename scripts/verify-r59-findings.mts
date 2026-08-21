// Verify round 59 findings: 12 raised, all 12 confirmed by the panel and
// implemented as proposed.
// - app/api/stripe/update-quantity/route.ts (self-audit-r58, HIGH): a real
//   regression round 58 introduced -- its topics-truncation fix reused a
//   `topics` snapshot fetched at the TOP of the handler, before 3
//   sequential awaited Stripe calls (list/update/retrieve). Since the
//   capped-topics write is truthy on virtually every call, this silently
//   clobbered a concurrent, independent /api/account/topics save made
//   during that window, on EVERY plan change (up or down), not just
//   downgrades. Now re-reads `topics` fresh immediately before the final
//   write, mirroring the webhook's own (already-correct) branch.
// - app/settings/page.tsx (accessibility-resweep-newer-code-r7, MEDIUM):
//   5 standalone CTA links ("Change topics", "See all looks", "Pick your
//   new topics", "Manage all users", "Changelog") had no touch-target
//   padding, unlike 6 sibling links in the same file that already do.
// - app/writing/page.tsx (accessibility-resweep-newer-code-r7, MEDIUM): 3
//   recovery-screen controls (Go to inbox, Email support, Wait on the
//   inbox) had the same gap, in the app's actual failure/retry UI.
// - app/error.tsx + app/not-found.tsx (accessibility-resweep-newer-code-r7,
//   MEDIUM): the "Or open your inbox" link on each had the same gap --
//   notably right next to app/error.tsx's own round-58 role="alert" edit,
//   uncaught by that round.
// - components/EmailChanger.tsx (accessibility-resweep-newer-code-r7,
//   MEDIUM): "Use a different email" (the post-submit sentTo view) had the
//   same gap as its own sibling trigger button 20 lines below.
// - app/archive/page.tsx (accessibility-resweep-newer-code-r7, MEDIUM):
//   "Contact support" in the ended-subscription empty state had the same gap.
// - scripts/verify-privacy-ai-provider-scope.mts (duplicate-code-audit-r9,
//   MEDIUM): 3 of 9 assertions were failing because round 36's later
//   "break marathon sentences into short declaratives" rewrite of
//   app/privacy/page.tsx shifted exact wording/punctuation at the checked
//   spots (a semicolon splice became two sentences; "of the letter built
//   from" became "built from"). The guard was stale, not the privacy copy.
// - scripts/verify-sample-issue-voice.mts (duplicate-code-audit-r9, LOW):
//   its last assertion required the literal substring "platforms,
//   aggregation" -- but round 40's later voice-guide pass rewrote that
//   sentence again to drop a banned rule-of-three/colon construction,
//   removing that phrase while keeping the sentence accurate and
//   banned-word-free (already re-confirmed by this same script's earlier
//   checks).
// - scripts/verify-r24-terms-and-admin-delete.mts (duplicate-code-audit-r9,
//   LOW): its sanity check asserted account/delete/route.ts's
//   cleanUpStripeCustomerBeforeDelete call was UNCHANGED at 3 arguments --
//   but round 46 legitimately changed it to 5 (a real, already-shipped fix
//   passing a pre-fetched stripe_customer_id, same shape as the admin
//   route round 24 originally fixed).
// - app/api/stripe/portal/route.ts (silent-catch-audit-r5, HIGH): the
//   stripe_customer_id pre-fetch discarded a real Supabase error, reporting
//   it identically to "no subscription" with zero logging, on the app's
//   only self-serve cancel/update-card path. Now split and logged, matching
//   the pattern already established at update-quantity/route.ts and
//   admin/users/route.ts.
// - app/settings/page.tsx (form-validation-consistency-audit-r4, MEDIUM):
//   after a downgrade, the "Your topics" section kept rendering backup
//   topics the server had just deleted server-side (round 58's own
//   truncation fix), because confirmTier() never resynced the client's
//   `topics` state. Now locally truncates to poolCap(data.topicQuota) on
//   direction === "down", mirroring the server's own logic.
// alpha-drift-r59-01 through r59-11, all 2026-08-20.
// Run: npx tsx scripts/verify-r59-findings.mts
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

function spawnCheck(cmd: string): boolean {
  try {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    execSync(cmd, { cwd: repoRoot, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

console.log("(1) app/api/stripe/update-quantity/route.ts: topics is now re-read fresh right before the write, not reused from before the Stripe round-trips");
{
  const src = readFileSync(new URL("../app/api/stripe/update-quantity/route.ts", import.meta.url), "utf8");
  check("(1a) the early SELECT no longer includes topics", !/\.select\("stripe_customer_id, topic_quota, subscribed_at, cancelled_at, topics"\)/.test(src));
  // alpha-drift-r61-07 added an `error: freshErr` destructure + a log check
  // to this same read -- loosened to allow either shape. See
  // verify-r61-findings.mts's (7).
  check("(1b) a fresh topics-only SELECT happens right before the final write", /const \{ data: freshRow(?:, error: freshErr)? \} = await svc\s*\n\s*\.from\("users"\)\s*\n\s*\.select\("topics"\)\s*\n\s*\.eq\("id", user\.id\)\s*\n\s*\.maybeSingle\(\);/.test(src));
  check("(1c) cappedTopics is now derived from freshRow, not the stale row", /Array\.isArray\(freshRow\?\.topics\)\s*\n\s*\? \(freshRow\.topics as TopicId\[\]\)\.slice\(0, poolCap\(newQuota\)\)/.test(src));
}

console.log("(2) app/settings/page.tsx: 5 CTA links now clear the 24px touch-target minimum");
{
  const src = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(2a) 'Change topics' link is padded", /Change topics →\s*\n\s*<\/Link>/.test(src) && /underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--accent-ink\)" \}\}\s*\n\s*>\s*\n\s*Change topics →/.test(src));
  check("(2b) 'See all looks' link is padded", /underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--accent-ink\)" \}\}\s*\n\s*>\s*\n\s*See all looks →/.test(src));
  check("(2c) 'Pick your new topics' link is padded", /font-semibold py-2 -my-2"/.test(src));
  check("(2d) 'Manage all users' link is padded", /underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--accent-ink\)" \}\}\s*\n\s*>\s*\n\s*Manage all users →/.test(src));
  check("(2e) 'Changelog' link is padded", /underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--accent-ink\)" \}\}\s*\n\s*>\s*\n\s*Changelog →/.test(src));
}

console.log("(3) app/writing/page.tsx: 3 recovery-screen controls now clear the touch-target minimum");
{
  const src = readFileSync(new URL("../app/writing/page.tsx", import.meta.url), "utf8");
  check("(3a) 'Go to inbox' is padded", /underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--ink-soft\)" \}\}\s*\n\s*>\s*\n\s*Go to inbox/.test(src));
  check("(3b) 'Email support' is padded", /underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--ink-soft\)" \}\}\s*\n\s*>\s*\n\s*Email support/.test(src));
  check("(3c) 'Wait on the inbox' is padded", /underline underline-offset-4 py-2 -my-2"/.test(src));
}

console.log("(4) app/error.tsx + app/not-found.tsx: the inbox link now clears the touch-target minimum");
{
  const err = readFileSync(new URL("../app/error.tsx", import.meta.url), "utf8");
  check("(4a) error.tsx's inbox link is padded", /underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--ink-soft\)" \}\}\s*\n\s*>\s*\n\s*Or open your inbox/.test(err));

  const nf = readFileSync(new URL("../app/not-found.tsx", import.meta.url), "utf8");
  check("(4b) not-found.tsx's inbox link is padded", /underline-offset-4 py-2 -my-2"\s*\n\s*style=\{\{ color: "var\(--ink-soft\)" \}\}\s*\n\s*>\s*\n\s*Or open your inbox/.test(nf));
}

console.log("(5) components/EmailChanger.tsx + app/archive/page.tsx: 2 more controls now clear the touch-target minimum");
{
  const ec = readFileSync(new URL("../components/EmailChanger.tsx", import.meta.url), "utf8");
  check("(5a) 'Use a different email' is padded", /underline underline-offset-4 mt-3 py-2 -my-2"/.test(ec));

  const archive = readFileSync(new URL("../app/archive/page.tsx", import.meta.url), "utf8");
  check("(5b) 'Contact support' is padded", /underline-offset-4 self-center py-2 -my-2"/.test(archive));
}

console.log("(6) 3 standalone verify scripts pass again after real-code drift from rounds 36, 40, and 46");
{
  check("(6a) verify-privacy-ai-provider-scope.mts passes clean", spawnCheck("npx tsx scripts/verify-privacy-ai-provider-scope.mts"));
  check("(6b) verify-sample-issue-voice.mts passes clean", spawnCheck("npx tsx scripts/verify-sample-issue-voice.mts"));
  check("(6c) verify-r24-terms-and-admin-delete.mts passes clean", spawnCheck("npx tsx scripts/verify-r24-terms-and-admin-delete.mts"));
}

console.log("(7) app/api/stripe/portal/route.ts: the stripe_customer_id pre-fetch error is now logged and reported distinctly");
{
  const src = readFileSync(new URL("../app/api/stripe/portal/route.ts", import.meta.url), "utf8");
  check("(7a) error is checked and logged separately from the not-found branch", /if \(error\) \{\s*\n\s*console\.error\("\[stripe\/portal\] customer lookup failed:", error\.message\);\s*\n\s*return NextResponse\.json\(\{ error: "Couldn't load your subscription\. Try again\." \}, \{ status: 500 \}\);\s*\n\s*\}/.test(src));
  check("(7b) the not-found 400 branch is now a separate, distinct check", /if \(!row\?\.stripe_customer_id\) \{\s*\n\s*return NextResponse\.json\(\s*\n\s*\{ error: "No Stripe customer on file\. Subscribe first\." \},/.test(src));
}

console.log("(8) app/settings/page.tsx: a downgrade now resyncs the client's topics state to match the server's truncation");
{
  const src = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(8a) poolCap is imported", /import \{ poolCap \} from "@\/lib\/engine\/select-sections";/.test(src));
  // alpha-drift-r68-01 (2026-08-21): superseded by a broadcast fix -- the
  // exact functional-setTopics-updater shape this used to pin no longer
  // exists (see verify-r68-findings.mts check 1). Reasserted here as the
  // semantic invariant this check actually cares about: a downgrade still
  // truncates topics to poolCap(data.topicQuota) and still calls setTopics.
  check("(8b) confirmTier's success branch truncates topics on a downgrade", /if \(direction === "down"\) \{[\s\S]{0,200}poolCap\(data\.topicQuota\)[\s\S]{0,200}setTopics\(/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R59 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R59 FINDINGS ASSERTIONS PASS");
