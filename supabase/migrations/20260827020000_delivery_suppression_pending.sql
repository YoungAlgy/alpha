-- Alpha Round 80: paid access must not depend on Resend availability.
--
-- checkout.session.completed provisions the subscriber first. If provider-side
-- suppression cleanup is unavailable, this timestamp keeps the address out of
-- the send loop while Stripe retries the webhook. Access and billing state stay
-- live, and local bounce/complaint evidence is preserved until cleanup succeeds.

alter table public.users
  add column if not exists suppression_cleanup_pending_at timestamptz,
  add column if not exists suppression_cleanup_next_attempt_at timestamptz,
  add column if not exists stripe_email_sync_pending_at timestamptz,
  add column if not exists stripe_email_sync_next_attempt_at timestamptz,
  add column if not exists stripe_email_sync_lease_token uuid,
  add column if not exists stripe_email_sync_lease_expires_at timestamptz,
  add column if not exists stripe_subscription_id text;

alter table public.users
  add constraint users_stripe_email_sync_lease_pair check (
    (
      stripe_email_sync_lease_token is null
      and stripe_email_sync_lease_expires_at is null
    )
    or (
      stripe_email_sync_lease_token is not null
      and stripe_email_sync_lease_expires_at is not null
      and stripe_email_sync_pending_at is not null
    )
  );

alter table public.users
  add constraint users_delivery_retry_deadlines_require_pending check (
    (suppression_cleanup_pending_at is not null or suppression_cleanup_next_attempt_at is null)
    and (stripe_email_sync_pending_at is not null or stripe_email_sync_next_attempt_at is null)
  );

-- Provider identifiers are opaque, but their stable Stripe prefixes and
-- no-whitespace shape are safe database invariants. A Subscription binding is
-- meaningful only with its exact Customer owner.
alter table public.users
  add constraint users_stripe_customer_id_format_check check (
    stripe_customer_id is null
    or stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'
  ),
  add constraint users_stripe_subscription_id_format_check check (
    stripe_subscription_id is null
    or stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'
  ),
  add constraint users_stripe_subscription_requires_customer_check check (
    stripe_subscription_id is null or stripe_customer_id is not null
  );

create index if not exists users_stripe_email_sync_pending_idx
  on public.users (stripe_email_sync_next_attempt_at, stripe_email_sync_pending_at)
  where stripe_email_sync_pending_at is not null;

create index if not exists users_suppression_cleanup_pending_idx
  on public.users (suppression_cleanup_next_attempt_at, suppression_cleanup_pending_at)
  where suppression_cleanup_pending_at is not null;

