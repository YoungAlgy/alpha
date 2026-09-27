type RetentionClient = {
  rpc: (name: string, args: Record<string, unknown>) =>
    PromiseLike<{ data: unknown; error: unknown }>;
};

const BATCH_LIMIT = 100;

/** Delete one bounded batch of old unowned event hashes. Owned events stay. */
export async function pruneUnownedBrevoEvents(sb: RetentionClient): Promise<{
  pruned: number;
  remaining: boolean;
  errors: number;
}> {
  try {
    const { data, error } = await sb.rpc("prune_unowned_brevo_suppression_events", {
      p_limit: BATCH_LIMIT,
    });
    if (error || !Number.isSafeInteger(data) || (data as number) < 0 ||
        (data as number) > BATCH_LIMIT) {
      return { pruned: 0, remaining: true, errors: 1 };
    }
    const pruned = data as number;
    // A full batch means more rows might be due. The next slot checks again.
    return { pruned, remaining: pruned === BATCH_LIMIT, errors: 0 };
  } catch {
    return { pruned: 0, remaining: true, errors: 1 };
  }
}
