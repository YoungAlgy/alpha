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
export function hasActiveAccess(
  cancelledAt: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!cancelledAt) return true;
  const ends = new Date(cancelledAt);
  if (Number.isNaN(ends.getTime())) return false; // unparseable → treat as ended (fail safe)
  return ends.getTime() > now.getTime();
}
