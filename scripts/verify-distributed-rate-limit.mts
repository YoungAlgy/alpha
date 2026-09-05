// Offline verification for the database-backed limiter. No env file, network,
// provider, or database is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.UNSUBSCRIBE_SECRET =
  "offline-distributed-rate-limit-secret-32-bytes";

const {
  consumeDistributedRateLimit,
  distributedRateLimitKeyHash,
} = await import("../lib/distributed-rate-limit.ts");

type RpcCall = { name: string; args: Record<string, unknown> };

function client(
  result: unknown,
  error: { message: string } | null = null,
  calls: RpcCall[] = []
) {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: result, error };
    },
  };
}

const calls: RpcCall[] = [];
const allowed = await consumeDistributedRateLimit(
  client([{ allowed: true, remaining: 2, retry_after_sec: 0 }], null, calls) as never,
  "generate-user",
  "real-user-id",
  { limit: 3, windowMs: 60 * 60 * 1000 }
);
assert.deepEqual(allowed, {
  ok: true,
  remaining: 2,
  retryAfterSec: 0,
  available: true,
});
assert.equal(calls[0]?.name, "consume_alpha_rate_limit");
assert.equal(calls[0]?.args.p_scope, "generate-user");
assert.equal(calls[0]?.args.p_limit, 3);
assert.equal(calls[0]?.args.p_window_seconds, 3600);
assert.match(String(calls[0]?.args.p_key_hash), /^[0-9a-f]{64}$/);
assert.ok(!JSON.stringify(calls[0]).includes("real-user-id"));

const limited = await consumeDistributedRateLimit(
  client([{ allowed: false, remaining: 0, retry_after_sec: 917 }]) as never,
  "access-request-email",
  "reader@example.com",
  { limit: 3, windowMs: 24 * 60 * 60 * 1000 }
);
assert.equal(limited.ok, false);
assert.equal(limited.available, true);
assert.equal(limited.retryAfterSec, 917);

const unavailable = await consumeDistributedRateLimit(
  client(null, { message: "offline rpc failure" }) as never,
  "generate-ip",
  "203.0.113.9",
  { limit: 3, windowMs: 60 * 60 * 1000 }
);
assert.equal(unavailable.ok, false);
assert.equal(unavailable.available, false);

const malformed = await consumeDistributedRateLimit(
  client([{ allowed: "yes", remaining: 2, retry_after_sec: 0 }]) as never,
  "generate-ip",
  "203.0.113.10",
  { limit: 3, windowMs: 60 * 60 * 1000 }
);
assert.equal(malformed.available, false);

assert.notEqual(
  distributedRateLimitKeyHash("generate-ip", "same-value"),
  distributedRateLimitKeyHash("generate-user", "same-value")
);
assert.throws(
  () => distributedRateLimitKeyHash("BAD SCOPE", "identity"),
  /scope is invalid/
);

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260830030000_distributed_rate_limits.sql"
  ),
  "utf8"
);
const generateRoute = fs.readFileSync(
  path.join(process.cwd(), "app", "api", "generate", "route.ts"),
  "utf8"
);
const accessRoute = fs.readFileSync(
  path.join(process.cwd(), "app", "api", "access", "request", "route.ts"),
  "utf8"
);
const quantityRoute = fs.readFileSync(
  path.join(process.cwd(), "app", "api", "stripe", "update-quantity", "route.ts"),
  "utf8"
);
const supportRoute = fs.readFileSync(
  path.join(process.cwd(), "app", "api", "support", "route.ts"),
  "utf8"
);
const limiter = fs.readFileSync(
  path.join(process.cwd(), "lib", "distributed-rate-limit.ts"),
  "utf8"
);
assert.match(migration, /security definer/i);
assert.match(migration, /set search_path = public, pg_temp/i);
assert.match(migration, /on conflict \(scope, key_hash, bucket_start, window_seconds\)/i);
assert.match(migration, /least\([\s\S]*p_limit \+ 1/i);
assert.match(migration, /order by expired\.expires_at[\s\S]*limit 500/i);
assert.match(migration, /revoke all on table public\.alpha_rate_limit_buckets/i);
assert.match(migration, /grant execute[\s\S]*to service_role/i);
assert.match(generateRoute, /"generate-ip"/);
assert.match(generateRoute, /"generate-user"/);
assert.match(generateRoute, /"generate-session"/);
assert.match(generateRoute, /email_confirmation_required/);
assert.match(accessRoute, /"access-request-ip"/);
assert.match(accessRoute, /"access-request-email"/);
assert.match(quantityRoute, /"quantity-update-user"/);
assert.match(quantityRoute, /email_confirmed_at/);
assert.match(supportRoute, /"support-ip"/);
assert.match(supportRoute, /"support-global"/);
assert.match(limiter, /process\.env\.UNSUBSCRIBE_SECRET/);
assert.doesNotMatch(limiter, /process\.env\.CHECKOUT_BINDING_SECRET/);

console.log("PASS verify-distributed-rate-limit (offline)");
