// Shared grandfather cutoff for the resend_message_id "proof of send" column,
// added 2026-08-05 (see supabase/migrations/20260805140000_watchdog_delivery_check_proof_of_send.sql).
// Every one of that day's genuine 14:00 UTC deliveries has delivered_at set
// and resend_message_id null -- not because they're stuck, but because the
// column didn't exist yet when they were sent. Anything delivered_at before
// this instant is exempt from the "must have resend_message_id" proof
// requirement; anything at or after it must have real proof.
//
// One canonical value, three call sites that all need to agree on it exactly
// (a mismatch would either falsely flag real pre-fix sends as stuck, or stop
// grandfathering something that should be): app/api/cron/weekly-send/route.ts's
// reclaim step, scripts/verify-stuck-claim-reclaim.mts, and
// scripts/verify-watchdog-proof-of-send.mts. The Postgres function
// (public.watchdog_delivery_check) can't import this -- Postgres and
// TypeScript don't share a runtime -- so its migration keeps its own literal
// copy with a comment pointing back here; keep that literal in sync with this
// one by hand if it's ever changed.
export const RECLAIM_GRANDFATHER_CUTOFF = "2026-08-05T19:10:00Z";
