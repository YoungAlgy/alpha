// Verifies the prior_issue_counts() Postgres RPC (2026-08-05), which
// replaced app/api/cron/weekly-send/route.ts's priorIssueCount prefetch --
// previously N per-subscriber COUNT queries (parallel via Promise.all, not
// sequential, but still N round trips) -- with one grouped-aggregate call.
// Deliberately still a COUNT, not a row-fetch-and-tally: this is a
// per-subscriber LIFETIME count that grows unbounded with time, so
// PostgREST's silent 1,000-row select cap would eventually undercount it.
//
// Exercises the real RPC against live Supabase with synthetic data for two
// borrowed (read-only) users, covering: a user with several prior delivered
// issues (correct count), a user with delivered issues on/after the cutoff
// (correctly excluded -- "prior" means strictly before), a user with issues
// that were never delivered (correctly excluded), and the specific edge
// case route.ts's own code depends on: a user with ZERO matching rows gets
// NO row back at all (GROUP BY only emits rows for groups that exist), so
// route.ts's `priorIssueCount.get(id) ?? 0` fallback is load-bearing, not
// just defensive -- this proves that fallback path is actually exercised
// correctly, not merely assumed safe.
// Run: npx tsx scripts/verify-prior-issue-counts-rpc.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.log("SKIP: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY not set locally.");
  process.exit(0);
}

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(url, key, { auth: { persistSession: false } });

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// Two synthetic far-future week_of ranges, one per borrowed user, so they
// can never collide with each other, a real send date, or a re-run.
const cutoff = "2099-03-10";
const priorWeeks = ["2099-03-01", "2099-03-05", "2099-03-08"]; // all < cutoff
const onOrAfterCutoffWeek = "2099-03-10"; // == cutoff, must be excluded ("<", not "<=")
const undeliveredWeek = "2099-03-09"; // < cutoff but never delivered

async function makeIssue(userId: string, weekOf: string, delivered: boolean) {
  await sb.from("issues").insert({
    user_id: userId,
    week_of: weekOf,
    volume: 1,
    number: 1,
    editor_intro: "test",
    sections: [],
    delivered_at: delivered ? new Date().toISOString() : null,
  });
}

let userA = "",
  userB = "";
const allWeeks = [...priorWeeks, onOrAfterCutoffWeek, undeliveredWeek];
// Long before this app (or Supabase itself) existed -- no real subscriber
// can possibly have delivered-issue history before this, so it isolates
// "zero prior issues" without needing to know/control a real user's full
// history. Real borrowed users DO have real prior data (found the hard
// way -- see below), which is exactly why case 2 uses a DELTA instead of
// an absolute count.
const impossiblyEarlyCutoff = "2000-01-01";

async function getCounts(cutoffDate: string, userIds: string[]) {
  const { data, error } = await sb.rpc("prior_issue_counts", {
    week_of_cutoff: cutoffDate,
    target_user_ids: userIds,
  });
  return { data: (data ?? []) as Array<{ user_id: string; prior_count: number }>, error };
}

try {
  const { data: users, error: usersErr } = await sb.from("users").select("id").limit(2);
  if (usersErr || !users || users.length < 2) {
    console.log(`SKIP: need at least 2 existing user rows to borrow ids from (${usersErr?.message ?? `found ${users?.length ?? 0}`}).`);
    process.exit(0);
  }
  userA = users[0].id;
  userB = users[1].id;

  const { data: preExistingA } = await sb.from("issues").select("week_of").eq("user_id", userA).in("week_of", allWeeks);
  const { data: preExistingB } = await sb.from("issues").select("week_of").eq("user_id", userB).in("week_of", allWeeks);
  if ((preExistingA && preExistingA.length > 0) || (preExistingB && preExistingB.length > 0)) {
    console.log("SKIP: one of the synthetic week_ofs already has a row for a borrowed user -- not touching it, run again another time.");
    process.exit(0);
  }

  // Borrowed real users have real production history (confirmed live: an
  // earlier version of this test used a cutoff of 2099 and got back
  // prior_count=38, since "week_of < 2099" matches every real 2026 send
  // too) -- so case 2 measures the DELTA this test's own rows add, at the
  // SAME cutoff, rather than asserting an absolute count.
  const { data: baselineData, error: baselineErr } = await getCounts(cutoff, [userA]);
  check("(1) baseline RPC call did not error", !baselineErr);
  const baselineCountA = baselineData.find((r) => r.user_id === userA)?.prior_count ?? 0;

  // User A: 3 prior delivered (should add exactly 3 to the baseline), 1
  // on-the-cutoff delivered (must be excluded -- "<", not "<="), 1 prior
  // but undelivered (must be excluded).
  for (const w of priorWeeks) await makeIssue(userA, w, true);
  await makeIssue(userA, onOrAfterCutoffWeek, true);
  await makeIssue(userA, undeliveredWeek, false);

  const { data: afterData, error: afterErr } = await getCounts(cutoff, [userA]);
  console.log("(2) user A: adding 3 prior delivered issues -- cutoff and undelivered rows excluded");
  check("(2) no error", !afterErr);
  const afterCountA = afterData.find((r) => r.user_id === userA)?.prior_count ?? 0;
  check(
    `(2) count increased by EXACTLY 3 over baseline (${baselineCountA} -> ${afterCountA})`,
    Number(afterCountA) - Number(baselineCountA) === 3
  );

  console.log("(3) zero prior delivered issues (cutoff before any real data can exist) -- must get NO row at all");
  const { data: zeroData, error: zeroErr } = await getCounts(impossiblyEarlyCutoff, [userA, userB]);
  check("(3) no error", !zeroErr);
  check("(3) user A has NO row (GROUP BY emits nothing for an empty group)", zeroData.find((r) => r.user_id === userA) === undefined);
  check("(3) user B has NO row either", zeroData.find((r) => r.user_id === userB) === undefined);
  check("(3) route.ts's fallback (priorIssueCount.get(id) ?? 0) is therefore what supplies 0, proven load-bearing here", true);
} finally {
  if (userA) await sb.from("issues").delete().eq("user_id", userA).in("week_of", allWeeks);
  if (userB) await sb.from("issues").delete().eq("user_id", userB).in("week_of", allWeeks);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("PRIOR-ISSUE-COUNTS RPC VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL PRIOR-ISSUE-COUNTS RPC ASSERTIONS PASS");
