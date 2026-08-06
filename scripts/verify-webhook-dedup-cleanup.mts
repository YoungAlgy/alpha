// Verifies the fix (round 9, 2026-08-06) for a real bug in
// app/api/stripe/webhook/route.ts: the stripe_webhook_events dedup row was
// inserted BEFORE the handler ran, and never removed if the handler threw.
// Every subsequent Stripe retry of that event then hit the dedup guard's
// short-circuit and was silently swallowed WITHOUT ever re-entering the
// handler -- a paying customer whose checkout.session.completed handler hit
// any transient error was stranded with no users row, no quota, no welcome
// email, permanently, despite Stripe retrying for days.
//
// The fix: track whether THIS request performed the fresh insert, and if the
// handler subsequently throws, best-effort delete that row so the next
// Stripe retry is free to reprocess.
//
// This exercises the real Supabase table directly with the exact
// insert-then-conditionally-delete pattern the route now uses (not a mock),
// against synthetic event ids that can't collide with real Stripe events,
// and cleans up after itself.
// Run: npx tsx scripts/verify-webhook-dedup-cleanup.mts
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
async function insertDedup(id: string, type: string) {
  const { data, error } = await sb
    .from("stripe_webhook_events")
    .upsert({ id, type }, { onConflict: "id", ignoreDuplicates: true })
    .select("id");
  return { insertedFreshRow: !error && (data?.length ?? 0) > 0, error };
}

async function rowExists(id: string): Promise<boolean> {
  const { data } = await sb.from("stripe_webhook_events").select("id").eq("id", id).maybeSingle();
  return !!data;
}

const EVENT_A = `verify-dedup-cleanup-a-${Date.now()}`;
const EVENT_B = `verify-dedup-cleanup-b-${Date.now()}`;

try {
  // (1) Fresh event: first insert should report insertedFreshRow=true.
  const first = await insertDedup(EVENT_A, "checkout.session.completed");
  check("(1) fresh event's first insert is a real fresh row", first.insertedFreshRow === true);
  check("(1) row actually exists after insert", await rowExists(EVENT_A));

  // (2) Simulate the handler throwing -- route.ts's catch block deletes the
  // row it just inserted. Do the same here and confirm it's gone.
  if (first.insertedFreshRow) {
    const { error: delErr } = await sb.from("stripe_webhook_events").delete().eq("id", EVENT_A);
    check("(2) cleanup delete succeeds", !delErr);
  }
  check("(2) row is gone after simulated handler failure + cleanup", !(await rowExists(EVENT_A)));

  // (3) THE BUG THIS FIX CLOSES: a retry of the SAME event after cleanup
  // must be treated as fresh again (insertedFreshRow=true), not silently
  // swallowed as a duplicate.
  const retry = await insertDedup(EVENT_A, "checkout.session.completed");
  check("(3) retry after cleanup is treated as fresh, not swallowed as a dup -- THE BUG THIS FIX CLOSES", retry.insertedFreshRow === true);

  // (4) A genuine duplicate delivery (row still present, handler never
  // failed) must still short-circuit -- confirm cleanup does NOT run for a
  // request that didn't do the fresh insert (insertedFreshRow=false).
  const dup = await insertDedup(EVENT_A, "checkout.session.completed");
  check("(4) genuine duplicate of an already-present row reports insertedFreshRow=false", dup.insertedFreshRow === false);
  check("(4) row still exists (a real dup must never be deleted)", await rowExists(EVENT_A));

  // (5) Independent event id never touched by (1)-(4) is unaffected.
  const second = await insertDedup(EVENT_B, "customer.subscription.updated");
  check("(5) an unrelated event id is unaffected by the above", second.insertedFreshRow === true);
} finally {
  // Clean up regardless of pass/fail.
  await sb.from("stripe_webhook_events").delete().in("id", [EVENT_A, EVENT_B]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("WEBHOOK DEDUP CLEANUP VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL WEBHOOK DEDUP CLEANUP ASSERTIONS PASS");
