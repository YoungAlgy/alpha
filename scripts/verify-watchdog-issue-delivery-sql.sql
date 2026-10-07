-- LOCAL DISPOSABLE DATABASE ONLY. Requires a superuser and an empty public schema.
-- Inert generic fixtures only. Includes the candidate migration and rolls back
-- every fixture table, function, trigger, role creation and schema grant.
-- No hosted database, environment values, private records or network calls.
\set ON_ERROR_STOP on
begin;

do $$
begin
  if exists (select 1 from pg_class where relnamespace = 'public'::regnamespace)
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace) then
    raise exception 'watchdog fixture requires an empty disposable database';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end;
$$;

create table public.users (
  id bigint primary key,
  email text not null default 'generic@example.invalid',
  delivery_enrolled boolean not null default true,
  subscribed_at timestamptz default now(),
  access_granted_at timestamptz default now(),
  cancelled_at timestamptz,
  unsubscribed_at timestamptz,
  brevo_unsubscribed_at timestamptz,
  bounced_at timestamptz,
  complained_at timestamptz,
  suppression_cleanup_pending_at timestamptz
);
create table public.issues (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.users(id),
  week_of date not null,
  delivered_at timestamptz,
  resend_message_id text,
  brevo_message_id text
);
alter table public.users enable row level security;
alter table public.issues enable row level security;
revoke all on public.users, public.issues from public, anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

\ir ../supabase/migrations/20261007000000_watchdog_issue_delivery_check.sql

-- No auth schema is supplied. Current watchdog eligibility does not join auth.
insert into public.users (id) select n from generate_series(1,13) as t(n);
insert into public.users (id, delivery_enrolled) values (101,false);
insert into public.users (id, subscribed_at) values (102,null);
insert into public.users (id, access_granted_at, cancelled_at) values (103,null,now()-interval '1 second');
insert into public.users (id, unsubscribed_at) values (104,now());
insert into public.users (id, brevo_unsubscribed_at) values (105,now());
insert into public.users (id, bounced_at) values (106,now());
insert into public.users (id, complained_at) values (107,now());
insert into public.users (id, suppression_cleanup_pending_at) values (108,now());
insert into public.users (id, access_granted_at, cancelled_at) values (109,null,now());
-- Permanent invite access survives cancelled billing. Future cancellation and
-- uncancelled paid access also preserve the exact existing eligibility rule.
update public.users set cancelled_at = now()-interval '1 day' where id = 11;
update public.users set access_granted_at = null, cancelled_at = now()+interval '1 day' where id = 12;
update public.users set access_granted_at = null where id = 13;

do $$
declare
  v_today date := (now() at time zone 'UTC')::date;
  v_date date := v_today - 1;
  v_start timestamptz := v_date::timestamp at time zone 'UTC';
  v_end timestamptz := v_today::timestamp at time zone 'UTC';
  v_tomorrow timestamptz := (v_today+1)::timestamp at time zone 'UTC';
begin
  insert into public.issues (user_id,week_of,delivered_at,resend_message_id,brevo_message_id) values
    -- The start is inclusive. Two accepted rows still cover only one reader.
    (1,v_date,v_start,'generic-resend',null),
    (1,v_date,v_start+interval '1 hour','generic-resend-duplicate',null),
    -- This -05 offset timestamp lands at 00:30 UTC on the checked issue date.
    (2,v_date,((v_date-1)::text || ' 19:30:00-05')::timestamptz,null,'generic-brevo'),
    (3,v_date,v_start+interval '1 hour',E' \t\n\r',U&'\00A0\2000\FEFF'),
    (3,v_date,v_start+interval '2 hours','',null),
    (4,v_date,v_start+interval '1 hour',null,null),
    -- A newer accepted issue cannot satisfy the older date, even with a stamp
    -- inside that older UTC interval. Normal today's acceptance is separate.
    (5,v_today,v_start+interval '1 hour','generic-newer-issue',null),
    (5,v_today,now(),'generic-today',null),
    (6,v_date-1,v_start+interval '1 hour','generic-older-issue',null),
    (7,v_date,v_start-interval '1 microsecond','generic-before-start',null),
    (8,v_date,v_end,'generic-at-next-midnight',null),
    (9,v_date,null,'generic-without-stamp',null),
    -- A future acceptance is strictly inside today's UTC interval. A correct
    -- date and provider ID still cannot cover a reader before its timestamp.
    (10,v_today,now()+(v_tomorrow-now())/2,'generic-future-stamp',null),
    (11,v_date,v_end-interval '1 microsecond',E' \tgeneric-invite\n ',null),
    (13,v_date,v_start+interval '1 hour',null,E' \tgeneric-paid\n ');
end;
$$;

-- Detect writes during every aggregate call, beyond comparing final contents.
create function public.watchdog_fixture_reject_write() returns trigger language plpgsql as $$
begin raise exception 'watchdog aggregate attempted a write'; end;
$$;
create trigger watchdog_fixture_no_user_writes before insert or update or delete on public.users
for each statement execute function public.watchdog_fixture_reject_write();
create trigger watchdog_fixture_no_issue_writes before insert or update or delete on public.issues
for each statement execute function public.watchdog_fixture_reject_write();

do $$
declare
  v_row record;
  v_today date := (now() at time zone 'UTC')::date;
  v_date date := v_today - 1;
  v_zone text;
  v_invalid date;
  v_role name;
  v_message text;
  v_before text;
  v_after text;
