import type { SupabaseClient } from "@supabase/supabase-js";
import { PublicSourceControlError } from "./public-source-control-error";

// Outage identities describe fixed upstreams, never a query or reader. They
// deliberately differ from the shared publisher request-budget identity.
export const PUBLIC_SOURCE_CIRCUIT_PROVIDERS = [
  "google-rss", "publisher-nist", "publisher-fda-medwatch",
  "publisher-fed-speeches", "global-voices-rss", "crossref-research", "gdelt", "plos-research", "ccmixter-uploads",
] as const;
export type PublicSourceCircuitProvider = typeof PUBLIC_SOURCE_CIRCUIT_PROVIDERS[number];
type RpcClient = Pick<SupabaseClient, "rpc">;
type Admission = { generation: string; probeToken: string | null };
export type PublicSourceAttempt = <T>(
  provider: PublicSourceCircuitProvider,
  reserve: () => Promise<void>,
  work: () => Promise<T>
) => Promise<T>;

export class PublicSourceCircuitError extends Error {
  constructor(
    public readonly code: "cooling_down" | "unavailable",
    public readonly provider: PublicSourceCircuitProvider
  ) {
    super(`Public source ${provider} circuit ${code}`);
    this.name = "PublicSourceCircuitError";
  }
}

export function durablePublicSourceCircuitEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ALPHA_DURABLE_SOURCE_COOLDOWN?.trim() ?? "");
}

async function loadServiceClient(): Promise<RpcClient> {
  // Disabled probes and offline checks never load a server client or secrets.
  const { supabaseServiceClient } = await import("@/lib/supabase/server");
  return supabaseServiceClient();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RETRY_SECONDS = 4 * 60 * 60;

export function createPublicSourceCircuit(deps: {
  enabled?: () => boolean;
  loadClient?: () => Promise<RpcClient>;
  timeoutMs?: number;
  warn?: (message: string) => void;
} = {}): PublicSourceAttempt {
  const enabled = deps.enabled ?? durablePublicSourceCircuitEnabled;
  const loadClient = deps.loadClient ?? loadServiceClient;
  const timeoutMs = deps.timeoutMs ?? 3000;
  const warn = deps.warn ?? ((message: string) => console.warn(message));

  async function rpc(provider: PublicSourceCircuitProvider, name: string, args: Record<string, unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PublicSourceCircuitError("unavailable", provider)), timeoutMs);
    });
    const request = (async () => {
      const client = await loadClient();
      const { data, error } = await client.rpc(name, args);
      if (error) throw new PublicSourceCircuitError("unavailable", provider);
      return data;
    })();
    try { return await Promise.race([request, deadline]); }
    catch { throw new PublicSourceCircuitError("unavailable", provider); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async function begin(provider: PublicSourceCircuitProvider): Promise<Admission> {
    const data = await rpc(provider, "begin_alpha_public_source", { p_provider: provider });
    const row = Array.isArray(data) && data.length === 1 ? data[0] : undefined;
    if (!row || typeof row !== "object" || typeof row.admitted !== "boolean" ||
        typeof row.generation !== "string" || !UUID.test(row.generation) ||
        !(row.probe_token === null || typeof row.probe_token === "string" && UUID.test(row.probe_token)) ||
        !Number.isInteger(row.retry_after_sec) || row.retry_after_sec < 0 ||
        row.retry_after_sec > MAX_RETRY_SECONDS ||
        (row.admitted ? row.retry_after_sec !== 0 : row.retry_after_sec < 1 || row.probe_token !== null)) {
      throw new PublicSourceCircuitError("unavailable", provider);
    }
    if (!row.admitted) throw new PublicSourceCircuitError("cooling_down", provider);
    return { generation: row.generation, probeToken: row.probe_token };
  }

  async function complete(provider: PublicSourceCircuitProvider, admission: Admission,
    outcome: "success" | "failure" | "neutral"): Promise<void> {
    try {
      const applied = await rpc(provider, "complete_alpha_public_source", {
        p_provider: provider, p_generation: admission.generation,
        p_probe_token: admission.probeToken, p_outcome: outcome,
      });
      if (typeof applied !== "boolean") throw new PublicSourceCircuitError("unavailable", provider);
      // False means a later generation/lease owns state. Never override it.
      if (!applied) warn(`[public-source-circuit] ${provider} completion stale; durable recovery unconfirmed`);
    } catch {
      warn(`[public-source-circuit] ${provider} completion unavailable; durable recovery unconfirmed`);
    }
  }

  return async function attempt<T>(provider: PublicSourceCircuitProvider,
    reserve: () => Promise<void>, work: () => Promise<T>): Promise<T> {
    if (!PUBLIC_SOURCE_CIRCUIT_PROVIDERS.includes(provider)) throw new Error("Unknown public source circuit provider");
    if (!enabled()) { await reserve(); return work(); }
    const admission = await begin(provider);
    try { await reserve(); }
    catch (error) {
      // No outbound provider work began. Quota/DB failure is not an outage.
      if (admission.probeToken !== null) await complete(provider, admission, "neutral");
      throw error;
    }
    let result: T;
    try { result = await work(); }
    catch (error) {
      // A final dispatch gate can expire after reservation but before fetch.
      // Release only an owned probe. Preserve the preceding outage history.
      if (error instanceof PublicSourceControlError) {
        if (admission.probeToken !== null) await complete(provider, admission, "neutral");
      } else {
        await complete(provider, admission, "failure");
      }
      throw error;
    }
    // Healthy successes never write or clear a concurrent failure. Only the
    // generation-fenced recovery probe can clear its own outage state.
    if (admission.probeToken !== null) await complete(provider, admission, "success");
    // Retrieval is read-only. A failed optional completion cannot invalidate
    // real, validated metadata. Keep useful work, without claiming recovery.
    return result;
  };
}

export const runPublicSourceAttempt = createPublicSourceCircuit();
