-- Alpha Round 80: durable, exact-subscription renewal cancellation.
--
-- Stripe and Postgres cannot share a transaction. Record the exact Customer
-- and Subscription before setting cancel_at_period_end so a process crash
-- after Stripe succeeds cannot lose the local cancelled_at sync obligation.

alter table public.users
  add column renewal_cancel_pending_at timestamptz,
  add column renewal_cancel_customer_id text,
  add column renewal_cancel_subscription_id text,
  add column renewal_cancel_next_attempt_at timestamptz,
  add column renewal_cancel_lease_token uuid,
  add column renewal_cancel_lease_expires_at timestamptz,
  add column renewal_cancel_attempt_count smallint not null default 0,
  add column renewal_cancel_last_error_code text,
  add column renewal_cancel_escalated_at timestamptz,
  add constraint users_renewal_cancel_attempt_count_check check (
    renewal_cancel_attempt_count between 0 and 8
  ),
  add constraint users_renewal_cancel_last_error_code_check check (
    renewal_cancel_last_error_code is null
    or renewal_cancel_last_error_code in (
      'provider_unavailable',
      'provider_rate_limited',
      'provider_state_unsafe',
      'settlement_failed',
      'binding_changed',
      'unexpected'
    )
  ),
  add constraint users_renewal_cancel_marker_shape_check check (
    (
      renewal_cancel_pending_at is null
      and renewal_cancel_customer_id is null
      and renewal_cancel_subscription_id is null
      and renewal_cancel_next_attempt_at is null
      and renewal_cancel_lease_token is null
      and renewal_cancel_lease_expires_at is null
      and renewal_cancel_attempt_count = 0
      and renewal_cancel_last_error_code is null
      and renewal_cancel_escalated_at is null
    )
    or (
      renewal_cancel_pending_at is not null
      and renewal_cancel_customer_id is not null
      and renewal_cancel_subscription_id is not null
      and renewal_cancel_next_attempt_at is not null
      and (
        (
          renewal_cancel_lease_token is null
          and renewal_cancel_lease_expires_at is null
        )
        or (
          renewal_cancel_lease_token is not null
          and renewal_cancel_lease_expires_at is not null
        )
      )
      and (
        (
          renewal_cancel_attempt_count = 0
          and renewal_cancel_last_error_code is null
          and renewal_cancel_escalated_at is null
        )
        or (
          renewal_cancel_attempt_count between 1 and 7
          and renewal_cancel_last_error_code is not null
          and renewal_cancel_escalated_at is null
        )
        or (
          renewal_cancel_attempt_count = 8
          and renewal_cancel_last_error_code is not null
          and renewal_cancel_escalated_at is not null
        )
      )
    )
  );

create index users_renewal_cancel_pending_idx
  on public.users (renewal_cancel_next_attempt_at, renewal_cancel_pending_at)
  where renewal_cancel_pending_at is not null;

create index users_renewal_cancel_escalated_idx
  on public.users (renewal_cancel_escalated_at, renewal_cancel_pending_at)
  where renewal_cancel_escalated_at is not null;

-- These fields control a real Stripe mutation and must stay service-owned.
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
  new.renewal_cancel_pending_at := old.renewal_cancel_pending_at;
  new.renewal_cancel_customer_id := old.renewal_cancel_customer_id;
  new.renewal_cancel_subscription_id := old.renewal_cancel_subscription_id;
  new.renewal_cancel_next_attempt_at := old.renewal_cancel_next_attempt_at;
  new.renewal_cancel_lease_token := old.renewal_cancel_lease_token;
  new.renewal_cancel_lease_expires_at := old.renewal_cancel_lease_expires_at;
  new.renewal_cancel_attempt_count := old.renewal_cancel_attempt_count;
  new.renewal_cancel_last_error_code := old.renewal_cancel_last_error_code;
  new.renewal_cancel_escalated_at := old.renewal_cancel_escalated_at;
  return new;
end;
$$;

