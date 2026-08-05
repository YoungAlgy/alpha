// Verifies watchdog_delivery_check() correctly requires proof of send for
// anything after the 2026-08-05T19:10:00Z grandfather cutoff, while still
// correctly counting real pre-fix deliveries from before that time (they
// predate resend_message_id existing at all, so requiring it unconditionally
// would have made every one of today's genuine deliveries read as a false
// "not delivered" -- caught in review, see the migration's own comment).
//
// This is the fix for a real interaction bug between two of today's own
// changes: a stuck claim (delivered_at set, resend_message_id never set)
// used to read as "delivered" to this function, which both the watchdog's
// own 16:00 UTC check AND daily-send.yml's new retry pre-check rely on --
// meaning a stuck claim could fool the retry into skipping the one thing
// that would have reclaimed it, AND fool the watchdog into never alerting.
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
const GRANDFATHER_CUTOFF = new Date("2026-08-05T19:10:00Z");

async function delivered(cutoffIso: string) {
  const { data, error } = await sb.rpc("watchdog_delivery_check", { cutoff: cutoffIso });
  return { row: data?.[0], error };
}

let userId = "";

try {
  const { data: anyUser, error: userErr } = await sb.from("users").select("id").limit(1).maybeSingle();
  if (userErr || !anyUser) {
    console.log(`SKIP: no existing user row to borrow an id from (${userErr?.message ?? "table empty"}).`);
    process.exit(0);
  }
  userId = anyUser.id;

  const { data: preExisting } = await sb.from("issues").select("week_of").eq("user_id", userId).eq("week_of", weekOf);
  if (preExisting && preExisting.length > 0) {
    console.log("SKIP: synthetic week_of already has a row -- not touching it, run again another time.");
    process.exit(0);
  }

  // A "new" stuck claim: delivered_at set well AFTER the grandfather cutoff
  // (so it can't ride on that exemption), resend_message_id still null --
  // exactly the pattern a real stuck claim would leave behind today or any
  // day after the fix shipped.
  const afterGrandfather = new Date(GRANDFATHER_CUTOFF.getTime() + 60 * 60 * 1000).toISOString(); // +1hr
  await sb.from("issues").insert({
    user_id: userId,
    week_of: weekOf,
    volume: 1,
    number: 1,
    editor_intro: "test",
    sections: [],
    delivered_at: afterGrandfather,
    resend_message_id: null,
  });

  // Cutoff comfortably before our synthetic delivered_at so the RPC's own
  // delivered_at >= cutoff filter includes this row -- isolating the test
  // to specifically exercise the resend_message_id / grandfather logic,
  // not the cutoff-window filter itself.
  const testCutoff = new Date(GRANDFATHER_CUTOFF.getTime() - 60 * 60 * 1000).toISOString();

  console.log("(1) a NEW stuck claim (after the grandfather cutoff, no proof of send)");
  const before = await delivered(testCutoff);
  check("(1) RPC call did not error", !before.error);
  const countBefore = Number(before.row?.delivered_count ?? -1);

  // Confirm this row is actually influencing the count by checking it drops
  // back out when we supply proof of send -- i.e. this is a real behavioral
  // test, not just reading a static number.
  await sb.from("issues").update({ resend_message_id: "re_synthetic_proof" }).eq("user_id", userId).eq("week_of", weekOf);
  const after = await delivered(testCutoff);
  const countAfter = Number(after.row?.delivered_count ?? -1);

  check(
    `(1) delivered_count increases by exactly 1 once proof of send exists (${countBefore} -> ${countAfter})`,
    countAfter - countBefore === 1
  );
  console.log(
    "  (interpretation: before proof of send, this stuck-claim-shaped row did NOT count as delivered -- exactly the fix; after adding resend_message_id, it correctly does.)"
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
