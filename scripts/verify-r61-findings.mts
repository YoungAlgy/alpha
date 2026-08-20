// Verify round 61 findings: 8 raised, all 8 confirmed by the panel and
// implemented as proposed.
// - app/api/admin/users/route.ts (self-audit-r60, MEDIUM): a real
//   regression in round 60's own gatherStats()-throws fix -- combining
//   usersQuery and gatherStats() in one Promise.all meant a stats-only
//   failure discarded an already-successful user-list fetch too, blanking
//   the entire admin dashboard (including every action button) instead of
//   just hiding the stats panel. Decoupled via Promise.allSettled; stats:
//   null now signals "unavailable" to a frontend that already renders that
//   gracefully.
// - app/topics/page.tsx (accessibility-resweep-newer-code-r9, MEDIUM):
//   removeAt() unmounted the just-clicked remove button with no focus
//   restoration. Mirrors the accountsHeadingRef/deleteCount convention,
//   targeting the page's own always-rendered <h1> since removeAt() fires
//   from both the always-available custom-topic chip and the signed-in-
//   only ranked lineup.
// - app/settings/accounts/page.tsx (accessibility-resweep-newer-code-r9,
//   MEDIUM): the existing focus-restoration fix only fired for delete;
//   grant_free/revoke_free/clear_suppression unmount their own just-
//   clicked button identically but never triggered it. Renamed
//   deleteCount->actionCount and removed the action==="delete" gate.
// - components/ThemeApplier.tsx (duplicate-code-audit-r11, MEDIUM): the
//   signed-in DB theme hydrate updated <html data-theme> but never
//   dispatched alpha-theme-change, so ThemeSwitcher's button label and
//   dropdown highlight could go stale whenever the hydrate legitimately
//   changed the theme (no live edit involved). Now dispatches the same
//   event ThemeSwitcher already listens for.
// - lib/engine/persist.ts (silent-catch-audit-r7, MEDIUM): the
//   getUserById(expectedUserId) call discarded its error, so a transient
//   GoTrue failure was indistinguishable from a genuine "account deleted"
//   result and misattributed in the log. Now uses isUserNotFoundError to
//   tell the two apart -- still fails closed (skips persistence) on
//   genuine ambiguity, matching the pre-existing behavior, but now says so
//   accurately and pages ops.
// - app/api/cron/weekly-send/route.ts (silent-catch-audit-r7, LOW): the
//   Layer-2 last-resort backup-issue lookup discarded its error --
//   indistinguishable in the logs from "no prior delivered issue." Purely
//   a logging fix; the subscriber-facing outcome doesn't change.
// - app/api/stripe/update-quantity/route.ts (form-validation-consistency-
//   audit-r6, HIGH): round 59's own fresh topics re-read (added to fix a
//   staleness race) discarded its own error, silently reproducing the
//   exact truncation-skipped bug that fix existed to prevent, on a
//   transient read failure. Now logged, matching the rest of the handler.
// - app/api/stripe/webhook/route.ts (form-validation-consistency-audit-r6,
//   MEDIUM): the sibling topics-cap read's try/catch claimed to cover "a
//   read failure," but Supabase-js resolves rather than throws on a query
//   error -- the promised warn never actually fired for the real failure
//   mode. Now checks `error` explicitly, matching the comment's intent.
// alpha-drift-r61-01 through r61-08, all 2026-08-20.
// Run: npx tsx scripts/verify-r61-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/api/admin/users/route.ts: a gatherStats() failure no longer discards a successful user-list fetch");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  check("(1a) Promise.allSettled replaces the coupled Promise.all", /const \[usersSettled, statsSettled\] = await Promise\.allSettled\(\[usersQuery, gatherStats\(\)\]\);/.test(src));
  check("(1b) a rejected usersQuery is handled defensively", /if \(usersSettled\.status === "rejected"\) \{/.test(src));
  check("(1c) users comes from usersSettled.value regardless of stats outcome", /const \{ data: users, error \} = usersSettled\.value;/.test(src));
  check("(1d) stats defaults to null and is only set on a fulfilled gatherStats()", /let stats: Stats \| null = null;\s*\n\s*if \(statsSettled\.status === "fulfilled"\) \{\s*\n\s*stats = statsSettled\.value;/.test(src));
}

console.log("(2) app/topics/page.tsx: removeAt() now restores focus to the page's own heading");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
  check("(2a) removedCount state + topicsHeadingRef + effect exist", /const \[removedCount, setRemovedCount\] = useState\(0\);\s*\n\s*const topicsHeadingRef = useRef<HTMLHeadingElement>\(null\);\s*\n\s*useEffect\(\(\) => \{\s*\n\s*if \(removedCount > 0\) topicsHeadingRef\.current\?\.focus\(\);/.test(src));
  check("(2b) removeAt() increments removedCount", /setPicked\(\(prev\) => prev\.filter\(\(t\) => t !== id\)\);\s*\n\s*\/\/ alpha-drift-r61-02[^\n]*\n\s*setRemovedCount\(\(c\) => c \+ 1\);/.test(src));
  check("(2c) the h1 carries the ref, tabIndex, and outline:none", /ref=\{topicsHeadingRef\}\s*\n\s*tabIndex=\{-1\}\s*\n\s*className="alpha-display text-4xl md:text-5xl font-bold tracking-tight leading-tight mb-3"\s*\n\s*style=\{\{ outline: "none" \}\}/.test(src));
}

console.log("(3) app/settings/accounts/page.tsx: focus restoration now fires for all 4 actions, not just delete");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(3a) deleteCount was renamed to actionCount", /const \[actionCount, setActionCount\] = useState\(0\);/.test(src) && !/deleteCount/.test(src));
  check("(3b) the effect is keyed on actionCount", /if \(actionCount > 0\) accountsHeadingRef\.current\?\.focus\(\);\s*\n\s*\}, \[actionCount\]\);/.test(src));
  check("(3c) act()'s success path increments unconditionally, no action==='delete' gate", /setActionMsg\(`\$\{verb\} \$\{email\}\.`\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*setActionCount\(\(c\) => c \+ 1\);/.test(src));
}

