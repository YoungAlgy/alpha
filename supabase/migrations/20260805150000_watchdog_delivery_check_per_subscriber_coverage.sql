-- alpha · watchdog_delivery_check switches from aggregate counts to genuine
-- per-subscriber coverage · 2026-08-05
--
-- Real structural bug caught in a post-ship review, not a live incident:
-- both call sites of this function (daily-send.yml's retry pre-check, and
-- letter-watchdog.yml's alert check) decide "is everyone covered" by
-- comparing two independent aggregate counts -- delivered_count vs
-- active_subscriber_count. That comparison can be satisfied even when a
-- SPECIFIC active subscriber has no letter at all, as long as the totals
-- happen to net out. Concrete scenario: subscriber A unsubscribes between
-- the 14:00 primary send and the 15:00 retry (drops out of
-- active_subscriber_count, but A's own already-delivered issue row still
-- counts toward delivered_count), and subscriber E signs up in that same
-- window (joins active_subscriber_count, but has zero issues). Net active
-- count is unchanged, delivered_count is unchanged -- the pre-check reads
-- "fully covered" and skips the retry, and E never gets today's letter.
-- Tomorrow's cron uses a new week_of, so this isn't "late", it's silently
-- skipped forever. Directly contradicts this function's whole purpose.
--
-- Fix: replace the two-aggregate comparison with a single genuine
-- per-subscriber coverage check -- count of currently ACTIVE subscribers
-- who have NO qualifying covered issue since cutoff (NOT EXISTS, not two
-- separate counts that can coincidentally cancel out). Callers now check
-- `uncovered_count = 0` instead of `delivered_count >= active_subscriber_count`.
-- active_subscriber_count is kept in the return row purely for the same
-- logging/observability both callers already did -- the skip/alert decision
-- itself now depends only on uncovered_count.
--
-- Same cutoff-window and proof-of-send/grandfather semantics as the prior
-- migration (unchanged): a covered issue is one with delivered_at >= cutoff
-- (truncated to the hour, same slack as before) AND (resend_message_id is
-- not null OR delivered_at < the 2026-08-05T19:10:00Z grandfather cutoff --
-- see lib/delivery-proof.ts's RECLAIM_GRANDFATHER_CUTOFF, the canonical
-- source for this literal; Postgres can't import a TS module, so keep this
-- copy in sync by hand if that value is ever changed).
--
-- DROP FIRST: CREATE OR REPLACE FUNCTION cannot rename OUT parameters
-- (delivered_count -> uncovered_count is a genuine signature change, not
-- just a body change) -- Postgres error 42P13 confirmed this live before
-- shipping. Same (name, arg-types) signature, so the revoke/grant below
-- still applies to the replacement.
drop function if exists public.watchdog_delivery_check(timestamptz);

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
    ) as active_subscriber_count;
$$;

-- Same overload-trap warning as every prior migration touching this
-- function: this revoke/grant pair only applies to THIS exact (name,
-- arg-types) signature. Copy it into any future migration that changes
-- watchdog_delivery_check's parameter list.
revoke all on function public.watchdog_delivery_check(timestamptz) from public;
revoke all on function public.watchdog_delivery_check(timestamptz) from authenticated;
grant execute on function public.watchdog_delivery_check(timestamptz) to anon;
