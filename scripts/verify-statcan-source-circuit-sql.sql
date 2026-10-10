-- Prepared for a disposable LOCAL PostgreSQL fixture only. No managed database.
-- Requires prior rate-limit/circuit/PLOS/ccMixter/Federal Register/GOV.UK migrations.
-- Run as table owner with the original anon/authenticated/service_role fixtures.
-- All changes are rolled back. This script does not record a live migration.
\set ON_ERROR_STOP on
create temp table statcan_rollback_before as
select jsonb_build_object(
  'rows', (select jsonb_agg(to_jsonb(c) order by c.provider) from public.alpha_public_source_circuits c),
  'constraint', (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.alpha_public_source_circuits'::regclass
      and conname = 'alpha_public_source_circuits_provider_check')
) as state;
begin;
-- Preservation checks include existing outage and live probe shapes.
update public.alpha_public_source_circuits
set failure_count = 2, cooldown_until = clock_timestamp() + interval '1 hour',
    last_failure_at = clock_timestamp() - interval '1 minute'
where provider = 'govuk-news';
update public.alpha_public_source_circuits
set failure_count = 1, cooldown_until = clock_timestamp() - interval '1 second',
    last_failure_at = clock_timestamp() - interval '1 minute',
    probe_token = gen_random_uuid(), probe_until = clock_timestamp() + interval '30 seconds'
where provider = 'publisher-nist';
create temp table statcan_before as
select jsonb_build_object(
  'rows', (select jsonb_agg(to_jsonb(c) order by c.provider) from public.alpha_public_source_circuits c),
  'table', (select jsonb_build_object('owner', c.relowner, 'acl', to_jsonb(c.relacl),
    'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity) from pg_class c
    where c.oid = 'public.alpha_public_source_circuits'::regclass),
  'policies', (select coalesce(jsonb_agg(to_jsonb(p) order by p.policyname), '[]'::jsonb)
    from pg_policies p where schemaname = 'public' and tablename = 'alpha_public_source_circuits'),
  'functions', (select jsonb_agg(jsonb_build_object('signature', p.oid::regprocedure::text,
    'definition', pg_get_functiondef(p.oid), 'acl', to_jsonb(p.proacl),
    'owner', p.proowner, 'security_definer', p.prosecdef, 'config', to_jsonb(p.proconfig))
    order by p.oid::regprocedure::text) from pg_proc p where p.oid in (
      'public.begin_alpha_public_source(text)'::regprocedure,
      'public.complete_alpha_public_source(text,uuid,uuid,text)'::regprocedure,
      'public.consume_alpha_rate_limit(text,text,integer,integer)'::regprocedure))
) as state;
\ir ../supabase/migrations/20261010010000_statcan_public_source_circuit.sql
do $$
declare v_before jsonb; v_after jsonb; v_admission record;
begin
  select state into v_before from statcan_before;
  if (select array_agg(provider order by provider) from public.alpha_public_source_circuits)
    is distinct from array['ccmixter-uploads','crossref-research','federal-register-finance',
      'gdelt','global-voices-rss','google-rss','govuk-news','plos-research',
      'publisher-fda-medwatch','publisher-fed-speeches','publisher-nist','statcan-labour']::text[] then
    raise exception 'StatCan fixture did not leave exactly twelve fixed identities';
  end if;
  select jsonb_agg(to_jsonb(c) order by c.provider) into v_after
    from public.alpha_public_source_circuits c where provider <> 'statcan-labour';
  if v_after is distinct from v_before->'rows' then raise exception 'Prior outage/probe rows changed'; end if;
  select jsonb_build_object('owner', c.relowner, 'acl', to_jsonb(c.relacl),
    'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity) into v_after from pg_class c
    where c.oid = 'public.alpha_public_source_circuits'::regclass;
  if v_after is distinct from v_before->'table' then raise exception 'Table ACL or RLS changed'; end if;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.policyname), '[]'::jsonb) into v_after
    from pg_policies p where schemaname = 'public' and tablename = 'alpha_public_source_circuits';
  if v_after is distinct from v_before->'policies' then raise exception 'RLS policies changed'; end if;
  select jsonb_agg(jsonb_build_object('signature', p.oid::regprocedure::text,
    'definition', pg_get_functiondef(p.oid), 'acl', to_jsonb(p.proacl),
    'owner', p.proowner, 'security_definer', p.prosecdef, 'config', to_jsonb(p.proconfig))
    order by p.oid::regprocedure::text) into v_after from pg_proc p where p.oid in (
      'public.begin_alpha_public_source(text)'::regprocedure,
      'public.complete_alpha_public_source(text,uuid,uuid,text)'::regprocedure,
      'public.consume_alpha_rate_limit(text,text,integer,integer)'::regprocedure);
  if v_after is distinct from v_before->'functions' then raise exception 'Protected RPC contract changed'; end if;
  if exists(select 1 from public.alpha_public_source_circuits where provider = 'statcan-labour'
    and (failure_count <> 0 or cooldown_until is not null or last_failure_at is not null
      or probe_token is not null or probe_until is not null or generation is null or updated_at is null)) then
    raise exception 'New circuit must start healthy';
  end if;
  select * into v_admission from public.begin_alpha_public_source('statcan-labour');
  if v_admission.admitted is distinct from true or v_admission.probe_token is not null
    or v_admission.retry_after_sec <> 0 then raise exception 'New healthy identity not admitted'; end if;
  if public.complete_alpha_public_source('statcan-labour', v_admission.generation,
    null, 'failure') is distinct from true then raise exception 'New failure not recorded'; end if;
  select * into v_admission from public.begin_alpha_public_source('statcan-labour');
  if v_admission.admitted is distinct from false or v_admission.retry_after_sec < 1 then
    raise exception 'New failed identity did not cool down';
  end if;
end;
$$;
create temp table statcan_repeat_before as select to_jsonb(c) as state
  from public.alpha_public_source_circuits c where provider = 'statcan-labour';
\ir ../supabase/migrations/20261010010000_statcan_public_source_circuit.sql
do $$
begin
  if (select to_jsonb(c) from public.alpha_public_source_circuits c where provider = 'statcan-labour')
    is distinct from (select state from statcan_repeat_before) then
    raise exception 'Reapplication changed existing StatCan outage state';
  end if;
end;
$$;
rollback;
do $$
declare v_after jsonb;
begin
  select jsonb_build_object(
    'rows', (select jsonb_agg(to_jsonb(c) order by c.provider) from public.alpha_public_source_circuits c),
    'constraint', (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.alpha_public_source_circuits'::regclass
        and conname = 'alpha_public_source_circuits_provider_check')) into v_after;
  if v_after is distinct from (select state from statcan_rollback_before) then
    raise exception 'StatCan rollback did not preserve original state';
  end if;
end;
$$;
select 'PASS local StatCan preservation, unchanged RPC/ACL/RLS, admission, cooldown, reapplication and rollback' as result;
