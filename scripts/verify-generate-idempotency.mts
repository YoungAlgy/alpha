// Verify the onboarding first-letter send is idempotent via the atomic
// delivered_at claim, so it can't double-send when it races the weekly cron (a
// signup completing within ~a minute of a Sun/Tue/Thu tick targets the same
// (user, week_of) row). Mirrors scripts/verify-webhook-mutation.mts.
// Run: npx tsx scripts/verify-generate-idempotency.mts
const { deliverLetterOnce } = await import("../lib/letter-delivery.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// In-memory issues store that models Postgres' atomic UPDATE ... WHERE
// delivered_at IS NULL: the first claimer of a NULL row flips it and wins,
// everyone after sees it set and loses. A row absent from the map models a
// missing issue row (exists:false). JS is single-threaded, so calling claim
// twice in sequence is a faithful model of two overlapping invocations — the DB
// serializes the CAS exactly the same way.
function makeStore(initial: Record<string, { delivered_at: string | null }> = {}) {
  const rows = new Map(Object.entries(initial));
  let claims = 0,
    releases = 0;
  return {
    rows,
    get claims() {
      return claims;
    },
    get releases() {
      return releases;
    },
    store: {
      async claim(userId: string, weekOf: string, stamp: string) {
        claims++;
        const row = rows.get(`${userId}:${weekOf}`);
        if (!row) return { won: false, exists: false };
        if (row.delivered_at == null) {
          row.delivered_at = stamp;
          return { won: true, exists: true };
        }
        return { won: false, exists: true };
      },
      async release(userId: string, weekOf: string, stamp: string) {
        releases++;
        const row = rows.get(`${userId}:${weekOf}`);
        if (row && row.delivered_at === stamp) row.delivered_at = null;
      },
    },
  };
}

const WEEK = "2026-06-24";

// (1) Two overlapping invocations on the SAME claimable row → exactly ONE send.
{
  const h = makeStore({ "u1:2026-06-24": { delivered_at: null } });
  let sends = 0;
  const send = async () => {
    sends++;
  };
  const r1 = await deliverLetterOnce({ store: h.store, userId: "u1", weekOf: WEEK, stamp: "S1", send });
  const r2 = await deliverLetterOnce({ store: h.store, userId: "u1", weekOf: WEEK, stamp: "S2", send });
  console.log("(1) two invocations, one claimable row:");
  check("first invocation sends (claimed)", r1.sent && r1.reason === "claimed");
  check("second invocation skips (already-delivered)", !r2.sent && r2.reason === "already-delivered");
  check("exactly ONE email sent", sends === 1);
  check("row holds the winner's stamp (S1)", h.rows.get("u1:2026-06-24")!.delivered_at === "S1");
}

// (2) Send FAILURE releases the claim → a later retry can re-claim and deliver.
{
  const h = makeStore({ "u2:2026-06-24": { delivered_at: null } });
  let sends = 0;
  const failing = async () => {
    throw new Error("resend 500");
  };
  const ok = async () => {
    sends++;
  };
  const r1 = await deliverLetterOnce({ store: h.store, userId: "u2", weekOf: WEEK, stamp: "S1", send: failing, onError: () => {} });
  console.log("(2) send failure rolls back, retry delivers:");
  check("failed send reports sent:false (send-failed)", !r1.sent && r1.reason === "send-failed");
  check("claim released (row back to NULL)", h.rows.get("u2:2026-06-24")!.delivered_at === null);
  check("released exactly once", h.releases === 1);
  const r2 = await deliverLetterOnce({ store: h.store, userId: "u2", weekOf: WEEK, stamp: "S2", send: ok });
  check("retry re-claims and sends", r2.sent && r2.reason === "claimed");
  check("exactly ONE successful email", sends === 1);
  check("row ends delivered with retry stamp (S2)", h.rows.get("u2:2026-06-24")!.delivered_at === "S2");
}

// (3) No persisted user row (userId null) → best-effort single send, no store touch.
{
  const h = makeStore();
  let sends = 0;
  const r = await deliverLetterOnce({ store: null, userId: null, weekOf: WEEK, stamp: "S1", send: async () => { sends++; } });
  console.log("(3) no persistence → best-effort send:");
  check("sends best-effort (no-persistence)", r.sent && r.reason === "no-persistence");
  check("exactly one email", sends === 1);
  check("store untouched", h.claims === 0);
}

// (4) User row but NO issue row (best-effort persist left none) → best-effort send.
{
  const h = makeStore(); // no rows
  let sends = 0;
  const r = await deliverLetterOnce({ store: h.store, userId: "u4", weekOf: WEEK, stamp: "S1", send: async () => { sends++; } });
  console.log("(4) missing issue row → best-effort send:");
  check("sends best-effort (no-row)", r.sent && r.reason === "no-row");
  check("exactly one email", sends === 1);
}

// (5) Already delivered (row pre-stamped) → skip, no send, existing stamp kept.
{
  const h = makeStore({ "u5:2026-06-24": { delivered_at: "EARLIER" } });
  let sends = 0;
  const r = await deliverLetterOnce({ store: h.store, userId: "u5", weekOf: WEEK, stamp: "S1", send: async () => { sends++; } });
  console.log("(5) already delivered → skip:");
  check("skips (already-delivered)", !r.sent && r.reason === "already-delivered");
  check("no email", sends === 0);
  check("existing stamp untouched", h.rows.get("u5:2026-06-24")!.delivered_at === "EARLIER");
}

// (6) Claim query ERROR → fail OPEN (best-effort send) so a DB blip never blocks
//     a paid first letter.
{
  let sends = 0;
  const errStore = {
    async claim() {
      throw new Error("db down");
    },
    async release() {},
  };
  const r = await deliverLetterOnce({ store: errStore, userId: "u6", weekOf: WEEK, stamp: "S1", send: async () => { sends++; }, onError: () => {} });
  console.log("(6) claim error → fail open:");
  check("sends best-effort (claim-error)", r.sent && r.reason === "claim-error");
  check("exactly one email", sends === 1);
}

// (7) Live, READ-ONLY: confirm the issues table exposes delivered_at, so the real
//     store's claim/release query shape is valid against the actual schema. No
//     writes — purely a SELECT.
console.log("(7) live read-only schema tie-in (issues.delivered_at):");
try {
  const { readFileSync } = await import("node:fs");
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("  -- no service creds; skipping live tie-in (pure tests already cover logic)");
  } else {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { error } = await sb.from("issues").select("user_id, week_of, delivered_at").limit(1);
    check("issues.delivered_at is selectable (claim/release shape valid)", !error);
  }
} catch (e) {
  console.log(`  -- live tie-in skipped (${e instanceof Error ? e.message : e})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("GENERATE IDEMPOTENCY VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL GENERATE IDEMPOTENCY ASSERTIONS PASS");
