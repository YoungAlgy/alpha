-- LOCAL PROPOSAL ONLY. Apply only in a separately reviewed migration transaction.
-- This additive aggregate leaves watchdog_delivery_check(timestamptz) unchanged.
-- Checks current delivery eligibility against one exact recent UTC issue date.
-- Provider acceptance does not prove a delivery event or inbox receipt.
-- delivered_at is a claim marker, not the provider acceptance timestamp.
-- Claims outside the UTC issue window remain unproven by this bounded check.
-- Yesterday uses today's eligibility. No historical audience is reconstructed.
create function public.watchdog_issue_delivery_check(issue_date date)
returns table (
  checked_issue_date date,
  uncovered_count bigint,
  active_subscriber_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_issue_date date := issue_date;
  v_now timestamptz := pg_catalog.now();
  v_utc_today date := (v_now at time zone 'UTC')::date;
  v_start timestamptz;
  v_end timestamptz;
begin
  if v_issue_date is null
     or v_issue_date < v_utc_today - 1
     or v_issue_date > v_utc_today then
    raise exception 'watchdog issue date invalid' using errcode = '22023';
  end if;

  v_start := v_issue_date::timestamp at time zone 'UTC';
  v_end := (v_issue_date + 1)::timestamp at time zone 'UTC';

  return query
  with eligible as materialized (
    -- Preserve the current eligibility in the Brevo foundation watchdog.
    select u.id from public.users u
    where u.delivery_enrolled
      and u.subscribed_at is not null
      and (
        u.access_granted_at is not null
        or u.cancelled_at is null
        or u.cancelled_at > pg_catalog.now()
      )
      and u.unsubscribed_at is null
      and u.brevo_unsubscribed_at is null
      and u.bounced_at is null
      and u.complained_at is null
      and u.suppression_cleanup_pending_at is null
  )
  select v_issue_date,
    pg_catalog.count(*) filter (where not exists (
      select 1 from public.issues i
      where i.user_id = e.id
        and i.week_of = v_issue_date
        and i.delivered_at >= v_start
        and i.delivered_at < v_end
        and i.delivered_at <= v_now
        and (
          -- Match ordinary trimmed-ID checks, including whitespace-only IDs.
          nullif(pg_catalog.btrim(i.resend_message_id,
            U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') is not null
          or nullif(pg_catalog.btrim(i.brevo_message_id,
            U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') is not null
        )
    )),
    pg_catalog.count(*)
  from eligible e;
end;
$$;

revoke all on function public.watchdog_issue_delivery_check(date)
  from public, authenticated, service_role;
grant execute on function public.watchdog_issue_delivery_check(date) to anon;

comment on function public.watchdog_issue_delivery_check(date) is
  'Read-only aggregate of current eligible readers without accepted-issue evidence and a claim marker inside exactly today or yesterday in UTC. The claim marker does not establish acceptance time. No historical audience or inbox receipt is inferred.';
