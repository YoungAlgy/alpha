import type { SupabaseClient } from "@supabase/supabase-js";
import { consumeDistributedRateLimit } from "@/lib/distributed-rate-limit";

export type PublicSourceProvider = "google-rss" | "publisher-rss" | "gdelt" | "plos-research" | "ccmixter-uploads" | "federal-register-finance";
export type PublicSourceBudgetErrorCode = "unavailable" | "exhausted";

type RpcClient = Pick<SupabaseClient, "rpc">;

interface PublicSourceBudgetDependencies {
  enabled?: () => boolean;
  loadClient?: () => Promise<RpcClient>;
  timeoutMs?: number;
}

const WINDOW_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const PROVIDER_LIMITS: Record<PublicSourceProvider, number> = {
  "google-rss": 60,
  "publisher-rss": 12,
  gdelt: 12,
  // At most four requests around a fixed-window boundary. Below PLOS's
  // 10/minute, 300/hour, 7200/day and five-connection published limits.
  "plos-research": 2,
  // Narrow fixed upload feed. Shared across runs, independent of other sources.
  "ccmixter-uploads": 2,
  "federal-register-finance": 2,
};

export class PublicSourceBudgetError extends Error {
  constructor(
    public readonly code: PublicSourceBudgetErrorCode,
    public readonly provider: PublicSourceProvider
  ) {
    super(`Public source ${provider} budget ${code}`);
    this.name = "PublicSourceBudgetError";
  }
}

export function durablePublicSourceBudgetEnabled(): boolean {
  const raw = process.env.ALPHA_DURABLE_SOURCE_BUDGET?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

async function loadServiceClient(): Promise<RpcClient> {
  // Avoid loading the server client, credentials, or database code in offline
  // source probes. The scheduled runtime enables this explicitly.
  const { supabaseServiceClient } = await import("@/lib/supabase/server");
  return supabaseServiceClient();
}

/**
 * Reserve one public-source request in Supabase before the outbound fetch.
 * Only a fixed provider identity reaches the HMAC-backed database limiter.
 * Queries, custom topics, reader IDs, and result URLs never enter its key.
 *
 * This is a cross-run request ceiling, not a result cache or failure cooldown.
 * A timed-out reservation fails closed. The shared Supabase client currently
 * applies its own 10-second transport timeout, so the 3-second deadline here
 * bounds the caller but may leave an RPC finishing in the background. That can
 * consume a slot without an outbound source request; it cannot exceed budget.
 */
export function createPublicSourceBudget(deps: PublicSourceBudgetDependencies = {}) {
  const enabled = deps.enabled ?? durablePublicSourceBudgetEnabled;
  const loadClient = deps.loadClient ?? loadServiceClient;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function reservePublicSourceRequest(provider: PublicSourceProvider): Promise<void> {
    if (!Object.hasOwn(PROVIDER_LIMITS, provider)) {
      throw new Error("Unknown public source provider");
    }
    if (!enabled()) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PublicSourceBudgetError("unavailable", provider)),
        timeoutMs
      );
    });
    const reservation = (async () => {
      const client = await loadClient();
      const result = await consumeDistributedRateLimit(
        client,
        `public_source:${provider.replaceAll("-", "_")}`,
        provider,
        { limit: PROVIDER_LIMITS[provider], windowMs: WINDOW_MS }
      );
      if (!result.available) throw new PublicSourceBudgetError("unavailable", provider);
      if (!result.ok) throw new PublicSourceBudgetError("exhausted", provider);
    })();

    try {
      await Promise.race([reservation, deadline]);
    } catch (error) {
      if (error instanceof PublicSourceBudgetError) throw error;
      throw new PublicSourceBudgetError("unavailable", provider);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

export const reservePublicSourceRequest = createPublicSourceBudget();
