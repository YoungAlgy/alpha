// Verifies the fix (2026-08-05, adversarial audit follow-up) for a real race in
// app/api/cron/weekly-send/route.ts's runPersistAndSend(): content used to be
// upserted unconditionally BEFORE the atomic delivered_at claim, so whichever
// of two concurrent attempts (e.g. a slow live send racing a backup layer)
// wrote content LAST won, regardless of which one actually won the claim (or
// sent an email at all yet). /letter and /inbox read sections straight from
// this row, so the wrong content could be shown even after the right email
// went out.
//
// The fix bundles content into the SAME atomic UPDATE as the delivered_at
// claim, so only the winner of the compare-and-swap ever writes content. A
// separate ignoreDuplicates upsert just ensures the row exists first, never
// overwriting existing content.
//
// This exercises the real Supabase table directly with the exact two-query
// pattern the route now uses (not a mock), against a synthetic user_id/week_of
// that can't collide with real data, and cleans up after itself.
// Run: npx tsx scripts/verify-persist-claim-atomicity.mts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

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

// issues.user_id is a FK to users.id, which is itself a FK to Supabase Auth's
// internal auth.users -- creating a genuine synthetic user needs the admin
// API and isn't worth the extra surface here. Instead: borrow an EXISTING
// user's real id (read-only lookup, never touches their row) and only ever
// write to a synthetic far-future week_of that can't collide with a real
// send. Cleanup deletes exactly that one (user_id, week_of) issues row --
// the borrowed user itself is never modified.
const weekOf = "2099-01-01"; // far-future, can't collide with a real send date

async function ensureExists(content: { volume: number; number: number; editor_intro: string; sections: unknown }) {
  return sb.from("issues").upsert(
    { user_id: userId, week_of: weekOf, ...content },
    { onConflict: "user_id,week_of", ignoreDuplicates: true }
  );
}

async function claimWithContent(
  claimedAt: string,
  content: { volume: number; number: number; editor_intro: string; sections: unknown }
) {
  return sb
    .from("issues")
    .update({ delivered_at: claimedAt, ...content })
    .eq("user_id", userId)
    .eq("week_of", weekOf)
    .is("delivered_at", null)
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
  // Guard: bail loudly rather than silently corrupting data if this
  // synthetic far-future week_of somehow already has a row (shouldn't ever
  // happen for a real send date, but don't overwrite it if it does).
  const { data: preExisting } = await sb
    .from("issues")
    .select("user_id")
    .eq("user_id", userId)
    .eq("week_of", weekOf)
    .maybeSingle();
  if (preExisting) {
    console.log(`SKIP: (user, ${weekOf}) already has a row -- not touching it, run again another time.`);
    process.exit(0);
  }

  // --- 1) ensure-exists never overwrites content that's already there -------
  console.log("(1) ensure-exists (ignoreDuplicates) never overwrites existing content");
  await sb.from("issues").insert({
    user_id: userId,
    week_of: weekOf,
    volume: 1,
    number: 1,
    editor_intro: "ORIGINAL",
    sections: [{ topicLabel: "original" }],
  });
  const { error: dupErr } = await ensureExists({
    volume: 999,
    number: 999,
    editor_intro: "SHOULD-NOT-APPEAR",
    sections: [{ topicLabel: "intruder" }],
  });
  check("(1) ensureExists call did not error", !dupErr);
  const { data: afterDup } = await sb
    .from("issues")
    .select("editor_intro")
    .eq("user_id", userId)
    .eq("week_of", weekOf)
    .single();
  check(
    "(1) original content survives (ensure-exists is a true no-op on conflict)",
    afterDup?.editor_intro === "ORIGINAL"
  );

  // Reset to undelivered for the race test below.
  await sb.from("issues").delete().eq("user_id", userId).eq("week_of", weekOf);

  // --- 2) two concurrent attempts race the SAME atomic UPDATE ----------------
  // JS is single-threaded, so calling this twice in sequence with no row
  // existing yet models two overlapping invocations faithfully -- Postgres
  // serializes the real CAS the identical way (see verify-generate-
  // idempotency.mts for the same reasoning applied to the delivered_at-only
  // claim this mirrors).
  console.log("(2) two racing attempts -- only the WINNER's content persists");
  const attemptA = {
    volume: 1,
    number: 1,
    editor_intro: "ATTEMPT-A (should win if A claims first)",
    sections: [{ topicLabel: "attempt-a" }],
  };
  const attemptB = {
    volume: 2,
    number: 2,
    editor_intro: "ATTEMPT-B (the loser -- must NOT end up persisted)",
    sections: [{ topicLabel: "attempt-b" }],
  };

  // Both attempts run their ensure-exists step first, exactly like two real
  // concurrent runPersistAndSend calls would (neither knows about the other).
  await ensureExists(attemptA);
  await ensureExists(attemptB);

  const claimA = await claimWithContent(new Date(Date.now()).toISOString(), attemptA);
  const claimB = await claimWithContent(new Date(Date.now() + 1).toISOString(), attemptB);

  check("(2) exactly one of the two claims won", (claimA.data?.length ?? 0) + (claimB.data?.length ?? 0) === 1);
  const aWon = (claimA.data?.length ?? 0) === 1;
  check(`(2) the ${aWon ? "first" : "second"} caller won (matches CAS semantics: first-to-claim wins)`, aWon);

  const { data: finalRow } = await sb
    .from("issues")
    .select("editor_intro, delivered_at")
    .eq("user_id", userId)
    .eq("week_of", weekOf)
    .single();

  const winningContent = aWon ? attemptA : attemptB;
  const losingContent = aWon ? attemptB : attemptA;
  check(
    "(2) persisted content matches the WINNER, not the loser -- THE BUG THIS FIX CLOSES",
    finalRow?.editor_intro === winningContent.editor_intro
  );
  check(
    "(2) loser's content is nowhere in the final row",
    finalRow?.editor_intro !== losingContent.editor_intro
  );
  check("(2) delivered_at was stamped by the winning claim", !!finalRow?.delivered_at);
} finally {
  // Cleanup -- delete ONLY the synthetic (user_id, week_of) row this script
  // wrote. Scoped to both columns deliberately: the user_id was borrowed
  // read-only from a real user, so this must never touch their real issues
  // (a bare .eq("user_id", userId) would delete every letter they've ever
  // received) or the user row itself (never created here, not ours to delete).
  if (userId) {
    await sb.from("issues").delete().eq("user_id", userId).eq("week_of", weekOf);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("PERSIST-CLAIM-ATOMICITY VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL PERSIST-CLAIM-ATOMICITY ASSERTIONS PASS");