begin
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public.watchdog_issue_delivery_check(date)'::regprocedure
      and p.provolatile = 's' and p.prosecdef
      and 'search_path=""' = any(p.proconfig)
      and p.proargnames = array['issue_date','checked_issue_date','uncovered_count','active_subscriber_count']
  ) then raise exception 'watchdog function contract mismatch'; end if;

  if not has_function_privilege('anon','public.watchdog_issue_delivery_check(date)','execute')
     or has_function_privilege('authenticated','public.watchdog_issue_delivery_check(date)','execute')
     or has_function_privilege('service_role','public.watchdog_issue_delivery_check(date)','execute') then
    raise exception 'watchdog execute privilege mismatch';
  end if;
  if exists (
    select 1 from pg_proc p, lateral aclexplode(p.proacl) a
    where p.oid = 'public.watchdog_issue_delivery_check(date)'::regprocedure
      and a.privilege_type = 'EXECUTE'
      and (a.grantee = 0 or a.grantee not in (p.proowner,'anon'::regrole::oid))
  ) then raise exception 'watchdog has an unexpected execute grant'; end if;

  foreach v_role in array array['anon'::name,'authenticated'::name,'service_role'::name] loop
    if has_table_privilege(v_role,'public.users','select,insert,update,delete')
       or has_table_privilege(v_role,'public.issues','select,insert,update,delete') then
      raise exception 'watchdog fixture unexpectedly granted direct table access';
    end if;
  end loop;

  perform set_config('TimeZone','UTC',true);
  select md5(jsonb_build_array(
    (select jsonb_agg(to_jsonb(u) order by u.id) from public.users u),
    (select jsonb_agg(to_jsonb(i) order by i.id) from public.issues i)
  )::text) into v_before;

  -- UTC fences are independent of the invoking session's calendar date.
  foreach v_zone in array array['UTC','Pacific/Kiritimati','America/Los_Angeles'] loop
    perform set_config('TimeZone',v_zone,true);
    select * into strict v_row from public.watchdog_issue_delivery_check(v_date);
    if v_row.checked_issue_date is distinct from v_date
       or v_row.uncovered_count <> 9 or v_row.active_subscriber_count <> 13 then
      raise exception 'watchdog exact yesterday coverage or eligibility failed';
    end if;
    select * into strict v_row from public.watchdog_issue_delivery_check(v_today);
    if v_row.checked_issue_date is distinct from v_today
       or v_row.uncovered_count <> 12 or v_row.active_subscriber_count <> 13 then
      raise exception 'watchdog exact today coverage or future fence failed';
    end if;
  end loop;

  foreach v_invalid in array array[null::date,v_today-2,v_today+1,'-infinity'::date,'infinity'::date] loop
    begin
      perform * from public.watchdog_issue_delivery_check(v_invalid);
      raise exception using errcode='P0002', message='invalid watchdog issue date accepted';
    exception when invalid_parameter_value then
      get stacked diagnostics v_message = message_text;
      if v_message <> 'watchdog issue date invalid' then
        raise exception 'watchdog date error exposed request details';
      end if;
    end;
  end loop;

  perform set_config('TimeZone','UTC',true);
  select md5(jsonb_build_array(
    (select jsonb_agg(to_jsonb(u) order by u.id) from public.users u),
    (select jsonb_agg(to_jsonb(i) order by i.id) from public.issues i)
  )::text) into v_after;
  if v_after is distinct from v_before then raise exception 'watchdog aggregate changed rows'; end if;
end;
$$;

-- Actual invocation verifies the anon aggregate works without table read grants.
set local role anon;
do $$
declare v_row record;
begin
  select * into strict v_row
    from public.watchdog_issue_delivery_check((now() at time zone 'UTC')::date-1);
  if v_row.uncovered_count <> 9 or v_row.active_subscriber_count <> 13
     or (select array_agg(k order by k) from jsonb_object_keys(to_jsonb(v_row)) as t(k))
        is distinct from array['active_subscriber_count','checked_issue_date','uncovered_count'] then
    raise exception 'anon watchdog response is not the expected aggregate';
  end if;
  begin
    perform 1 from public.users;
    raise exception using errcode='P0002', message='anon user read unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.issues;
    raise exception using errcode='P0002', message='anon issue read unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

do $$
declare v_role name;
begin
  foreach v_role in array array['authenticated'::name,'service_role'::name] loop
    execute format('set local role %I',v_role);
    begin
      perform * from public.watchdog_issue_delivery_check((now() at time zone 'UTC')::date);
      raise exception using errcode='P0002', message='non-anon watchdog call unexpectedly allowed';
    exception when insufficient_privilege then null;
    end;
    execute 'reset role';
  end loop;
end;
$$;

-- Rechecking yesterday uses current eligibility, rather than a historical
-- subscriber snapshot. Pausing an accepted reader reduces today's denominator.
drop trigger watchdog_fixture_no_user_writes on public.users;
update public.users set delivery_enrolled = false where id = 1;
do $$
declare v_row record;
begin
  select * into strict v_row from public.watchdog_issue_delivery_check((now() at time zone 'UTC')::date-1);
  if v_row.uncovered_count <> 9 or v_row.active_subscriber_count <> 12 then
    raise exception 'watchdog reconstructed historical audience';
  end if;
end;
$$;
update public.users set delivery_enrolled = false;
create trigger watchdog_fixture_no_user_writes before insert or update or delete on public.users
for each statement execute function public.watchdog_fixture_reject_write();
set local role anon;
do $$
declare v_row record;
begin
  select * into strict v_row from public.watchdog_issue_delivery_check((now() at time zone 'UTC')::date);
  if v_row.checked_issue_date is distinct from (now() at time zone 'UTC')::date
     or v_row.uncovered_count <> 0 or v_row.active_subscriber_count <> 0 then
    raise exception 'watchdog no-reader aggregate failed';
  end if;
end;
$$;
reset role;
rollback;