-- A public.users row represents at most one exact Alpha subscription. The
-- customer id alone is not enough in a shared Stripe account because the same
-- Customer can own subscriptions for another product.
create unique index if not exists users_stripe_subscription_id_unique_idx
  on public.users (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- This is service-owned delivery state. Keep it protected alongside the other
-- billing and suppression columns from direct authenticated writes.
create or replace function public.protect_user_privileged_columns()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if (coalesce(current_setting('request.jwt.claims', true), '{}')::json->>'role') = 'service_role' then
    return new;
  end if;
  new.id := old.id;
  new.email := old.email;
  new.stripe_customer_id := old.stripe_customer_id;
  new.stripe_subscription_id := old.stripe_subscription_id;
  new.subscribed_at := old.subscribed_at;
  new.cancelled_at := old.cancelled_at;
  new.unsubscribed_at := old.unsubscribed_at;
  new.topic_quota := old.topic_quota;
  new.created_at := old.created_at;
  new.bounced_at := old.bounced_at;
  new.complained_at := old.complained_at;
  new.suppression_cleanup_pending_at := old.suppression_cleanup_pending_at;
  new.suppression_cleanup_next_attempt_at := old.suppression_cleanup_next_attempt_at;
  new.stripe_email_sync_pending_at := old.stripe_email_sync_pending_at;
  new.stripe_email_sync_next_attempt_at := old.stripe_email_sync_next_attempt_at;
  new.stripe_email_sync_lease_token := old.stripe_email_sync_lease_token;
  new.stripe_email_sync_lease_expires_at := old.stripe_email_sync_lease_expires_at;
  return new;
end;
$$;

-- A new cleanup obligation must be immediately eligible. A backoff belongs
-- only to the exact unchanged marker that failed, and clears with that marker.
create or replace function public.normalize_delivery_retry_deadlines()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if new.suppression_cleanup_pending_at is distinct from old.suppression_cleanup_pending_at then
    new.suppression_cleanup_next_attempt_at := null;
  end if;
  if new.stripe_email_sync_pending_at is distinct from old.stripe_email_sync_pending_at then
    new.stripe_email_sync_next_attempt_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists users_normalize_delivery_retry_deadlines on public.users;
create trigger users_normalize_delivery_retry_deadlines
before update on public.users
for each row execute function public.normalize_delivery_retry_deadlines();

revoke all on function public.protect_user_privileged_columns()
  from public, anon, authenticated;
revoke all on function public.normalize_delivery_retry_deadlines()
  from public, anon, authenticated;

-- Claim an exact pending Stripe-email mutation under the same owner lock used
-- by account deletion. The ten-minute lease exceeds this route's five-minute
-- runtime ceiling, so an expired lease cannot belong to a process that can
-- still resume a provider call. Deletion blocks while any live lease exists.
create or replace function public.claim_stripe_email_sync(
  p_user_id uuid,
  p_lease_token uuid
)
returns table (
  decision text,
  canonical_email text,
  customer_id text,
  pending_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
begin
  if p_user_id is null or p_lease_token is null then
    return query select 'invalid'::text,
      null::text, null::text, null::timestamptz;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_user_id
  ) then
    return query select 'deletion_pending'::text,
      null::text, null::text, null::timestamptz;
    return;
  end if;
  select *
    into v_user
    from public.users u
   where u.id = p_user_id
   for update;
  if not found then
    return query select 'missing'::text,
      null::text, null::text, null::timestamptz;
    return;
  end if;
  if v_user.stripe_email_sync_pending_at is null then
    return query select 'not_pending'::text,
      null::text, null::text, null::timestamptz;
    return;
  end if;
  if v_user.stripe_email_sync_next_attempt_at is not null
     and v_user.stripe_email_sync_next_attempt_at > now() then
    return query select 'not_due'::text,
      null::text, null::text, null::timestamptz;
    return;
  end if;
  if v_user.stripe_email_sync_lease_token is distinct from p_lease_token
     and v_user.stripe_email_sync_lease_expires_at is not null
     and v_user.stripe_email_sync_lease_expires_at > now() then
    return query select 'in_progress'::text,
      null::text, null::text, null::timestamptz;
    return;
  end if;
  update public.users u
     set stripe_email_sync_lease_token = p_lease_token,
         stripe_email_sync_lease_expires_at = now() + interval '10 minutes',
         updated_at = now()
   where u.id = p_user_id
     and u.stripe_email_sync_pending_at = v_user.stripe_email_sync_pending_at;
  if not found then
    return query select 'changed'::text,
      null::text, null::text, null::timestamptz;
    return;
  end if;
  return query select 'claimed'::text,
    v_user.email,
    v_user.stripe_customer_id,
    v_user.stripe_email_sync_pending_at;
end;
$$;

-- Recheck the exact lease and deletion guard immediately before the provider
-- mutation. prepare_account_deletion refuses to begin while this durable
-- lease remains live.
create or replace function public.authorize_stripe_email_sync(
  p_user_id uuid,
  p_lease_token uuid,
  p_customer_id text,
  p_pending_at timestamptz,
  p_canonical_email text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null
     or p_lease_token is null
     or coalesce(p_customer_id, '') = ''
     or p_pending_at is null
     or coalesce(p_canonical_email, '') = '' then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_user_id
  ) then
    return false;
  end if;
  return exists (
    select 1
      from public.users u
     where u.id = p_user_id
       and u.email = p_canonical_email
       and u.stripe_customer_id = p_customer_id
       and u.stripe_email_sync_pending_at = p_pending_at
       and u.stripe_email_sync_lease_token = p_lease_token
       and u.stripe_email_sync_lease_expires_at > now()
  );
end;
$$;

create or replace function public.complete_stripe_email_sync(
  p_user_id uuid,
  p_lease_token uuid,
  p_customer_id text,
  p_pending_at timestamptz,
  p_canonical_email text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  update public.users u
     set stripe_email_sync_pending_at = null,
         stripe_email_sync_next_attempt_at = null,
         stripe_email_sync_lease_token = null,
         stripe_email_sync_lease_expires_at = null,
         updated_at = now()
   where u.id = p_user_id
     and u.email = p_canonical_email
     and u.stripe_customer_id = p_customer_id
     and u.stripe_email_sync_pending_at = p_pending_at
     and u.stripe_email_sync_lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.release_stripe_email_sync(
  p_user_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  update public.users u
     set stripe_email_sync_lease_token = null,
         stripe_email_sync_lease_expires_at = null,
         stripe_email_sync_next_attempt_at = now() + interval '5 minutes',
         updated_at = now()
   where u.id = p_user_id
     and u.stripe_email_sync_lease_token = p_lease_token;
  return found;
end;
$$;

revoke all on function public.claim_stripe_email_sync(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.authorize_stripe_email_sync(uuid, uuid, text, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.complete_stripe_email_sync(uuid, uuid, text, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.release_stripe_email_sync(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_stripe_email_sync(uuid, uuid)
  to service_role;
grant execute on function public.authorize_stripe_email_sync(uuid, uuid, text, timestamptz, text)
  to service_role;
grant execute on function public.complete_stripe_email_sync(uuid, uuid, text, timestamptz, text)
  to service_role;
grant execute on function public.release_stripe_email_sync(uuid, uuid)
  to service_role;

-- The scheduled delivery precheck asks only whether maintenance is due. It
-- returns no profile, billing, or account identifiers and fails safe when the
-- caller supplies no clock.
create or replace function public.alpha_scheduled_maintenance_due(
  p_now timestamptz
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select case
    when p_now is null then true
    else
      exists (
        select 1
          from public.checkout_profiles p
         where (
           p.billing_state in ('creating', 'deleting')
           and p.stripe_session_id is null
           and p.session_creation_lease_expires_at <= p_now
         ) or (
           p.billing_state = 'recovering'
           and p.recovery_lease_expires_at <= p_now
         ) or (
           p.billing_state in ('open', 'paid')
           and p.provisioned_user_id is null
           and p.expires_at <= p_now
           and (
             p.recovery_lease_expires_at is null
             or p.recovery_lease_expires_at <= p_now
           )
         ) or (
           p.billing_state in ('ended', 'expired')
           and p.identity_scrubbed_at is null
           and p.updated_at <= p_now - interval '180 days'
         )
      )
      or exists (
        select 1
          from public.checkout_fulfillments f
         where f.status = 'completed'
           and f.identity_scrubbed_at is null
           and f.completed_at <= p_now - interval '180 days'
      )
      or exists (
        select 1
          from public.account_deletion_sagas s
         where (
           s.state <> 'complete'
           and s.updated_at <= p_now - interval '15 minutes'
           and s.reconcile_next_attempt_at <= p_now
         ) or (
           s.state = 'complete'
           and s.purge_after <= p_now
         )
      )
      or exists (
        select 1
          from public.refund_reviews r
         where r.status in ('pending', 'reviewed')
      )
      or exists (
        select 1
          from public.refund_reviews r
         where r.status in ('refunded', 'not_required')
           and r.resolved_at <= p_now - interval '180 days'
      )
      or exists (
        select 1
          from public.checkout_creation_reviews r
         where r.status = 'pending'
      )
      or exists (
        select 1
          from public.users u
         where (
             u.suppression_cleanup_pending_at is not null
             and (
               u.suppression_cleanup_next_attempt_at is null
               or u.suppression_cleanup_next_attempt_at <= p_now
             )
           ) or (
             u.stripe_email_sync_pending_at is not null
             and (
               u.stripe_email_sync_next_attempt_at is null
               or u.stripe_email_sync_next_attempt_at <= p_now
             )
           )
      )
  end;
$$;

revoke all on function public.alpha_scheduled_maintenance_due(timestamptz)
  from public, anon, authenticated;
grant execute on function public.alpha_scheduled_maintenance_due(timestamptz)
  to service_role;
