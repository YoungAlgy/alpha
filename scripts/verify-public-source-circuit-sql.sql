-- Run in a disposable local database after the migration. The runner supplies
-- anon, authenticated, and service_role and executes this file as a table owner.
begin;

do $$
declare
  v_count integer;
  v_begin_a record;
  v_begin_b record;
  v_probe record;
  v_generation uuid;
  v_ok boolean;
  v_until timestamptz;
  v_role name;
  v_privilege text;
  v_expected_count integer;
  v_expected_minutes integer;
  v_step integer;
begin
  select count(*) into v_count from public.alpha_public_source_circuits;
  if v_count <> 7 then raise exception 'expected exactly seven fixed circuit rows'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.alpha_public_source_circuits'::regclass)
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'alpha_public_source_circuits') then
    raise exception 'circuit table must have RLS enabled with no policies';
  end if;
  if exists (
    select 1 from public.alpha_public_source_circuits
     where provider not in ('google-rss','publisher-nist','publisher-fda-medwatch',
       'publisher-fed-speeches','global-voices-rss','crossref-research','gdelt')
  ) then raise exception 'unexpected circuit provider'; end if;
  foreach v_role in array array['anon'::name, 'authenticated'::name, 'service_role'::name] loop
    foreach v_privilege in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
      if has_table_privilege(v_role, 'public.alpha_public_source_circuits', v_privilege) then
        raise exception 'circuit table has direct % privilege for %', v_privilege, v_role;
      end if;
    end loop;
  end loop;
  if not has_function_privilege('service_role',
      'public.begin_alpha_public_source(text)', 'execute')
     or not has_function_privilege('service_role',
      'public.complete_alpha_public_source(text,uuid,uuid,text)', 'execute') then
    raise exception 'service role lacks circuit RPC execute';
  end if;
  if has_function_privilege('anon', 'public.begin_alpha_public_source(text)', 'execute')
     or has_function_privilege('authenticated', 'public.begin_alpha_public_source(text)', 'execute')
     or has_function_privilege('anon', 'public.complete_alpha_public_source(text,uuid,uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.complete_alpha_public_source(text,uuid,uuid,text)', 'execute') then
    raise exception 'non-service role has circuit RPC execute';
  end if;
  if pg_get_functiondef('public.begin_alpha_public_source(text)'::regprocedure) ~* '\m(users|subscribers|issues|topic_blurbs)\M'
     or pg_get_functiondef('public.complete_alpha_public_source(text,uuid,uuid,text)'::regprocedure) ~* '\m(users|subscribers|issues|topic_blurbs)\M' then
    raise exception 'circuit function reached unrelated account or cache state';
  end if;

  -- Healthy begins can run concurrently and success cannot clear later state.
  select * into v_begin_a from public.begin_alpha_public_source('google-rss');
  select * into v_begin_b from public.begin_alpha_public_source('google-rss');
  if not v_begin_a.admitted or not v_begin_b.admitted
     or v_begin_a.probe_token is not null or v_begin_b.probe_token is not null
     or v_begin_a.generation <> v_begin_b.generation then
    raise exception 'healthy mode is not concurrent';
  end if;
  select public.complete_alpha_public_source('google-rss', v_begin_a.generation, null, 'success') into v_ok;
  if v_ok then raise exception 'healthy success unexpectedly wrote circuit state'; end if;
  select public.complete_alpha_public_source('google-rss', v_begin_a.generation, null, 'failure') into v_ok;
  if not v_ok then raise exception 'healthy failure was not accepted'; end if;
  select generation, cooldown_until into v_generation, v_until
    from public.alpha_public_source_circuits where provider = 'google-rss';
  if v_generation = v_begin_a.generation or v_until <= clock_timestamp() + interval '14 minutes' then
    raise exception 'first failure did not fence generation or set fifteen-minute cooldown';
  end if;
  select public.complete_alpha_public_source('google-rss', v_begin_b.generation, null, 'failure') into v_ok;
  if v_ok then raise exception 'stale concurrent failure mutated circuit'; end if;
  select * into v_begin_a from public.begin_alpha_public_source('google-rss');
  if v_begin_a.admitted or v_begin_a.retry_after_sec < 1 then
    raise exception 'active cooldown admitted a request';
  end if;

  -- An expired circuit grants one thirty-second probe. Neutral budget failure
  -- releases only that lease, leaving the failed era and generation intact.
  update public.alpha_public_source_circuits
     set cooldown_until = clock_timestamp() - interval '1 second'
   where provider = 'google-rss';
  select generation into v_generation from public.alpha_public_source_circuits where provider = 'google-rss';
  select * into v_probe from public.begin_alpha_public_source('google-rss');
  if not v_probe.admitted or v_probe.probe_token is null or v_probe.generation <> v_generation then
    raise exception 'expired circuit did not issue one owned probe';
  end if;
  select * into v_begin_b from public.begin_alpha_public_source('google-rss');
  if v_begin_b.admitted then raise exception 'second half-open request was admitted'; end if;
  select public.complete_alpha_public_source('google-rss', v_probe.generation, v_probe.probe_token, 'neutral') into v_ok;
  if not v_ok then raise exception 'owned neutral probe release failed'; end if;
  if exists (select 1 from public.alpha_public_source_circuits
      where provider = 'google-rss' and (failure_count <> 1 or generation <> v_generation
        or probe_token is not null or probe_until is not null)) then
    raise exception 'neutral completion changed failure state';
  end if;

  -- A failed recovery probe increases the backoff, while a stale duplicate is inert.
  select * into v_probe from public.begin_alpha_public_source('google-rss');
  select public.complete_alpha_public_source('google-rss', v_probe.generation, v_probe.probe_token, 'failure') into v_ok;
  if not v_ok then raise exception 'owned recovery failure was rejected'; end if;
  if exists (select 1 from public.alpha_public_source_circuits
      where provider = 'google-rss' and (failure_count <> 2
        or cooldown_until <= clock_timestamp() + interval '29 minutes')) then
    raise exception 'second failure did not set thirty-minute backoff';
  end if;
  select public.complete_alpha_public_source('google-rss', v_probe.generation, v_probe.probe_token, 'failure') into v_ok;
  if v_ok then raise exception 'duplicate recovery failure mutated circuit'; end if;

  -- Continue through every bounded backoff step, including the five-count cap.
  for v_step in 1..4 loop
    v_expected_count := (array[3, 4, 5, 5])[v_step];
    v_expected_minutes := (array[60, 120, 240, 240])[v_step];
    update public.alpha_public_source_circuits
       set cooldown_until = clock_timestamp() - interval '1 second'
     where provider = 'google-rss';
    select * into v_probe from public.begin_alpha_public_source('google-rss');
    if not v_probe.admitted or v_probe.probe_token is null then
      raise exception 'backoff step % did not issue a probe', v_expected_count;
    end if;
    select public.complete_alpha_public_source('google-rss', v_probe.generation, v_probe.probe_token, 'failure') into v_ok;
    if not v_ok
       or exists (select 1 from public.alpha_public_source_circuits
          where provider = 'google-rss' and (failure_count <> v_expected_count
            or cooldown_until <= clock_timestamp() + make_interval(mins => v_expected_minutes - 1))) then
      raise exception 'backoff step % did not hold for % minutes', v_expected_count, v_expected_minutes;
    end if;
  end loop;

  -- A matching successful probe alone resets the circuit and changes generation.
  update public.alpha_public_source_circuits
     set cooldown_until = clock_timestamp() - interval '1 second'
   where provider = 'google-rss';
  select * into v_probe from public.begin_alpha_public_source('google-rss');
  select public.complete_alpha_public_source('google-rss', v_probe.generation, v_probe.probe_token, 'success') into v_ok;
  if not v_ok then raise exception 'owned recovery success was rejected'; end if;
  if exists (select 1 from public.alpha_public_source_circuits
      where provider = 'google-rss' and (failure_count <> 0 or cooldown_until is not null
        or last_failure_at is not null or probe_token is not null or generation = v_probe.generation)) then
    raise exception 'successful probe did not reset and fence circuit';
  end if;
  select public.complete_alpha_public_source('google-rss', v_probe.generation, v_probe.probe_token, 'failure') into v_ok;
  if v_ok then raise exception 'old probe failure reopened a successfully reset circuit'; end if;

  -- Failure history decays only after 24 hours and only with no live probe.
  update public.alpha_public_source_circuits
     set failure_count = 5,
         cooldown_until = clock_timestamp() - interval '1 second',
         last_failure_at = clock_timestamp() - interval '24 hours 1 second',
         probe_token = null,
         probe_until = null
   where provider = 'gdelt';
  select generation into v_generation from public.alpha_public_source_circuits where provider = 'gdelt';
  select * into v_begin_a from public.begin_alpha_public_source('gdelt');
  if not v_begin_a.admitted or v_begin_a.probe_token is not null
     or v_begin_a.generation = v_generation
     or exists (select 1 from public.alpha_public_source_circuits where provider = 'gdelt' and failure_count <> 0) then
    raise exception 'old failure era did not decay to healthy state';
  end if;

  update public.alpha_public_source_circuits
     set failure_count = 5,
         cooldown_until = clock_timestamp() - interval '1 second',
         last_failure_at = clock_timestamp() - interval '24 hours 1 second',
         probe_token = gen_random_uuid(),
         probe_until = clock_timestamp() + interval '30 seconds'
   where provider = 'crossref-research';
  select * into v_begin_a from public.begin_alpha_public_source('crossref-research');
  if v_begin_a.admitted
     or exists (select 1 from public.alpha_public_source_circuits
        where provider = 'crossref-research' and failure_count <> 5) then
    raise exception 'live probe incorrectly decayed an old failure era';
  end if;

  -- A completion after lease expiry is inert. A stale neutral completion cannot
  -- release the next owner after a new half-open probe is issued.
  update public.alpha_public_source_circuits
     set failure_count = 1,
         cooldown_until = clock_timestamp() - interval '1 second',
         last_failure_at = clock_timestamp(),
         probe_token = null,
         probe_until = null
   where provider = 'publisher-nist';
  select * into v_probe from public.begin_alpha_public_source('publisher-nist');
  update public.alpha_public_source_circuits
     set probe_until = clock_timestamp() - interval '1 second'
   where provider = 'publisher-nist';
  select public.complete_alpha_public_source('publisher-nist', v_probe.generation, v_probe.probe_token, 'failure') into v_ok;
  if v_ok then raise exception 'expired probe completion mutated circuit'; end if;
  select * into v_begin_a from public.begin_alpha_public_source('publisher-nist');
  if not v_begin_a.admitted or v_begin_a.probe_token is null or v_begin_a.probe_token = v_probe.probe_token then
    raise exception 'expired probe did not yield a new owner';
  end if;
  select public.complete_alpha_public_source('publisher-nist', v_probe.generation, v_probe.probe_token, 'neutral') into v_ok;
  if v_ok
     or not exists (select 1 from public.alpha_public_source_circuits
       where provider = 'publisher-nist' and probe_token = v_begin_a.probe_token) then
    raise exception 'stale neutral completion cleared a newer probe';
  end if;

  begin
    perform public.complete_alpha_public_source('google-rss', gen_random_uuid(), null, null);
    raise exception using errcode = 'P0002', message = 'NULL outcome was accepted';
  exception when SQLSTATE 'P0001' then null;
  end;
  begin
    perform public.begin_alpha_public_source('not-a-provider');
    raise exception using errcode = 'P0002', message = 'invalid provider was accepted';
  exception when SQLSTATE 'P0001' then null;
  end;
end;
$$;

-- Actual invoker checks supplement metadata ACL checks. Each forbidden action
-- must fail under the role itself, not merely appear absent in catalog ACLs.
do $$
declare v_role name;
begin
  foreach v_role in array array['anon'::name, 'authenticated'::name] loop
    execute format('set local role %I', v_role);
    begin
      perform 1 from public.alpha_public_source_circuits;
      raise exception using errcode = 'P0002', message = 'direct circuit select was accepted';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.begin_alpha_public_source('google-rss');
      raise exception using errcode = 'P0002', message = 'circuit execute was accepted';
    exception when insufficient_privilege then null;
    end;
    execute 'reset role';
  end loop;
end;
$$;

-- Check role execution separately from table-owner assertions above.
set local role service_role;
select admitted, generation is not null as has_generation, probe_token is null as healthy_has_no_probe
  from public.begin_alpha_public_source('publisher-nist');
reset role;

rollback;
