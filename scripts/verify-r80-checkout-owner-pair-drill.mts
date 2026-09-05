// Offline source contract for the disposable-clone checkout owner-pair drill.
// It does not load environment files or connect to PostgreSQL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const drill = readFileSync(new URL("./r80-checkout-owner-pair-drill.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260827000000_checkout_fulfillment_claims.sql", import.meta.url), "utf8");

assert.match(migration, /if new\.owner_user_id is not null[\s\S]*?new\.provisioned_user_id is not null[\s\S]*?new\.owner_user_id <> new\.provisioned_user_id then[\s\S]*?raise exception 'checkout owner and provisioned user must match'/);
assert.match(migration, /before insert or update of billing_state, owner_user_id, provisioned_user_id[\s\S]*?execute function public\.block_checkout_for_deleting_owner\(\)/);
assert.match(drill, /^\\set ON_ERROR_STOP on\s+begin isolation level repeatable read read write;/);
assert.match(drill, /set local request\.jwt\.claims = '\{"role":"service_role"\}'/);
assert.match(drill, /current_database\(\) !~ '\^alpha_drill_\[a-f0-9\]\{16\}\\?\$'/);
assert.match(drill, /inet_server_addr\(\)::text/);
assert.match(drill, /checkout owner-pair fixture collision/);
assert.equal((drill.match(/-- ASSERTION [123]:/g) || []).length, 3);
assert.equal((drill.match(/sqlerrm <> 'checkout owner and provisioned user must match'/g) || []).length, 2);
assert.match(drill, /set provisioned_user_id = 'e8000000-0000-4000-8000-000000000002'[\s\S]*?rejected checkout owner update changed the valid pair/);
assert.match(drill, /R80 CHECKOUT OWNER PAIR DRILL PASS: 3 assertions';\s+rollback;\s*$/);
assert.doesNotMatch(drill, /\bcommit\s*;/i);
assert.doesNotMatch(drill, /nextval\s*\(|setval\s*\(|alter\s+sequence/i);

console.log("PASS verify-r80-checkout-owner-pair-drill (offline, rollback-only 3-assertion contract)");
