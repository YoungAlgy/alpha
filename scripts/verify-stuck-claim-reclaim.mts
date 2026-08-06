// Verifies the stuck-claim reclaim logic added 2026-08-05 to close the
// biggest remaining single point of failure the resilience audit found:
// runPersistAndSend stamps delivered_at as an atomic CLAIM before calling
// Resend. If the process dies in between, the row is left with delivered_at
// set and no email ever sent -- and every other check in the system reads
// that as "done", so that subscriber silently never gets a letter.
//
// The fix: resend_message_id is only ever set AFTER a confirmed successful
// send. A row with delivered_at set, resend_message_id still null, and
// delivered_at older than a safety margin is unambiguously stuck (not just
// slow) -- the reclaim step at the top of the GET handler nulls delivered_at
// back out for exactly that pattern.
//
// This exercises the real reclaim query directly against live Supabase
// (same shape as the route's own query) across five cases: a genuinely
// stuck old claim (should reclaim), a claim that's recent (still plausibly
// in-flight -- must NOT reclaim), a genuinely successful old send (has
// proof -- must NOT reclaim), an undelivered row (nothing to reclaim), and
// a row dated before the grandfather cutoff that LOOKS stuck (delivered_at
// set, no proof) but predates resend_message_id existing at all -- must
// NOT reclaim (added after catching a real gap in review: today's actual
// pre-fix deliveries all match the "stuck" pattern on the column alone).
// Run: npx tsx scripts/verify-stuck-claim-reclaim.mts
import { loadEnvLocal } from "./_load-env.mts";
import { RECLAIM_GRANDFATHER_CUTOFF } from "../lib/delivery-proof.ts";
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

const RECLAIM_SAFETY_MARGIN_MS = 10 * 60 * 1000;
// Five synthetic far-future week_of values, one per case, so they can never
// collide with each other or a real send date.
const weekOfStuck = "2099-02-01";
const weekOfRecent = "2099-02-02";
const weekOfProven = "2099-02-03";
const weekOfUndelivered = "2099-02-04";
const weekOfPreGrandfather = "2099-02-05";
const allWeekOfs = [weekOfStuck, weekOfRecent, weekOfProven, weekOfUndelivered, weekOfPreGrandfather];

async function reclaim(weekOf: string) {
  const reclaimCutoff = new Date(Date.now() - RECLAIM_SAFETY_MARGIN_MS).toISOString();
  return sb
    .from("issues")
    .update({ delivered_at: null })
    .eq("week_of", weekOf)
    .is("resend_message_id", null)
    .not("delivered_at", "is", null)
    .gte("delivered_at", RECLAIM_GRANDFATHER_CUTOFF)
    .lt("delivered_at", reclaimCutoff)
    .select("user_id");
}

let userId = "";