create or replace function public.claim_alpha_renewal_cancellation(
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_lease_token uuid,
  p_lease_seconds integer
)
returns table(decision text, pending_at timestamptz, cancelled_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
  v_now timestamptz := now();
begin
  if p_user_id is null
     or p_lease_token is null
     or p_customer_id is null
     or btrim(p_customer_id) = ''
     or p_subscription_id is null
     or btrim(p_subscription_id) = '' then
    raise exception 'exact renewal cancellation identity is required';
  end if;
  if p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 600 then
    raise exception 'renewal cancellation lease must be 30 through 600 seconds';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  perform pg_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
      80425081
    )
  );

  select *
    into v_user
    from public.users u
   where u.id = p_user_id
   for update;
  if not found then
    return query select 'missing_user'::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_user_id
  ) then
    return query select 'deletion_pending'::text, v_user.renewal_cancel_pending_at, v_user.cancelled_at;
    return;
  end if;
  if v_user.stripe_customer_id is distinct from p_customer_id
     or v_user.stripe_subscription_id is distinct from p_subscription_id then
    return query select 'binding_changed'::text, v_user.renewal_cancel_pending_at, v_user.cancelled_at;
    return;
  end if;
  if v_user.renewal_cancel_pending_at is not null then
    if v_user.renewal_cancel_customer_id is distinct from p_customer_id
       or v_user.renewal_cancel_subscription_id is distinct from p_subscription_id then
      return query select 'pending_binding_changed'::text, v_user.renewal_cancel_pending_at, v_user.cancelled_at;
      return;
    end if;
    if v_user.renewal_cancel_lease_token is not null
       and v_user.renewal_cancel_lease_expires_at > v_now
       and v_user.renewal_cancel_lease_token <> p_lease_token then
      return query select 'in_progress'::text, v_user.renewal_cancel_pending_at, v_user.cancelled_at;
      return;
    end if;
    if v_user.renewal_cancel_lease_token = p_lease_token
       and v_user.renewal_cancel_lease_expires_at > v_now then
      return query select 'claimed'::text, v_user.renewal_cancel_pending_at, v_user.cancelled_at;
      return;
    end if;
    if v_user.renewal_cancel_next_attempt_at > v_now then
      return query select 'not_due'::text, v_user.renewal_cancel_pending_at, v_user.cancelled_at;
      return;
    end if;
  end if;

  update public.users u
     set renewal_cancel_pending_at = coalesce(u.renewal_cancel_pending_at, v_now),
         renewal_cancel_customer_id = p_customer_id,
         renewal_cancel_subscription_id = p_subscription_id,
         renewal_cancel_next_attempt_at =
           v_now + make_interval(secs => p_lease_seconds),
         renewal_cancel_lease_token = p_lease_token,
         renewal_cancel_lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
         renewal_cancel_attempt_count =
           case when u.renewal_cancel_pending_at is null
             then 0
             else u.renewal_cancel_attempt_count
           end,
         renewal_cancel_last_error_code =
           case when u.renewal_cancel_pending_at is null
             then null
             else u.renewal_cancel_last_error_code
           end,
         renewal_cancel_escalated_at =
           case when u.renewal_cancel_pending_at is null
             then null
             else u.renewal_cancel_escalated_at
           end
   where u.id = p_user_id
     and u.stripe_customer_id = p_customer_id
     and u.stripe_subscription_id = p_subscription_id
     and not exists (
       select 1
         from public.account_deletion_sagas s
        where s.user_id = p_user_id
     )
  returning u.renewal_cancel_pending_at, u.cancelled_at
       into v_user.renewal_cancel_pending_at, v_user.cancelled_at;
  if not found then
    return query select 'binding_changed'::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  return query select 'claimed'::text, v_user.renewal_cancel_pending_at, v_user.cancelled_at;
end;
$$;

create or replace function public.settle_alpha_renewal_cancellation(
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_lease_token uuid,
  p_cancel_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  if p_user_id is null
     or p_lease_token is null
     or p_customer_id is null
     or btrim(p_customer_id) = ''
     or p_subscription_id is null
     or btrim(p_subscription_id) = ''
     or p_cancel_at is null
     or p_cancel_at <= v_now then
    raise exception 'valid future exact renewal cancellation settlement is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  perform pg_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
      80425081
    )
  );
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_user_id
  ) then
    return 'deletion_pending';
  end if;

  update public.users u
     -- A terminal/unpaid webhook can revoke access after the provider update
     -- but before this settlement transaction. Never replace that earlier
     -- access end with the future period-end date and accidentally regrant.
     set cancelled_at = least(
           coalesce(u.cancelled_at, p_cancel_at),
           p_cancel_at
         ),
         renewal_cancel_pending_at = null,
         renewal_cancel_customer_id = null,
         renewal_cancel_subscription_id = null,
         renewal_cancel_next_attempt_at = null,
         renewal_cancel_lease_token = null,
         renewal_cancel_lease_expires_at = null,
         renewal_cancel_attempt_count = 0,
         renewal_cancel_last_error_code = null,
         renewal_cancel_escalated_at = null
   where u.id = p_user_id
     and u.stripe_customer_id = p_customer_id
     and u.stripe_subscription_id = p_subscription_id
     and u.renewal_cancel_customer_id = p_customer_id
     and u.renewal_cancel_subscription_id = p_subscription_id
     and u.renewal_cancel_lease_token = p_lease_token
     and u.renewal_cancel_lease_expires_at > now();
  if not found then
    return 'lease_lost';
  end if;
  return 'settled';
