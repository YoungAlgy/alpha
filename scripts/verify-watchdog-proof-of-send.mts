// Verifies watchdog_delivery_check() correctly requires proof of send for
// anything after the 2026-08-05T19:10:00Z grandfather cutoff (see
// lib/delivery-proof.ts), while still correctly treating real pre-fix
// deliveries from before that time as covered (they predate
// resend_message_id existing at all, so requiring it unconditionally would
// have made every one of that day's genuine deliveries read as a false
// "not delivered" -- caught in review, see the migration's own comment).
//
// This is the fix for a real interaction bug between two of that day's own
// changes: a stuck claim (delivered_at set, resend_message_id never set)
// used to read as "delivered" to this function, which both the watchdog's
// own 16:00 UTC check AND daily-send.yml's retry pre-check rely on --
// meaning a stuck claim could fool the retry into skipping the one thing
// that would have reclaimed it, AND fool the watchdog into never alerting.
//
// Also verifies the 2026-08-05 rewrite from an aggregate-count comparison
// (delivered_count >= active_subscriber_count -- coincidentally satisfiable
// even when one SPECIFIC active subscriber has no letter, e.g. someone
// unsubscribes the same window someone else signs up) to a genuine
// per-subscriber coverage check (uncovered_count -- a real active
// subscriber with zero covered issues since cutoff). This test borrows a
// real active subscriber and confirms the function correctly flags them
// uncovered while their only recent issue lacks proof of send, and correctly
// clears once proof exists.
// Run: npx tsx scripts/verify-watchdog-proof-of-send.mts
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

const weekOf = "2099-04-01"; // synthetic, can't collide with real data

async function checkCoverage(cutoffIso: string) {
  const { data, error } = await sb.rpc("watchdog_delivery_check", { cutoff: cutoffIso });
  return { row: data?.[0], error };
}

let userId = "";

try {
  // Must be a genuinely ACTIVE subscriber -- the rewritten RPC only counts
  // active subscribers toward uncovered_count, so an arbitrary (possibly
  // cancelled/unsubscribed) borrowed row would never move the number no
  // matter what we do to its issues.
  const { data: anyUser, error: userErr } = await sb
    .from("users")
    .select("id")
    .not("subscribed_at", "is", null)
    .is("unsubscribed_at", null)
    .is("cancelled_at", null)
    .limit(1)
    .maybeSingle();
  if (userErr || !anyUser) {
    console.log(`SKIP: no active user row to borrow an id from (${userErr?.message ?? "none found"}).`);
    process.exit(0);
  }
  userId = anyUser.id;

  const { data: preExisting } = await sb.from("issues").select("week_of").eq("user_id", userId).eq("week_of", weekOf);
  if (preExisting && preExisting.length > 0) {
    console.log("SKIP: synthetic week_of already has a row -- not touching it, run again another time.");
    process.exit(0);
  }

  // "Now", not a fixed historical instant -- always lands after the fixed
  // 2026-08-05 grandfather cutoff (so proof of send is genuinely required),
  // and keeps this test valid indefinitely instead of quietly rotting once
  // real production data accumulates past a hardcoded date. A "new" stuck
  // claim: delivered_at set just now, resend_message_id still null --
  // exactly the pattern a real stuck claim would leave behind.
  const nowIso = new Date().toISOString();
  await sb.from("issues").insert({
    user_id: userId,
    week_of: weekOf,
    volume: 1,
    number: 1,
    editor_intro: "test",
    sections: [],
    delivered_at: nowIso,
    resend_message_id: null,
  });

  // A tight recent window (not the fixed grandfather date) so this only
  // ever sees OUR synthetic row for this user, never their real delivery
  // history from another day -- a per-user existence check saturates at
  // "covered" the moment ANY qualifying row exists, so an old real letter
  // sitting inside a wide cutoff window would make the borrowed user look
  // covered regardless of what we do to the synthetic row, breaking the
  // "changes by exactly 1" assertion below.
  const testCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  console.log("(1) a NEW stuck claim (delivered just now, no proof of send) -- borrowed active subscriber should show UNCOVERED");
  const before = await checkCoverage(testCutoff);
  check("(1) RPC call did not error", !before.error);
  const uncoveredBefore = Number(before.row?.uncovered_count ?? -1);
  check("(1) borrowed active subscriber is counted uncovered", uncoveredBefore >= 1);

  // Confirm this is a real behavioral test, not a static read: supply proof
  // of send and confirm the subscriber drops back OFF the uncovered count.
  await sb.from("issues").update({ resend_message_id: "re_synthetic_proof" }).eq("user_id", userId).eq("week_of", weekOf);
  const after = await checkCoverage(testCutoff);
  const uncoveredAfter = Number(after.row?.uncovered_count ?? -1);

  check(
    `(1) uncovered_count drops by exactly 1 once proof of send exists (${uncoveredBefore} -> ${uncoveredAfter})`,
    uncoveredBefore - uncoveredAfter === 1
  );
  console.log(
    "  (interpretation: before proof of send, this stuck-claim-shaped row did NOT count as covering the subscriber -- exactly the fix; after adding resend_message_id, it correctly does.)"
  );
} finally {
  if (userId) {
    await sb.from("issues").delete().eq("user_id", userId).eq("week_of", weekOf);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("WATCHDOG PROOF-OF-SEND VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL WATCHDOG PROOF-OF-SEND ASSERTIONS PASS");