console.log("(4) components/ThemeApplier.tsx: the DB hydrate now dispatches alpha-theme-change so ThemeSwitcher stays in sync");
{
  const src = readFileSync(new URL("../components/ThemeApplier.tsx", import.meta.url), "utf8");
  check("(4a) the hydrate branch now dispatches the event after set(dbTheme)", /if \(dbTheme && !themeEditedThisLoad\(\)\) \{\s*\n\s*set\(dbTheme\);\s*\n\s*window\.dispatchEvent\(new CustomEvent\("alpha-theme-change", \{ detail: \{ theme: dbTheme \} \}\)\);\s*\n\s*\}/.test(src));
}

console.log("(5) lib/engine/persist.ts: a real GoTrue error is now told apart from a genuine not-found result");
{
  const src = readFileSync(new URL("../lib/engine/persist.ts", import.meta.url), "utf8");
  check("(5a) isUserNotFoundError is imported", /import \{ isUserNotFoundError \} from "@\/lib\/gotrue-errors";/.test(src));
  check("(5b) error is destructured from getUserById", /const \{ data: stillExists, error: getUserErr \} = await sb\.auth\.admin\.getUserById\(expectedUserId\);/.test(src));
  check("(5c) a real (non-not-found) error logs, pages ops, and still fails closed", /if \(getUserErr && !isUserNotFoundError\(getUserErr\)\) \{[\s\S]{0,1500}return null;\s*\n\s*\}/.test(src));
  check("(5d) the original not-found branch is unchanged", /if \(!stillExists\?\.user\) \{\s*\n\s*console\.warn\(\s*\n\s*`\[persist\] expectedUserId/.test(src));
}

console.log("(6) app/api/cron/weekly-send/route.ts: the Layer-2 backup-issue lookup now logs a real query failure");
{
  const src = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
  check("(6a) error is destructured from the prior-issue read", /const \{ data: prior, error: priorErr \} = await sb/.test(src));
  check("(6b) a real error is logged distinctly", /if \(priorErr\) \{\s*\n\s*console\.error\(`\[cron\/weekly-send\] backup lookup query failed → \$\{row\.id\}: \$\{priorErr\.message\}`\);\s*\n\s*\}/.test(src));
}

console.log("(7) app/api/stripe/update-quantity/route.ts: the round-59 fresh topics re-read now logs a real error");
{
  const src = readFileSync(new URL("../app/api/stripe/update-quantity/route.ts", import.meta.url), "utf8");
  check("(7a) error is destructured from the fresh re-read", /const \{ data: freshRow, error: freshErr \} = await svc/.test(src));
  check("(7b) a real error is logged", /if \(freshErr\) \{\s*\n\s*console\.error\("\[update-quantity\] topics re-read failed:", freshErr\.message\);\s*\n\s*\}/.test(src));
}

console.log("(8) app/api/stripe/webhook/route.ts: the topics-cap read now checks error explicitly, matching its own comment's intent");
{
  const src = readFileSync(new URL("../app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
  check("(8a) error is destructured from the topics-cap read", /const \{ data: topicsRow, error: topicsErr \} = await sb/.test(src));
  check("(8b) a real error is explicitly checked and logged before the Array.isArray branch", /if \(topicsErr\) \{\s*\n\s*console\.warn\("\[stripe-webhook\] topics-cap read failed, writing topic_quota only:", topicsErr\.message\);\s*\n\s*\} else if \(Array\.isArray\(topicsRow\?\.topics\)\) \{/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R61 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R61 FINDINGS ASSERTIONS PASS");
