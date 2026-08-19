-- alpha · watchdog_delivery_check's active-subscriber definition omits
-- bounced_at/complained_at, permanently miscounting suppressed subscribers
-- as uncovered · round 38 self-audit, 2026-08-19
--
-- public.watchdog_delivery_check(cutoff) defines both uncovered_count and
-- active_subscriber_count using only subscribed_at/cancelled_at/
-- unsubscribed_at. It never filters on bounced_at/complained_at. Those two
-- columns were added the NEXT day (20260806030000_resend_webhook_deliverability.sql)
-- specifically so the real send (app/api/cron/weekly-send/route.ts) excludes
-- hard-bounced/complained subscribers from ever being sent to again -- but
-- no migration since has updated this RPC to match.
--
-- Consequence: once any subscriber ever hard-bounces or complains (a normal,
-- expected occurrence -- that's the entire reason those columns exist), this
-- RPC still counts them as "active" but they will NEVER have a covered issue
-- again by design (the real send skips them on purpose). uncovered_count can
-- then never return to 0. That deterministically breaks daily-send.yml's
-- pre-check (which requires uncovered_count==0 to skip the expensive retry
-- pipeline -- it would run the full pipeline on every retry, every day,
-- forever) and skews letter-watchdog.yml's derived delivered count downward
-- permanently, risking a false "possible partial/crashed send" alert.
--
-- Fix: add the identical bounced_at/complained_at filter the real send
-- already uses, to both the uncovered_count NOT EXISTS subquery's outer
-- WHERE and the active_subscriber_count subquery's WHERE, so this RPC's
-- notion of "active" matches who the app actually still sends to.
--
-- Same DROP-FIRST note as the prior migration touching this function:
-- CREATE OR REPLACE FUNCTION can't rename OUT parameters, but this change
-- only adds WHERE conditions (same signature, same OUT param names), so a
-- plain CREATE OR REPLACE is sufficient here -- no drop needed.
create or replace function public.watchdog_delivery_check(cutoff timestamptz)
returns table(uncovered_count bigint, active_subscriber_count bigint)
language sql
security definer
set search_path = public
as $$
  select
    (
      select count(*) from public.users u
      where u.subscribed_at is not null
        and (u.cancelled_at is null or u.cancelled_at > now())
        and u.unsubscribed_at is null
        and u.bounced_at is null
        and u.complained_at is null
        and not exists (
          select 1 from public.issues i
          where i.user_id = u.id
            and i.delivered_at >= date_trunc('hour', cutoff)
            and (
              i.resend_message_id is not null
              or i.delivered_at < '2026-08-05T19:10:00Z'::timestamptz
            )
        )
    ) as uncovered_count,
    (
      select count(*) from public.users
      where subscribed_at is not null
        and (cancelled_at is null or cancelled_at > now())
        and unsubscribed_at is null
        and bounced_at is null
        and complained_at is null
    ) as active_subscriber_count;
$$;

-- Same overload-trap warning as every prior migration touching this
-- function: this revoke/grant pair only applies to THIS exact (name,
-- arg-types) signature. Copy it into any future migration that changes
-- watchdog_delivery_check's parameter list.
revoke all on function public.watchdog_delivery_check(timestamptz) from public;
revoke all on function public.watchdog_delivery_check(timestamptz) from authenticated;
grant execute on function public.watchdog_delivery_check(timestamptz) to anon;
