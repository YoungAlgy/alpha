-- Run only in a disposable local PostgreSQL fixture after applying the PLOS
-- circuit migration. The runner executes this file as the table owner and
-- supplies anon, authenticated and service_role. Every fixture is rolled back.
begin;

do $$
declare
  v_count integer;
  v_role name;
  v_privilege text;
  v_old_state jsonb;
  v_old_state_after jsonb;
  v_begin_a record;
  v_begin_b record;
  v_probe record;
  v_ok boolean;
  v_generation uuid;
begin
  select count(*) into v_count from public.alpha_public_source_circuits;
  if v_count <> 8 then
    raise exception 'expected exactly eight fixed circuit rows after PLOS migration';
  end if;
  if (select count(*) from public.alpha_public_source_circuits where provider = 'plos-research') <> 1 then
    raise exception 'expected exactly one PLOS circuit row';
  end if;
  if exists (
    select 1 from public.alpha_public_source_circuits
     where provider not in (
       'google-rss', 'publisher-nist', 'publisher-fda-medwatch',
       'publisher-fed-speeches', 'global-voices-rss', 'crossref-research',
       'gdelt', 'plos-research'
     )
  ) then
    raise exception 'unexpected circuit provider after PLOS migration';
  end if;
  if exists (
    select 1 from public.alpha_public_source_circuits
     where provider = 'plos-research'
       and (failure_count <> 0 or cooldown_until is not null
         or last_failure_at is not null or probe_token is not null
         or probe_until is not null or generation is null or updated_at is null)
  ) then
    raise exception 'PLOS circuit did not begin in healthy default state';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.alpha_public_source_circuits'::regclass)
     or exists (
       select 1 from pg_policies
        where schemaname = 'public' and tablename = 'alpha_public_source_circuits'
     ) then
    raise exception 'circuit table must retain RLS with no policies';
  end if;
  if (select array_agg(a.attname order by a.attnum)
        from pg_attribute a
       where a.attrelid = 'public.alpha_public_source_circuits'::regclass
         and a.attnum > 0 and not a.attisdropped)
     is distinct from array[
       'provider', 'failure_count', 'generation', 'cooldown_until',
       'last_failure_at', 'probe_token', 'probe_until', 'updated_at'
     ]::name[] then
    raise exception 'circuit table gained query, reader, URL or other state';
  end if;
  foreach v_role in array array['anon'::name, 'authenticated'::name, 'service_role'::name] loop
    foreach v_privilege in array array[
      'select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'
    ] loop
      if has_table_privilege(v_role, 'public.alpha_public_source_circuits', v_privilege) then
        raise exception 'circuit table has direct % privilege for %', v_privilege, v_role;
      end if;
    end loop;
  end loop;
  if not has_function_privilege(
       'service_role', 'public.begin_alpha_public_source(text)', 'execute')
     or not has_function_privilege(
       'service_role', 'public.complete_alpha_public_source(text,uuid,uuid,text)', 'execute') then
    raise exception 'service role lacks circuit RPC execute';
  end if;
  if has_function_privilege('anon', 'public.begin_alpha_public_source(text)', 'execute')
     or has_function_privilege('authenticated', 'public.begin_alpha_public_source(text)', 'execute')
     or has_function_privilege('anon',
       'public.complete_alpha_public_source(text,uuid,uuid,text)', 'execute')
     or has_function_privilege('authenticated',
       'public.complete_alpha_public_source(text,uuid,uuid,text)', 'execute') then
    raise exception 'non-service role has circuit RPC execute';
  end if;

  -- Snapshot every column of all seven pre-existing rows. PLOS operations below
  -- must be isolated from that state, including generations, leases and clocks.
  select coalesce(jsonb_agg(to_jsonb(c) order by c.provider), '[]'::jsonb)
    into v_old_state
    from public.alpha_public_source_circuits c
   where c.provider <> 'plos-research';
  if jsonb_array_length(v_old_state) <> 7 then
    raise exception 'old circuit snapshot did not contain all seven providers';
  end if;

  -- Healthy calls share a generation and carry no lease. A healthy success is
  -- deliberately inert, while one concurrent failure fences the other caller.
  select * into v_begin_a from public.begin_alpha_public_source('plos-research');
  select * into v_begin_b from public.begin_alpha_public_source('plos-research');
  if not v_begin_a.admitted or not v_begin_b.admitted
     or v_begin_a.probe_token is not null or v_begin_b.probe_token is not null
     or v_begin_a.generation <> v_begin_b.generation then
    raise exception 'healthy PLOS calls are not concurrent';
  end if;
  select public.complete_alpha_public_source(
    'plos-research', v_begin_a.generation, null, 'success') into v_ok;
  if v_ok then
    raise exception 'healthy PLOS success unexpectedly wrote circuit state';
  end if;
  select public.complete_alpha_public_source(
    'plos-research', v_begin_a.generation, null, 'failure') into v_ok;
  if not v_ok then
    raise exception 'first healthy PLOS failure was rejected';
  end if;
  select generation into v_generation
    from public.alpha_public_source_circuits where provider = 'plos-research';
  if v_generation = v_begin_a.generation then
    raise exception 'PLOS failure did not fence its healthy generation';
  end if;
  select public.complete_alpha_public_source(
    'plos-research', v_begin_b.generation, null, 'failure') into v_ok;
  if v_ok then
    raise exception 'stale concurrent PLOS failure mutated the circuit';
  end if;
  select * into v_begin_a from public.begin_alpha_public_source('plos-research');
  if v_begin_a.admitted or v_begin_a.retry_after_sec < 1 then
    raise exception 'active PLOS cooldown admitted another call';
  end if;

  -- Once the cooldown expires, exactly one caller owns the recovery lease.
  update public.alpha_public_source_circuits
     set cooldown_until = clock_timestamp() - interval '1 second'
   where provider = 'plos-research';
  select * into v_probe from public.begin_alpha_public_source('plos-research');
  if not v_probe.admitted or v_probe.probe_token is null then
    raise exception 'expired PLOS cooldown did not issue a recovery lease';
  end if;
  select * into v_begin_b from public.begin_alpha_public_source('plos-research');
  if v_begin_b.admitted or v_begin_b.retry_after_sec < 1 then
    raise exception 'concurrent PLOS recovery caller bypassed the active lease';
  end if;
  select public.complete_alpha_public_source(
    'plos-research', v_probe.generation, v_probe.probe_token, 'success') into v_ok;
  if not v_ok then
    raise exception 'owned PLOS recovery success was rejected';
  end if;
  if exists (
    select 1 from public.alpha_public_source_circuits
     where provider = 'plos-research'
       and (failure_count <> 0 or cooldown_until is not null
         or last_failure_at is not null or probe_token is not null
         or probe_until is not null or generation = v_probe.generation)
  ) then
    raise exception 'PLOS recovery success did not reset and fence the circuit';
  end if;
  select public.complete_alpha_public_source(
    'plos-research', v_probe.generation, v_probe.probe_token, 'failure') into v_ok;
  if v_ok then
    raise exception 'completed PLOS recovery lease accepted a late failure';
  end if;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.provider), '[]'::jsonb)
    into v_old_state_after
    from public.alpha_public_source_circuits c
   where c.provider <> 'plos-research';
  if v_old_state_after is distinct from v_old_state then
    raise exception 'PLOS operations changed pre-existing circuit state';
  end if;
