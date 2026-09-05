// Verify round 21 finding (alpha-drift-r21-07, 2026-08-14, self-audit): the
// round-20 deleted-account-access fix (alpha-drift-r20-05, see
// verify-deleted-account-access.mts) reached the 4 session-based pages
// (/inbox, /inbox/[issueId], /archive load()+loadMore()) but never
// app/letter/page.tsx -- the "view in browser" link from the weekly email,
// which is TOKEN-based (no session to bounce), valid for up to 90 days, and
// reads via the service-role Supabase client (bypasses RLS entirely). A
// cascade-deleted `users` row makes userRow null; hasActiveAccess(undefined)
// reads that as "never cancelled" i.e. active -- if the orphaned issues row
// ever survives an account delete (no CASCADE, or a future schema change),
// this route would have rendered a deleted reader's letter to anyone still
// holding the 90-day link, with no session to have invalidated in the
// meantime. Same fix as round 20: destructure the users-query's own error
// and treat a genuinely-missing row (not a query failure) as access-ended.
// Run: npx tsx scripts/verify-letter-page-deleted-account.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
};

const { hasReaderAccess } = await import("../lib/access.ts");

console.log("(1) pure boundary table: the exact scenarios a 90-day-old letter link can be opened against");
{
  // Mirrors the real logic added to app/letter/page.tsx: an issue row is
  // "openable" only if it exists AND the account isn't deleted AND access
  // hasn't expired.
  function letterOpenable(
    issueRow: object | null,
    userRow: {
      subscribed_at?: string | null;
      cancelled_at?: string | null;
      access_granted_at?: string | null;
    } | null,
    userError: unknown
  ): boolean {
    if (!issueRow) return false;
    if (userError) return false;
    const accountDeleted = !userRow;
    return !(
      accountDeleted ||
      !hasReaderAccess(
        userRow?.subscribed_at,
        userRow?.cancelled_at,
        userRow?.access_granted_at
      )
    );
  }

  const past = new Date("2026-07-01T00:00:00.000Z").toISOString();
  const dbError = { message: "connection reset", code: "08006" };

  check(
    "(1) deleted account with an orphaned surviving issue row -> letter NOT openable",
    letterOpenable({}, null, null) === false
  );
  check(
    "(1) genuinely active reader (row exists, never cancelled) -> letter openable",
    letterOpenable({}, { subscribed_at: "2026-08-01T00:00:00.000Z", cancelled_at: null }, null) === true
  );
  check(
    "(1) cancellation already past its end date -> letter NOT openable",
    letterOpenable({}, { subscribed_at: "2026-08-01T00:00:00.000Z", cancelled_at: past }, null) === false
  );
  check(
    "(1) invite grant keeps a letter open after billing ends",
    letterOpenable(
      {},
      {
        subscribed_at: "2026-08-01T00:00:00.000Z",
        cancelled_at: past,
        access_granted_at: "2026-08-28T00:00:00.000Z",
      },
      null
    ) === true
  );
  check(
    "(1) revoked comp with no cancellation date -> letter NOT openable",
    letterOpenable({}, { subscribed_at: null, cancelled_at: null }, null) === false
  );
  check(
    "(1) transient users-query failure -> letter fails closed to load-problem state",
    letterOpenable({}, null, dbError) === false
  );
  check(
    "(1) no issue row at all (legitimately nothing to show) -> not openable, regardless of account state",
    letterOpenable(null, { subscribed_at: "2026-08-01T00:00:00.000Z", cancelled_at: null }, null) === false
  );
}

console.log("(2) source-level regression guard: the fix is actually wired into app/letter/page.tsx");
{
  const src = readFileSync(new URL("../app/letter/page.tsx", import.meta.url), "utf8");
  check("(2) the users-query destructures its own error, not just data", /error: userError/.test(src));
  check("(2) a users-query failure is ruled out before access is evaluated", /if \(!userError\) \{/.test(src));
  check("(2) an accountDeleted flag is derived from a clean missing row", /const accountDeleted = !userRow/.test(src));
  check("(2) accessEnded includes the shared paid-or-invite reader predicate", /!hasReaderAccess\([\s\S]*userRow\?\.access_granted_at/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("LETTER-PAGE-DELETED-ACCOUNT VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL LETTER-PAGE-DELETED-ACCOUNT ASSERTIONS PASS");
