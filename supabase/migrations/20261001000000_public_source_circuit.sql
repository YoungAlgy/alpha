-- Durable provider-outage circuit for the seven fixed public-source clients.
-- It stores no query, URL, account, reader, provider response, or secret.
-- Apply only inside one reviewed transaction, including ACLs and migration
-- ledger recording. Never paste/run individual statements in production.
create table public.alpha_public_source_circuits (
  provider text primary key check (provider in (
    'google-rss',
    'publisher-nist',
    'publisher-fda-medwatch',
    'publisher-fed-speeches',
    'global-voices-rss',
    'crossref-research',
    'gdelt'
  )),
  failure_count integer not null default 0 check (failure_count between 0 and 5),
  generation uuid not null default gen_random_uuid(),
  cooldown_until timestamptz,
  last_failure_at timestamptz,
  probe_token uuid,
  probe_until timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check ((probe_token is null) = (probe_until is null)),
  check (
    (failure_count = 0 and cooldown_until is null and last_failure_at is null and probe_token is null)
    or (failure_count > 0 and cooldown_until is not null and last_failure_at is not null)
  )
);

insert into public.alpha_public_source_circuits (provider)
values
  ('google-rss'),
  ('publisher-nist'),
  ('publisher-fda-medwatch'),
  ('publisher-fed-speeches'),
  ('global-voices-rss'),
  ('crossref-research'),
  ('gdelt');

alter table public.alpha_public_source_circuits enable row level security;

revoke all on table public.alpha_public_source_circuits
  from public, anon, authenticated, service_role;

create or replace function public.begin_alpha_public_source(p_provider text)
returns table (
  admitted boolean,
  generation uuid,
  probe_token uuid,
  retry_after_sec integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.alpha_public_source_circuits%rowtype;
  v_now timestamptz;
  v_token uuid;
begin
  if p_provider is null then
    raise exception 'public source provider is invalid';
  end if;

  select * into v_row
    from public.alpha_public_source_circuits
   where provider = p_provider
   for update;
  if not found then
    raise exception 'public source provider is invalid';
  end if;
  v_now := clock_timestamp();

  if v_row.failure_count = 0 then
    return query select true, v_row.generation, null::uuid, 0;
    return;
  end if;

  if v_row.probe_until is not null and v_row.probe_until > v_now then
    return query select false, v_row.generation, null::uuid,
      greatest(1, ceil(extract(epoch from (v_row.probe_until - v_now)))::integer);
    return;
  end if;

  if v_row.cooldown_until is not null and v_row.cooldown_until > v_now then
    return query select false, v_row.generation, null::uuid,
      greatest(1, ceil(extract(epoch from (v_row.cooldown_until - v_now)))::integer);
    return;
  end if;

  -- A stale failed era becomes healthy only when there is no live probe.
  if v_row.last_failure_at <= v_now - interval '24 hours' then
    v_row.generation := gen_random_uuid();
    update public.alpha_public_source_circuits
       set failure_count = 0,
           generation = v_row.generation,
           cooldown_until = null,
           last_failure_at = null,
           probe_token = null,
           probe_until = null,
           updated_at = v_now
     where provider = p_provider;
    return query select true, v_row.generation, null::uuid, 0;
    return;
  end if;

  v_token := gen_random_uuid();
  update public.alpha_public_source_circuits
     set probe_token = v_token,
         probe_until = v_now + interval '30 seconds',
         updated_at = v_now
   where provider = p_provider;
  return query select true, v_row.generation, v_token, 0;
end;
$$;

create or replace function public.complete_alpha_public_source(
  p_provider text,
  p_generation uuid,
  p_probe_token uuid,
  p_outcome text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.alpha_public_source_circuits%rowtype;
  v_now timestamptz;
  v_count integer;
  v_delay interval;
begin
  if p_provider is null
     or p_generation is null
     or p_outcome is null
     or p_outcome not in ('success', 'failure', 'neutral') then
    raise exception 'public source completion is invalid';
  end if;

  select * into v_row
    from public.alpha_public_source_circuits
   where provider = p_provider
   for update;
  if not found then
    raise exception 'public source provider is invalid';
  end if;
  v_now := clock_timestamp();

  if p_outcome = 'neutral' then
    if p_probe_token is null
       or v_row.generation <> p_generation
       or v_row.probe_token is distinct from p_probe_token
       or v_row.probe_until is null
       or v_row.probe_until <= v_now then
      return false;
    end if;
    update public.alpha_public_source_circuits
       set probe_token = null,
           probe_until = null,
           updated_at = v_now
     where provider = p_provider;
    return true;
  end if;

  if p_outcome = 'success' then
    -- A healthy success never writes: it cannot clear a newer outage.
    if p_probe_token is null
       or v_row.generation <> p_generation
       or v_row.probe_token is distinct from p_probe_token
       or v_row.probe_until is null
       or v_row.probe_until <= v_now then
      return false;
    end if;
    update public.alpha_public_source_circuits
       set failure_count = 0,
           generation = gen_random_uuid(),
           cooldown_until = null,
           last_failure_at = null,
           probe_token = null,
           probe_until = null,
           updated_at = v_now
     where provider = p_provider;
    return true;
  end if;

  -- A healthy request may open the circuit only if no failure/probe state was
  -- present when it began. A half-open failure must own its current lease.
  if v_row.generation <> p_generation then
    return false;
  end if;
  if p_probe_token is null then
    if v_row.failure_count <> 0 or v_row.probe_token is not null then
      return false;
    end if;
  elsif v_row.probe_token is distinct from p_probe_token
     or v_row.probe_until is null
     or v_row.probe_until <= v_now then
    return false;
  end if;

  if v_row.last_failure_at is null or v_row.last_failure_at <= v_now - interval '24 hours' then
    v_count := 1;
  else
    v_count := least(5, v_row.failure_count + 1);
  end if;
  v_delay := case v_count
    when 1 then interval '15 minutes'
    when 2 then interval '30 minutes'
    when 3 then interval '60 minutes'
    when 4 then interval '120 minutes'
    else interval '240 minutes'
  end;

  update public.alpha_public_source_circuits
     set failure_count = v_count,
         generation = gen_random_uuid(),
         cooldown_until = v_now + v_delay,
         last_failure_at = v_now,
         probe_token = null,
         probe_until = null,
         updated_at = v_now
   where provider = p_provider;
  return true;
end;
$$;

revoke all on function public.begin_alpha_public_source(text)
  from public, anon, authenticated;
revoke all on function public.complete_alpha_public_source(text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.begin_alpha_public_source(text) to service_role;
grant execute on function public.complete_alpha_public_source(text, uuid, uuid, text) to service_role;
