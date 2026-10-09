-- Run with psql in a disposable local PostgreSQL fixture that has the
-- distributed-rate-limit, public-source-circuit, PLOS, and ccMixter migrations applied,
-- but has NOT applied the Federal Register migration. Run as the table owner with
-- anon, authenticated, and service_role available. Nothing survives rollback.
\set ON_ERROR_STOP on
-- Retain an outer snapshot so the final ROLLBACK is checked explicitly.
create temp table federal_register_rollback_before as
select jsonb_build_object(
  'rows', (select jsonb_agg(to_jsonb(c) order by c.provider)
             from public.alpha_public_source_circuits c),
  'provider_constraint', (select pg_get_constraintdef(oid)
                           from pg_constraint
                          where conrelid = 'public.alpha_public_source_circuits'::regclass
                            and conname = 'alpha_public_source_circuits_provider_check'),
  'rate_rows', (select coalesce(jsonb_agg(to_jsonb(b) order by
                 b.scope, b.key_hash, b.bucket_start, b.window_seconds), '[]'::jsonb)
                 from public.alpha_rate_limit_buckets b)
) as state;
begin;

-- Exercise preservation against real outage shapes rather than nine healthy
-- defaults. These are fixture-only changes, made before the migration snapshot.
update public.alpha_public_source_circuits
   set failure_count = 2,
       cooldown_until = clock_timestamp() + interval '1 hour',
       last_failure_at = clock_timestamp() - interval '1 minute'
 where provider = 'plos-research';
update public.alpha_public_source_circuits
   set failure_count = 1,
       cooldown_until = clock_timestamp() - interval '1 second',
       last_failure_at = clock_timestamp() - interval '1 minute',
       probe_token = gen_random_uuid(),
       probe_until = clock_timestamp() + interval '30 seconds'
 where provider = 'publisher-nist';

create temp table federal_register_fixture_before (
  item text primary key,
  value jsonb not null
) on commit drop;

do $$
begin
  if (select count(*) from public.alpha_public_source_circuits) <> 9
     or exists (select 1 from public.alpha_public_source_circuits
                 where provider = 'federal-register-finance') then
    raise exception 'fixture requires the nine-provider pre-Federal Register state';
  end if;
  if exists (
    select 1 from public.alpha_public_source_circuits
     where provider not in (
       'google-rss', 'publisher-nist', 'publisher-fda-medwatch',
       'publisher-fed-speeches', 'global-voices-rss', 'crossref-research',
       'gdelt', 'plos-research', 'ccmixter-uploads'
     )
  ) then
    raise exception 'fixture contains an unexpected prior provider';
  end if;
  if (select relrowsecurity from pg_class
       where oid = 'public.alpha_public_source_circuits'::regclass) is distinct from true
     or exists (select 1 from pg_policies
                 where schemaname = 'public'
                   and tablename = 'alpha_public_source_circuits') then
    raise exception 'fixture requires RLS enabled with no circuit policies';
  end if;
end;
$$;

insert into federal_register_fixture_before (item, value)
select 'prior_rows', jsonb_agg(to_jsonb(c) order by c.provider)
  from public.alpha_public_source_circuits c;
insert into federal_register_fixture_before (item, value)
select 'columns', jsonb_agg(jsonb_build_object(
    'name', a.attname,
    'type', format_type(a.atttypid, a.atttypmod),
    'not_null', a.attnotnull,
    'identity', a.attidentity,
    'generated', a.attgenerated,
    'default', pg_get_expr(d.adbin, d.adrelid)
  ) order by a.attnum)
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
 where a.attrelid = 'public.alpha_public_source_circuits'::regclass
   and a.attnum > 0 and not a.attisdropped;
insert into federal_register_fixture_before (item, value)
select 'table_access', jsonb_build_object(
    'owner', c.relowner::text,
    'acl', to_jsonb(c.relacl),
    'rls', c.relrowsecurity,
    'force_rls', c.relforcerowsecurity,
    'policies', (select count(*) from pg_policies
                  where schemaname = 'public'
                    and tablename = 'alpha_public_source_circuits')
  )
  from pg_class c
 where c.oid = 'public.alpha_public_source_circuits'::regclass;
