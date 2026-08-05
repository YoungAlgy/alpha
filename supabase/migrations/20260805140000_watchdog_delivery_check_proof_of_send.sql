-- alpha · watchdog_delivery_check now requires proof of send · 2026-08-05
--
-- Real interaction bug caught in review, not by a live incident: this
-- session added TWO things on the same day that turned out to conflict --
-- (1) issues.resend_message_id + a reclaim step in weekly-send/route.ts
-- for stuck claims (delivered_at set, but the process died before Resend
-- confirmed), and (2) a pre-check in daily-send.yml that reuses THIS
-- function to decide whether the 15:00 UTC retry can skip its expensive
-- pipeline. Both were tested and correct in isolation, but this function's
-- delivered_count only ever checked delivered_at -- which a stuck claim
-- also has set. So a stuck claim would read as "delivered" here, meaning:
--
--   1. The retry pre-check could see delivered_count == active_count (the
--      stuck claim counted as covered) and skip the ENTIRE pipeline --
--      including the reclaim step that lives inside the route itself,
--      which only ever runs on a real HTTP call to weekly-send. The one
--      thing that would have fixed the stuck claim never gets a chance to.
--   2. The watchdog's own 16:00 UTC check has the identical blind spot --
--      a stuck claim reads as "fine" here too, so it would never alert,
--      and since the route's reclaim step is scoped to TODAY's week_of,
--      a claim stuck past today's retry window silently stays stuck
--      forever with nothing left watching it.
--
-- Fix: delivered_count now also requires resend_message_id is not null --
-- genuine confirmed-sent, not just claimed. This makes both call sites
-- correctly treat a stuck claim as "not really delivered", which is
-- exactly what closes the second half of the gap the resend_message_id
-- column and reclaim step were added earlier today to fix.
--
-- GRANDFATHER CLAUSE, added the same time as the fix above after checking
-- real data before trusting it live: resend_message_id was added to the
-- schema TODAY, after today's actual 14:00 UTC send had already run on the
-- OLD code. All 4 real subscribers' genuine, successful deliveries from
-- today have delivered_at set and resend_message_id NULL -- not because
-- they're stuck, but because the column didn't exist yet when they were
-- sent. Requiring resend_message_id unconditionally would have made the
-- very next watchdog/pre-check run report a false "0 delivered" against
-- letters that genuinely went out. `delivered_at < '2026-08-05T19:10:00Z'`
-- (comfortably after all 4 real 18:52 UTC sends, before this migration)
-- exempts only pre-fix rows; anything delivered after that moment --
-- including every future day's send -- still requires real proof. A bulk
-- backfill UPDATE of existing rows was considered instead but intentionally
-- not done: a time-based exemption in the function achieves the identical
-- protective goal without mutating any data, which is both simpler to
-- reason about and matches this migration's own DDL-only risk profile.
create or replace function public.watchdog_delivery_check(cutoff timestamptz)
returns table(delivered_count bigint, active_subscriber_count bigint)
language sql
security definer
set search_path = public
as $$
  select
    (
      select count(*) from public.issues
      where delivered_at >= date_trunc('hour', cutoff)
        and (
          resend_message_id is not null
          or delivered_at < '2026-08-05T19:10:00Z'::timestamptz
        )
    ) as delivered_count,
    (
      select count(*) from public.users
      where subscribed_at is not null
        and (cancelled_at is null or cancelled_at > now())
        and unsubscribed_at is null
    ) as active_subscriber_count;
$$;

-- Same overload-trap warning as the two prior migrations touching this
-- function: this revoke/grant pair only applies to THIS exact (name,
-- arg-types) signature. Copy it into any future migration that changes
-- watchdog_delivery_check's parameter list.
revoke all on function public.watchdog_delivery_check(timestamptz) from public;
revoke all on function public.watchdog_delivery_check(timestamptz) from authenticated;
grant execute on function public.watchdog_delivery_check(timestamptz) to anon;
