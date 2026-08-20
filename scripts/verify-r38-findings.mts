// Verify round 38 findings: smallest, most surgical round of the marathon
// so far -- 4 confirmed, ZERO refuted at the survives-verify stage (9 raw
// findings from other dimensions were correctly refuted before reaching
// "confirmed" -- speculative hardening, taste opinions, or claims the code
// contradicted -- see the round's own workflow journal for those).
// - self-audit-r37 found round 37's OWN voice-guard.ts fix still missed
//   -ed forms on 5 of the 10 verbs it patched (utilized/leveraged/navigated/
//   optimized/calibrated), plus game-changing alongside game-changer.
// - Fable's email-copy pass found an em dash shipping in literally every
//   daily letter's "IN THIS ISSUE" list -- the single most repeated AI-tell
//   exposure in the whole subscriber-facing surface.
// - Stripe billing edge cases found cancelled_at derived from the stale
//   webhook event snapshot instead of the live-refetched subscription,
//   unlike quantity two lines above it -- a genuine out-of-order-delivery
//   resurrection risk.
// - Cron reliability found watchdog_delivery_check()'s active-subscriber
//   definition never got updated for bounced_at/complained_at after those
//   columns were added the day after the RPC shipped -- dormant today (0
//   suppressed subscribers) but breaks permanently on the first real bounce.
//   The migration for this is WRITTEN but NOT YET APPLIED -- needs Algy's
//   live SQL editor click, same as every DDL change this session. Verified
//   here only as a file-shape check; a live pg_indexes-style confirmation
//   has to wait for that click, same discipline as prior migration rounds.
// alpha-drift-r38-01 through r38-04, all 2026-08-19.
// Run: npx tsx scripts/verify-r38-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) lib/engine/voice-guard.ts: BANNED_LEXICAL now catches the -ed forms round 37 missed");
{
  const src = readFileSync(new URL("../lib/engine/voice-guard.ts", import.meta.url), "utf8");
  check("(1a) leveraged added", /leverage\|leverages\|leveraging\|leveraged\b/.test(src));
  check("(1b) utilized added", /utilize\|utilizes\|utilizing\|utilized\b/.test(src));
  check("(1c) navigated added", /navigate\|navigates\|navigating\|navigated\b/.test(src));
  // alpha-drift-r39-02: round 39 further rewrote "optimization" to
  // "optimizations?" (adding plural coverage) and "game-changer" to
  // "game[- ]changers?" (adding the unhyphenated form) -- both changes
  // break these two assertions' exact literal-substring match even though
  // the underlying capability (optimized/game-changing detection) is still
  // present and now MORE complete, not less. Loosened to check presence of
  // the still-unchanged pieces plus the behavioral proof below, which is
  // the assertion that actually matters.
  check("(1d) optimized added", /optimize\|optimizes\|optimizing\|optimized\|optimizations?\b/.test(src));
  check("(1e) calibrated added", /calibrate\|calibrates\|calibrating\|calibrated\b/.test(src));
  check("(1f) game-changing added alongside game-changer", /changing\b/.test(src) && /changers?\b/.test(src));

  // Behavioral proof against the REAL exported findLexicalTells, not a
  // reimplementation -- these exact 6 sentences were confirmed by the r38
  // adversarial verify agents to slip through undetected pre-fix.
  const { findLexicalTells } = await import("../lib/engine/voice-guard.ts");
  check("(1g) behavioral: 'optimized workflows' now trips a tell", findLexicalTells("the new dashboard optimized workflows for busy teams").length > 0);
  check("(1h) behavioral: 'leveraged existing infrastructure' now trips a tell", findLexicalTells("the team leveraged existing infrastructure to ship faster").length > 0);
  check("(1i) behavioral: 'utilized real-time data' now trips a tell", findLexicalTells("this tool utilized real-time data").length > 0);
  check("(1j) behavioral: 'navigated readers' now trips a tell", findLexicalTells("the guide navigated readers through the new interface").length > 0);
  check("(1k) behavioral: 'game-changing release' now trips a tell", findLexicalTells("reviewers called it a real game-changing release").length > 0);
  check("(1l) behavioral: 'calibrated the sensors' now trips a tell", findLexicalTells("engineers calibrated the sensors overnight").length > 0);
  check("(1m) behavioral: a clean sentence with none of these words still trips nothing", findLexicalTells("The report shows home prices rose slightly last month.").length === 0);
}

console.log("(2) lib/email.ts: the daily letter's IN THIS ISSUE list no longer joins topic and headline with an em dash");
{
  const src = readFileSync(new URL("../lib/email.ts", import.meta.url), "utf8");
  check("(2a) the em dash join is gone", !/• \$\{s\.topicLabel\} — \$\{lead\}/.test(src));
  // alpha-drift-r39-01: round 39 found the r38 colon join itself collided
  // with a colon already inside the catalog's own "ai-news" topic label,
  // and fixed it by joining a sanitized safeLabel instead of the raw
  // s.topicLabel directly -- see verify-r39-findings.mts section (1) for
  // the full regression coverage of that fix. Loosened here to check the
  // colon-join SHAPE survived (not the exact raw-label variable name),
  // since the join mechanism itself (colon, not em dash) is still what
  // this assertion cares about.
  check("(2b) replaced with a colon join", /return lead \? `• \$\{safeLabel\}: \$\{lead\}` : `• \$\{safeLabel\}`;/.test(src));

  // Sanity: no other em dash was introduced by this edit, and the bullet
  // character itself is untouched. Widened the match window again after
  // r39 added more comment lines to this block (same non-reason as the
  // r38->r39 widening already done once here).
  const sectionListFnMatch = src.match(/const sectionList = params\.issue\.sections[\s\S]{0,2600}?\.join\("\\n"\);/);
  check("(2c) sanity: the sectionList builder itself contains zero em dashes after the fix", !!sectionListFnMatch && !sectionListFnMatch[0].includes("—"));

  const previewSrc = readFileSync(new URL("../scripts/preview-email.mts", import.meta.url), "utf8");
  // alpha-drift-r39-01: r39 wrapped this same fixture's label in
  // previewSafeLabel(...) (see verify-r39-findings.mts (1f)) to fix a
  // separate colon-collision bug that fixture's raw-label version had
  // reintroduced -- the literal "Topic"}: substring this assertion checked
  // now has an extra closing paren before it. Loosened to check the colon
  // join survived without pinning the exact call shape around it.
  check("(2d) scripts/preview-email.mts's sample fixture updated to match (colon, not em dash)", /"Topic"\)?\}: \$\{LONG_HEADLINE\}/.test(previewSrc));
}

