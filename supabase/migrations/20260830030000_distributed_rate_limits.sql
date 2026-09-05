-- Global request caps for provider-touching and public mutation routes.
-- The application sends only a domain-separated HMAC of the real identity.
create table public.alpha_rate_limit_buckets (
  scope           text not null check (
    scope ~ '^[a-z0-9][a-z0-9:_-]{0,63}$'
  ),
  key_hash        text not null check (
    key_hash ~ '^[0-9a-f]{64}$'
  ),
  bucket_start    timestamptz not null,
  window_seconds integer not null check (
    window_seconds between 1 and 2592000
  ),
  request_count   integer not null check (
    request_count between 1 and 10001
  ),
  expires_at      timestamptz not null,
  updated_at      timestamptz not null default now(),
  primary key (scope, key_hash, bucket_start, window_seconds)
);

create index alpha_rate_limit_buckets_expiry_idx
  on public.alpha_rate_limit_buckets (expires_at);

alter table public.alpha_rate_limit_buckets enable row level security;

create or replace function public.consume_alpha_rate_limit(
  p_scope text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table (
  allowed boolean,
  remaining integer,
  retry_after_sec integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_bucket_start timestamptz;
  v_bucket_end timestamptz;
  v_count integer;
begin
  if p_scope is null
     or p_scope !~ '^[a-z0-9][a-z0-9:_-]{0,63}$'
     or p_key_hash is null
     or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_limit is null
     or p_limit < 1
     or p_limit > 10000
     or p_window_seconds is null
     or p_window_seconds < 1
     or p_window_seconds > 2592000 then
    raise exception 'rate-limit reservation is invalid';
  end if;

  v_bucket_start := to_timestamp(
    floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds
  );
  v_bucket_end := v_bucket_start + make_interval(secs => p_window_seconds);

  -- Opportunistically prune a bounded global slice. Limiting the delete keeps
  -- one public request from turning cleanup into an unbounded transaction,
  -- while repeated traffic steadily drains expired one-off attacker keys.
  delete from public.alpha_rate_limit_buckets b
   where b.ctid in (
     select expired.ctid
       from public.alpha_rate_limit_buckets expired
      where expired.expires_at <= v_now
      order by expired.expires_at
      limit 500
   );

  insert into public.alpha_rate_limit_buckets (
    scope,
    key_hash,
    bucket_start,
    window_seconds,
    request_count,
    expires_at,
    updated_at
  ) values (
    p_scope,
    p_key_hash,
    v_bucket_start,
    p_window_seconds,
    1,
    v_bucket_end + make_interval(secs => p_window_seconds),
    v_now
  )
  on conflict (scope, key_hash, bucket_start, window_seconds)
  do update set
    request_count = least(
      public.alpha_rate_limit_buckets.request_count + 1,
      p_limit + 1
    ),
    updated_at = v_now
  returning public.alpha_rate_limit_buckets.request_count into v_count;

  return query select
    v_count <= p_limit,
    greatest(0, p_limit - v_count),
    case
      when v_count <= p_limit then 0
      else greatest(
        1,
        ceil(extract(epoch from (v_bucket_end - v_now)))::integer
      )
    end;
end;
$$;

revoke all on table public.alpha_rate_limit_buckets
  from public, anon, authenticated;
revoke all on function public.consume_alpha_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_alpha_rate_limit(text, text, integer, integer)
  to service_role;
