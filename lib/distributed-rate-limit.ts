import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RateLimitOptions, RateLimitResult } from "@/lib/rate-limit";

type RpcClient = Pick<SupabaseClient, "rpc">;

export type DistributedRateLimitResult = RateLimitResult & {
  available: boolean;
};

const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

function rateLimitSecret(): string {
  // UNSUBSCRIBE_SECRET is already a hard product requirement in invite and
  // paid modes and is present in both Worker and scheduled-send runtimes.
  // Domain separation below keeps limiter keys independent from letter and
  // unsubscribe tokens even though they share the same random root secret.
  const value = process.env.UNSUBSCRIBE_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new Error("distributed rate-limit secret is unavailable");
  }
  return value;
}

export function distributedRateLimitKeyHash(
  scope: string,
  identity: string
): string {
  if (!SCOPE_PATTERN.test(scope)) {
    throw new Error("distributed rate-limit scope is invalid");
  }
  const normalizedIdentity = identity.trim();
  if (!normalizedIdentity || normalizedIdentity.length > 8192) {
    throw new Error("distributed rate-limit identity is invalid");
  }
  return createHmac("sha256", rateLimitSecret())
    .update(`alpha-rate-limit:v1:${scope}\n${normalizedIdentity}`)
    .digest("hex");
}

function unavailable(windowMs: number): DistributedRateLimitResult {
  return {
    ok: false,
    remaining: 0,
    retryAfterSec: Math.max(60, Math.ceil(windowMs / 1000)),
    available: false,
  };
}

/**
 * Consume one request from Alpha's database-backed fixed-window limiter.
 *
 * Raw IPs, emails, user ids, and Checkout Session ids never reach the table.
 * The database receives only a domain-separated HMAC. Callers should fail
 * closed when `available` is false on routes that can trigger provider work.
 */
export async function consumeDistributedRateLimit(
  sb: RpcClient,
  scope: string,
  identity: string,
  { limit, windowMs }: RateLimitOptions
): Promise<DistributedRateLimitResult> {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10_000 ||
    !Number.isInteger(windowMs) ||
    windowMs < 1_000 ||
    windowMs > MAX_WINDOW_MS
  ) {
    throw new Error("distributed rate-limit options are invalid");
  }

  let keyHash: string;
  try {
    keyHash = distributedRateLimitKeyHash(scope, identity);
  } catch {
    return unavailable(windowMs);
  }

  try {
    const { data, error } = await sb.rpc("consume_alpha_rate_limit", {
      p_scope: scope,
      p_key_hash: keyHash,
      p_limit: limit,
      p_window_seconds: Math.ceil(windowMs / 1000),
    });
    if (error) return unavailable(windowMs);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object") return unavailable(windowMs);
    const record = row as Record<string, unknown>;
    if (
      typeof record.allowed !== "boolean" ||
      !Number.isInteger(record.remaining) ||
      (record.remaining as number) < 0 ||
      !Number.isInteger(record.retry_after_sec) ||
      (record.retry_after_sec as number) < 0
    ) {
      return unavailable(windowMs);
    }

    return {
      ok: record.allowed,
      remaining: record.remaining as number,
      retryAfterSec: record.retry_after_sec as number,
      available: true,
    };
  } catch {
    return unavailable(windowMs);
  }
}
