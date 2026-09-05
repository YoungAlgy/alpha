-- Alpha account privacy and reconciliation retry bounds.
--
-- Account deletion and provider-mirror cleanup are safety-critical durable
-- obligations. A transient provider failure may retry automatically, but a
-- poison row must eventually stop retrying and remain visible for operator
-- review. No email or profile text is stored in the deletion tombstone.

alter table public.account_deletion_sagas
  add column if not exists reconcile_last_error_code text,
  add column if not exists reconcile_dead_lettered_at timestamptz;

-- Older workers could increment this counter without a ceiling. Normalize any
-- rows left by that implementation before adding the bounded-state checks.
-- The old counter is an operational fact, not user data, so retaining only the
-- terminal classification is sufficient for a safe forward migration.
update public.account_deletion_sagas
   set reconcile_attempt_count = least(reconcile_attempt_count, 8),
       reconcile_last_error_code = case
         when reconcile_attempt_count > 0
           then coalesce(reconcile_last_error_code, 'unexpected')
         else null
       end,
       reconcile_dead_lettered_at = case
         when reconcile_attempt_count >= 8
           then coalesce(reconcile_dead_lettered_at, now())
         else null
       end,
       reconcile_next_attempt_at = case
         when reconcile_attempt_count >= 8 then now()
         else reconcile_next_attempt_at
       end,
       updated_at = now()
 where reconcile_attempt_count > 0
    or reconcile_last_error_code is not null
    or reconcile_dead_lettered_at is not null;

-- PostgreSQL auto-named the original inline `reconcile_attempt_count >= 0`
-- check with this exact name. Replace that unbounded check before installing
-- the terminal retry ceiling below.
alter table public.account_deletion_sagas
  drop constraint if exists account_deletion_sagas_reconcile_attempt_count_check;

alter table public.account_deletion_sagas
  add constraint account_deletion_sagas_reconcile_attempt_count_check check (
    reconcile_attempt_count between 0 and 8
  ),
  add constraint account_deletion_sagas_reconcile_error_code_check check (
    reconcile_last_error_code is null
    or reconcile_last_error_code in (
      'provider_unavailable',
      'privacy_blocked',
      'database_transient',
      'state_changed',
      'unexpected'
    )
  ),
  add constraint account_deletion_sagas_reconcile_marker_check check (
    (
      reconcile_attempt_count = 0
      and reconcile_last_error_code is null
      and reconcile_dead_lettered_at is null
    )
    or (
      reconcile_attempt_count between 1 and 7
      and reconcile_last_error_code is not null
      and reconcile_dead_lettered_at is null
    )
    or (
      reconcile_attempt_count = 8
      and reconcile_last_error_code is not null
      and reconcile_dead_lettered_at is not null
    )
  );

alter table public.users
  add column if not exists stripe_email_sync_attempt_count smallint not null default 0,
  add column if not exists stripe_email_sync_last_error_code text,
  add column if not exists stripe_email_sync_dead_lettered_at timestamptz,
  add column if not exists suppression_cleanup_attempt_count smallint not null default 0,
  add column if not exists suppression_cleanup_last_error_code text,
  add column if not exists suppression_cleanup_dead_lettered_at timestamptz;