console.log("(3) app/api/stripe/webhook/route.ts: cancelledAt now derives from the live-refetched subscription, not the stale event snapshot");
{
  const src = readFileSync(new URL("../app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
  check("(3a) liveSub is hoisted with `let` above the try block (was `const` inside it, out of scope at the derivation site)", /let liveSub: Stripe\.Subscription \| undefined;\s*\n\s*try \{\s*\n\s*liveSub = await stripe\.subscriptions\.retrieve\(sub\.id\);/.test(src));
  check("(3b) cancelledAt now derives from liveSub with a fallback to the event snapshot on retrieve failure", /const cancelledAt = deriveCancelledAt\(liveSub\?\.status \?\? sub\.status, liveSub\?\.cancel_at \?\? sub\.cancel_at\);/.test(src));
  check("(3c) the old stale-snapshot-only derivation is gone", !/const cancelledAt = deriveCancelledAt\(sub\.status, sub\.cancel_at\);/.test(src));

  // Behavioral proof against the REAL exported deriveCancelledAt, replicating
  // the exact out-of-order-delivery scenario the finding describes: an
  // earlier non-terminal event's retry lands after a later terminal event
  // already resolved cancelled_at, and confirms deriving from the live
  // subscription (not the stale event) converges on the correct answer.
  const { deriveCancelledAt } = await import("../lib/webhook-user-mutation.ts");
  const staleEventSnapshot = { status: "active", cancel_at: null }; // an EARLIER event's embedded state, delivered late
  const liveSubNow = { status: "canceled", cancel_at: null }; // Stripe's actual current state by the time this retry is processed
  const oldBehavior = deriveCancelledAt(staleEventSnapshot.status, staleEventSnapshot.cancel_at);
  const newBehavior = deriveCancelledAt(liveSubNow.status ?? staleEventSnapshot.status, liveSubNow.cancel_at ?? staleEventSnapshot.cancel_at);
  check("(3d) behavioral: the OLD stale-snapshot derivation would have resurrected a churned subscriber (returned null instead of a real cancellation timestamp)", oldBehavior === null);
  check("(3e) behavioral: the NEW live-subscription derivation correctly keeps the terminal cancellation (non-null)", newBehavior !== null);
}

console.log("(4) watchdog_delivery_check RPC: active-subscriber definition now matches the real send's bounced_at/complained_at exclusion (migration WRITTEN, blocked on Algy's live SQL editor click)");
{
  const migrationSrc = readFileSync(new URL("../supabase/migrations/20260819000000_watchdog_delivery_check_bounced_complained.sql", import.meta.url), "utf8");
  check("(4a) uncovered_count subquery now excludes bounced subscribers", /u\.bounced_at is null/.test(migrationSrc));
  check("(4b) uncovered_count subquery now excludes complained subscribers", /u\.complained_at is null/.test(migrationSrc));
  check("(4c) active_subscriber_count subquery now excludes bounced subscribers", /\n\s*and bounced_at is null/.test(migrationSrc));
  check("(4d) active_subscriber_count subquery now excludes complained subscribers", /\n\s*and complained_at is null/.test(migrationSrc));
  check("(4e) same function signature preserved (no drop needed, matches the file's own reasoning)", /returns table\(uncovered_count bigint, active_subscriber_count bigint\)/.test(migrationSrc));
  check("(4f) revoke/grant pair copied forward for this signature", /revoke all on function public\.watchdog_delivery_check\(timestamptz\) from public;/.test(migrationSrc) && /grant execute on function public\.watchdog_delivery_check\(timestamptz\) to anon;/.test(migrationSrc));

  const weeklySendSrc = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
  check("(4g) sanity: the real send's own filter this migration is matching is unchanged", /\.is\("bounced_at", null\)\s*\n\s*\.is\("complained_at", null\)/.test(weeklySendSrc));

  const verifyScriptSrc = readFileSync(new URL("../scripts/verify-watchdog-proof-of-send.mts", import.meta.url), "utf8");
  check("(4h) the borrow-a-subscriber test query updated to match (won't borrow a suppressed subscriber the RPC no longer counts as active)", /\.is\("bounced_at", null\)\s*\n\s*\.is\("complained_at", null\)\s*\n\s*\.limit\(1\)/.test(verifyScriptSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R38 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R38 FINDINGS ASSERTIONS PASS (migration file-shape only -- item (4)'s live application still needs Algy's SQL editor click)");
