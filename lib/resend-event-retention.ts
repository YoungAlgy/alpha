type RetentionClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

/** One bounded batch. No identities or provider requests belong in this job. */
export async function pruneUnownedResendEvents(sb: RetentionClient): Promise<{
  pruned: number;
  remaining: boolean;
  errors: number;
}> {
  try {
    const { data, error } = await sb.rpc("prune_unowned_resend_webhook_events", {
      p_limit: 1000,
    });
    const row = Array.isArray(data) && data.length === 1 ? data[0] : null;
    if (
      error ||
      !row ||
      !Number.isSafeInteger(row.pruned_count) ||
      row.pruned_count < 0 ||
      row.pruned_count > 1000 ||
      typeof row.remaining !== "boolean"
    ) {
      return { pruned: 0, remaining: true, errors: 1 };
    }
    return { pruned: row.pruned_count, remaining: row.remaining, errors: 0 };
  } catch {
    return { pruned: 0, remaining: true, errors: 1 };
  }
}