alter table public.users
  add constraint users_stripe_email_sync_attempt_count_check check (
    stripe_email_sync_attempt_count between 0 and 8
  ),
  add constraint users_stripe_email_sync_error_code_check check (
    stripe_email_sync_last_error_code is null
    or stripe_email_sync_last_error_code in (
      'provider_unavailable',
      'database_transient',
      'state_changed',
      'unexpected'
    )
  ),
  add constraint users_stripe_email_sync_retry_marker_check check (
    (
      stripe_email_sync_pending_at is null
      and stripe_email_sync_next_attempt_at is null
      and stripe_email_sync_lease_token is null
      and stripe_email_sync_lease_expires_at is null
      and stripe_email_sync_attempt_count = 0
      and stripe_email_sync_last_error_code is null
      and stripe_email_sync_dead_lettered_at is null
    )
    or (
      stripe_email_sync_pending_at is not null
      and (
        (
          stripe_email_sync_attempt_count = 0
          and stripe_email_sync_last_error_code is null
          and stripe_email_sync_dead_lettered_at is null
        )
        or (
          stripe_email_sync_attempt_count between 1 and 7
          and stripe_email_sync_last_error_code is not null
          and stripe_email_sync_dead_lettered_at is null
          and stripe_email_sync_next_attempt_at is not null
        )
        or (
          stripe_email_sync_attempt_count = 8
          and stripe_email_sync_last_error_code is not null
          and stripe_email_sync_dead_lettered_at is not null
          and stripe_email_sync_next_attempt_at is not null
        )
      )
      and (
        (
          stripe_email_sync_lease_token is null
          and stripe_email_sync_lease_expires_at is null
        )
        or (
          stripe_email_sync_lease_token is not null
          and stripe_email_sync_lease_expires_at is not null
        )
      )
    )
  ),
  add constraint users_suppression_cleanup_attempt_count_check check (
    suppression_cleanup_attempt_count between 0 and 8
  ),
  add constraint users_suppression_cleanup_error_code_check check (
    suppression_cleanup_last_error_code is null
    or suppression_cleanup_last_error_code in (
      'provider_unavailable',
      'database_transient',
      'state_changed',
      'unexpected'
    )
  ),
  add constraint users_suppression_cleanup_retry_marker_check check (
    (
      suppression_cleanup_pending_at is null
      and suppression_cleanup_next_attempt_at is null
      and suppression_cleanup_attempt_count = 0
      and suppression_cleanup_last_error_code is null
      and suppression_cleanup_dead_lettered_at is null
    )
    or (
      suppression_cleanup_pending_at is not null
      and (
        (
          suppression_cleanup_attempt_count = 0
          and suppression_cleanup_last_error_code is null
          and suppression_cleanup_dead_lettered_at is null
        )
        or (
          suppression_cleanup_attempt_count between 1 and 7
          and suppression_cleanup_last_error_code is not null
          and suppression_cleanup_dead_lettered_at is null
          and suppression_cleanup_next_attempt_at is not null
        )
        or (
          suppression_cleanup_attempt_count = 8
          and suppression_cleanup_last_error_code is not null
          and suppression_cleanup_dead_lettered_at is not null
          and suppression_cleanup_next_attempt_at is not null
        )
      )
    )
  );

create index if not exists account_deletion_sagas_reconcile_dead_letter_idx
  on public.account_deletion_sagas (reconcile_dead_lettered_at)
  where reconcile_dead_lettered_at is not null;

create index if not exists users_stripe_email_sync_dead_letter_idx
  on public.users (stripe_email_sync_dead_lettered_at)
  where stripe_email_sync_dead_lettered_at is not null;

create index if not exists users_suppression_cleanup_dead_letter_idx
  on public.users (suppression_cleanup_dead_lettered_at)
  where suppression_cleanup_dead_lettered_at is not null;

-- Keep all retry markers service-owned. Pending-marker changes start a fresh
-- bounded obligation. A Stripe email re-key retains its live lease so the
-- worker that changed the canonical email can still finish the same provider
-- call under the existing authorization check.
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
  new.access_requested_at := old.access_requested_at;
  new.access_granted_at := old.access_granted_at;
  new.bounced_at := old.bounced_at;
  new.complained_at := old.complained_at;
  new.suppression_cleanup_pending_at := old.suppression_cleanup_pending_at;
  new.suppression_cleanup_next_attempt_at := old.suppression_cleanup_next_attempt_at;
  new.stripe_email_sync_pending_at := old.stripe_email_sync_pending_at;
  new.stripe_email_sync_next_attempt_at := old.stripe_email_sync_next_attempt_at;
  new.stripe_email_sync_lease_token := old.stripe_email_sync_lease_token;
  new.stripe_email_sync_lease_expires_at := old.stripe_email_sync_lease_expires_at;
  new.stripe_email_sync_attempt_count := old.stripe_email_sync_attempt_count;
  new.stripe_email_sync_last_error_code := old.stripe_email_sync_last_error_code;
  new.stripe_email_sync_dead_lettered_at := old.stripe_email_sync_dead_lettered_at;
  new.suppression_cleanup_attempt_count := old.suppression_cleanup_attempt_count;
  new.suppression_cleanup_last_error_code := old.suppression_cleanup_last_error_code;
  new.suppression_cleanup_dead_lettered_at := old.suppression_cleanup_dead_lettered_at;
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

