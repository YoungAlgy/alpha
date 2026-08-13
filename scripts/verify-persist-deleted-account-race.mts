// Verifies the fix (alpha-drift-r17-03, 2026-08-07) for a real race: /api/generate
// can run up to GENERATE_DEADLINE_MS=105s, and if the SAME authenticated user
// deletes their account (cascades within seconds) while their own generate call
// is still in flight, persistIssueIfPossible's generateLink({type:"magiclink"})
// used to find no auth user for that email anymore and IMPLICITLY CREATE A NEW
// ONE -- silently resurrecting the "deleted" account moments after deletion,
// with a fresh session established.
//
// The fix: when persistIssueIfPossible is called with an expectedUserId (only
// set for an already-authenticated re-generate call, never a true first-time
// signup), it re-checks that exact user still exists via getUserById BEFORE
// calling generateLink, and bails (returns null, no side effects) if not.
//
// This test exercises the real Supabase auth admin API against a genuinely
// nonexistent user id + a synthetic, never-real email, and confirms:
//   1. getUserById on a nonexistent id behaves the way the fix assumes.
//   2. persistIssueIfPossible with that nonexistent expectedUserId returns
//      null AND does not create any new auth user for the synthetic email --
//      the actual bug this fix closes.
// Run: npx tsx scripts/verify-persist-deleted-account-race.mts
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

// A syntactically valid UUID that (with overwhelming probability) has never
// been a real auth user id -- models "this user was just deleted."
const NONEXISTENT_USER_ID = "00000000-0000-4000-8000-000000000001";
const SYNTHETIC_EMAIL = `alpha-test-r17-03-${Date.now()}@example.invalid`;

console.log("(1) getUserById on a nonexistent id -- confirms the assumption the fix relies on");
{
  const { data, error } = await sb.auth.admin.getUserById(NONEXISTENT_USER_ID);
  check("(1) no user returned for a nonexistent id", !data?.user);
  console.log(`    (informational: error=${error?.message ?? "none"})`);
}

console.log("(2) persistIssueIfPossible with a dead expectedUserId does NOT resurrect an account");
{
  const { persistIssueIfPossible } = await import("../lib/engine/persist.ts");
  const fakeProfile = {
    email: SYNTHETIC_EMAIL,
    firstName: "Test",
    city: "",
    topics: ["ai-news"],
  } as Parameters<typeof persistIssueIfPossible>[0];
  const fakeIssue = {
    id: "test",
    volume: 1,
    number: 1,
    weekOf: "2099-01-01",
    recipientFirstName: "Test",
    recipientCity: "",
    editorIntro: "test",
    sections: [],
  } as Parameters<typeof persistIssueIfPossible>[1];

  const result = await persistIssueIfPossible(fakeProfile, fakeIssue, "2099-01-01", NONEXISTENT_USER_ID);
  check("(2) persistIssueIfPossible returned null (persistence correctly skipped)", result === null);

  // The actual bug: did generateLink get called anyway and silently create a
  // new auth user for this synthetic email? listUsers doesn't support a
  // direct email filter in the admin API used here, so page through and look
  // for it -- the synthetic email is unique enough (timestamped) that finding
  // it at all proves the bug reproduced.
  let foundLeakedUser = false;
  for (let page = 1; page <= 5; page++) {
    const { data: list } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (!list?.users?.length) break;
    if (list.users.some((u) => u.email?.toLowerCase() === SYNTHETIC_EMAIL)) {
      foundLeakedUser = true;
      break;
    }
    if (list.users.length < 200) break; // last page
  }
  check("(2) no new auth user was created for the synthetic email -- THE BUG THIS FIX CLOSES", !foundLeakedUser);

  if (foundLeakedUser) {
    console.log("    !! Cleaning up an accidentally-created leaked test user...");
    const { data: list } = await sb.auth.admin.listUsers({ perPage: 200 });
    const leaked = list?.users?.find((u) => u.email?.toLowerCase() === SYNTHETIC_EMAIL);
    if (leaked) await sb.auth.admin.deleteUser(leaked.id);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("PERSIST-DELETED-ACCOUNT-RACE VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL PERSIST-DELETED-ACCOUNT-RACE ASSERTIONS PASS");