insert into federal_register_fixture_before (item, value)
select 'functions', jsonb_agg(jsonb_build_object(
    'signature', p.oid::regprocedure::text,
    'definition', pg_get_functiondef(p.oid),
    'owner', p.proowner::text,
    'acl', to_jsonb(p.proacl),
    'security_definer', p.prosecdef,
    'config', to_jsonb(p.proconfig)
  ) order by p.oid::regprocedure::text)
  from pg_proc p
 where p.oid in (
   'public.begin_alpha_public_source(text)'::regprocedure,
   'public.complete_alpha_public_source(text,uuid,uuid,text)'::regprocedure,
   'public.consume_alpha_rate_limit(text,text,integer,integer)'::regprocedure
 );

-- psql resolves \ir relative to this script's directory. Applying twice in
-- this one transaction checks ON CONFLICT idempotency without a live write.
\ir ../supabase/migrations/20261009000000_federal_register_public_source_circuit.sql

do $$
declare
  v_item record;
  v_after jsonb;
  v_role name;
  v_privilege text;
begin
  if (select array_agg(provider order by provider)
        from public.alpha_public_source_circuits) is distinct from array[
      'ccmixter-uploads', 'crossref-research', 'federal-register-finance', 'gdelt',
      'global-voices-rss', 'google-rss', 'plos-research',
      'publisher-fda-medwatch', 'publisher-fed-speeches', 'publisher-nist'
    ]::text[] then
    raise exception 'migration did not leave exactly ten fixed providers';
  end if;
  if exists (select 1 from public.alpha_public_source_circuits
              where provider = 'federal-register-finance'
                and (failure_count <> 0 or cooldown_until is not null
                  or last_failure_at is not null or probe_token is not null
                  or probe_until is not null or generation is null
                  or updated_at is null)) then
    raise exception 'new Federal Register row did not start healthy';
  end if;

  select jsonb_agg(to_jsonb(c) order by c.provider) into v_after
    from public.alpha_public_source_circuits c
   where c.provider <> 'federal-register-finance';
  if v_after is distinct from
     (select value from federal_register_fixture_before where item = 'prior_rows') then
    raise exception 'migration changed one of nine prior outage states';
  end if;

  for v_item in select * from federal_register_fixture_before
                 where item in ('columns', 'table_access', 'functions') loop
    case v_item.item
      when 'columns' then
        select jsonb_agg(jsonb_build_object(
            'name', a.attname,
            'type', format_type(a.atttypid, a.atttypmod),
            'not_null', a.attnotnull,
            'identity', a.attidentity,
            'generated', a.attgenerated,
            'default', pg_get_expr(d.adbin, d.adrelid)
          ) order by a.attnum) into v_after
          from pg_attribute a
          left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
         where a.attrelid = 'public.alpha_public_source_circuits'::regclass
           and a.attnum > 0 and not a.attisdropped;
      when 'table_access' then
        select jsonb_build_object(
            'owner', c.relowner::text,
            'acl', to_jsonb(c.relacl),
            'rls', c.relrowsecurity,
            'force_rls', c.relforcerowsecurity,
            'policies', (select count(*) from pg_policies
                          where schemaname = 'public'
                            and tablename = 'alpha_public_source_circuits')
          ) into v_after
          from pg_class c
         where c.oid = 'public.alpha_public_source_circuits'::regclass;
      when 'functions' then
        select jsonb_agg(jsonb_build_object(
            'signature', p.oid::regprocedure::text,
            'definition', pg_get_functiondef(p.oid),
            'owner', p.proowner::text,
            'acl', to_jsonb(p.proacl),
            'security_definer', p.prosecdef,
            'config', to_jsonb(p.proconfig)
          ) order by p.oid::regprocedure::text) into v_after
          from pg_proc p
         where p.oid in (
           'public.begin_alpha_public_source(text)'::regprocedure,
           'public.complete_alpha_public_source(text,uuid,uuid,text)'::regprocedure,
           'public.consume_alpha_rate_limit(text,text,integer,integer)'::regprocedure
         );
    end case;
    if v_after is distinct from v_item.value then
      raise exception 'migration changed %', v_item.item;
    end if;
  end loop;

  if (select array_agg(a.attname order by a.attnum)
        from pg_attribute a
       where a.attrelid = 'public.alpha_public_source_circuits'::regclass
         and a.attnum > 0 and not a.attisdropped) is distinct from array[
       'provider', 'failure_count', 'generation', 'cooldown_until',
       'last_failure_at', 'probe_token', 'probe_until', 'updated_at'
     ]::name[] then
    raise exception 'circuit gained query, reader, URL, or other columns';
  end if;
  foreach v_role in array array['anon'::name, 'authenticated'::name,
                                'service_role'::name] loop
    foreach v_privilege in array array[
      'select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'
    ] loop
      if has_table_privilege(v_role, 'public.alpha_public_source_circuits',
                             v_privilege) then
        raise exception 'circuit table grants % to %', v_privilege, v_role;
      end if;
    end loop;
  end loop;
  if not has_function_privilege('service_role',
       'public.begin_alpha_public_source(text)', 'execute')
     or not has_function_privilege('service_role',
       'public.complete_alpha_public_source(text,uuid,uuid,text)', 'execute')
     or has_function_privilege('anon',
       'public.begin_alpha_public_source(text)', 'execute')
     or has_function_privilege('authenticated',
       'public.begin_alpha_public_source(text)', 'execute')
     or has_function_privilege('anon',
       'public.complete_alpha_public_source(text,uuid,uuid,text)', 'execute')
     or has_function_privilege('authenticated',
       'public.complete_alpha_public_source(text,uuid,uuid,text)', 'execute') then
    raise exception 'circuit RPC execute permissions changed';
  end if;
  begin
    insert into public.alpha_public_source_circuits (provider)
    values ('federal-register-reader-or-url');
    raise exception using errcode = 'P0002',
      message = 'provider constraint accepted a non-fixed identity';
  exception when check_violation then null;
  end;
  begin
    perform public.begin_alpha_public_source('federal-register-reader-or-url');
    raise exception using errcode = 'P0002',
      message = 'admission RPC accepted an unsupported identity';
  exception when raise_exception then
    if sqlerrm <> 'public source provider is invalid' then raise; end if;
  end;
