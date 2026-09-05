import type { supabaseServiceClient } from "@/lib/supabase/server";

type ServiceClient = Awaited<ReturnType<typeof supabaseServiceClient>>;

export interface SuppressionReconciliationResult {
  inspected: number;
  cleared: number;
  deferred: number;
  deadLettered: number;
  errors: string[];
}

/**
 * Report bounded pending delivery reviews. Automatic maintenance never removes
 * a provider suppression or changes local delivery evidence. Manual provider
 * recovery is held pending late-event ordering and terminal-resolution proof.
 */
export async function reconcilePendingSuppressions(
  sb: ServiceClient,
  limit = 5
): Promise<SuppressionReconciliationResult> {
  const safeLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(10, limit))
    : 5;
  const result: SuppressionReconciliationResult = {
    inspected: 0,
    cleared: 0,
    deferred: 0,
    deadLettered: 0,
    errors: [],
  };
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from("users")
    .select(
      "suppression_cleanup_pending_at"
    )
    .not("suppression_cleanup_pending_at", "is", null)
    .is("suppression_cleanup_dead_lettered_at", null)
    .or(
      `suppression_cleanup_next_attempt_at.is.null,suppression_cleanup_next_attempt_at.lte.${nowIso}`
    )
    .order("suppression_cleanup_pending_at", { ascending: true })
    .limit(safeLimit);
  if (error) {
    result.errors.push(`pending suppression lookup failed: ${error.message}`);
    return result;
  }

  // The markers remain in place. They keep scheduled delivery blocked and
  // visible for review. This release offers no manual recovery action.
  const reviewRequired = data?.length ?? 0;
  result.inspected = reviewRequired;
  result.deferred = reviewRequired;

  return result;
}
