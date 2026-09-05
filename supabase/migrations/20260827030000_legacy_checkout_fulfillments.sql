-- Alpha Round 80: durable one-time fulfillment for paid Checkout Sessions
-- created before staged checkout profiles existed.

create table public.legacy_checkout_fulfillments (
  session_id       text primary key,
  email_hash       text check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$'),
  -- This is intentionally not an FK. A verified Auth user may not have a
  -- public mirror yet. The deletion-saga trigger below clears this identifier
  -- while preserving the one-time Session/subscription replay guard.
  user_id          uuid,
  stripe_customer_id text,
  stripe_subscription_id text,
  week_of          date not null,
  status           text not null default 'pending'
    check (status in ('pending', 'awaiting_issue', 'deleting', 'completed', 'retired', 'aborted')),
  lease_token      uuid,
  lease_expires_at timestamptz,
  reconcile_attempt_count integer not null default 0
    check (reconcile_attempt_count between 0 and 8),
  reconcile_last_error_code text check (
    reconcile_last_error_code is null
    or reconcile_last_error_code in (
      'provider_unavailable',
      'winner_state_unresolved',
      'winner_not_live_exact',
      'winner_binding_incomplete',
      'loser_binding_changed',
      'loser_not_exact_alpha',
      'cancellation_not_terminal',
      'database_transient',
      'state_changed'
    )
  ),
  reconcile_dead_lettered_at timestamptz,
  awaiting_issue_until timestamptz,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  identity_scrubbed_at timestamptz,
  check (
    (
      identity_scrubbed_at is null
      and email_hash is not null
      and user_id is not null
      and stripe_customer_id is not null
      and stripe_subscription_id is not null
    )
    or (
      identity_scrubbed_at is not null
      and email_hash is null
      and stripe_customer_id is null
      and stripe_subscription_id is null
      and (
        (
          status = 'awaiting_issue'
          and user_id is not null
          and awaiting_issue_until is not null
        )
        or (
          status = 'deleting'
          and user_id is not null
          and awaiting_issue_until is null
          and lease_token is null
          and lease_expires_at is null
        )
        or (
          status in ('completed', 'retired', 'aborted')
          and user_id is null
          and awaiting_issue_until is null
          and lease_token is null
          and lease_expires_at is null
        )
      )
    )
  ),
  check (status <> 'completed' or completed_at is not null),
  check (status = 'awaiting_issue' or awaiting_issue_until is null),
  check (
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
  )
);

create unique index legacy_checkout_fulfillments_subscription_idx
  on public.legacy_checkout_fulfillments (stripe_subscription_id);

create index legacy_checkout_fulfillments_dead_letter_idx
  on public.legacy_checkout_fulfillments (reconcile_dead_lettered_at)
  where reconcile_dead_lettered_at is not null;

alter table public.legacy_checkout_fulfillments enable row level security;

create or replace function public.block_legacy_checkout_billing_pair_conflict()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is not null then
    if not pg_try_advisory_xact_lock(
      hashtextextended(new.user_id::text, 80425080)
    ) then
      raise exception 'concurrent account operation; retry legacy checkout mutation';
    end if;
  end if;
  if new.stripe_customer_id is null then
    return new;
  end if;
  if not pg_try_advisory_xact_lock(
    hashtextextended('alpha-customer:' || new.stripe_customer_id, 80425082)
  ) then
    raise exception 'concurrent customer operation; retry legacy checkout mutation';
  end if;
  if new.stripe_subscription_id is null then
    return new;
  end if;
  if not pg_try_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || new.stripe_customer_id || ':' || new.stripe_subscription_id,
      80425081
    )
  ) then
    raise exception 'concurrent subscription operation; retry legacy checkout mutation';
  end if;
  if exists (
    select 1
      from public.checkout_profiles p
     where p.stripe_subscription_id = new.stripe_subscription_id
       and (
         new.user_id is null
         or (
           p.owner_user_id is distinct from new.user_id
           and p.provisioned_user_id is distinct from new.user_id
         )
       )
  ) or exists (
    select 1
      from public.users u
     where u.stripe_subscription_id = new.stripe_subscription_id
       and (new.user_id is null or u.id <> new.user_id)
  ) or exists (
    select 1
      from public.account_deletion_sagas s
     where s.stripe_subscription_id = new.stripe_subscription_id
       and (new.user_id is null or s.user_id <> new.user_id)
  ) or exists (
    select 1
      from public.account_deletion_alpha_subscriptions r
     where r.subscription_id = new.stripe_subscription_id
       and (new.user_id is null or r.user_id <> new.user_id)
  ) then
    raise exception 'another identity owns this exact billing pair';
  end if;
  return new;
end;
$$;

create trigger legacy_checkout_billing_pair_conflict
before insert or update of stripe_customer_id, stripe_subscription_id
on public.legacy_checkout_fulfillments
for each row execute function public.block_legacy_checkout_billing_pair_conflict();

-- Once a pending legacy Session is durably classified as the loser, keep the
-- user's canonical pair fixed to the stored winner until the exact loser is
-- terminally aborted. The recorder and this trigger share the owner lock, so
-- a rebind cannot cross provider cancellation authorization.
create or replace function public.block_user_legacy_duplicate_winner_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended(new.id::text, 80425080)) then
    raise exception 'concurrent account operation; retry billing mutation';
  end if;
  if exists (
    select 1
      from public.legacy_checkout_fulfillments l
      join public.refund_reviews r
        on r.session_id = l.session_id
       and r.customer_id = l.stripe_customer_id
       and r.subscription_id = l.stripe_subscription_id
       and r.winner_customer_id is not null
       and r.winner_subscription_id is not null
     where l.user_id = new.id
       and l.status = 'pending'
       and (
         new.stripe_customer_id is distinct from r.winner_customer_id
         or new.stripe_subscription_id is distinct from r.winner_subscription_id
       )
  ) then
    raise exception 'legacy duplicate cleanup freezes the canonical winner';
  end if;
  return new;
end;
$$;

create trigger users_block_legacy_duplicate_winner_mutation
before insert or update of stripe_customer_id, stripe_subscription_id
on public.users
for each row execute function public.block_user_legacy_duplicate_winner_mutation();