end;
$$;

-- Fresh provider proof can show that the still-canonical exact subscription
-- no longer grants Alpha access. End access and clear the marker atomically.
-- Keeping this separate from marker-only retirement prevents an old replaced
-- subscription from ending access attached to a newer canonical binding.
create or replace function public.settle_alpha_renewal_cancellation_no_access(
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_lease_token uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  if p_user_id is null
     or p_lease_token is null
     or p_customer_id is null
     or btrim(p_customer_id) = ''
     or p_subscription_id is null
     or btrim(p_subscription_id) = '' then
    raise exception 'exact no-access renewal cancellation settlement is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  perform pg_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
      80425081
    )
  );
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_user_id
  ) then
    return 'deletion_pending';
  end if;

  update public.users u
     set cancelled_at = least(coalesce(u.cancelled_at, v_now), v_now),
         renewal_cancel_pending_at = null,
         renewal_cancel_customer_id = null,
         renewal_cancel_subscription_id = null,
         renewal_cancel_next_attempt_at = null,
         renewal_cancel_lease_token = null,
         renewal_cancel_lease_expires_at = null,
         renewal_cancel_attempt_count = 0,
         renewal_cancel_last_error_code = null,
         renewal_cancel_escalated_at = null
   where u.id = p_user_id
     and u.stripe_customer_id = p_customer_id
     and u.stripe_subscription_id = p_subscription_id
     and u.renewal_cancel_customer_id = p_customer_id
     and u.renewal_cancel_subscription_id = p_subscription_id
     and u.renewal_cancel_lease_token = p_lease_token
     and u.renewal_cancel_lease_expires_at > now();
  if not found then
    return 'lease_lost';
  end if;
  return 'settled';
end;
$$;

-- A provider-confirmed marker can outlive its original canonical binding. A
-- later checkout is allowed to replace only a freshly proved terminal or
-- no-longer-Alpha prior subscription, but a crash can leave this marker behind.
-- This lease authorizes read-only review of that exact old pair. It never
-- authorizes a Stripe mutation or derives identity from the new binding.
create or replace function public.claim_alpha_renewal_cancellation_retirement(
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_lease_token uuid,
  p_lease_seconds integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
  v_now timestamptz := now();
begin
  if p_user_id is null
     or p_lease_token is null
     or p_customer_id is null
     or btrim(p_customer_id) = ''
     or p_subscription_id is null
     or btrim(p_subscription_id) = '' then
    raise exception 'exact renewal marker retirement identity is required';
  end if;
  if p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 600 then
    raise exception 'renewal marker retirement lease must be 30 through 600 seconds';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  perform pg_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
      80425081
    )
  );
  select *
    into v_user
    from public.users u
   where u.id = p_user_id
   for update;
  if not found or v_user.renewal_cancel_pending_at is null then
    return 'marker_missing';
  end if;
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_user_id
  ) then
    return 'deletion_pending';
  end if;
  if v_user.renewal_cancel_customer_id is distinct from p_customer_id
     or v_user.renewal_cancel_subscription_id is distinct from p_subscription_id then
    return 'marker_changed';
  end if;
  if v_user.renewal_cancel_lease_token is not null
     and v_user.renewal_cancel_lease_expires_at > v_now
     and v_user.renewal_cancel_lease_token <> p_lease_token then
    return 'in_progress';
  end if;
  if v_user.renewal_cancel_lease_token = p_lease_token
     and v_user.renewal_cancel_lease_expires_at > v_now then
    return 'claimed';
  end if;
  if v_user.renewal_cancel_next_attempt_at > v_now then
    return 'not_due';
  end if;

  update public.users u
     set renewal_cancel_lease_token = p_lease_token,
         renewal_cancel_lease_expires_at =
           v_now + make_interval(secs => p_lease_seconds),
         renewal_cancel_next_attempt_at =
           v_now + make_interval(secs => p_lease_seconds)
   where u.id = p_user_id
     and u.renewal_cancel_customer_id = p_customer_id
     and u.renewal_cancel_subscription_id = p_subscription_id
     and not exists (
       select 1
         from public.account_deletion_sagas s
        where s.user_id = p_user_id
     );
  return case when found then 'claimed' else 'marker_changed' end;
