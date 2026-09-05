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
// Round 80 follow-up: reader access now also requires subscribed_at through
// hasSubscriberAccess(). Each page handles userError as a retryable load
// failure, then treats a clean missing row or missing subscription grant as
// access ended. This fails closed without mislabeling a DB hiccup as deletion.
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
  if (cond) pass++;
  else fail++;
};

const { hasActiveAccess, hasReaderAccess } = await import("../lib/access.ts");

// The exact boolean the fix adds at each call site.
function isGenuinelyMissingRow(userRow: unknown, userError: unknown): boolean {
  return !userError && !userRow;
}

// The full per-page outcome in the same order the real pages now use.
function accessOutcome(
  userRow: {
    subscribed_at?: string | null;
    cancelled_at?: string | null;
    access_granted_at?: string | null;
  } | null,
  userError: unknown,
  now: Date
): "error" | "ended" | "active" {
  if (userError) return "error";
  if (isGenuinelyMissingRow(userRow, userError)) return "ended";
  return hasReaderAccess(
    userRow?.subscribed_at,
    userRow?.cancelled_at,
    userRow?.access_granted_at,
    now
  )
    ? "active"
    : "ended";
}

console.log("(1) pure boundary table: the exact scenarios a signed-in tab can be in");
{
  const now = new Date("2026-08-13T12:00:00.000Z");
  const past = new Date("2026-07-01T00:00:00.000Z").toISOString();
  const future = new Date("2026-09-01T00:00:00.000Z").toISOString();
  const dbError = { message: "connection reset", code: "08006" };

  check(
    "(1) deleted account (row genuinely gone, query succeeded) -> access ended",
    accessOutcome(null, null, now) === "ended"
  );
  check(
    "(1) genuinely active reader (row exists, never cancelled) -> access NOT ended",
    accessOutcome({ subscribed_at: "2026-08-01T00:00:00.000Z", cancelled_at: null }, null, now) === "active"
  );
  check(
    "(1) cancel-at-period-end, still inside the paid window -> access NOT ended",
    accessOutcome({ subscribed_at: "2026-08-01T00:00:00.000Z", cancelled_at: future }, null, now) === "active"
  );
  check(
    "(1) cancellation already past its end date -> access ended",
    accessOutcome({ subscribed_at: "2026-08-01T00:00:00.000Z", cancelled_at: past }, null, now) === "ended"
  );
  check(
    "(1) permanent invite remains active after the paid period ends",
    accessOutcome(
      {
        subscribed_at: "2026-08-01T00:00:00.000Z",
        cancelled_at: past,
        access_granted_at: "2026-08-12T00:00:00.000Z",
      },
      null,
      now
    ) === "active"
  );
  check(
    "(1) revoked comp (subscribed_at null, cancellation null) -> access ended",
    accessOutcome({ subscribed_at: null, cancelled_at: null }, null, now) === "ended"
  );
  check(
    "(1) transient query failure -> retryable error state",
    accessOutcome(null, dbError, now) === "error"
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
    const errorChecks = (src.match(/if \(userError\)/g) ?? []).length;
    const guardChecks = (src.match(/if \(!userRow\)/g) ?? []).length;
    check(`(2) ${f.label}: userError is destructured from every users-table query (${f.expectedSites} expected)`, userErrorDestructures === f.expectedSites);
    check(`(2) ${f.label}: users-query errors get an explicit retry/error branch (${f.expectedSites} expected)`, errorChecks === f.expectedSites);
    check(`(2) ${f.label}: the genuinely-missing-row guard actually runs (${f.expectedSites} expected)`, guardChecks === f.expectedSites);
    const errorIdx = src.indexOf("if (userError)");
    const guardIdx = src.indexOf("if (!userRow)");
    const subscriberAccessIdx = src.indexOf("hasReaderAccess(", guardIdx);
    check(`(2) ${f.label}: error, missing-row, and subscribed-access checks run in fail-closed order`, errorIdx > -1 && guardIdx > errorIdx && subscriberAccessIdx > guardIdx);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("DELETED-ACCOUNT-ACCESS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL DELETED-ACCOUNT-ACCESS ASSERTIONS PASS");
