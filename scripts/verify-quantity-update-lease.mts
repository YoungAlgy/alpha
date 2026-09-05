// Offline verification for quantity-update serialization. No env file,
// provider, network, or database is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { claimQuantityUpdateLease, releaseQuantityUpdateLease } = await import(
  "../lib/quantity-update-lease.ts"
);

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
const sb = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return { data: true, error: null };
  },
};

assert.equal(
  await claimQuantityUpdateLease(
    sb as never,
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002"
  ),
  true
);
assert.equal(calls[0]?.name, "claim_alpha_quantity_update");
assert.equal(calls[0]?.args.p_lease_seconds, 180);
assert.equal(
  await releaseQuantityUpdateLease(
    sb as never,
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002"
  ),
  true
);
assert.equal(calls[1]?.name, "release_alpha_quantity_update");
await assert.rejects(
  claimQuantityUpdateLease(sb as never, "user", "token", 5),
  /input is invalid/
);

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260830040000_quantity_update_leases.sql"
  ),
  "utf8"
);
const route = fs.readFileSync(
  path.join(
    process.cwd(),
    "app",
    "api",
    "stripe",
    "update-quantity",
    "route.ts"
  ),
  "utf8"
);
const settings = fs.readFileSync(
  path.join(process.cwd(), "app", "settings", "page.tsx"),
  "utf8"
);
assert.match(migration, /on conflict \(user_id\) do update/i);
assert.match(migration, /lease_expires_at <= clock_timestamp\(\)/i);
assert.match(migration, /where user_id = p_user_id[\s\S]*lease_token = p_lease_token/i);
assert.match(migration, /security definer/gi);
assert.match(migration, /revoke all on table public\.alpha_quantity_update_leases/i);
assert.match(route, /expectedQuantity\?: number/);
assert.match(route, /currentQty !== body\.expectedQuantity/);
assert.match(settings, /expectedQuantity: topicQuota \/ TOPICS_PER_BUNDLE/);

console.log("PASS verify-quantity-update-lease (offline)");
