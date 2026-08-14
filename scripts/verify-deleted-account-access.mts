// Verify round 20 task #129 (alpha-drift-r20-05, 2026-08-13): a deleted
// account kept a working "signed in" session on other devices/tabs.
//
// Root cause: app/inbox/page.tsx, app/inbox/[issueId]/page.tsx, and
// app/archive/page.tsx (load() + loadMore(), 4 call sites total) all read
// `session` via supabase.auth.getSession() -- which only decodes the LOCAL
// cached JWT, with no live check against the Supabase Auth server -- then
// gated access with `hasActiveAccess(userRow?.cancelled_at)`. Once an
// account is deleted, its `users` row is cascade-deleted, so userRow becomes
// null; `userRow?.cancelled_at` is then `undefined`, and
// hasActiveAccess(undefined) === true ("never cancelled" == active), the
// exact opposite of what a missing row means. A signed-in tab on another
// device kept rendering the reader's last-cached issue (or the localStorage
// fallback) indefinitely.
//
// Fix: at each call site, also destructure the users-query's own `error`
// and treat a GENUINELY missing row (!userError && !userRow -- .maybeSingle()
// returns error:null on a real zero-row result, unlike a query failure) as
// "access ended," same as an expired cancellation. A transient query failure
// (network/RLS hiccup) still falls through unchanged, exactly as before --
// this must never misread a hiccup as "this account was deleted."
//
// These are client React components with no DOM test harness in this repo,
// so (like verify-access-window.mts does for hasActiveAccess itself) this
// verifies the DECISION LOGIC in isolation as a pure boundary table, plus a
// source-level regression guard proving the fix is actually wired into all
// 4 call sites (not just present in one file while silently missing from a
// sibling -- the exact class of drift this session's self-audit rounds keep
// catching).
// Run: npx tsx scripts/verify-deleted-account-access.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const { hasActiveAccess } = await import("../lib/access.ts");

// The exact boolean the fix adds at each call site.
function isGenuinelyMissingRow(userRow: unknown, userError: unknown): boolean {
  return !userError && !userRow;
}

// The full per-page decision, combining the new check with the existing
// hasActiveAccess call in the same order the real pages now use.
function accessEnded(userRow: { cancelled_at?: string | null } | null, userError: unknown, now: Date): boolean {
  if (isGenuinelyMissingRow(userRow, userError)) return true;
  return !hasActiveAccess(userRow?.cancelled_at, now);
}

console.log("(1) pure boundary table: the exact scenarios a signed-in tab can be in");
{
  const now = new Date("2026-08-13T12:00:00.000Z");
  const past = new Date("2026-07-01T00:00:00.000Z").toISOString();
  const future = new Date("2026-09-01T00:00:00.000Z").toISOString();
  const dbError = { message: "connection reset", code: "08006" };

  check(
    "(1) deleted account (row genuinely gone, query succeeded) -> access ended",
    accessEnded(null, null, now) === true
  );
  check(
    "(1) genuinely active reader (row exists, never cancelled) -> access NOT ended",
    accessEnded({ cancelled_at: null }, null, now) === false
  );
  check(
    "(1) cancel-at-period-end, still inside the paid window -> access NOT ended",
    accessEnded({ cancelled_at: future }, null, now) === false
  );
  check(
    "(1) cancellation already past its end date -> access ended",
    accessEnded({ cancelled_at: past }, null, now) === true
  );
  check(
    "(1) THE CRITICAL CASE: a transient query failure must NOT be misread as deletion",
    accessEnded(null, dbError, now) === false
  );
  check(
    "(1) the OLD buggy behavior is what this replaces: hasActiveAccess(undefined) alone reads a missing row as active",
    hasActiveAccess(undefined, now) === true
  );
}

console.log("(2) source-level regression guard: the fix is wired into all 4 real call sites, not just some");
{
  const files: Array<{ path: string; expectedSites: number; label: string }> = [
    { path: "../app/inbox/page.tsx", expectedSites: 1, label: "/inbox" },
    { path: "../app/inbox/[issueId]/page.tsx", expectedSites: 1, label: "/inbox/[issueId]" },
    { path: "../app/archive/page.tsx", expectedSites: 2, label: "/archive (load + loadMore)" },
  ];
  for (const f of files) {
    const src = readFileSync(new URL(f.path, import.meta.url), "utf8");
    const userErrorDestructures = (src.match(/error:\s*userError/g) ?? []).length;
    // Match the real `if (...)` guard specifically, not the explanatory
    // comment above it that also quotes the expression in prose.
    const guardChecks = (src.match(/if \(!userError && !userRow\)/g) ?? []).length;
    check(`(2) ${f.label}: userError is destructured from every users-table query (${f.expectedSites} expected)`, userErrorDestructures === f.expectedSites);
    check(`(2) ${f.label}: the genuinely-missing-row guard actually runs (${f.expectedSites} expected)`, guardChecks === f.expectedSites);
    // Ordering: the new guard must run BEFORE the existing hasActiveAccess
    // call at each site, mirroring the fix's intent (catch the deleted-
    // account case as its own signal, not as a side effect of the
    // cancellation-date check).
    const guardIdx = src.indexOf("!userError && !userRow");
    const hasActiveAccessIdx = src.indexOf("hasActiveAccess(userRow?.cancelled_at)");
    check(`(2) ${f.label}: the new guard is checked before hasActiveAccess, not after`, guardIdx > -1 && hasActiveAccessIdx > -1 && guardIdx < hasActiveAccessIdx);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("DELETED-ACCOUNT-ACCESS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL DELETED-ACCOUNT-ACCESS ASSERTIONS PASS");
