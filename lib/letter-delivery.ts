// Idempotent letter-email delivery built on an ATOMIC delivered_at
// compare-and-swap, so the onboarding first-letter path (/api/generate) and the
// weekly-send cron can never double-send. Both can target the SAME (user,
// week_of) issue row: a reader who finishes Stripe checkout within ~a minute of
// a Sun/Tue/Thu 14:00 UTC cron tick is already in the cron's subscriber set AND
// running generate, on the same period key. A non-atomic "read delivered_at,
// send, then stamp" lets both read NULL and both send. The cron closes this with
// an UPDATE ... WHERE delivered_at IS NULL claim. This shares that primitive so
// the two paths can never both win the same row.

// The minimal storage surface deliverLetterOnce needs. The route adapts a
// Supabase service client to it. The test harness backs it with an in-memory map
// that models the same atomic CAS.
export interface DeliveryStore {
  // Atomic claim: stamp delivered_at = `stamp` for (userId, weekOf) ONLY if it
  // is currently NULL. `won` is true for the single caller that flipped it.
  // `exists` is false when there is no issue row at all (best-effort persist can
  // leave none), which the caller treats as "nothing to dedup against".
  claim(
    userId: string,
    weekOf: string,
    stamp: string
  ): Promise<{ won: boolean; exists: boolean }>;
  // Release a claim, guarded on the EXACT stamp written, so a rollback never
  // clears a different invocation's claim. Used when the send fails.
  release(userId: string, weekOf: string, stamp: string): Promise<void>;
}

export interface DeliverLetterOnceOpts {
  store: DeliveryStore | null; // null when persistence failed entirely
  userId: string | null; // null when there is no persisted user row
  weekOf: string;
  stamp: string; // the claim timestamp (caller supplies)
  send: () => Promise<void>; // performs the actual email send
  onError?: (e: unknown) => void; // observability hook for the caller's logger
}

export type DeliverReason =
  | "claimed" // won the atomic claim, sent
  | "no-persistence" // no store / user row, best-effort send (legacy behavior)
  | "no-row" // user row but no issue row, best-effort send
  | "claim-error" // claim query errored, failed OPEN and sent best-effort
  | "already-delivered" // a concurrent run already delivered, skipped
  | "send-failed"; // we claimed and the send threw (claim released)

// Send a letter email at most once for (userId, weekOf), holding an atomic claim
// whenever persistence allows it. Returns whether an email went out. Never throws
// on a send failure (the letter still renders on /inbox). On a claimed-then-
// failed send it releases the claim so a retry or the cron can deliver later.
export async function deliverLetterOnce(
  opts: DeliverLetterOnceOpts
): Promise<{ sent: boolean; reason: DeliverReason }> {
  const { store, userId, weekOf, stamp, send, onError } = opts;

  // No way to dedup (persist returned nothing) → best-effort single send, the
  // same behavior as before the atomic claim existed.
  if (!store || !userId) {
    await send();
    return { sent: true, reason: "no-persistence" };
  }

  let claim: { won: boolean; exists: boolean };
  try {
    claim = await store.claim(userId, weekOf, stamp);
  } catch (e) {
    // The claim query itself errored (a DB blip). Fail OPEN: this is the paid
    // first letter and the route's rule is to never block it on an infra hiccup.
    // The only dup risk is a same-instant cron tick, which is vanishingly rare.
    onError?.(e);
    await send();
    return { sent: true, reason: "claim-error" };
  }

  if (!claim.won) {
    if (claim.exists) {
      // Row exists and was already claimed or delivered by a concurrent run or a
      // re-submit. This is the case the atomic claim exists to catch. Skip.
      return { sent: false, reason: "already-delivered" };
    }
    // No issue row to claim (best-effort persist left none) → best-effort send,
    // same as the no-persistence path. There is nothing to roll back.
    await send();
    return { sent: true, reason: "no-row" };
  }

  // We hold the claim: delivered_at is ours. Send, and release on failure so a
  // retry or the cron can re-claim and deliver this period cleanly.
  try {
    await send();
    return { sent: true, reason: "claimed" };
  } catch (e) {
    onError?.(e);
    try {
      await store.release(userId, weekOf, stamp);
    } catch (e2) {
      onError?.(e2);
    }
    return { sent: false, reason: "send-failed" };
  }
}