end;
$$;

create temp table federal_register_fixture_after_first (
  rows jsonb not null
) on commit drop;
insert into federal_register_fixture_after_first
select jsonb_agg(to_jsonb(c) order by c.provider)
  from public.alpha_public_source_circuits c;

\ir ../supabase/migrations/20261009000000_federal_register_public_source_circuit.sql

do $$
declare v_after jsonb;
begin
  select jsonb_agg(to_jsonb(c) order by c.provider) into v_after
    from public.alpha_public_source_circuits c;
  if v_after is distinct from
     (select rows from federal_register_fixture_after_first) then
    raise exception 'reapplying migration changed circuit state';
  end if;
end;
$$;

-- Two healthy callers share one generation. A failure fences the second,
-- then the cooldown and recovery probe are durable across separate RPC calls.
do $$
declare
  v_first record;
  v_second record;
  v_probe record;
  v_next record;
  v_ok boolean;
  v_prior jsonb;
begin
  select value into v_prior from federal_register_fixture_before
   where item = 'prior_rows';
  select * into v_first from public.begin_alpha_public_source('federal-register-finance');
  select * into v_second from public.begin_alpha_public_source('federal-register-finance');
  if not v_first.admitted or not v_second.admitted
     or v_first.generation is null
     or v_first.generation <> v_second.generation
     or v_first.probe_token is not null or v_second.probe_token is not null then
    raise exception 'healthy Federal Register admission is invalid';
  end if;
  select public.complete_alpha_public_source(
    'federal-register-finance', v_first.generation, null, 'success') into v_ok;
  if v_ok then raise exception 'healthy success wrote circuit state'; end if;
  select public.complete_alpha_public_source(
    'federal-register-finance', v_first.generation, null, 'failure') into v_ok;
  if not v_ok then raise exception 'Federal Register failure was rejected'; end if;
  select public.complete_alpha_public_source(
    'federal-register-finance', v_second.generation, null, 'failure') into v_ok;
  if v_ok then raise exception 'stale healthy generation reopened outage'; end if;
  select * into v_next from public.begin_alpha_public_source('federal-register-finance');
  if v_next.admitted or v_next.retry_after_sec < 1
     or v_next.generation = v_first.generation then
    raise exception 'Federal Register cooldown failed across calls';
  end if;
  update public.alpha_public_source_circuits
     set cooldown_until = clock_timestamp() - interval '1 second'
   where provider = 'federal-register-finance';
  select * into v_probe from public.begin_alpha_public_source('federal-register-finance');
  if not v_probe.admitted or v_probe.probe_token is null
     or v_probe.generation <> v_next.generation then
    raise exception 'expired Federal Register cooldown did not issue a probe lease';
  end if;
  select * into v_next from public.begin_alpha_public_source('federal-register-finance');
  if v_next.admitted or v_next.retry_after_sec < 1 then
    raise exception 'second Federal Register caller bypassed active probe lease';
  end if;
  select public.complete_alpha_public_source(
    'federal-register-finance', v_probe.generation, gen_random_uuid(), 'success') into v_ok;
  if v_ok then raise exception 'foreign probe token cleared the circuit'; end if;
  select public.complete_alpha_public_source(
    'federal-register-finance', v_probe.generation, v_probe.probe_token, 'neutral') into v_ok;
  if not v_ok then raise exception 'owned neutral probe release was rejected'; end if;
  if exists (select 1 from public.alpha_public_source_circuits
              where provider = 'federal-register-finance'
                and (failure_count <> 1 or last_failure_at is null
                  or cooldown_until is null or generation <> v_probe.generation
                  or probe_token is not null or probe_until is not null)) then
    raise exception 'neutral release erased outage history or retained its lease';
  end if;
  select * into v_next from public.begin_alpha_public_source('federal-register-finance');
  if not v_next.admitted or v_next.probe_token is null
     or v_next.probe_token = v_probe.probe_token then
    raise exception 'released probe was not replaced with a distinct owned lease';
  end if;
  select public.complete_alpha_public_source(
    'federal-register-finance', v_probe.generation, v_probe.probe_token, 'neutral') into v_ok;
  if v_ok then raise exception 'stale neutral release cleared a later lease'; end if;
  v_probe := v_next;
  select public.complete_alpha_public_source(
    'federal-register-finance', v_probe.generation, v_probe.probe_token, 'success') into v_ok;
  if not v_ok then raise exception 'owned Federal Register recovery was rejected'; end if;
  if exists (select 1 from public.alpha_public_source_circuits
              where provider = 'federal-register-finance'
                and (failure_count <> 0 or cooldown_until is not null
                  or last_failure_at is not null or probe_token is not null
                  or probe_until is not null
                  or generation = v_probe.generation)) then
    raise exception 'Federal Register recovery did not reset and fence state';
  end if;
  select public.complete_alpha_public_source(
    'federal-register-finance', v_probe.generation, v_probe.probe_token, 'failure') into v_ok;
  if v_ok then raise exception 'stale probe reopened recovered circuit'; end if;
  if (select jsonb_agg(to_jsonb(c) order by c.provider)
        from public.alpha_public_source_circuits c
       where c.provider <> 'federal-register-finance') is distinct from v_prior then
    raise exception 'Federal Register RPC calls changed prior provider state';
  end if;
