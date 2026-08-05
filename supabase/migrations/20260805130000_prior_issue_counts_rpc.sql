-- alpha · grouped prior-issue-count RPC · 2026-08-05
--
-- Replaces app/api/cron/weekly-send/route.ts's priorIssueCount prefetch,
-- which ran ONE count query PER subscriber (in parallel via Promise.all --
-- not a sequential N+1, but still N round trips instead of one). The
-- surrounding comment already flagged this as a known tradeoff with an
-- explicit revisit plan ("Revisit with a grouped aggregate RPC if the list
-- grows past ~100") -- this is that RPC.
--
-- Deliberately still a COUNT aggregate, not a row-fetch-and-tally: this
-- value is a per-subscriber LIFETIME count of delivered issues, which grows
-- unbounded with time (unlike the alreadyDelivered prefetch in the same
-- file, which is bounded by today's active-subscriber count) -- at daily
-- cadence a subscriber crosses PostgREST's silent 1,000-row select cap
-- within a few years, and a row-fetch would silently undercount "Issue N"
-- past that point with no error anywhere. GROUP BY + count(*) has no such
-- cap; it returns exactly one row per user_id regardless of how many
-- underlying issue rows it's summing.
create or replace function public.prior_issue_counts(week_of_cutoff date, target_user_ids uuid[])
returns table(user_id uuid, prior_count bigint)
language sql
security definer
set search_path = public
as $$
  select i.user_id, count(*) as prior_count
  from public.issues i
  where i.week_of < week_of_cutoff
    and i.delivered_at is not null
    and i.user_id = any(target_user_ids)
  group by i.user_id
$$;

-- Same overload trap as watchdog_delivery_check's own migration comment
-- warns about: this revoke/grant pair only applies to THIS exact (name,
-- arg-types) signature. A future signature change creates a new function
-- object that does NOT inherit these lines -- copy them into any future
-- migration that changes this function's parameter list.
revoke all on function public.prior_issue_counts(date, uuid[]) from public;
revoke all on function public.prior_issue_counts(date, uuid[]) from authenticated;
revoke all on function public.prior_issue_counts(date, uuid[]) from anon;
grant execute on function public.prior_issue_counts(date, uuid[]) to service_role;