try {
  const { data: anyUser, error: userErr } = await sb.from("users").select("id").limit(1).maybeSingle();
  if (userErr || !anyUser) {
    console.log(`SKIP: no existing user row to borrow an id from (${userErr?.message ?? "table empty"}).`);
    process.exit(0);
  }
  userId = anyUser.id;

  const { data: preExisting } = await sb.from("issues").select("week_of").eq("user_id", userId).in("week_of", allWeekOfs);
  if (preExisting && preExisting.length > 0) {
    console.log("SKIP: one of the synthetic week_ofs already has a row -- not touching it, run again another time.");
    process.exit(0);
  }

  const baseContent = { volume: 1, number: 1, editor_intro: "test", sections: [] };
  const oldEnough = new Date(Date.now() - RECLAIM_SAFETY_MARGIN_MS - 60_000).toISOString(); // 1 min past the margin
  const tooRecent = new Date(Date.now() - 60_000).toISOString(); // 1 min ago -- well within the margin

  // Case 1: genuinely stuck -- old claim, no proof of send.
  await sb.from("issues").insert({ user_id: userId, week_of: weekOfStuck, ...baseContent, delivered_at: oldEnough, resend_message_id: null });
  // Case 2: recent claim, no proof yet -- plausibly still in-flight.
  await sb.from("issues").insert({ user_id: userId, week_of: weekOfRecent, ...baseContent, delivered_at: tooRecent, resend_message_id: null });
  // Case 3: old AND has proof -- a genuine successful send, just old.
  await sb.from("issues").insert({ user_id: userId, week_of: weekOfProven, ...baseContent, delivered_at: oldEnough, resend_message_id: "re_abc123genuine" });
  // Case 4: never claimed at all.
  await sb.from("issues").insert({ user_id: userId, week_of: weekOfUndelivered, ...baseContent, delivered_at: null, resend_message_id: null });
  // Case 5: looks stuck (delivered_at set, no proof, old) but dated BEFORE
  // the grandfather cutoff -- must survive untouched, same as today's real
  // pre-fix deliveries need to.
  const preGrandfather = "2026-08-05T18:00:00.000Z";
  await sb.from("issues").insert({ user_id: userId, week_of: weekOfPreGrandfather, ...baseContent, delivered_at: preGrandfather, resend_message_id: null });

  console.log("(1) stuck claim (old, no proof) -- should RECLAIM");
  const r1 = await reclaim(weekOfStuck);
  check("(1) reclaim query did not error", !r1.error);
  check("(1) exactly one row reclaimed", (r1.data?.length ?? 0) === 1);
  const { data: row1 } = await sb.from("issues").select("delivered_at").eq("user_id", userId).eq("week_of", weekOfStuck).single();
  check("(1) delivered_at is now null", row1?.delivered_at === null);

  console.log("(2) recent claim (still plausibly in-flight) -- must NOT reclaim");
  const r2 = await reclaim(weekOfRecent);
  check("(2) zero rows reclaimed", (r2.data?.length ?? 0) === 0);
  const { data: row2 } = await sb.from("issues").select("delivered_at").eq("user_id", userId).eq("week_of", weekOfRecent).single();
  check("(2) delivered_at is UNTOUCHED (still set)", row2?.delivered_at !== null);

  console.log("(3) old claim WITH proof of send -- must NOT reclaim a real success");
  const r3 = await reclaim(weekOfProven);
  check("(3) zero rows reclaimed", (r3.data?.length ?? 0) === 0);
  const { data: row3 } = await sb.from("issues").select("delivered_at, resend_message_id").eq("user_id", userId).eq("week_of", weekOfProven).single();
  check("(3) delivered_at is UNTOUCHED (still set)", row3?.delivered_at !== null);
  check("(3) resend_message_id is UNTOUCHED", row3?.resend_message_id === "re_abc123genuine");

  console.log("(4) never delivered -- nothing to reclaim");
  const r4 = await reclaim(weekOfUndelivered);
  check("(4) zero rows reclaimed", (r4.data?.length ?? 0) === 0);

  console.log("(5) looks stuck but predates the grandfather cutoff -- must NOT reclaim (matches today's real pre-fix deliveries)");
  const r5 = await reclaim(weekOfPreGrandfather);
  check("(5) zero rows reclaimed", (r5.data?.length ?? 0) === 0);
  const { data: row5 } = await sb.from("issues").select("delivered_at").eq("user_id", userId).eq("week_of", weekOfPreGrandfather).single();
  check("(5) delivered_at is UNTOUCHED (still set)", row5?.delivered_at !== null);
} finally {
  // Cleanup -- scoped to this user's synthetic week_ofs only, never a bare
  // eq("user_id", ...) (that would delete every real letter this borrowed
  // user has ever received).
  if (userId) {
    await sb.from("issues").delete().eq("user_id", userId).in("week_of", allWeekOfs);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("STUCK-CLAIM RECLAIM VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL STUCK-CLAIM RECLAIM ASSERTIONS PASS");
