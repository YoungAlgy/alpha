// Verifies the fix (alpha-drift-r14-03, review 2026-08-06) for a real gap in
// app/api/webhooks/resend/route.ts: the resend_webhook_events dedup row was
// inserted BEFORE the bounced_at/complained_at write ran, and never removed
// if that write failed. Every subsequent delivery of that (email_id, type)
// pair -- Resend's own retry, or a manual replay from the Resend dashboard
// -- then hit the dedup guard's short-circuit and was silently swallowed
// WITHOUT ever re-attempting the suppression write. A subscriber's dead
// address (or a real spam complaint) kept getting sent to indefinitely,
// exactly the outcome this webhook exists to prevent -- unlike its Stripe
// sibling (app/api/stripe/webhook/route.ts), which already handled this
// exact hazard (see scripts/verify-webhook-dedup-cleanup.mts), this fix
// was not carried over when the Resend webhook was built.
//
// Mirrors that script's own technique: exercise the real
// resend_webhook_events table directly with the insert-then-conditionally-
// delete pattern the route now uses (not a mock), against synthetic
// (email_id, type) pairs that can't collide with real Resend events, and
// clean up after itself.
// Run: npx tsx scripts/verify-resend-webhook-dedup-cleanup.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY in .env.local");
  process.exit(1);
}
const sb = createClient(url, key);

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// Mirrors route.ts's dedup insert exactly.
async function insertDedup(emailId: string, type: string) {
  const { data, error } = await sb
    .from("resend_webhook_events")
    .upsert({ email_id: emailId, type }, { onConflict: "email_id,type", ignoreDuplicates: true })
    .select("email_id");
  return { insertedFreshRow: !error && (data?.length ?? 0) > 0, error };
}

async function rowExists(emailId: string, type: string): Promise<boolean> {
  const { data } = await sb.from("resend_webhook_events").select("email_id").eq("email_id", emailId).eq("type", type).maybeSingle();
  return !!data;
}

const EVENT_A = `verify-resend-dedup-cleanup-a-${Date.now()}`;
const EVENT_B = `verify-resend-dedup-cleanup-b-${Date.now()}`;
const TYPE = "email.bounced";

try {
  // (1) Fresh event: first insert should report insertedFreshRow=true.
  const first = await insertDedup(EVENT_A, TYPE);
  check("(1) fresh event's first insert is a real fresh row", first.insertedFreshRow === true);
  check("(1) row actually exists after insert", await rowExists(EVENT_A, TYPE));

  // (2) Simulate the suppression write failing -- route.ts's updateErr
  // branch deletes the row it just inserted. Do the same here and confirm
  // it's gone.
  if (first.insertedFreshRow) {
    const { error: delErr } = await sb.from("resend_webhook_events").delete().eq("email_id", EVENT_A).eq("type", TYPE);
    check("(2) cleanup delete succeeds", !delErr);
  }
  check("(2) row is gone after simulated write failure + cleanup", !(await rowExists(EVENT_A, TYPE)));

  // (3) THE BUG THIS FIX CLOSES: a retry/replay of the SAME (email_id, type)
  // after cleanup must be treated as fresh again (insertedFreshRow=true),
  // not silently swallowed as a duplicate forever.
  const retry = await insertDedup(EVENT_A, TYPE);
  check("(3) retry after cleanup is treated as fresh, not swallowed as a dup -- THE BUG THIS FIX CLOSES", retry.insertedFreshRow === true);

  // (4) A genuine duplicate delivery (row still present, write never
  // failed) must still short-circuit -- confirm cleanup does NOT run for a
  // request that didn't do the fresh insert (insertedFreshRow=false).
  const dup = await insertDedup(EVENT_A, TYPE);
  check("(4) genuine duplicate of an already-present row reports insertedFreshRow=false", dup.insertedFreshRow === false);
  check("(4) row still exists (a real dup must never be deleted)", await rowExists(EVENT_A, TYPE));

  // (5) Same email_id, DIFFERENT type is a distinct key -- confirms the
  // composite (email_id, type) primary key, not just email_id alone, is
  // what's actually being deduped on.
  const otherType = await insertDedup(EVENT_A, "email.complained");
  check("(5) same email_id but a different type is a distinct dedup key", otherType.insertedFreshRow === true);

  // (6) An unrelated email_id entirely is unaffected by any of the above.
  const second = await insertDedup(EVENT_B, TYPE);
  check("(6) an unrelated email_id is unaffected by the above", second.insertedFreshRow === true);
} finally {
  // Clean up regardless of pass/fail.
  await sb.from("resend_webhook_events").delete().in("email_id", [EVENT_A, EVENT_B]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("RESEND WEBHOOK DEDUP CLEANUP VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL RESEND WEBHOOK DEDUP CLEANUP ASSERTIONS PASS");
