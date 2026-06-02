// Verify the "access runs through the paid period" fix on two fronts:
//   (A) pure: lib/access.hasActiveAccess boundary table (the JS gate logic)
//   (B) live, READ-ONLY: the weekly-send PostgREST `.or` filter actually
//       parses + executes against the Alpha DB, and the counts reconcile
//       (new active set == old active set + the future-cancel cohort the old
//       filter wrongly dropped). No writes, no sends — counts only.
// Run: npx tsx scripts/verify-access-window.mts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { hasActiveAccess } = await import("../lib/access.ts");

// ---- (A) pure boundary table ----
const now = new Date("2026-06-02T12:00:00.000Z");
const future = new Date("2026-07-01T00:00:00.000Z").toISOString();
const past = new Date("2026-05-01T00:00:00.000Z").toISOString();
const cases: Array<[string | null | undefined, boolean]> = [
  [null, true],
  [undefined, true],
  [future, true], // cancel-at-period-end, still paid up → active
  [past, false], // period ended → inactive
  ["2026-06-02T12:00:00.000Z", false], // exactly now → not > now → inactive
  ["not-a-date", false], // unparseable → fail safe to inactive
];
let pass = 0,
  fail = 0;
console.log("(A) hasActiveAccess boundary table:");
for (const [input, want] of cases) {
  const got = hasActiveAccess(input, now);
  const ok = got === want;
  console.log(`  ${ok ? "OK " : "XX "} ${JSON.stringify(input)} → ${got} (want ${want})`);
  ok ? pass++ : fail++;
}

// ---- (B) live read-only filter check ----
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("XX  no Supabase service creds in .env.local — cannot run live check");
  process.exit(1);
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(url, key, { auth: { persistSession: false } });
const nowIso = new Date().toISOString();

async function count(build: (q: any) => any): Promise<number> {
  const q = build(sb.from("users").select("*", { count: "exact", head: true }));
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

console.log("\n(B) live read-only weekly-send filter check:");
try {
  const oldActive = await count((q: any) =>
    q.not("subscribed_at", "is", null).is("cancelled_at", null).is("unsubscribed_at", null)
  );
  const newActive = await count((q: any) =>
    q
      .not("subscribed_at", "is", null)
      .or(`cancelled_at.is.null,cancelled_at.gt.${nowIso}`)
      .is("unsubscribed_at", null)
  );
  const futureCancel = await count((q: any) =>
    q.not("subscribed_at", "is", null).gt("cancelled_at", nowIso).is("unsubscribed_at", null)
  );
  console.log(`  old filter (cancelled_at IS NULL)      → ${oldActive} recipients`);
  console.log(`  NEW filter (null OR cancel > now)      → ${newActive} recipients`);
  console.log(`  future-cancel cohort (was dropped)     → ${futureCancel}`);
  const reconciles = newActive === oldActive + futureCancel;
  console.log(`  reconciles (new == old + futureCancel) : ${reconciles ? "OK" : "XX"}`);
  console.log(`  .or filter executed without PostgREST error: OK`);
  reconciles ? pass++ : fail++;
  pass++; // the .or query executing without throwing is itself a pass
} catch (e) {
  console.error(`  XX live check failed: ${e instanceof Error ? e.message : e}`);
  fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("ACCESS-WINDOW VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ACCESS-WINDOW ASSERTIONS PASS");