end;
$$;

-- The worker calls this only after a fresh retrieve proves the exact marked
-- subscription terminal, or proves a replaced prior subscription no longer
-- contains Alpha. The token/CAS prevents that proof from clearing a newer
-- marker created while the provider read was in flight.
create or replace function public.retire_alpha_renewal_cancellation_marker(
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_lease_token uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null
     or p_lease_token is null
     or p_customer_id is null
     or btrim(p_customer_id) = ''
     or p_subscription_id is null
     or btrim(p_subscription_id) = '' then
    raise exception 'exact renewal marker retirement settlement is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  perform pg_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
      80425081
    )
  );
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_user_id
  ) then
    return 'deletion_pending';
  end if;
  update public.users u
     set renewal_cancel_pending_at = null,
         renewal_cancel_customer_id = null,
         renewal_cancel_subscription_id = null,
         renewal_cancel_next_attempt_at = null,
         renewal_cancel_lease_token = null,
         renewal_cancel_lease_expires_at = null,
         renewal_cancel_attempt_count = 0,
         renewal_cancel_last_error_code = null,
         renewal_cancel_escalated_at = null
   where u.id = p_user_id
       and u.renewal_cancel_customer_id = p_customer_id
       and u.renewal_cancel_subscription_id = p_subscription_id
       and u.renewal_cancel_lease_token = p_lease_token
       and u.renewal_cancel_lease_expires_at > now()
       -- Marker-only retirement is safe only while this remains a replaced
      -- pair. If checkout makes it canonical during the provider read, leave
      -- the marker red so the current-binding settlement ends access instead.
      and (
        u.stripe_customer_id is distinct from p_customer_id
        or u.stripe_subscription_id is distinct from p_subscription_id
      );
  if found then return 'retired'; end if;
  if exists (
    select 1
      from public.users u
     where u.id = p_user_id
       and u.renewal_cancel_pending_at is null
  ) then
    return 'marker_missing';
  end if;
  return 'lease_lost';
end;
$$;

-- Failure releases only the lease. The exact-pair marker stays pending and
-- visible until a later token holder proves Stripe state and settles by CAS.
-- The database owns the retry schedule, caps the fast phase at eight failed
-- attempts, and keeps retrying escalated work no faster than once per day.
-- Escalation is durable and remains visible to operators between slow retries.
create or replace function public.release_alpha_renewal_cancellation_lease(
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_lease_token uuid,
  p_retry_seconds integer default 0,
  p_error_code text default 'unexpected'
)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null
     or p_lease_token is null
     or p_customer_id is null
     or btrim(p_customer_id) = ''
     or p_subscription_id is null
     or btrim(p_subscription_id) = '' then
    raise exception 'exact renewal cancellation lease identity is required';
  end if;
  if p_retry_seconds < 0 or p_retry_seconds > 3600 then
    raise exception 'renewal cancellation retry delay must be 0 through 3600 seconds';
  end if;
  if p_error_code is null or p_error_code not in (
    'provider_unavailable',
    'provider_rate_limited',
    'provider_state_unsafe',
    'settlement_failed',
    'binding_changed',
    'unexpected'
  ) then
    raise exception 'stable renewal cancellation error code is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  perform pg_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
      80425081
    )
  );
  update public.users u
     set renewal_cancel_lease_token = null,
         renewal_cancel_lease_expires_at = null,
         renewal_cancel_next_attempt_at =
           now() + make_interval(
             secs => greatest(
               p_retry_seconds,
               case u.renewal_cancel_attempt_count
                 when 0 then 60
                 when 1 then 300
                 when 2 then 900
                 when 3 then 3600
                 when 4 then 10800
                 when 5 then 21600
                 when 6 then 43200
                 else 86400
               end
             )
           ),
         renewal_cancel_attempt_count =
           least(u.renewal_cancel_attempt_count + 1, 8),
         renewal_cancel_last_error_code = p_error_code,
         renewal_cancel_escalated_at =
           case when u.renewal_cancel_attempt_count >= 7
             then coalesce(u.renewal_cancel_escalated_at, now())
             else null
           end
   where u.id = p_user_id
     and u.renewal_cancel_customer_id = p_customer_id
     and u.renewal_cancel_subscription_id = p_subscription_id
     and u.renewal_cancel_lease_token = p_lease_token;
  return case when found then 'released' else 'lease_lost' end;
