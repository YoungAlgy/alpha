-- alpha · watchdog delivery-check RPC fix · 2026-08-05
--
-- Fixes a real correctness bug in the first version of this function
-- (20260805080000_watchdog_delivery_check_rpc.sql), caught by a same-day
-- second-pass review: its active_subscriber_count used a bare
-- `cancelled_at is null` check with no unsubscribed_at filter, which is
-- NOT what actually decides who gets a letter. That's the exact bug class
-- lib/access.ts's hasActiveAccess() comment already warns about ("the old
-- gates checked a bare cancelled_at == null, which cut paying customers
-- off the instant they scheduled a cancellation... keep them in sync") --
-- this RPC reintroduced it in a second code path, plus never checked
-- unsubscribed_at at all. Realigned to match
-- app/api/cron/weekly-send/route.ts's real filter exactly:
--   subscribed_at is not null
--   and (cancelled_at is null or cancelled_at > now())   -- cancel-at-
--       period-end readers are still paid up and still get letters
--   and unsubscribed_at is null                          -- emails-only
--       opt-out is independent of billing and permanent
--
-- Also, while touching this function:
-- - Explicitly revokes from `authenticated` too, not just `public` --
--   Supabase's platform-level default privileges grant `authenticated`
--   its own direct EXECUTE on new public-schema functions independent of
--   the PUBLIC pseudo-role, so a public-only revoke may not actually be
--   the access boundary the original comment claimed it was.
-- - Truncates the caller-supplied cutoff to the hour before using it.
--   delivered_count is monotonically non-increasing in cutoff, so an
--   anon caller could otherwise binary-search adjacent cutoffs to recover
--   an individual issue's delivered_at down to the second -- hour
--   granularity is all the watchdog itself ever needs (it only ever asks
--   "in roughly the last 20 hours") and caps how precisely a non-CI
--   caller can reconstruct send timing.
-- - Documents the overload trap for future editors: create-or-replace
--   only affects THIS exact (name, arg-types) signature. A future
--   migration that changes the parameter list creates a brand-new
--   function object that does NOT inherit these revoke/grant lines --
--   Postgres auto-grants EXECUTE to PUBLIC on new functions by default.
--   Copy the revoke/grant block below into any future signature change.
create or replace function public.watchdog_delivery_check(cutoff timestamptz)
returns table(delivered_count bigint, active_subscriber_count bigint)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*) from public.issues where delivered_at >= date_trunc('hour', cutoff)) as delivered_count,
    (
      select count(*) from public.users
      where subscribed_at is not null
        and (cancelled_at is null or cancelled_at > now())
        and unsubscribed_at is null
    ) as active_subscriber_count;
$$;

revoke all on function public.watchdog_delivery_check(timestamptz) from public;
revoke all on function public.watchdog_delivery_check(timestamptz) from authenticated;
grant execute on function public.watchdog_delivery_check(timestamptz) to anon;