end;
$$;

-- A fixed HMAC-shaped fixture key models two processes using the same Federal Register
-- identity and fixed 15-minute bucket. Denial counts the third reservation
-- attempt, while no third outbound request is admitted.
do $$
declare
  v_hash constant text :=
    'b3022f7af243f6e7561ffeb822e27d82bc3e1cb25dd30f7297d4ab5283a8e8a5';
  v_first record;
  v_second record;
  v_third record;
  v_prior_budget record;
  v_scope text;
  v_limit integer;
begin
  if exists (select 1 from public.alpha_rate_limit_buckets
              where key_hash = v_hash
                and scope in ('public_source:federal_register_finance',
                              'public_source:publisher_rss', 'public_source:google_rss',
                              'public_source:gdelt', 'public_source:plos_research',
                              'public_source:ccmixter_uploads')) then
    raise exception 'Federal Register rate fixture hash already exists';
  end if;
  select * into v_first from public.consume_alpha_rate_limit(
    'public_source:federal_register_finance', v_hash, 2, 900);
  select * into v_second from public.consume_alpha_rate_limit(
    'public_source:federal_register_finance', v_hash, 2, 900);
  select * into v_third from public.consume_alpha_rate_limit(
    'public_source:federal_register_finance', v_hash, 2, 900);
  if not v_first.allowed or v_first.remaining <> 1 or v_first.retry_after_sec <> 0
     or not v_second.allowed or v_second.remaining <> 0 or v_second.retry_after_sec <> 0
     or v_third.allowed or v_third.remaining <> 0 or v_third.retry_after_sec < 1 then
    raise exception 'Federal Register two-per-900-second ceiling failed';
  end if;
  for v_scope, v_limit in
    select * from (values
      ('public_source:google_rss', 60),
      ('public_source:publisher_rss', 12),
      ('public_source:gdelt', 12),
      ('public_source:plos_research', 2),
      ('public_source:ccmixter_uploads', 2)
    ) as prior_budget(scope, cap)
  loop
    if exists (select 1 from public.alpha_rate_limit_buckets
                where key_hash = v_hash and scope = v_scope) then
      raise exception 'Federal Register calls consumed prior budget %', v_scope;
    end if;
    select * into v_prior_budget from public.consume_alpha_rate_limit(
      v_scope, v_hash, v_limit, 900);
    if not v_prior_budget.allowed or v_prior_budget.remaining <> v_limit - 1
       or v_prior_budget.retry_after_sec <> 0
       or (select request_count from public.alpha_rate_limit_buckets
            where scope = v_scope and key_hash = v_hash
              and window_seconds = 900) <> 1 then
      raise exception 'prior source budget % was not independent', v_scope;
    end if;
  end loop;
  if (select request_count from public.alpha_rate_limit_buckets
       where scope = 'public_source:federal_register_finance' and key_hash = v_hash
         and window_seconds = 900) <> 3 then
    raise exception 'Federal Register bucket count changed during prior budget calls';
  end if;
end;
$$;

rollback;

do $$
declare v_after jsonb;
begin
  select jsonb_build_object(
    'rows', (select jsonb_agg(to_jsonb(c) order by c.provider)
               from public.alpha_public_source_circuits c),
    'provider_constraint', (select pg_get_constraintdef(oid)
                             from pg_constraint
                            where conrelid = 'public.alpha_public_source_circuits'::regclass
                              and conname = 'alpha_public_source_circuits_provider_check'),
    'rate_rows', (select coalesce(jsonb_agg(to_jsonb(b) order by
                   b.scope, b.key_hash, b.bucket_start, b.window_seconds), '[]'::jsonb)
                   from public.alpha_rate_limit_buckets b)
  ) into v_after;
  if v_after is distinct from (select state from federal_register_rollback_before) then
    raise exception 'rollback did not restore prior rows, constraint and budget buckets';
  end if;
end;
$$;
drop table federal_register_rollback_before;
\echo PASS Federal Register circuit fixture: prior nine states, RPCs, ACLs, apply/reapply/rollback, owned probes and independent budgets.
