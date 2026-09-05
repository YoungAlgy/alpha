-- Serialize billing quantity changes per Alpha account. A short expiring lease
-- prevents two tabs from applying opposing Stripe changes concurrently while
-- still recovering automatically if a process is terminated mid-request.
create table public.alpha_quantity_update_leases (
  user_id          uuid primary key,
  lease_token      uuid not null,
  lease_expires_at timestamptz not null,
  updated_at       timestamptz not null default now()
);

create index alpha_quantity_update_leases_expiry_idx
  on public.alpha_quantity_update_leases (lease_expires_at);

alter table public.alpha_quantity_update_leases enable row level security;

create or replace function public.claim_alpha_quantity_update(
  p_user_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid;
begin
  if p_user_id is null
     or p_lease_token is null
     or p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 300 then
    raise exception 'quantity update lease input is invalid';
  end if;

  insert into public.alpha_quantity_update_leases (
    user_id,
    lease_token,
    lease_expires_at,
    updated_at
  ) values (
    p_user_id,
    p_lease_token,
    clock_timestamp() + make_interval(secs => p_lease_seconds),
    clock_timestamp()
  )
  on conflict (user_id) do update set
    lease_token = excluded.lease_token,
    lease_expires_at = excluded.lease_expires_at,
    updated_at = excluded.updated_at
  where public.alpha_quantity_update_leases.lease_expires_at <= clock_timestamp()
  returning lease_token into v_token;

  return v_token is not distinct from p_lease_token;
end;
$$;

create or replace function public.release_alpha_quantity_update(
  p_user_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  if p_user_id is null or p_lease_token is null then
    raise exception 'quantity update lease input is invalid';
  end if;

  delete from public.alpha_quantity_update_leases
   where user_id = p_user_id
     and lease_token = p_lease_token;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

revoke all on table public.alpha_quantity_update_leases
  from public, anon, authenticated;
revoke all on function public.claim_alpha_quantity_update(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_alpha_quantity_update(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_alpha_quantity_update(uuid, uuid, integer)
  to service_role;
grant execute on function public.release_alpha_quantity_update(uuid, uuid)
  to service_role;
