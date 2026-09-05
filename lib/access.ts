// A subscriber's access to letters runs through the end of any period they
// have already paid for. The Stripe webhook stores `cancelled_at` as the date
// access ENDS, not the date the cancellation was *requested*:
//   - null            → active, no cancellation
//   - a FUTURE date   → "cancel at period end" scheduled (Stripe's default
//                        portal cancellation); they keep reading until then
//   - a past/now date → subscription actually deleted; access has ended
//
// So "still has access right now" means: not cancelled, OR cancelled with an
// end-date still in the future. The old gates checked a bare
// `cancelled_at == null`, which cut paying customers off the instant they
// *scheduled* a cancellation — denying them weeks of letters they'd paid for.
// This helper is the single source of truth for that rule (the weekly-send
// cron expresses the equivalent as a PostgREST `.or` filter — keep them in
// sync).
export const ADMIN_EMAIL = "youngalgy@gmail.com";

export function hasActiveAccess(
  cancelledAt: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!cancelledAt) return true;
  const ends = new Date(cancelledAt);
  if (Number.isNaN(ends.getTime())) return false; // unparseable → treat as ended (fail safe)
  return ends.getTime() > now.getTime();
}

// Reader-facing access requires BOTH evidence that access was granted and an
// unexpired cancellation window. hasActiveAccess() intentionally answers only
// the second half because billing/admin callers use it alongside their own
// subscription checks. Letter, inbox, and archive reads must use this combined
// predicate so a revoked comp (`subscribed_at = null`) cannot keep reading old
// issues merely because cancelled_at was historically null.
export function hasSubscriberAccess(
  subscribedAt: string | null | undefined,
  cancelledAt: string | null | undefined,
  now: Date = new Date()
): boolean {
  return !!subscribedAt && hasActiveAccess(cancelledAt, now);
}

// Invite access is a separate entitlement from Stripe. A manually approved
// reader keeps access after the linked paid period ends, while cancelled_at
// continues to mirror the real billing end date. Keeping those two facts
// separate lets an invite grant be revoked without inventing Stripe state.
// subscribed_at is still required so a bare or deleted profile cannot regain
// access from a stale audit marker alone.
export function hasReaderAccess(
  subscribedAt: string | null | undefined,
  cancelledAt: string | null | undefined,
  accessGrantedAt: string | null | undefined,
  now: Date = new Date()
): boolean {
  return (
    !!subscribedAt &&
    (!!accessGrantedAt || hasActiveAccess(cancelledAt, now))
  );
}