end;
$$;

create or replace function public.count_pending_alpha_renewal_cancellations()
returns bigint
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::bigint
    from public.users u
   where u.renewal_cancel_pending_at is not null;
$$;

-- One-time, evidence-led identity repair for paid users created before
-- users.stripe_subscription_id existed. The operator proves the exact live
-- Alpha subscription through Stripe first. This function performs only the
-- locked database compare-and-set and refuses every ambiguous reservation.
create or replace function public.bind_existing_alpha_subscription(
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_provider_status text,
  p_provider_quantity integer,
  p_provider_observed_at timestamptz,
  p_expected_subscribed_at timestamptz,
  p_expected_cancelled_at timestamptz,
  p_expected_topic_quota integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
  v_already_bound boolean;
begin
  if p_user_id is null
     or coalesce(btrim(p_customer_id), '') = ''
     or coalesce(btrim(p_subscription_id), '') = ''
     or p_customer_id <> btrim(p_customer_id)
     or p_subscription_id <> btrim(p_subscription_id)
     or p_customer_id !~ '^cus_[A-Za-z0-9]+$'
     or p_subscription_id !~ '^sub_[A-Za-z0-9]+$'
     or p_provider_status is null
     or p_provider_status not in ('active', 'trialing', 'past_due')
     or p_provider_quantity is null
     or p_provider_quantity < 1
     or p_provider_quantity > 5
     or p_provider_observed_at is null
     or p_expected_subscribed_at is null
     or p_expected_topic_quota is null
     or p_expected_topic_quota <> p_provider_quantity * 5 then
    return 'invalid';
  end if;
  if p_provider_observed_at < now() - interval '5 minutes'
     or p_provider_observed_at > now() + interval '1 minute' then
    return 'stale_provider_evidence';
  end if;

  if not pg_try_advisory_xact_lock(
    hashtextextended(p_user_id::text, 80425080)
  ) then
    return 'busy';
  end if;
  if not pg_try_advisory_xact_lock(
    hashtextextended('alpha-customer:' || p_customer_id, 80425082)
  ) then
    return 'busy';
  end if;
  if not pg_try_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
      80425081
    )
  ) then
    return 'busy';
  end if;

  select u.*
    into v_user
    from public.users u
   where u.id = p_user_id
   for update;
  if not found then
    return 'missing_user';
  end if;
  v_already_bound :=
    v_user.stripe_customer_id is not distinct from p_customer_id
    and v_user.stripe_subscription_id is not distinct from p_subscription_id;
  if not v_already_bound
     and (
       v_user.stripe_customer_id is distinct from p_customer_id
       or v_user.stripe_subscription_id is not null
     ) then
    return 'binding_changed';
  end if;
  if v_user.subscribed_at is distinct from p_expected_subscribed_at
     or v_user.cancelled_at is distinct from p_expected_cancelled_at
     or v_user.subscribed_at is null
     or (v_user.cancelled_at is not null and v_user.cancelled_at <= now()) then
    return 'access_changed';
  end if;
  if v_user.topic_quota is distinct from p_expected_topic_quota then
    return 'quota_changed';
  end if;
  if (
    select count(*)
      from public.users u
     where u.stripe_customer_id = p_customer_id
  ) <> 1 then
    return 'customer_ambiguous';
  end if;
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_user_id
        or s.stripe_customer_id = p_customer_id
        or s.stripe_subscription_id = p_subscription_id
  ) or exists (
    select 1
      from public.account_deletion_alpha_subscriptions r
     where r.user_id <> p_user_id
       and (
         r.customer_id = p_customer_id
         or r.subscription_id = p_subscription_id
       )
  ) then
    return 'deletion_pending';
  end if;
  if v_user.renewal_cancel_pending_at is not null
     or v_user.renewal_cancel_customer_id is not null
     or v_user.renewal_cancel_subscription_id is not null
     or exists (
       select 1
         from public.users u
        where u.id <> p_user_id
          and u.renewal_cancel_pending_at is not null
          and (
            u.renewal_cancel_customer_id = p_customer_id
            or u.renewal_cancel_subscription_id = p_subscription_id
          )
     ) then
    return 'renewal_pending';
  end if;
  if exists (
    select 1
      from public.checkout_profiles p
     where p.billing_state in ('open', 'creating', 'paid', 'recovering', 'deleting')
       and (
         p.owner_user_id = p_user_id
         or p.provisioned_user_id = p_user_id
         or p.stripe_customer_id = p_customer_id
         or p.stripe_subscription_id = p_subscription_id
       )
  ) then
    return 'checkout_pending';
  end if;
  if exists (
    select 1
      from public.legacy_checkout_fulfillments l
     where l.status in ('pending', 'awaiting_issue', 'deleting')
       and (
         l.user_id = p_user_id
         or l.stripe_customer_id = p_customer_id
         or l.stripe_subscription_id = p_subscription_id
       )
  ) then
    return 'legacy_fulfillment_pending';
  end if;
  if exists (
    select 1
      from public.refund_reviews r
     where r.status in ('pending', 'reviewed')
       and (
         (r.customer_id = p_customer_id and r.subscription_id = p_subscription_id)
         or (
           r.winner_customer_id = p_customer_id
           and r.winner_subscription_id = p_subscription_id
         )
       )
  ) then
    return 'refund_review_pending';
  end if;
  if exists (
    select 1
      from public.users u
     where u.id <> p_user_id
       and (
         u.stripe_customer_id = p_customer_id
         or u.stripe_subscription_id = p_subscription_id
       )
  ) or exists (
    select 1
      from public.checkout_profiles p
      where (
        p.stripe_customer_id = p_customer_id
        or p.stripe_subscription_id = p_subscription_id
      )
        and (
          (
            p.owner_user_id is null
            and p.provisioned_user_id is null
          )
          or (
            p.owner_user_id is not null
            and p.owner_user_id <> p_user_id
          )
          or (
            p.provisioned_user_id is not null
            and p.provisioned_user_id <> p_user_id
          )
        )
  ) or exists (
    select 1
      from public.legacy_checkout_fulfillments l
     where (
       l.stripe_customer_id = p_customer_id
       or l.stripe_subscription_id = p_subscription_id
     )
       and l.user_id is distinct from p_user_id
  ) then
    return 'reservation_conflict';
  end if;

  if v_already_bound then
    return 'already_bound';
  end if;

  update public.users u
     set stripe_subscription_id = p_subscription_id,
         updated_at = now()
   where u.id = p_user_id
     and u.stripe_customer_id = p_customer_id
     and u.stripe_subscription_id is null
     and u.subscribed_at is not distinct from p_expected_subscribed_at
     and u.cancelled_at is not distinct from p_expected_cancelled_at
     and u.topic_quota is not distinct from p_expected_topic_quota;
  return case when found then 'bound' else 'binding_changed' end;