end;
$$;

-- Actual invoker checks supplement catalog ACL checks.
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
      perform public.begin_alpha_public_source('plos-research');
      raise exception using errcode = 'P0002', message = 'circuit execute was accepted';
    exception when insufficient_privilege then null;
    end;
    execute 'reset role';
  end loop;
end;
$$;

set local role service_role;
select admitted, generation is not null as has_generation,
       probe_token is null as healthy_has_no_probe
  from public.begin_alpha_public_source('plos-research');
reset role;

do $$
declare
  v_test_hash constant text :=
    '7d5b4f531f004b50a1f17fd1134f67110ad52a710bc98bc0e107f2f1c2658f6b';
  v_other_before jsonb;
  v_other_after jsonb;
  v_first record;
  v_second record;
  v_third record;
  v_publisher record;
begin
  -- Fixed local HMAC-shaped fixture. The two PLOS reservations represent two
  -- processes sharing one provider identity and fixed fifteen-minute bucket.
  if exists (
    select 1 from public.alpha_rate_limit_buckets
     where key_hash = v_test_hash
       and scope in ('public_source:plos_research', 'public_source:publisher_rss')
  ) then
    raise exception 'fixed rate-limit fixture hash is already present';
  end if;
  select coalesce(jsonb_agg(to_jsonb(b) order by b.scope, b.key_hash,
      b.bucket_start, b.window_seconds), '[]'::jsonb)
    into v_other_before
    from public.alpha_rate_limit_buckets b;

  select * into v_first from public.consume_alpha_rate_limit(
    'public_source:plos_research', v_test_hash, 2, 900);
  select * into v_second from public.consume_alpha_rate_limit(
    'public_source:plos_research', v_test_hash, 2, 900);
  select * into v_third from public.consume_alpha_rate_limit(
    'public_source:plos_research', v_test_hash, 2, 900);
  if not v_first.allowed or v_first.remaining <> 1 or v_first.retry_after_sec <> 0
     or not v_second.allowed or v_second.remaining <> 0 or v_second.retry_after_sec <> 0
     or v_third.allowed or v_third.remaining <> 0 or v_third.retry_after_sec < 1 then
    raise exception 'PLOS shared rate ceiling did not admit two and block the third';
  end if;

  -- The PLOS scope must not consume the pre-existing publisher ceiling.
  select * into v_publisher from public.consume_alpha_rate_limit(
    'public_source:publisher_rss', v_test_hash, 12, 900);
  if not v_publisher.allowed or v_publisher.remaining <> 11
     or v_publisher.retry_after_sec <> 0 then
    raise exception 'PLOS reservations changed the independent publisher ceiling';
  end if;
  if (select request_count from public.alpha_rate_limit_buckets
       where scope = 'public_source:plos_research' and key_hash = v_test_hash
         and window_seconds = 900) <> 3
     or (select request_count from public.alpha_rate_limit_buckets
       where scope = 'public_source:publisher_rss' and key_hash = v_test_hash
         and window_seconds = 900) <> 1 then
    raise exception 'rate-limit fixture counts do not match the expected scopes';
  end if;

  select coalesce(jsonb_agg(to_jsonb(b) order by b.scope, b.key_hash,
      b.bucket_start, b.window_seconds), '[]'::jsonb)
    into v_other_after
    from public.alpha_rate_limit_buckets b
   where not (b.key_hash = v_test_hash
     and b.scope in ('public_source:plos_research', 'public_source:publisher_rss'));
  if v_other_after is distinct from v_other_before then
    raise exception 'rate-limit fixture changed unrelated bucket data';
  end if;
end;
$$;

rollback;