create or replace function public.claim_legacy_checkout_fulfillment(
  p_session_id text,
  p_email_hash text,
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_week_of date,
  p_lease_token uuid,
  p_lease_seconds integer default 180
)
returns table (
  decision text,
  claimed_user_id uuid,
  claimed_week_of date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.legacy_checkout_fulfillments%rowtype;
begin
  if p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 300 then
    raise exception 'lease seconds out of range';
  end if;
  if p_session_id is null or p_session_id = ''
     or p_email_hash is null
     or p_email_hash !~ '^[0-9a-f]{64}$'
     or p_user_id is null
     or p_stripe_customer_id is null or p_stripe_customer_id = ''
     or p_stripe_subscription_id is null or p_stripe_subscription_id = ''
     or p_week_of is null
     or p_lease_token is null then
    raise exception 'invalid legacy checkout fulfillment claim';
  end if;

  -- Serialize with prepare_account_deletion(), which uses the same keyed
  -- transaction lock. Without this, its saga-insert trigger can run before an
  -- uncommitted claim row is visible and the claim could commit afterward.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));

  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_user_id
  ) then
    return query select 'aborted'::text, null::uuid, p_week_of;
    return;
  end if;

  insert into public.legacy_checkout_fulfillments (
    session_id,
    email_hash,
    user_id,
    stripe_customer_id,
    stripe_subscription_id,
    week_of,
    status,
    lease_token,
    lease_expires_at
  ) values (
    p_session_id,
    p_email_hash,
    p_user_id,
    p_stripe_customer_id,
    p_stripe_subscription_id,
    p_week_of,
    'pending',
    p_lease_token,
    now() + make_interval(secs => p_lease_seconds)
  )
  on conflict (session_id) do nothing;

  select *
    into v_row
    from public.legacy_checkout_fulfillments
   where session_id = p_session_id
   for update;

  if v_row.reconcile_dead_lettered_at is not null then
    return query select 'manual_review'::text, v_row.user_id, v_row.week_of;
    return;
  end if;

  if v_row.status = 'aborted' then
    return query select 'aborted'::text, v_row.user_id, v_row.week_of;
    return;
  end if;

  if v_row.status in ('completed', 'retired') then
    return query select 'completed'::text, v_row.user_id, v_row.week_of;
    return;
  end if;

  if v_row.status = 'awaiting_issue' then
    if v_row.user_id is distinct from p_user_id
       or v_row.week_of is distinct from p_week_of
       or not exists (
         select 1
           from public.users u
          where u.id = p_user_id
            and u.stripe_customer_id = p_stripe_customer_id
            and u.stripe_subscription_id = p_stripe_subscription_id
            and u.subscribed_at is not null
            and (u.cancelled_at is null or u.cancelled_at > now())
       ) then
      return query select 'profile_mismatch'::text, v_row.user_id, v_row.week_of;
      return;
    end if;
  elsif v_row.email_hash is distinct from p_email_hash
        or v_row.user_id is distinct from p_user_id
        or v_row.stripe_customer_id is distinct from p_stripe_customer_id
        or v_row.stripe_subscription_id is distinct from p_stripe_subscription_id
        or v_row.week_of is distinct from p_week_of then
      return query select 'profile_mismatch'::text, v_row.user_id, v_row.week_of;
      return;
  end if;

  if v_row.lease_token is distinct from p_lease_token
     and v_row.lease_expires_at is not null
     and v_row.lease_expires_at > now() then
    return query select 'in_progress'::text, v_row.user_id, v_row.week_of;
    return;
  end if;

  update public.legacy_checkout_fulfillments
     set lease_token = p_lease_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where session_id = p_session_id;

  return query select 'claimed'::text, v_row.user_id, v_row.week_of;
end;
$$;

