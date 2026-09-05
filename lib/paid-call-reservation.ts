import type { SupabaseClient } from "@supabase/supabase-js";

type RpcClient = Pick<SupabaseClient, "rpc">;

export interface DailyPaidCallBudgetSnapshot {
  granted: number;
  used: number;
  remaining: number;
  exhausted: boolean;
  error: string | null;
}

export async function reserveDailyPaidCalls(
  sb: RpcClient,
  budgetDate: string,
  requested: number
): Promise<number> {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(budgetDate) ||
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > 400
  ) {
    throw new Error("paid-call reservation input was invalid");
  }
  const { data, error } = await sb.rpc("reserve_alpha_paid_calls", {
    p_budget_date: budgetDate,
    p_requested: requested,
  });
  if (error || !Number.isInteger(data) || data < 0 || data > requested) {
    throw new Error(
      `paid-call reservation failed: ${error?.message ?? String(data)}`
    );
  }
  return data;
}

/**
 * Lazily reserves small chunks from the database-backed daily ceiling.
 *
 * Reserving only when a paid provider is about to start keeps a normal run
 * that succeeds on free/cache paths at zero. A process crash can strand at
 * most one small unused chunk, which fails closed on spend without blocking
 * the free and prior-issue fallbacks. Concurrent topic calls share one refill
 * promise, so they cannot each reserve their own chunk at the same boundary.
 */
export function createDailyPaidCallGuard(
  sb: RpcClient,
  budgetDate: string,
  chunkSize = 25
): {
  allow: () => Promise<boolean>;
  snapshot: () => DailyPaidCallBudgetSnapshot;
} {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 400) {
    throw new Error("paid-call reservation chunk size was invalid");
  }

  let remaining = 0;
  let granted = 0;
  let used = 0;
  let exhausted = false;
  let reservationError: string | null = null;
  let refillPromise: Promise<void> | null = null;

  const refill = async (): Promise<void> => {
    if (!refillPromise) {
      refillPromise = (async () => {
        try {
          const nextGrant = await reserveDailyPaidCalls(
            sb,
            budgetDate,
            chunkSize
          );
          granted += nextGrant;
          remaining += nextGrant;
          if (nextGrant < chunkSize) exhausted = true;
        } catch (error) {
          reservationError =
            error instanceof Error ? error.message : String(error);
          exhausted = true;
        }
      })();
    }

    const currentRefill = refillPromise;
    await currentRefill;
    if (refillPromise === currentRefill) refillPromise = null;
  };

  const allow = async (): Promise<boolean> => {
    while (remaining < 1 && !exhausted) {
      await refill();
    }
    if (remaining < 1) return false;
    remaining -= 1;
    used += 1;
    return true;
  };

  const snapshot = (): DailyPaidCallBudgetSnapshot => ({
    granted,
    used,
    remaining,
    exhausted,
    error: reservationError,
  });

  return { allow, snapshot };
}