create or replace function public.normalize_delivery_retry_deadlines()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if new.suppression_cleanup_pending_at is distinct from old.suppression_cleanup_pending_at then
    new.suppression_cleanup_next_attempt_at := null;
    new.suppression_cleanup_attempt_count := 0;
    new.suppression_cleanup_last_error_code := null;
    new.suppression_cleanup_dead_lettered_at := null;
  end if;
  if new.stripe_email_sync_pending_at is distinct from old.stripe_email_sync_pending_at then
    new.stripe_email_sync_next_attempt_at := null;
    new.stripe_email_sync_attempt_count := 0;
    new.stripe_email_sync_last_error_code := null;
    new.stripe_email_sync_dead_lettered_at := null;
  end if;
  if new.stripe_email_sync_pending_at is null then
    new.stripe_email_sync_lease_token := null;
    new.stripe_email_sync_lease_expires_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.protect_user_privileged_columns()
  from public, anon, authenticated;
revoke all on function public.normalize_delivery_retry_deadlines()
  from public, anon, authenticated;

-- Recheck the dead-letter marker while holding the same owner lock used by the
-- provider call. A row that became terminal after discovery can never reclaim
-- a lease or reach Stripe.
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
  if v_user.stripe_email_sync_dead_lettered_at is not null then
    return query select 'dead_lettered'::text,
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
     and u.stripe_email_sync_pending_at = v_user.stripe_email_sync_pending_at
     and u.stripe_email_sync_dead_lettered_at is null;
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