end;
$$;

revoke all on function public.claim_alpha_renewal_cancellation(uuid, text, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.settle_alpha_renewal_cancellation(uuid, text, text, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.settle_alpha_renewal_cancellation_no_access(uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_alpha_renewal_cancellation_retirement(uuid, text, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.retire_alpha_renewal_cancellation_marker(uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.release_alpha_renewal_cancellation_lease(uuid, text, text, uuid, integer, text)
  from public, anon, authenticated;
revoke all on function public.count_pending_alpha_renewal_cancellations()
  from public, anon, authenticated;
revoke all on function public.bind_existing_alpha_subscription(uuid, text, text, text, integer, timestamptz, timestamptz, timestamptz, integer)
  from public, anon, authenticated;

grant execute on function public.claim_alpha_renewal_cancellation(uuid, text, text, uuid, integer)
  to service_role;
grant execute on function public.settle_alpha_renewal_cancellation(uuid, text, text, uuid, timestamptz)
  to service_role;
grant execute on function public.settle_alpha_renewal_cancellation_no_access(uuid, text, text, uuid)
  to service_role;
grant execute on function public.claim_alpha_renewal_cancellation_retirement(uuid, text, text, uuid, integer)
  to service_role;
grant execute on function public.retire_alpha_renewal_cancellation_marker(uuid, text, text, uuid)
  to service_role;
grant execute on function public.release_alpha_renewal_cancellation_lease(uuid, text, text, uuid, integer, text)
  to service_role;
grant execute on function public.count_pending_alpha_renewal_cancellations()
  to service_role;
grant execute on function public.bind_existing_alpha_subscription(uuid, text, text, text, integer, timestamptz, timestamptz, timestamptz, integer)
  to service_role;

-- Keep the workflow's cheap precheck aware of every bounded maintenance
-- obligation introduced through this migration. This is the final definition
-- in migration order, so it repeats the existing queues and adds the exact
-- renewal-cancellation marker rather than accidentally hiding older work.
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
           p.recovery_dead_lettered_at is not null
         ) or (
           p.billing_state in ('creating', 'deleting')
           and p.stripe_session_id is null
           and p.session_creation_lease_expires_at <= p_now
         ) or (
           p.billing_state = 'recovering'
           and p.recovery_dead_lettered_at is null
           and p.recovery_lease_expires_at <= p_now
         ) or (
           p.billing_state in ('open', 'paid')
           and p.recovery_dead_lettered_at is null
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
          ) or (
            p.raw_profile_scrubbed_at is null
            and p.expires_at <= p_now
            and (
              p.provisioned_user_id is not null
              or p.billing_state in ('ended', 'expired')
            )
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
          from public.checkout_fulfillments f
          join public.checkout_profiles p on p.id = f.profile_id
         where f.status = 'pending'
           and (
             f.lease_token is null
             or f.lease_expires_at is null
             or f.lease_expires_at <= p_now
           )
           and (
             p.billing_state in ('ended', 'expired')
             or (
               p.provisioned_user_id is not null
               and p.raw_profile_scrubbed_at is not null
               and (
                 f.created_at <= p_now - interval '24 hours'
                 or exists (
                   select 1
                     from public.issues i
                    where i.user_id = p.provisioned_user_id
                      and i.week_of = f.week_of
                 )
               )
             )
           )
      )
      or exists (
        select 1
          from public.checkout_creation_reviews r
         where r.status = 'pending'
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
            and not exists (
              select 1
                from public.legacy_checkout_fulfillments l
              where l.session_id = r.session_id
                and l.stripe_subscription_id = r.subscription_id
                 and l.stripe_customer_id = r.customer_id
                 and l.status in ('pending', 'deleting')
            )
            and not exists (
              select 1
                from public.checkout_profiles p
               where p.stripe_session_id = r.session_id
                 and p.stripe_customer_id = r.customer_id
                 and p.stripe_subscription_id = r.subscription_id
                 and p.billing_state in (
                   'open', 'creating', 'paid', 'recovering', 'deleting'
                 )
            )
            and not exists (
              select 1
                from public.checkout_fulfillments f
                join public.checkout_profiles p
                  on p.id = f.profile_id
                 and p.stripe_session_id = f.session_id
               where f.session_id = r.session_id
                 and f.status = 'pending'
                 and p.stripe_customer_id = r.customer_id
                 and p.stripe_subscription_id = r.subscription_id
            )
      )
      or exists (
        select 1
          from public.legacy_checkout_fulfillments l
         where l.reconcile_dead_lettered_at is not null
      )
      or exists (
        select 1
          from public.legacy_checkout_fulfillments l
          where (
              l.status = 'awaiting_issue'
              and coalesce(l.lease_expires_at, l.created_at) <= p_now
            )
             or (
               l.status = 'pending'
              and coalesce(
                l.lease_expires_at,
                l.created_at + interval '5 minutes'
              ) <= p_now
            )
      )
      or exists (
        select 1
          from public.legacy_checkout_fulfillments l
          join public.refund_reviews r
            on r.session_id = l.session_id
           and r.subscription_id = l.stripe_subscription_id
           and r.customer_id = l.stripe_customer_id
           and r.winner_customer_id is not null
           and r.winner_subscription_id is not null
         where l.status = 'pending'
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
             and (
               u.stripe_email_sync_lease_expires_at is null
               or u.stripe_email_sync_lease_expires_at <= p_now
             )
           )
            or (
              u.renewal_cancel_pending_at is not null
              and (
                u.renewal_cancel_escalated_at is not null
                or u.renewal_cancel_next_attempt_at <= p_now
              )
            )
      )
  end;
$$;

revoke all on function public.alpha_scheduled_maintenance_due(timestamptz)
  from public, anon, authenticated;
grant execute on function public.alpha_scheduled_maintenance_due(timestamptz)
  to service_role;
