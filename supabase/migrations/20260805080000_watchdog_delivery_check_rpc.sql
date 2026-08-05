-- alpha · watchdog delivery-check RPC · 2026-08-05
--
-- Replaces the GitHub Actions letter-watchdog.yml's use of the full-
-- privilege, RLS-bypassing SUPABASE_SECRET_KEY (a real overexposure caught
-- in a same-day adversarial review: that key can read and write every
-- table in the project, but the watchdog only ever needed two counts).
--
-- This function returns ONLY aggregate counts, never raw rows -- no
-- delivered_at timestamps, no user IDs, no PII crosses the wire to CI at
-- all. security definer lets it read past RLS internally (issues/users
-- both restrict SELECT to auth.uid() = user_id, which an unauthenticated
-- CI job can never satisfy) without handing the caller any broader access
-- than "these two numbers." Callable with the public anon/publishable key,
-- which is already non-sensitive (it ships inside client-side bundles) --
-- so the GitHub secret this replaces stops being a secret worth protecting
-- at all.
create or replace function public.watchdog_delivery_check(cutoff timestamptz)
returns table(delivered_count bigint, active_subscriber_count bigint)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*) from public.issues where delivered_at >= cutoff) as delivered_count,
    (select count(*) from public.users where subscribed_at is not null and cancelled_at is null) as active_subscriber_count;
$$;

revoke all on function public.watchdog_delivery_check(timestamptz) from public;
grant execute on function public.watchdog_delivery_check(timestamptz) to anon;