-- A failed claimed Stripe-email sync has a finite automatic retry budget.
-- The database owns the backoff floor and stores only a closed error code.
create or replace function public.fail_stripe_email_sync(
  p_user_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_retry_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
  v_attempt integer;
  v_floor interval;
begin
  if p_user_id is null
     or p_lease_token is null
     or p_error_code is null
     or p_error_code not in (
       'provider_unavailable',
       'database_transient',
       'state_changed',
       'unexpected'
     )
     or p_retry_at is null
     or p_retry_at < now() + interval '1 minute'
     or p_retry_at > now() + interval '25 hours' then
    return 'invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select *
    into v_user
    from public.users u
   where u.id = p_user_id
   for update;
  if not found then
    return 'missing';
  end if;
  if v_user.stripe_email_sync_dead_lettered_at is not null then
    return 'manual_review';
  end if;
  if v_user.stripe_email_sync_pending_at is null then
    return 'state_changed';
  end if;
  if v_user.stripe_email_sync_lease_token is distinct from p_lease_token
     or v_user.stripe_email_sync_lease_expires_at is null
     or v_user.stripe_email_sync_lease_expires_at <= now() then
    return 'lease_lost';
  end if;

  v_attempt := least(8, v_user.stripe_email_sync_attempt_count + 1);
  if v_attempt = 8 then
    update public.users u
       set stripe_email_sync_lease_token = null,
           stripe_email_sync_lease_expires_at = null,
           stripe_email_sync_next_attempt_at = now(),
           stripe_email_sync_attempt_count = 8,
           stripe_email_sync_last_error_code = p_error_code,
           stripe_email_sync_dead_lettered_at = coalesce(
             u.stripe_email_sync_dead_lettered_at,
             now()
           ),
           updated_at = now()
     where u.id = p_user_id
       and u.stripe_email_sync_pending_at is not null
       and u.stripe_email_sync_lease_token = p_lease_token;
    return case when found then 'dead_lettered' else 'lease_lost' end;
  end if;

  v_floor := case v_attempt
    when 1 then interval '5 minutes'
    when 2 then interval '15 minutes'
    when 3 then interval '1 hour'
    when 4 then interval '3 hours'
    when 5 then interval '6 hours'
    when 6 then interval '12 hours'
    else interval '24 hours'
  end;
  update public.users u
     set stripe_email_sync_lease_token = null,
         stripe_email_sync_lease_expires_at = null,
         stripe_email_sync_next_attempt_at = greatest(p_retry_at, now() + v_floor),
         stripe_email_sync_attempt_count = v_attempt,
         stripe_email_sync_last_error_code = p_error_code,
         stripe_email_sync_dead_lettered_at = null,
         updated_at = now()
   where u.id = p_user_id
     and u.stripe_email_sync_pending_at is not null
     and u.stripe_email_sync_lease_token = p_lease_token;
  return case when found then 'deferred' else 'lease_lost' end;
end;
$$;

create or replace function public.requeue_stripe_email_sync(
  p_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
begin
  if p_user_id is null then return 'invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select * into v_user from public.users where id = p_user_id for update;
  if not found then return 'missing'; end if;
  if v_user.stripe_email_sync_pending_at is null then return 'not_pending'; end if;
  if v_user.stripe_email_sync_dead_lettered_at is null then
    return 'not_dead_lettered';
  end if;
  if v_user.stripe_email_sync_attempt_count <> 8
     or v_user.stripe_email_sync_last_error_code is null
     or v_user.stripe_email_sync_lease_token is not null
     or v_user.stripe_email_sync_lease_expires_at is not null then
    return 'state_changed';
  end if;
  update public.users
     set stripe_email_sync_attempt_count = 0,
         stripe_email_sync_last_error_code = null,
         stripe_email_sync_dead_lettered_at = null,
         stripe_email_sync_next_attempt_at = null,
         updated_at = now()
   where id = p_user_id
     and stripe_email_sync_dead_lettered_at = v_user.stripe_email_sync_dead_lettered_at
     and stripe_email_sync_attempt_count = 8;
  return case when found then 'requeued' else 'state_changed' end;
end;
$$;

create or replace function public.count_dead_lettered_stripe_email_sync()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
    from public.users
   where stripe_email_sync_dead_lettered_at is not null;
$$;

-- A successful deletion no longer needs retry metadata. Clearing it here also
-- keeps completed tombstones out of the dead-letter review count.
create or replace function public.complete_account_deletion(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.account_deletion_sagas
     set state = 'complete',
         stripe_customer_id = null,
         stripe_subscription_id = null,
         reconcile_next_attempt_at = now(),
         reconcile_attempt_count = 0,
         reconcile_last_error_code = null,
         reconcile_dead_lettered_at = null,
         completed_at = coalesce(completed_at, now()),
         purge_after = coalesce(purge_after, now() + interval '7 days'),
         updated_at = now()
   where user_id = p_user_id
     and state in ('auth_delete_started', 'complete');
  if not found then
    return false;
  end if;

  update public.checkout_fulfillments f
     set status = 'aborted',
         email_hash = null,
         user_id = null,
         lease_token = null,
         lease_expires_at = null,
         identity_scrubbed_at = coalesce(f.identity_scrubbed_at, now())
   where f.profile_id in (
     select p.id
       from public.checkout_profiles p
      where p.owner_user_id = p_user_id
   );

  update public.checkout_profiles
     set email_hash = null,
         browser_nonce_hash = null,
         stripe_customer_id = null,
         stripe_subscription_id = null,
         owner_user_id = null,
         provisioned_user_id = null,
         owner_deleted_at = coalesce(owner_deleted_at, now()),
         identity_scrubbed_at = coalesce(identity_scrubbed_at, now()),
         updated_at = now()
   where owner_user_id = p_user_id;

  delete from public.account_deletion_alpha_subscriptions
   where user_id = p_user_id;
  return true;
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
         stripe_email_sync_attempt_count = 0,
         stripe_email_sync_last_error_code = null,
         stripe_email_sync_dead_lettered_at = null,
         updated_at = now()
   where u.id = p_user_id
     and u.email = p_canonical_email
     and u.stripe_customer_id = p_customer_id
     and u.stripe_email_sync_pending_at = p_pending_at
     and u.stripe_email_sync_lease_token = p_lease_token;
  return found;
end;
$$;

-- Preserve the old service-only release entry point for any already deployed
-- worker while routing it through the bounded failure state machine.
create or replace function public.release_stripe_email_sync(
  p_user_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  v_status := public.fail_stripe_email_sync(
    p_user_id,
    p_lease_token,
    'provider_unavailable',
    now() + interval '5 minutes'
  );
  return v_status in ('deferred', 'dead_lettered');
end;
$$;

-- A suppression-cleanup failure uses the complete row snapshot as its CAS.
-- This preserves the existing race protection while making the retry count
-- and terminal marker atomic under the user lock.
create or replace function public.fail_suppression_cleanup(
  p_user_id uuid,
  p_pending_at timestamptz,
  p_email text,
  p_subscribed_at timestamptz,
  p_cancelled_at timestamptz,
  p_access_granted_at timestamptz,
  p_customer_id text,
  p_subscription_id text,
  p_unsubscribed_at timestamptz,
  p_bounced_at timestamptz,
  p_complained_at timestamptz,
  p_error_code text,
  p_retry_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
  v_attempt integer;
  v_floor interval;
begin
  if p_user_id is null
     or p_pending_at is null
     or p_error_code is null
     or p_error_code not in (
       'provider_unavailable',
       'database_transient',
       'state_changed',
       'unexpected'
     )
     or p_retry_at is null
     or p_retry_at < now() + interval '1 minute'
     or p_retry_at > now() + interval '25 hours' then
    return 'invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select * into v_user from public.users where id = p_user_id for update;
  if not found then return 'missing'; end if;
  if v_user.suppression_cleanup_pending_at is null then return 'state_changed'; end if;
  if v_user.suppression_cleanup_dead_lettered_at is not null then
    return 'manual_review';
  end if;
  if v_user.suppression_cleanup_pending_at is distinct from p_pending_at
     or v_user.email is distinct from p_email
     or v_user.subscribed_at is distinct from p_subscribed_at
     or v_user.cancelled_at is distinct from p_cancelled_at
     or v_user.access_granted_at is distinct from p_access_granted_at
     or v_user.stripe_customer_id is distinct from p_customer_id
     or v_user.stripe_subscription_id is distinct from p_subscription_id
     or v_user.unsubscribed_at is distinct from p_unsubscribed_at
     or v_user.bounced_at is distinct from p_bounced_at
     or v_user.complained_at is distinct from p_complained_at then
    return 'state_changed';
  end if;

  v_attempt := least(8, v_user.suppression_cleanup_attempt_count + 1);
  if v_attempt = 8 then
    update public.users
       set suppression_cleanup_next_attempt_at = now(),
           suppression_cleanup_attempt_count = 8,
           suppression_cleanup_last_error_code = p_error_code,
           suppression_cleanup_dead_lettered_at = coalesce(
             suppression_cleanup_dead_lettered_at,
             now()
           ),
           updated_at = now()
     where id = p_user_id
       and suppression_cleanup_pending_at = p_pending_at;
    return case when found then 'dead_lettered' else 'state_changed' end;
  end if;

  v_floor := case v_attempt
    when 1 then interval '5 minutes'
    when 2 then interval '15 minutes'
    when 3 then interval '1 hour'
    when 4 then interval '3 hours'
    when 5 then interval '6 hours'
    when 6 then interval '12 hours'
    else interval '24 hours'
  end;
  update public.users
     set suppression_cleanup_next_attempt_at = greatest(p_retry_at, now() + v_floor),
         suppression_cleanup_attempt_count = v_attempt,
         suppression_cleanup_last_error_code = p_error_code,
         suppression_cleanup_dead_lettered_at = null,
         updated_at = now()
   where id = p_user_id
     and suppression_cleanup_pending_at = p_pending_at;
  return case when found then 'deferred' else 'state_changed' end;
end;
$$;

create or replace function public.requeue_suppression_cleanup(
  p_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
begin
  if p_user_id is null then return 'invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select * into v_user from public.users where id = p_user_id for update;
  if not found then return 'missing'; end if;
  if v_user.suppression_cleanup_pending_at is null then return 'not_pending'; end if;
  if v_user.suppression_cleanup_dead_lettered_at is null then
    return 'not_dead_lettered';
  end if;
  if v_user.suppression_cleanup_attempt_count <> 8
     or v_user.suppression_cleanup_last_error_code is null then
    return 'state_changed';
  end if;
  update public.users
     set suppression_cleanup_attempt_count = 0,
         suppression_cleanup_last_error_code = null,
         suppression_cleanup_dead_lettered_at = null,
         suppression_cleanup_next_attempt_at = null,
         updated_at = now()
   where id = p_user_id
     and suppression_cleanup_dead_lettered_at = v_user.suppression_cleanup_dead_lettered_at
     and suppression_cleanup_attempt_count = 8;
  return case when found then 'requeued' else 'state_changed' end;
end;
$$;

create or replace function public.count_dead_lettered_suppression_cleanups()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
    from public.users
   where suppression_cleanup_dead_lettered_at is not null;
$$;

-- Account-deletion reconciliation has the same finite retry contract. The
-- previous boolean entry point remains available for old workers and now
-- delegates to the status-returning state machine.
create or replace function public.fail_account_deletion_reconciliation(
  p_user_id uuid,
  p_error_code text,
  p_retry_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saga public.account_deletion_sagas%rowtype;
  v_attempt integer;
  v_floor interval;
begin
  if p_user_id is null
     or p_error_code is null
     or p_error_code not in (
       'provider_unavailable',
       'privacy_blocked',
       'database_transient',
       'state_changed',
       'unexpected'
     )
     or p_retry_at is null
     or p_retry_at < now() + interval '1 minute'
     or p_retry_at > now() + interval '25 hours' then
    return 'invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select * into v_saga
    from public.account_deletion_sagas
   where user_id = p_user_id
   for update;
  if not found then return 'missing'; end if;
  if v_saga.state = 'complete' then return 'complete'; end if;
  if v_saga.reconcile_dead_lettered_at is not null then
    return 'manual_review';
  end if;

  v_attempt := least(8, v_saga.reconcile_attempt_count + 1);
  if v_attempt = 8 then
    update public.account_deletion_sagas
       set reconcile_next_attempt_at = now(),
           reconcile_attempt_count = 8,
           reconcile_last_error_code = p_error_code,
           reconcile_dead_lettered_at = coalesce(
             reconcile_dead_lettered_at,
             now()
           ),
           updated_at = now()
     where user_id = p_user_id
       and state in ('prepared', 'billing_clean', 'auth_delete_started');
    return case when found then 'dead_lettered' else 'state_changed' end;
  end if;

  v_floor := case v_attempt
    when 1 then interval '5 minutes'
    when 2 then interval '15 minutes'
    when 3 then interval '1 hour'
    when 4 then interval '3 hours'
    when 5 then interval '6 hours'
    when 6 then interval '12 hours'
    else interval '24 hours'
  end;
  update public.account_deletion_sagas
     set reconcile_next_attempt_at = greatest(p_retry_at, now() + v_floor),
         reconcile_attempt_count = v_attempt,
         reconcile_last_error_code = p_error_code,
         reconcile_dead_lettered_at = null,
         updated_at = now()
   where user_id = p_user_id
     and state in ('prepared', 'billing_clean', 'auth_delete_started');
  return case when found then 'deferred' else 'state_changed' end;
end;
$$;

create or replace function public.defer_account_deletion_reconciliation(
  p_user_id uuid,
  p_retry_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  v_status := public.fail_account_deletion_reconciliation(
    p_user_id,
    'unexpected',
    p_retry_at
  );
  return v_status in ('deferred', 'dead_lettered', 'manual_review');
end;
$$;

create or replace function public.requeue_account_deletion_reconciliation(
  p_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saga public.account_deletion_sagas%rowtype;
begin
  if p_user_id is null then return 'invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select * into v_saga
    from public.account_deletion_sagas
   where user_id = p_user_id
   for update;
  if not found then return 'missing'; end if;
  if v_saga.state = 'complete' then return 'complete'; end if;
  if v_saga.reconcile_dead_lettered_at is null then
    return 'not_dead_lettered';
  end if;
  if v_saga.reconcile_attempt_count <> 8
     or v_saga.reconcile_last_error_code is null then
    return 'state_changed';
  end if;
  update public.account_deletion_sagas
     set reconcile_attempt_count = 0,
         reconcile_last_error_code = null,
         reconcile_dead_lettered_at = null,
         reconcile_next_attempt_at = now(),
         updated_at = now()
   where user_id = p_user_id
     and state in ('prepared', 'billing_clean', 'auth_delete_started')
     and reconcile_dead_lettered_at = v_saga.reconcile_dead_lettered_at
     and reconcile_attempt_count = 8;
  return case when found then 'requeued' else 'state_changed' end;
end;
$$;

create or replace function public.count_dead_lettered_account_deletions()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
    from public.account_deletion_sagas
   where reconcile_dead_lettered_at is not null;
$$;

-- Terminal provider/deletion rows remain pending so operators can requeue
-- them, but they must not make the scheduled retry precheck stay permanently
-- due. The dedicated dead-letter count RPCs above remain the review signal.
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
           and s.reconcile_dead_lettered_at is null
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
             and u.suppression_cleanup_dead_lettered_at is null
             and (
               u.suppression_cleanup_next_attempt_at is null
               or u.suppression_cleanup_next_attempt_at <= p_now
             )
           ) or (
             u.stripe_email_sync_pending_at is not null
             and u.stripe_email_sync_dead_lettered_at is null
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

revoke all on function public.claim_stripe_email_sync(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_stripe_email_sync(uuid, uuid, text, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.release_stripe_email_sync(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.fail_stripe_email_sync(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.requeue_stripe_email_sync(uuid)
  from public, anon, authenticated;
revoke all on function public.count_dead_lettered_stripe_email_sync()
  from public, anon, authenticated;
revoke all on function public.fail_suppression_cleanup(uuid, timestamptz, text, timestamptz, timestamptz, timestamptz, text, text, timestamptz, timestamptz, timestamptz, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.requeue_suppression_cleanup(uuid)
  from public, anon, authenticated;
revoke all on function public.count_dead_lettered_suppression_cleanups()
  from public, anon, authenticated;
revoke all on function public.fail_account_deletion_reconciliation(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.defer_account_deletion_reconciliation(uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.requeue_account_deletion_reconciliation(uuid)
  from public, anon, authenticated;
revoke all on function public.count_dead_lettered_account_deletions()
  from public, anon, authenticated;

grant execute on function public.claim_stripe_email_sync(uuid, uuid)
  to service_role;
grant execute on function public.complete_stripe_email_sync(uuid, uuid, text, timestamptz, text)
  to service_role;
grant execute on function public.release_stripe_email_sync(uuid, uuid)
  to service_role;
grant execute on function public.fail_stripe_email_sync(uuid, uuid, text, timestamptz)
  to service_role;
grant execute on function public.requeue_stripe_email_sync(uuid)
  to service_role;
grant execute on function public.count_dead_lettered_stripe_email_sync()
  to service_role;
grant execute on function public.fail_suppression_cleanup(uuid, timestamptz, text, timestamptz, timestamptz, timestamptz, text, text, timestamptz, timestamptz, timestamptz, text, timestamptz)
  to service_role;
grant execute on function public.requeue_suppression_cleanup(uuid)
  to service_role;
grant execute on function public.count_dead_lettered_suppression_cleanups()
  to service_role;
grant execute on function public.fail_account_deletion_reconciliation(uuid, text, timestamptz)
  to service_role;
grant execute on function public.defer_account_deletion_reconciliation(uuid, timestamptz)
  to service_role;
grant execute on function public.requeue_account_deletion_reconciliation(uuid)
  to service_role;
grant execute on function public.count_dead_lettered_account_deletions()
  to service_role;