-- Every failed claimed reconciliation has a finite automatic retry budget.
-- The database owns the backoff floor and stores only a closed error code.
create or replace function public.fail_legacy_checkout_fulfillment(
  p_session_id text,
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
  v_row public.legacy_checkout_fulfillments%rowtype;
  v_attempt integer;
  v_floor interval;
begin
  if coalesce(p_session_id, '') = ''
     or p_lease_token is null
     or p_retry_at is null
     or p_retry_at < now() + interval '1 minute'
     or p_retry_at > now() + interval '25 hours'
     or p_error_code is null
     or p_error_code not in (
       'provider_unavailable',
       'winner_state_unresolved',
       'winner_not_live_exact',
       'winner_binding_incomplete',
       'loser_binding_changed',
       'loser_not_exact_alpha',
       'cancellation_not_terminal',
       'database_transient',
       'state_changed'
     ) then
    return 'invalid';
  end if;
  select *
    into v_row
    from public.legacy_checkout_fulfillments l
   where l.session_id = p_session_id
   for update;
  if not found then
    return 'missing';
  end if;
  if v_row.reconcile_dead_lettered_at is not null then
    return 'manual_review';
  end if;
  if v_row.status <> 'pending' then
    return 'state_changed';
  end if;
  if v_row.lease_token is distinct from p_lease_token
     or v_row.lease_expires_at is null
     or v_row.lease_expires_at <= now() then
    return 'lease_lost';
  end if;

  v_attempt := least(8, v_row.reconcile_attempt_count + 1);
  if v_attempt = 8 then
    update public.legacy_checkout_fulfillments l
       set lease_token = null,
           lease_expires_at = null,
           reconcile_attempt_count = 8,
           reconcile_last_error_code = p_error_code,
           reconcile_dead_lettered_at = coalesce(
             l.reconcile_dead_lettered_at,
             now()
           )
     where l.session_id = p_session_id
       and l.status = 'pending'
       and l.lease_token = p_lease_token;
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
  update public.legacy_checkout_fulfillments l
     set lease_token = null,
         lease_expires_at = greatest(p_retry_at, now() + v_floor),
         reconcile_attempt_count = v_attempt,
         reconcile_last_error_code = p_error_code,
         reconcile_dead_lettered_at = null
   where l.session_id = p_session_id
     and l.status = 'pending'
     and l.lease_token = p_lease_token;
  return case when found then 'deferred' else 'lease_lost' end;
end;
$$;

create or replace function public.requeue_legacy_checkout_fulfillment(
  p_session_id text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_row public.legacy_checkout_fulfillments%rowtype;
begin
  if coalesce(p_session_id, '') = '' then
    return 'invalid';
  end if;
  select l.user_id
    into v_owner_id
    from public.legacy_checkout_fulfillments l
   where l.session_id = p_session_id;
  if not found then
    return 'missing';
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
    if exists (
      select 1 from public.account_deletion_sagas s where s.user_id = v_owner_id
    ) then
      return 'deletion_pending';
    end if;
  end if;
  select *
    into v_row
    from public.legacy_checkout_fulfillments l
   where l.session_id = p_session_id
   for update;
  if not found then
    return 'missing';
  end if;
  if v_row.reconcile_dead_lettered_at is null then
    return 'not_dead_lettered';
  end if;
  if v_row.status <> 'pending'
     or v_row.user_id is distinct from v_owner_id
     or v_row.reconcile_attempt_count <> 8
     or v_row.reconcile_last_error_code is null
     or v_row.lease_token is not null
     or v_row.lease_expires_at is not null then
    return 'state_changed';
  end if;
  update public.legacy_checkout_fulfillments l
     set reconcile_attempt_count = 0,
         reconcile_last_error_code = null,
         reconcile_dead_lettered_at = null,
         lease_expires_at = now()
   where l.session_id = p_session_id
     and l.reconcile_dead_lettered_at = v_row.reconcile_dead_lettered_at
     and l.reconcile_attempt_count = 8
     and l.status = 'pending';
  return case when found then 'requeued' else 'state_changed' end;
end;
$$;

create or replace function public.count_dead_lettered_legacy_checkout_fulfillments()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
    from public.legacy_checkout_fulfillments l
   where l.reconcile_dead_lettered_at is not null;
$$;

-- The generator persists the canonical issue before consuming this one-time
-- Session. Finish only under the exact lease and only after the canonical user
-- has this exact billing pair, live access, and the issue for the claimed week.
-- The Session ID and completed state remain as the replay guard; all remaining
-- identity and billing fields are scrubbed in the same transaction.
create or replace function public.complete_legacy_checkout_fulfillment(
  p_session_id text,
  p_lease_token uuid,
  p_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id text;
  v_subscription_id text;
  v_row public.legacy_checkout_fulfillments%rowtype;
  v_user public.users%rowtype;
begin
  if coalesce(p_session_id, '') = ''
     or p_lease_token is null
     or p_user_id is null then
    return 'invalid';
  end if;
  select f.stripe_customer_id, f.stripe_subscription_id
    into v_customer_id, v_subscription_id
    from public.legacy_checkout_fulfillments f
   where f.session_id = p_session_id
     and f.user_id = p_user_id;
  if not found then
    return 'lease_lost';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  if v_customer_id is null and v_subscription_id is null then
    select u.stripe_customer_id, u.stripe_subscription_id
      into v_customer_id, v_subscription_id
      from public.users u
     where u.id = p_user_id;
  end if;
  if coalesce(v_customer_id, '') = ''
     or coalesce(v_subscription_id, '') = '' then
    return 'not_ready';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('alpha-customer:' || v_customer_id, 80425082)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || v_customer_id || ':' || v_subscription_id,
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
  select *
    into v_row
    from public.legacy_checkout_fulfillments f
   where f.session_id = p_session_id
   for update;
  if not found
     or v_row.status not in ('pending', 'awaiting_issue')
     or v_row.lease_token is distinct from p_lease_token
     or v_row.user_id is distinct from p_user_id
     or (
       v_row.status = 'pending'
       and (
         v_row.stripe_customer_id is distinct from v_customer_id
         or v_row.stripe_subscription_id is distinct from v_subscription_id
       )
     )
     or (
       v_row.status = 'awaiting_issue'
       and (
         v_row.stripe_customer_id is not null
         or v_row.stripe_subscription_id is not null
       )
     ) then
    return 'lease_lost';
  end if;
  select *
    into v_user
    from public.users u
   where u.id = p_user_id
   for update;
  if not found
     or v_user.stripe_customer_id is distinct from v_customer_id
     or v_user.stripe_subscription_id is distinct from v_subscription_id
     or v_user.subscribed_at is null
     or (v_user.cancelled_at is not null and v_user.cancelled_at <= now())
     or not exists (
       select 1
         from public.issues i
        where i.user_id = p_user_id
          and i.week_of = v_row.week_of
     ) then
    return 'not_ready';
  end if;

  update public.legacy_checkout_fulfillments
     set email_hash = null,
         user_id = null,
         stripe_customer_id = null,
         stripe_subscription_id = null,
         status = 'completed',
         completed_at = coalesce(completed_at, now()),
         lease_token = null,
         lease_expires_at = null,
         reconcile_attempt_count = 0,
         reconcile_last_error_code = null,
         reconcile_dead_lettered_at = null,
         awaiting_issue_until = null,
         identity_scrubbed_at = coalesce(identity_scrubbed_at, now())
   where session_id = p_session_id
     and status in ('pending', 'awaiting_issue')
     and lease_token = p_lease_token;
  return case when found then 'completed' else 'lease_lost' end;
end;
$$;

-- If canonical billing/access is already durable but first-letter generation
-- failed, the full checkout identity is no longer needed. Keep only the
-- pseudonymous owner and claimed week for a short authenticated retry window.
-- Normal scheduled delivery can also create that issue during this window.
create or replace function public.defer_legacy_checkout_fulfillment(
  p_session_id text,
  p_lease_token uuid,
  p_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id text;
  v_subscription_id text;
  v_row public.legacy_checkout_fulfillments%rowtype;
begin
  if coalesce(p_session_id, '') = ''
     or p_lease_token is null
     or p_user_id is null then
    return 'invalid';
  end if;
  select f.stripe_customer_id, f.stripe_subscription_id
    into v_customer_id, v_subscription_id
    from public.legacy_checkout_fulfillments f
   where f.session_id = p_session_id
     and f.user_id = p_user_id;
  if not found
     or coalesce(v_customer_id, '') = ''
     or coalesce(v_subscription_id, '') = '' then
    return 'lease_lost';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  perform pg_advisory_xact_lock(
    hashtextextended('alpha-customer:' || v_customer_id, 80425082)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || v_customer_id || ':' || v_subscription_id,
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
  select *
    into v_row
    from public.legacy_checkout_fulfillments f
   where f.session_id = p_session_id
   for update;
  if not found
     or v_row.status <> 'pending'
     or v_row.lease_token is distinct from p_lease_token
     or v_row.user_id is distinct from p_user_id
     or v_row.stripe_customer_id is distinct from v_customer_id
     or v_row.stripe_subscription_id is distinct from v_subscription_id then
    return 'lease_lost';
  end if;
  if exists (
    select 1
      from public.refund_reviews r
     where r.session_id = p_session_id
       and r.subscription_id = v_subscription_id
       and r.customer_id = v_customer_id
       and r.winner_customer_id is not null
       and r.winner_subscription_id is not null
  ) then
    return 'duplicate_review_pending';
  end if;
  if not exists (
    select 1
      from public.users u
     where u.id = p_user_id
       and u.stripe_customer_id = v_customer_id
       and u.stripe_subscription_id = v_subscription_id
       and u.subscribed_at is not null
       and (u.cancelled_at is null or u.cancelled_at > now())
  ) then
    return 'canonical_access_missing';
  end if;
  if exists (
    select 1
      from public.issues i
     where i.user_id = p_user_id
       and i.week_of = v_row.week_of
  ) then
    return 'issue_ready';
  end if;

  update public.legacy_checkout_fulfillments
     set email_hash = null,
         stripe_customer_id = null,
         stripe_subscription_id = null,
         status = 'awaiting_issue',
         lease_token = null,
         lease_expires_at = null,
         reconcile_attempt_count = 0,
         reconcile_last_error_code = null,
         reconcile_dead_lettered_at = null,
         awaiting_issue_until = now() + interval '24 hours',
         identity_scrubbed_at = coalesce(identity_scrubbed_at, now())
   where session_id = p_session_id
     and status = 'pending'
     and lease_token = p_lease_token;
  return case when found then 'awaiting_issue' else 'lease_lost' end;
end;
$$;

-- Provider classification happens outside Postgres, but authorization to
-- cancel a losing legacy Session must be durable and race-safe. Recheck the
-- exact canonical winner and losing fulfillment under the shared owner plus
-- deterministic Customer/pair locks, then persist the refund obligation in
-- the same transaction. A changed winner returns false and permits no Stripe
-- mutation.
create or replace function public.record_legacy_duplicate_refund_review(
  p_session_id text,
  p_lease_token uuid,
  p_user_id uuid,
  p_winner_customer_id text,
  p_winner_subscription_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.legacy_checkout_fulfillments%rowtype;
  v_customer_a text;
  v_customer_b text;
  v_pair_a text;
  v_pair_b text;
begin
  if coalesce(p_session_id, '') = ''
     or p_lease_token is null
     or p_user_id is null
     or coalesce(p_winner_customer_id, '') = ''
     or coalesce(p_winner_subscription_id, '') = '' then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select *
    into v_row
    from public.legacy_checkout_fulfillments l
   where l.session_id = p_session_id;
  if not found
     or v_row.status <> 'pending'
     or v_row.lease_token is distinct from p_lease_token
     or v_row.user_id is distinct from p_user_id
     or coalesce(v_row.stripe_customer_id, '') = ''
     or coalesce(v_row.stripe_subscription_id, '') = ''
     or (
       v_row.stripe_customer_id = p_winner_customer_id
       and v_row.stripe_subscription_id = p_winner_subscription_id
     ) then
    return false;
  end if;

  v_customer_a := least(
    'alpha-customer:' || v_row.stripe_customer_id,
    'alpha-customer:' || p_winner_customer_id
  );
  v_customer_b := greatest(
    'alpha-customer:' || v_row.stripe_customer_id,
    'alpha-customer:' || p_winner_customer_id
  );
  perform pg_advisory_xact_lock(hashtextextended(v_customer_a, 80425082));
  if v_customer_b <> v_customer_a then
    perform pg_advisory_xact_lock(hashtextextended(v_customer_b, 80425082));
  end if;
  v_pair_a := least(
    'alpha-billing:' || v_row.stripe_customer_id || ':' || v_row.stripe_subscription_id,
    'alpha-billing:' || p_winner_customer_id || ':' || p_winner_subscription_id
  );
  v_pair_b := greatest(
    'alpha-billing:' || v_row.stripe_customer_id || ':' || v_row.stripe_subscription_id,
    'alpha-billing:' || p_winner_customer_id || ':' || p_winner_subscription_id
  );
  perform pg_advisory_xact_lock(hashtextextended(v_pair_a, 80425081));
  if v_pair_b <> v_pair_a then
    perform pg_advisory_xact_lock(hashtextextended(v_pair_b, 80425081));
  end if;

  select *
    into v_row
    from public.legacy_checkout_fulfillments l
   where l.session_id = p_session_id
   for update;
  if not found
     or v_row.status <> 'pending'
     or v_row.lease_token is distinct from p_lease_token
     or v_row.user_id is distinct from p_user_id
     or not exists (
       select 1
         from public.users u
        where u.id = p_user_id
          and u.stripe_customer_id = p_winner_customer_id
          and u.stripe_subscription_id = p_winner_subscription_id
     )
     or exists (
       select 1
         from public.account_deletion_sagas s
        where s.user_id = p_user_id
     ) then
    return false;
  end if;
  -- Preserve an earlier overdue/unfulfillable charge-review reason while
  -- attaching the immutable winner that authorizes recurring cleanup.
  insert into public.refund_reviews (
    session_id,
    subscription_id,
    customer_id,
    winner_subscription_id,
    winner_customer_id,
    reason
  ) values (
    v_row.session_id,
    v_row.stripe_subscription_id,
    v_row.stripe_customer_id,
    p_winner_subscription_id,
    p_winner_customer_id,
    'duplicate_checkout'
  )
  on conflict (session_id, subscription_id) do update
     set winner_subscription_id = coalesce(
           public.refund_reviews.winner_subscription_id,
           excluded.winner_subscription_id
         ),
         winner_customer_id = coalesce(
           public.refund_reviews.winner_customer_id,
           excluded.winner_customer_id
         ),
         updated_at = now()
   where public.refund_reviews.customer_id = excluded.customer_id
     and (
       public.refund_reviews.winner_customer_id is null
       or (
         public.refund_reviews.winner_customer_id = excluded.winner_customer_id
         and public.refund_reviews.winner_subscription_id =
           excluded.winner_subscription_id
       )
     );
  return found;
end;
$$;

-- Return one exact current-checkout winner candidate without authorizing any
-- provider mutation. Application code must freshly prove this pair is one live
-- Alpha subscription before passing it to the locked recorder below.
create or replace function public.find_legacy_current_checkout_conflict(
  p_session_id text,
  p_lease_token uuid,
  p_user_id uuid
)
returns table (
  decision text,
  winner_customer_id text,
  winner_subscription_id text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.legacy_checkout_fulfillments%rowtype;
  v_winner_customer_id text;
  v_winner_subscription_id text;
  v_winner_count integer := 0;
begin
  if coalesce(p_session_id, '') = ''
     or p_lease_token is null
     or p_user_id is null then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select *
    into v_row
    from public.legacy_checkout_fulfillments l
   where l.session_id = p_session_id
   for update;
  if not found
     or v_row.status <> 'pending'
     or v_row.lease_token is distinct from p_lease_token
     or v_row.user_id is distinct from p_user_id
     or coalesce(v_row.stripe_customer_id, '') = ''
     or coalesce(v_row.stripe_subscription_id, '') = '' then
    return query select 'lease_lost'::text, null::text, null::text;
    return;
  end if;
  if exists (
    select 1 from public.account_deletion_sagas s where s.user_id = p_user_id
  ) then
    return query select 'deletion_pending'::text, null::text, null::text;
    return;
  end if;
  select count(*)::integer,
         min(p.stripe_customer_id),
         min(p.stripe_subscription_id)
    into v_winner_count, v_winner_customer_id, v_winner_subscription_id
    from public.checkout_profiles p
   where p.owner_user_id = p_user_id
     and p.provisioned_user_id is null
     and p.billing_state in ('open', 'paid', 'recovering')
     and p.stripe_customer_id is not null
     and p.stripe_subscription_id is not null
     and (
       p.stripe_customer_id is distinct from v_row.stripe_customer_id
       or p.stripe_subscription_id is distinct from v_row.stripe_subscription_id
     );
  if v_winner_count = 0 then
    return query select 'no_conflict'::text, null::text, null::text;
    return;
  end if;
  if v_winner_count <> 1 then
    return query select 'ambiguous'::text, null::text, null::text;
    return;
  end if;
  return query select 'candidate'::text,
    v_winner_customer_id, v_winner_subscription_id;
end;
$$;

-- After the candidate is freshly proved live and exact, recheck both local
-- rows under owner plus deterministic loser/winner locks and only then make
-- the immutable cleanup authorization durable.
create or replace function public.record_legacy_current_checkout_conflict_refund_review(
  p_session_id text,
  p_lease_token uuid,
  p_user_id uuid,
  p_winner_customer_id text,
  p_winner_subscription_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.legacy_checkout_fulfillments%rowtype;
  v_customer_a text;
  v_customer_b text;
  v_pair_a text;
  v_pair_b text;
begin
  if coalesce(p_session_id, '') = ''
     or p_lease_token is null
     or p_user_id is null
     or coalesce(p_winner_customer_id, '') = ''
     or coalesce(p_winner_subscription_id, '') = '' then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select *
    into v_row
    from public.legacy_checkout_fulfillments l
   where l.session_id = p_session_id;
  if not found
     or v_row.status <> 'pending'
     or v_row.lease_token is distinct from p_lease_token
     or v_row.user_id is distinct from p_user_id
     or coalesce(v_row.stripe_customer_id, '') = ''
     or coalesce(v_row.stripe_subscription_id, '') = ''
     or (
       v_row.stripe_customer_id = p_winner_customer_id
       and v_row.stripe_subscription_id = p_winner_subscription_id
     ) then
    return false;
  end if;
  v_customer_a := least(
    'alpha-customer:' || v_row.stripe_customer_id,
    'alpha-customer:' || p_winner_customer_id
  );
  v_customer_b := greatest(
    'alpha-customer:' || v_row.stripe_customer_id,
    'alpha-customer:' || p_winner_customer_id
  );
  perform pg_advisory_xact_lock(hashtextextended(v_customer_a, 80425082));
  if v_customer_b <> v_customer_a then
    perform pg_advisory_xact_lock(hashtextextended(v_customer_b, 80425082));
  end if;
  v_pair_a := least(
    'alpha-billing:' || v_row.stripe_customer_id || ':' || v_row.stripe_subscription_id,
    'alpha-billing:' || p_winner_customer_id || ':' || p_winner_subscription_id
  );
  v_pair_b := greatest(
    'alpha-billing:' || v_row.stripe_customer_id || ':' || v_row.stripe_subscription_id,
    'alpha-billing:' || p_winner_customer_id || ':' || p_winner_subscription_id
  );
  perform pg_advisory_xact_lock(hashtextextended(v_pair_a, 80425081));
  if v_pair_b <> v_pair_a then
    perform pg_advisory_xact_lock(hashtextextended(v_pair_b, 80425081));
  end if;
  if exists (
    select 1 from public.account_deletion_sagas s where s.user_id = p_user_id
  ) then
    return false;
  end if;
  select *
    into v_row
    from public.legacy_checkout_fulfillments l
   where l.session_id = p_session_id
   for update;
  if not found
     or v_row.status <> 'pending'
     or v_row.lease_token is distinct from p_lease_token
     or v_row.user_id is distinct from p_user_id
     or not exists (
       select 1
         from public.checkout_profiles p
        where p.owner_user_id = p_user_id
          and p.provisioned_user_id is null
          and p.billing_state in ('open', 'paid', 'recovering')
          and p.stripe_customer_id = p_winner_customer_id
          and p.stripe_subscription_id = p_winner_subscription_id
     ) then
    return false;
  end if;
  insert into public.refund_reviews (
    session_id,
    subscription_id,
    customer_id,
    winner_subscription_id,
    winner_customer_id,
    reason
  ) values (
    v_row.session_id,
    v_row.stripe_subscription_id,
    v_row.stripe_customer_id,
    p_winner_subscription_id,
    p_winner_customer_id,
    'duplicate_checkout'
  )
  on conflict (session_id, subscription_id) do update
     set winner_subscription_id = coalesce(
           public.refund_reviews.winner_subscription_id,
           excluded.winner_subscription_id
         ),
         winner_customer_id = coalesce(
           public.refund_reviews.winner_customer_id,
           excluded.winner_customer_id
         ),
         updated_at = now()
   where public.refund_reviews.customer_id = excluded.customer_id
     and (
       public.refund_reviews.winner_customer_id is null
       or (
         public.refund_reviews.winner_customer_id = excluded.winner_customer_id
         and public.refund_reviews.winner_subscription_id =
           excluded.winner_subscription_id
       )
     );
  return found;
end;
$$;

-- A newly-paid legacy Session can duplicate a still-live exact Alpha binding
-- already owned by the same account. Application code first persists the
-- refund review and proves terminal cancellation of this new exact pair. This
-- token-gated CAS then consumes the one-time Session and drops its remaining
-- identity fields so retries cannot provision or cancel anything else.
create or replace function public.abort_legacy_checkout_fulfillment(
  p_session_id text,
  p_lease_token uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_winner_customer_id text,
  p_winner_subscription_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_row public.legacy_checkout_fulfillments%rowtype;
  v_current_profile public.checkout_profiles%rowtype;
  v_customer_a text;
  v_customer_b text;
  v_pair_a text;
  v_pair_b text;
begin
  if coalesce(p_session_id, '') = ''
     or p_lease_token is null
     or coalesce(p_stripe_customer_id, '') = ''
     or coalesce(p_stripe_subscription_id, '') = ''
     or coalesce(p_winner_customer_id, '') = ''
     or coalesce(p_winner_subscription_id, '') = ''
     or (
       p_stripe_customer_id = p_winner_customer_id
       and p_stripe_subscription_id = p_winner_subscription_id
     ) then
    return false;
  end if;
  select f.user_id
    into v_user_id
    from public.legacy_checkout_fulfillments f
   where f.session_id = p_session_id;
  if not found or v_user_id is null then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 80425080));
  v_customer_a := least(
    'alpha-customer:' || p_stripe_customer_id,
    'alpha-customer:' || p_winner_customer_id
  );
  v_customer_b := greatest(
    'alpha-customer:' || p_stripe_customer_id,
    'alpha-customer:' || p_winner_customer_id
  );
  perform pg_advisory_xact_lock(hashtextextended(v_customer_a, 80425082));
  if v_customer_b <> v_customer_a then
    perform pg_advisory_xact_lock(hashtextextended(v_customer_b, 80425082));
  end if;
  v_pair_a := least(
    'alpha-billing:' || p_stripe_customer_id || ':' || p_stripe_subscription_id,
    'alpha-billing:' || p_winner_customer_id || ':' || p_winner_subscription_id
  );
  v_pair_b := greatest(
    'alpha-billing:' || p_stripe_customer_id || ':' || p_stripe_subscription_id,
    'alpha-billing:' || p_winner_customer_id || ':' || p_winner_subscription_id
  );
  perform pg_advisory_xact_lock(hashtextextended(v_pair_a, 80425081));
  if v_pair_b <> v_pair_a then
    perform pg_advisory_xact_lock(hashtextextended(v_pair_b, 80425081));
  end if;
  select *
    into v_row
    from public.legacy_checkout_fulfillments f
   where f.session_id = p_session_id
   for update;
  if not found
     or v_row.user_id is distinct from v_user_id
     or v_row.status <> 'pending'
     or v_row.lease_token is distinct from p_lease_token
     or v_row.stripe_customer_id is distinct from p_stripe_customer_id
     or v_row.stripe_subscription_id is distinct from p_stripe_subscription_id
     or not exists (
       select 1
         from public.refund_reviews r
        where r.session_id = p_session_id
          and r.subscription_id = p_stripe_subscription_id
          and r.customer_id = p_stripe_customer_id
          and r.winner_customer_id = p_winner_customer_id
          and r.winner_subscription_id = p_winner_subscription_id
     ) then
    return false;
  end if;

  -- A webhook can discover a duplicate only after the loser profile has
  -- already been provisioned and scrubbed. Current profile recovery cannot
  -- claim that state, so the webhook recorder creates this legacy obligation.
  -- Once application code has freshly proven the stored winner and terminal
  -- loser, atomically end the exact provisioned loser profile before consuming
  -- the fallback row. A missing profile is the ordinary legacy case.
  select *
    into v_current_profile
    from public.checkout_profiles p
   where p.stripe_session_id = p_session_id
     and p.stripe_customer_id = p_stripe_customer_id
     and p.stripe_subscription_id = p_stripe_subscription_id
   for update;
  if found then
    if v_current_profile.provisioned_user_id is distinct from v_user_id
       or (
         v_current_profile.owner_user_id is not null
         and v_current_profile.owner_user_id <> v_user_id
       ) then
      return false;
    end if;

    if v_current_profile.billing_state in ('open', 'paid', 'recovering') then
      update public.checkout_profiles p
         set billing_state = 'ended',
             session_creation_lease_expires_at = null,
             session_creation_replay_token = null,
             session_creation_replay_lease_expires_at = null,
             recovery_lease_token = null,
             recovery_lease_expires_at = null,
             recovery_previous_state = null,
             recovery_attempt_count = 0,
             recovery_last_error_code = null,
             recovery_dead_lettered_at = null,
             email = null,
             first_name = null,
             city = null,
             job_blurb = null,
             project_blurb = null,
             fun_blurb = null,
             birthday = null,
             gender = null,
             topics = null,
             theme = null,
             raw_profile_scrubbed_at = coalesce(p.raw_profile_scrubbed_at, now()),
             updated_at = now()
       where p.id = v_current_profile.id
         and p.stripe_session_id = p_session_id
         and p.stripe_customer_id = p_stripe_customer_id
         and p.stripe_subscription_id = p_stripe_subscription_id
         and p.provisioned_user_id = v_user_id
         and (
           p.owner_user_id is null
           or p.owner_user_id = v_user_id
         )
         and p.billing_state in ('open', 'paid', 'recovering');
      if not found then
        return false;
      end if;
    elsif v_current_profile.billing_state not in ('ended', 'expired') then
      return false;
    end if;
  end if;

  update public.legacy_checkout_fulfillments
     set email_hash = null,
         user_id = null,
         stripe_customer_id = null,
         stripe_subscription_id = null,
         status = 'aborted',
         lease_token = null,
         lease_expires_at = null,
         reconcile_attempt_count = 0,
         reconcile_last_error_code = null,
         reconcile_dead_lettered_at = null,
         identity_scrubbed_at = now()
   where session_id = p_session_id
     and status = 'pending'
     and lease_token = p_lease_token;
  return found;
end;
$$;

-- Select only crash-window rows that already have the exact durable refund
-- obligation. This prevents ordinary pending legacy first-letter claims from
-- starving the bounded finalizer and returns no email plaintext.
create or replace function public.list_pending_legacy_duplicate_finalizations(
  p_limit integer default 3
)
returns table (
  session_id text,
  email_hash text,
  user_id uuid,
  stripe_customer_id text,
  stripe_subscription_id text,
  winner_customer_id text,
  winner_subscription_id text,
  week_of date,
  lease_expires_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select l.session_id,
         l.email_hash,
         l.user_id,
         l.stripe_customer_id,
         l.stripe_subscription_id,
         r.winner_customer_id,
         r.winner_subscription_id,
         l.week_of,
         l.lease_expires_at
    from public.legacy_checkout_fulfillments l
    join public.refund_reviews r
      on r.session_id = l.session_id
     and r.subscription_id = l.stripe_subscription_id
     and r.customer_id = l.stripe_customer_id
     and r.winner_customer_id is not null
     and r.winner_subscription_id is not null
   where p_limit is not null
     and p_limit between 1 and 10
     and l.status = 'pending'
     and l.reconcile_dead_lettered_at is null
   order by r.created_at
   limit case
     when p_limit between 1 and 10 then p_limit
     else 0
   end;
$$;

-- An account-deletion request wins over any legacy first-letter work and
-- invalidates a live lease. Identity and exact billing refs remain only while
-- the durable deletion saga needs them to cancel and verify that subscription.
create or replace function public.abort_legacy_checkout_for_account_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.legacy_checkout_fulfillments
     set status = case
           when status = 'awaiting_issue' then 'deleting'
           else 'aborted'
         end,
         lease_token = null,
         lease_expires_at = null,
         reconcile_attempt_count = 0,
         reconcile_last_error_code = null,
         reconcile_dead_lettered_at = null,
         awaiting_issue_until = null
   where user_id = new.user_id;
  return new;
end;
$$;

-- List every abandoned legacy lease without plaintext email. Ordinary rows
-- can be completed from canonical database proof alone. Rows with a durable
-- duplicate refund review additionally require fresh terminal Stripe proof
-- before the exact cancellation path can be finalized.
create or replace function public.list_stale_pending_legacy_fulfillments(
  p_now timestamptz,
  p_limit integer default 3
)
returns table (
  session_id text,
  email_hash text,
  user_id uuid,
  stripe_customer_id text,
  stripe_subscription_id text,
  week_of date,
  lease_expires_at timestamptz,
  duplicate_refund_review boolean,
  duplicate_winner_customer_id text,
  duplicate_winner_subscription_id text
)
language sql
security definer
set search_path = public
stable
as $$
  select l.session_id,
         l.email_hash,
         l.user_id,
         l.stripe_customer_id,
         l.stripe_subscription_id,
         l.week_of,
         l.lease_expires_at,
         r.session_id is not null as duplicate_refund_review,
         r.winner_customer_id as duplicate_winner_customer_id,
         r.winner_subscription_id as duplicate_winner_subscription_id
    from public.legacy_checkout_fulfillments l
    left join public.refund_reviews r
      on r.session_id = l.session_id
     and r.subscription_id = l.stripe_subscription_id
     and r.customer_id = l.stripe_customer_id
     and r.winner_customer_id is not null
     and r.winner_subscription_id is not null
   where p_now is not null
     and p_limit is not null
     and p_limit between 1 and 10
     and l.status = 'pending'
     and l.reconcile_dead_lettered_at is null
     and coalesce(l.lease_expires_at, l.created_at + interval '5 minutes') <= p_now
   order by coalesce(l.lease_expires_at, l.created_at), l.created_at
   limit case
     when p_limit between 1 and 10 then p_limit
     else 0
   end;
$$;

create trigger account_deletion_abort_legacy_checkout
after insert on public.account_deletion_sagas
for each row execute function public.abort_legacy_checkout_for_account_deletion();

-- Once billing and Auth deletion have both completed, Session ID plus the
-- terminal status are sufficient to prevent replay. Remove every remaining
-- subscriber and billing identifier from the legacy guard.
create or replace function public.scrub_legacy_checkout_after_account_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.state = 'complete' and old.state is distinct from 'complete' then
    update public.legacy_checkout_fulfillments
       set email_hash = null,
           user_id = null,
           stripe_customer_id = null,
           stripe_subscription_id = null,
           status = 'aborted',
           lease_token = null,
           lease_expires_at = null,
           reconcile_attempt_count = 0,
           reconcile_last_error_code = null,
           reconcile_dead_lettered_at = null,
           awaiting_issue_until = null,
           identity_scrubbed_at = coalesce(identity_scrubbed_at, now())
     where user_id = new.user_id;
  end if;
  return new;
end;
$$;

create or replace function public.list_legacy_fulfillments_awaiting_issue(
  p_now timestamptz,
  p_limit integer default 3
)
returns table (
  session_id text,
  user_id uuid,
  week_of date,
  awaiting_issue_until timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select l.session_id, l.user_id, l.week_of, l.awaiting_issue_until
    from public.legacy_checkout_fulfillments l
   where p_now is not null
     and p_limit is not null
     and p_limit between 1 and 10
     and l.status = 'awaiting_issue'
     and coalesce(l.lease_expires_at, l.created_at) <= p_now
   order by coalesce(l.lease_expires_at, l.created_at), l.awaiting_issue_until, l.created_at
   limit case
     when p_limit between 1 and 10 then p_limit
     else 0
   end;
$$;

-- Consume a deferred row once normal delivery creates its issue. If no issue
-- arrives within the short retry window, retire the last pseudonymous owner
-- binding. Canonical account access remains the source for later generation.
create or replace function public.settle_legacy_fulfillment_awaiting_issue(
  p_session_id text,
  p_now timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_row public.legacy_checkout_fulfillments%rowtype;
  v_issue_ready boolean := false;
begin
  if coalesce(p_session_id, '') = '' or p_now is null then
    return 'invalid';
  end if;
  select l.user_id
    into v_owner_id
    from public.legacy_checkout_fulfillments l
   where l.session_id = p_session_id
     and l.status = 'awaiting_issue';
  if not found or v_owner_id is null then
    return 'not_awaiting';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
  select *
    into v_row
    from public.legacy_checkout_fulfillments l
   where l.session_id = p_session_id
   for update;
  if not found
     or v_row.status <> 'awaiting_issue'
     or v_row.user_id is distinct from v_owner_id
     or v_row.awaiting_issue_until is null then
    return 'not_awaiting';
  end if;
  v_issue_ready := exists (
    select 1
      from public.users u
      join public.issues i
        on i.user_id = u.id
       and i.week_of = v_row.week_of
     where u.id = v_owner_id
       and u.subscribed_at is not null
       and (u.cancelled_at is null or u.cancelled_at > p_now)
  );
  if not v_issue_ready and v_row.awaiting_issue_until > p_now then
    update public.legacy_checkout_fulfillments
       set lease_token = null,
           lease_expires_at = least(
             v_row.awaiting_issue_until,
             p_now + interval '5 minutes'
           )
     where session_id = p_session_id
       and status = 'awaiting_issue'
       and user_id = v_owner_id;
    return 'waiting';
  end if;

  update public.legacy_checkout_fulfillments
     set user_id = null,
         status = case when v_issue_ready then 'completed' else 'retired' end,
         completed_at = case
           when v_issue_ready then coalesce(completed_at, p_now)
           else completed_at
         end,
         lease_token = null,
         lease_expires_at = null,
         reconcile_attempt_count = 0,
         reconcile_last_error_code = null,
         reconcile_dead_lettered_at = null,
         awaiting_issue_until = null,
         identity_scrubbed_at = coalesce(identity_scrubbed_at, p_now)
   where session_id = p_session_id
     and status = 'awaiting_issue'
     and user_id = v_owner_id;
  if not found then
    return 'not_awaiting';
  end if;
  return case when v_issue_ready then 'completed' else 'retired' end;
end;
$$;

create trigger account_deletion_scrub_legacy_checkout
after update of state on public.account_deletion_sagas
for each row execute function public.scrub_legacy_checkout_after_account_deletion();

revoke all on table public.legacy_checkout_fulfillments from anon, authenticated;
revoke all on function public.claim_legacy_checkout_fulfillment(
  text, text, uuid, text, text, date, uuid, integer
) from public, anon, authenticated;
revoke all on function public.fail_legacy_checkout_fulfillment(text, uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.requeue_legacy_checkout_fulfillment(text)
  from public, anon, authenticated;
revoke all on function public.count_dead_lettered_legacy_checkout_fulfillments()
  from public, anon, authenticated;
revoke all on function public.abort_legacy_checkout_for_account_deletion()
  from public, anon, authenticated;
revoke all on function public.abort_legacy_checkout_fulfillment(text, uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.complete_legacy_checkout_fulfillment(text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.defer_legacy_checkout_fulfillment(text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.record_legacy_duplicate_refund_review(text, uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.find_legacy_current_checkout_conflict(text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.record_legacy_current_checkout_conflict_refund_review(text, uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.list_pending_legacy_duplicate_finalizations(integer)
  from public, anon, authenticated;
revoke all on function public.list_stale_pending_legacy_fulfillments(timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.list_legacy_fulfillments_awaiting_issue(timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.settle_legacy_fulfillment_awaiting_issue(text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.scrub_legacy_checkout_after_account_deletion()
  from public, anon, authenticated;
revoke all on function public.block_legacy_checkout_billing_pair_conflict()
  from public, anon, authenticated;
revoke all on function public.block_user_legacy_duplicate_winner_mutation()
  from public, anon, authenticated;
grant execute on function public.claim_legacy_checkout_fulfillment(
  text, text, uuid, text, text, date, uuid, integer
) to service_role;
grant execute on function public.fail_legacy_checkout_fulfillment(text, uuid, text, timestamptz)
  to service_role;
grant execute on function public.requeue_legacy_checkout_fulfillment(text)
  to service_role;
grant execute on function public.count_dead_lettered_legacy_checkout_fulfillments()
  to service_role;
grant execute on function public.abort_legacy_checkout_fulfillment(text, uuid, text, text, text, text)
  to service_role;
grant execute on function public.complete_legacy_checkout_fulfillment(text, uuid, uuid)
  to service_role;
grant execute on function public.defer_legacy_checkout_fulfillment(text, uuid, uuid)
  to service_role;
grant execute on function public.record_legacy_duplicate_refund_review(text, uuid, uuid, text, text)
  to service_role;
grant execute on function public.find_legacy_current_checkout_conflict(text, uuid, uuid)
  to service_role;
grant execute on function public.record_legacy_current_checkout_conflict_refund_review(text, uuid, uuid, text, text)
  to service_role;
grant execute on function public.list_pending_legacy_duplicate_finalizations(integer)
  to service_role;
grant execute on function public.list_stale_pending_legacy_fulfillments(timestamptz, integer)
  to service_role;
grant execute on function public.list_legacy_fulfillments_awaiting_issue(timestamptz, integer)
  to service_role;
grant execute on function public.settle_legacy_fulfillment_awaiting_issue(text, timestamptz)
  to service_role;

-- Extend the shared maintenance precheck after the legacy table exists.
-- Every stale ordinary lease stays visible until canonical access plus its
-- issue are proven and the row is scrubbed. A duplicate refund obligation is
-- visible regardless of refund-review status or current lease age so resolving
-- the human refund decision cannot hide an unfinished cancellation finalizer.
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
                and l.status = 'pending'
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
           )
      )
  end;
$$;

revoke all on function public.alpha_scheduled_maintenance_due(timestamptz)
  from public, anon, authenticated;
grant execute on function public.alpha_scheduled_maintenance_due(timestamptz)
  to service_role;
