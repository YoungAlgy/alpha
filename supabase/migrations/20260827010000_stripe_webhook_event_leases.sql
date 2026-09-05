-- Alpha Round 80: distinguish a webhook event that is still processing from
-- one that completed. The old presence-only marker returned HTTP 200 to a
-- concurrent duplicate even when the first request later failed.

alter table public.stripe_webhook_events
  add column if not exists status text not null default 'succeeded'
    check (status in ('processing', 'succeeded')),
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.claim_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_lease_token uuid,
  p_lease_seconds integer default 120
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.stripe_webhook_events%rowtype;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease seconds out of range';
  end if;

  insert into public.stripe_webhook_events (
    id,
    type,
    status,
    lease_token,
    lease_expires_at,
    updated_at
  ) values (
    p_event_id,
    p_event_type,
    'processing',
    p_lease_token,
    now() + make_interval(secs => p_lease_seconds),
    now()
  )
  on conflict (id) do nothing;

  select *
    into v_row
    from public.stripe_webhook_events
   where id = p_event_id
   for update;

  if v_row.status = 'succeeded' then
    return 'succeeded';
  end if;

  if v_row.lease_token is distinct from p_lease_token
     and v_row.lease_expires_at is not null
     and v_row.lease_expires_at > now() then
    return 'in_progress';
  end if;

  update public.stripe_webhook_events
     set type = p_event_type,
         status = 'processing',
         lease_token = p_lease_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where id = p_event_id;

  return 'claimed';
end;
$$;

revoke all on function public.claim_stripe_webhook_event(text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_stripe_webhook_event(text, text, uuid, integer)
  to service_role;
