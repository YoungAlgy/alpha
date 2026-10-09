// Offline checks for the cross-run public-source request ceiling.
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

const originalFetch = globalThis.fetch;
const originalFlag = process.env.ALPHA_DURABLE_SOURCE_BUDGET;
const originalSecret = process.env.UNSUBSCRIBE_SECRET;
let unexpectedNetwork = 0;
globalThis.fetch = (async () => {
  unexpectedNetwork++;
  throw new Error("network is disabled in the public-source-budget check");
}) as typeof fetch;

try {
  const {
    createPublicSourceBudget,
    durablePublicSourceBudgetEnabled,
    PublicSourceBudgetError,
  } = await import("../lib/engine/public-source-budget.ts");

  delete process.env.ALPHA_DURABLE_SOURCE_BUDGET;
  assert.equal(durablePublicSourceBudgetEnabled(), false);
  process.env.ALPHA_DURABLE_SOURCE_BUDGET = "yes";
  assert.equal(durablePublicSourceBudgetEnabled(), true);
  process.env.ALPHA_DURABLE_SOURCE_BUDGET = "0";
  assert.equal(durablePublicSourceBudgetEnabled(), false);

  let offLoads = 0;
  const off = createPublicSourceBudget({
    enabled: () => false,
    loadClient: async () => {
      offLoads++;
      throw new Error("disabled budget loaded a client");
    },
  });
  await off("google-rss");
  assert.equal(offLoads, 0, "offline probes do not touch Supabase");

  // One mock database is shared by two independent budget instances, as two
  // scheduled Actions processes would share the real rate-limit table.
  process.env.UNSUBSCRIBE_SECRET = "offline-test-only-secret-for-public-source-budget";
  const counts = new Map<string, number>();
  const scopes = new Map<string, Set<string>>();
  let rpcCalls = 0;
  let mockTime = Date.parse("2026-09-29T12:00:00Z");
  const mockClient = () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, "consume_alpha_rate_limit");
      rpcCalls++;
      const scope = String(args.p_scope);
      const hash = String(args.p_key_hash);
      const limit = Number(args.p_limit);
      assert.equal(args.p_window_seconds, 900);
      assert.match(hash, /^[0-9a-f]{64}$/);
      const seen = scopes.get(scope) ?? new Set<string>();
      seen.add(hash);
      scopes.set(scope, seen);
      const windowStart = Math.floor(mockTime / (Number(args.p_window_seconds) * 1000));
      const key = `${scope}|${hash}|${windowStart}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return {
        data: [{
          allowed: count <= limit,
          remaining: Math.max(0, limit - count),
          retry_after_sec: count <= limit ? 0 : 900,
        }],
        error: null,
      };
    },
  }) as unknown as Pick<SupabaseClient, "rpc">;
  const firstClient = mockClient();
  const secondClient = mockClient();
  assert.notEqual(firstClient, secondClient, "simulated processes have separate clients");
  const first = createPublicSourceBudget({ enabled: () => true, loadClient: async () => firstClient });
  const second = createPublicSourceBudget({ enabled: () => true, loadClient: async () => secondClient });

  for (let i = 0; i < 30; i++) await first("google-rss");
  for (let i = 0; i < 30; i++) await second("google-rss");
  await assert.rejects(second("google-rss"), (error: unknown) =>
    error instanceof PublicSourceBudgetError && error.code === "exhausted"
  );
  assert.equal(scopes.get("public_source:google_rss")?.size, 1);
  await second("publisher-rss");
  await second("gdelt");
  assert.equal(scopes.get("public_source:publisher_rss")?.size, 1);
  assert.equal(scopes.get("public_source:gdelt")?.size, 1);
  const hashes = [
    ...scopes.get("public_source:google_rss")!,
    ...scopes.get("public_source:publisher_rss")!,
    ...scopes.get("public_source:gdelt")!,
  ];
  assert.equal(new Set(hashes).size, 3, "provider budgets have separated HMAC identities");
  assert.equal(rpcCalls, 63);
  mockTime += 15 * 60_000;
  await second("google-rss");
  assert.equal(rpcCalls, 64, "a new fixed window admits a request from another client instance");
  await first("plos-research");
  await second("plos-research");
  await assert.rejects(first("plos-research"), (error: unknown) =>
    error instanceof PublicSourceBudgetError && error.code === "exhausted" && error.provider === "plos-research"
  );
  assert.equal(scopes.get("public_source:plos_research")?.size, 1);
  assert.equal(rpcCalls, 67, "PLOS shares its two-slot ceiling across independent instances");
  await first("ccmixter-uploads");
  await second("ccmixter-uploads");
  await assert.rejects(first("ccmixter-uploads"), (error: unknown) =>
    error instanceof PublicSourceBudgetError && error.code === "exhausted" && error.provider === "ccmixter-uploads"
  );
  assert.equal(scopes.get("public_source:ccmixter_uploads")?.size, 1);
  assert.equal(rpcCalls, 70, "ccMixter has its own shared two-slot budget");
  await first("federal-register-finance");
  await second("federal-register-finance");
  await assert.rejects(first("federal-register-finance"), (error: unknown) =>
    error instanceof PublicSourceBudgetError && error.code === "exhausted" && error.provider === "federal-register-finance"
  );
  assert.equal(scopes.get("public_source:federal_register_finance")?.size, 1);
  assert.equal(rpcCalls, 73, "Federal Register shares its own two-slot budget across runs");

  const unavailable = createPublicSourceBudget({
    enabled: () => true,
    loadClient: async () => ({
      rpc: async () => ({ data: null, error: { message: "offline simulated failure" } }),
    }) as unknown as Pick<SupabaseClient, "rpc">,
  });
  await assert.rejects(unavailable("gdelt"), (error: unknown) =>
    error instanceof PublicSourceBudgetError && error.code === "unavailable" &&
    !error.message.includes("offline simulated failure")
  );

  const timedOut = createPublicSourceBudget({
    enabled: () => true,
    timeoutMs: 5,
    loadClient: async () => new Promise<Pick<SupabaseClient, "rpc">>(() => {}),
  });
  await assert.rejects(timedOut("google-rss"), (error: unknown) =>
    error instanceof PublicSourceBudgetError && error.code === "unavailable"
  );

  delete process.env.UNSUBSCRIBE_SECRET;
  await assert.rejects(first("gdelt"), (error: unknown) =>
    error instanceof PublicSourceBudgetError && error.code === "unavailable"
  );
  assert.equal(unexpectedNetwork, 0);
  console.log("public-source-budget: offline checks passed");
} finally {
  globalThis.fetch = originalFetch;
  if (originalFlag === undefined) delete process.env.ALPHA_DURABLE_SOURCE_BUDGET;
  else process.env.ALPHA_DURABLE_SOURCE_BUDGET = originalFlag;
  if (originalSecret === undefined) delete process.env.UNSUBSCRIBE_SECRET;
  else process.env.UNSUBSCRIBE_SECRET = originalSecret;
}
