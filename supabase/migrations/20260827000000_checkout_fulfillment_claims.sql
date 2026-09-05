-- Alpha Round 80: bind paid checkout fulfillment to the profile that created
-- the Checkout Session, and consume each paid session exactly once.
--
-- Both tables are service-role only. The confirmed Auth owner's validated
-- profile is written directly to public.users before billing starts.
-- checkout_profiles holds only a pseudonymous reservation for its exact
-- Checkout Session and billing pair. The reservation remains until Stripe
-- proves the Session expired or its exact subscription ended, so age alone can
-- never permit a second recurring subscription. checkout_fulfillments is the
-- durable replay guard for Checkout Session IDs.

create table public.checkout_profiles (
  id              uuid primary key default gen_random_uuid(),
  email_hash      text check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$'),
  -- Kept nullable for defensive terminal cleanup. Current checkout staging
  -- writes these fields only to public.users and leaves this copy empty.
  email           text check (email is null or char_length(email) between 3 and 254),
  first_name      text check (first_name is null or char_length(first_name) between 1 and 60),
  city            text check (city is null or char_length(city) <= 120),
  job_blurb       text check (job_blurb is null or char_length(job_blurb) <= 500),
  project_blurb   text check (project_blurb is null or char_length(project_blurb) <= 600),
  fun_blurb       text check (fun_blurb is null or char_length(fun_blurb) <= 500),
  birthday        date,
  gender          text check (gender is null or gender in ('male', 'female')),
  topics          text[] check (topics is null or cardinality(topics) = 5),
  theme           text check (theme is null or char_length(theme) <= 30),
  browser_nonce_hash text check (browser_nonce_hash is null or char_length(browser_nonce_hash) = 64),
  -- Deliberately not an FK. If an authenticated owner deletes their account
  -- while checkout is open, retaining this id makes fulfillment fail closed
  -- instead of silently attaching the payment to a newly-created account.
  owner_user_id   uuid,
  provisioned_user_id uuid references public.users(id) on delete set null,
  stripe_session_id text unique,
  session_creation_started_at timestamptz,
  stripe_session_expires_at timestamptz,
  stripe_session_business_expires_at timestamptz,
  stripe_session_origin text,
  stripe_session_price_id text,
  stripe_session_params_version integer,
  stripe_session_customer_email_ciphertext text check (
    stripe_session_customer_email_ciphertext is null
    or (
      stripe_session_customer_email_ciphertext like 'v1.%'
      and char_length(stripe_session_customer_email_ciphertext) between 20 and 512
    )
  ),
  session_creation_lease_expires_at timestamptz,
  session_creation_replay_token uuid,
  session_creation_replay_lease_expires_at timestamptz,
  session_creation_reconciled_at timestamptz,
  session_creation_terminal_reason text check (
    session_creation_terminal_reason is null
    or session_creation_terminal_reason in (
      'provider_rejected_expired_params',
      'operator_proved_no_create'
    )
  ),
  session_creation_terminal_request_id text,
  recovery_lease_token uuid,
  recovery_lease_expires_at timestamptz,
  recovery_previous_state text check (
    recovery_previous_state is null
    or recovery_previous_state in ('open', 'paid')
  ),
  recovery_attempt_count smallint not null default 0
    check (recovery_attempt_count between 0 and 8),
  recovery_last_error_code text check (
    recovery_last_error_code is null
    or recovery_last_error_code in (
      'provider_unavailable',
      'provider_rate_limited',
      'database_transient',
      'unexpected',
      'winner_binding_changed',
      'winner_missing',
      'winner_not_live_exact_alpha',
      'review_winner_missing',
      'loser_binding_changed',
      'loser_missing_unproven',
      'loser_not_exact_alpha',
      'profile_identity_invalid'
    )
  ),
  recovery_dead_lettered_at timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  billing_state   text not null default 'open'
    check (billing_state in ('open', 'creating', 'paid', 'recovering', 'deleting', 'ended', 'expired')),
  owner_deletion_requested_at timestamptz,
  owner_deleted_at timestamptz,
  identity_scrubbed_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  raw_profile_scrubbed_at timestamptz,
  -- Five-day operational deadline inside the public seven-day outer limit. It
  -- schedules provider-backed recovery. It is never permission to release a
  -- bound billing lock. A Sessionless open reservation can retire locally.
  expires_at      timestamptz not null default (now() + interval '5 days'),
  check (
    billing_state <> 'paid'
    or (
      stripe_session_id is not null
      and stripe_customer_id is not null
      and stripe_subscription_id is not null
    )
  ),
  check (
    (
      session_creation_started_at is null
      and stripe_session_expires_at is null
      and stripe_session_business_expires_at is null
      and stripe_session_origin is null
      and stripe_session_price_id is null
      and stripe_session_params_version is null
    )
    or (
      session_creation_started_at is not null
      and stripe_session_expires_at is not null
      and stripe_session_business_expires_at is not null
      and stripe_session_origin is not null
      and stripe_session_price_id is not null
      and stripe_session_params_version = 1
    )
  ),
  check (
    billing_state <> 'creating'
    or (
      stripe_session_id is null
      and stripe_session_customer_email_ciphertext is not null
      and session_creation_lease_expires_at is not null
    )
  ),
  check (
    stripe_session_customer_email_ciphertext is null
    or (
      billing_state in ('creating', 'deleting')
      and stripe_session_id is null
    )
  ),
  check (
    (
      session_creation_replay_token is null
      and session_creation_replay_lease_expires_at is null
    )
    or (
      session_creation_replay_token is not null
      and session_creation_replay_lease_expires_at is not null
      and billing_state in ('creating', 'deleting')
      and stripe_session_id is null
    )
  ),
  check (
    (
      session_creation_reconciled_at is null
      and session_creation_terminal_reason is null
      and session_creation_terminal_request_id is null
    )
    or (
      session_creation_reconciled_at is not null
      and (
        (
          session_creation_terminal_reason = 'provider_rejected_expired_params'
          and session_creation_terminal_request_id like 'req_%'
        )
        or (
          session_creation_terminal_reason = 'operator_proved_no_create'
          and session_creation_terminal_request_id
            ~ '^(req|evt|case|ticket)_[A-Za-z0-9_-]+$'
        )
      )
      and billing_state = 'expired'
      and stripe_session_id is null
      and stripe_session_customer_email_ciphertext is null
    )
  ),
  check (
    (
      billing_state = 'recovering'
      and recovery_lease_token is not null
      and recovery_lease_expires_at is not null
      and recovery_previous_state is not null
    )
    or (
      billing_state <> 'recovering'
      and recovery_lease_token is null
      and recovery_lease_expires_at is null
      and recovery_previous_state is null
    )
  ),
  check (
    (recovery_attempt_count = 0 and recovery_last_error_code is null)
    or (recovery_attempt_count > 0 and recovery_last_error_code is not null)
  ),
  check (
    recovery_dead_lettered_at is null
    or (
      recovery_attempt_count = 8
      and billing_state in ('open', 'paid')
      and provisioned_user_id is null
      and recovery_lease_token is null
      and recovery_lease_expires_at is null
      and recovery_previous_state is null
    )
  ),
  check (
    (
      raw_profile_scrubbed_at is null
      and email is not null
      and first_name is not null
      and topics is not null
      and theme is not null
    )
    or (
      raw_profile_scrubbed_at is not null
      and email is null
      and first_name is null
      and city is null
      and job_blurb is null
      and project_blurb is null
      and fun_blurb is null
      and birthday is null
      and gender is null
      and topics is null
      and theme is null
    )
  ),
  check (
    (
      identity_scrubbed_at is null
      and email_hash is not null
      and browser_nonce_hash is not null
    )
    or (
      identity_scrubbed_at is not null
      and billing_state in ('ended', 'expired')
      and email_hash is null
      and browser_nonce_hash is null
      and stripe_customer_id is null
      and stripe_subscription_id is null
      and owner_user_id is null
      and provisioned_user_id is null
    )
  )
);

create index checkout_profiles_operational_expiry_idx
  on public.checkout_profiles (expires_at)
  where billing_state in ('open', 'paid', 'recovering');

-- Serialize every open or paid Alpha checkout by canonical email while still
-- allowing a proven-ended subscriber to create a new intent. The raw address
-- can then be scrubbed without releasing this one-subscription reservation.
create unique index checkout_profiles_active_email_idx
  on public.checkout_profiles (email_hash)
  where billing_state in ('open', 'creating', 'paid', 'recovering', 'deleting');

-- Email can change while a signed-in checkout is open. Stable Auth ownership
-- is the second serialization key, so one account cannot hold two recurring
-- Alpha intents under its old and new addresses at the same time.
create unique index checkout_profiles_active_owner_idx
  on public.checkout_profiles (owner_user_id)
  where owner_user_id is not null
    and billing_state in ('open', 'creating', 'paid', 'recovering', 'deleting');

create index checkout_profiles_customer_state_idx
  on public.checkout_profiles (stripe_customer_id, billing_state);

create index checkout_profiles_creation_lease_idx
  on public.checkout_profiles (session_creation_lease_expires_at)
  where billing_state in ('creating', 'deleting')
    and stripe_session_id is null;

create index checkout_profiles_recovery_lease_idx
  on public.checkout_profiles (recovery_lease_expires_at)
  where billing_state = 'recovering';

create index checkout_profiles_recovery_dead_letter_idx
  on public.checkout_profiles (recovery_dead_lettered_at)
  where recovery_dead_lettered_at is not null;

create index checkout_profiles_terminal_scrub_idx
  on public.checkout_profiles (updated_at)
  where billing_state in ('ended', 'expired')
    and identity_scrubbed_at is null;

alter table public.checkout_profiles enable row level security;

-- Create the durable Checkout Session replay guard before any of the account
-- deletion or profile-recovery functions declare its row type. PostgreSQL
-- validates %rowtype declarations when each function is created.
create table public.checkout_fulfillments (
  session_id       text primary key,
  profile_id       uuid not null unique references public.checkout_profiles(id) on delete restrict,
  email_hash       text check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$'),
  week_of          date not null,
  status           text not null default 'pending' check (status in ('pending', 'completed', 'aborted')),
  lease_token      uuid,
  lease_expires_at timestamptz,
  user_id          uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  identity_scrubbed_at timestamptz,
  check (
    (identity_scrubbed_at is null and email_hash is not null)
    or (
      identity_scrubbed_at is not null
      and status in ('completed', 'aborted')
      and email_hash is null
      and user_id is null
      and lease_token is null
      and lease_expires_at is null
    )
  )
);

create index checkout_fulfillments_terminal_scrub_idx
  on public.checkout_fulfillments (completed_at)
  where status = 'completed' and identity_scrubbed_at is null;

alter table public.checkout_fulfillments enable row level security;

-- Missing the bounded Stripe idempotency replay window is not terminal proof.
-- Keep a PII-free operator obligation before returning that decision. The
-- checkout reservation and encrypted exact request stay locked until an exact
-- Session is validated and bound through the ordinary path, or authoritative
-- provider evidence proves that no Session was ever created.
create table public.checkout_creation_reviews (
  profile_id          uuid primary key references public.checkout_profiles(id) on delete restrict,
  reason              text not null default 'replay_window_missed'
    check (reason in ('replay_window_missed', 'invite_mode_transition')),
  status              text not null default 'pending'
    check (status in ('pending', 'resolved_session', 'resolved_no_create')),
  resolved_session_id text,
  proof_reference     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  check (
    (
      status = 'pending'
      and resolved_session_id is null
      and proof_reference is null
      and resolved_at is null
    )
    or (
      status = 'resolved_session'
      and coalesce(resolved_session_id, '') <> ''
      and proof_reference is null
      and resolved_at is not null
    )
    or (
      status = 'resolved_no_create'
      and resolved_session_id is null
      and proof_reference ~ '^(req|evt|case|ticket)_[A-Za-z0-9_-]+$'
      and resolved_at is not null
    )
  )
);

create index checkout_creation_reviews_pending_created_idx
  on public.checkout_creation_reviews (created_at)
  where status = 'pending';

alter table public.checkout_creation_reviews enable row level security;

-- The later delivery-suppression migration also declares this with IF NOT
-- EXISTS. It is introduced here because the deletion saga must freeze and
-- cancel the exact subscription before Auth can be removed.
alter table public.users
  add column if not exists stripe_subscription_id text;

-- Account deletion is a durable saga because Stripe and Supabase Auth cannot
-- share one transaction. This tombstone contains no email or profile text.
-- It keeps only the pseudonymous Auth id and the exact Alpha billing binding
-- needed to retry safely after a timeout or process crash.
create table public.account_deletion_sagas (
  user_id                   uuid primary key,
  stripe_customer_id        text,
  stripe_subscription_id    text,
  state                     text not null default 'prepared'
    check (state in ('prepared', 'billing_clean', 'auth_delete_started', 'complete')),
  requested_at              timestamptz not null default now(),
  billing_cleaned_at        timestamptz,
  support_deleted_at        timestamptz,
  delivery_policy_settled_at timestamptz,
  auth_delete_started_at    timestamptz,
  completed_at              timestamptz,
  purge_after               timestamptz,
  reconcile_next_attempt_at timestamptz not null default now(),
  reconcile_attempt_count   integer not null default 0
    check (reconcile_attempt_count >= 0),
  updated_at                timestamptz not null default now(),
  check (stripe_subscription_id is null or stripe_customer_id is not null),
  check (
    purge_after is null
    or (
      state = 'complete'
      and completed_at is not null
      and purge_after >= completed_at
    )
  )
);

create index account_deletion_sagas_completed_purge_idx
  on public.account_deletion_sagas (purge_after)
  where state = 'complete' and purge_after is not null;

create index account_deletion_sagas_reconcile_due_idx
  on public.account_deletion_sagas (reconcile_next_attempt_at, updated_at)
  where state in ('prepared', 'billing_clean', 'auth_delete_started');

create unique index account_deletion_sagas_exact_subscription_idx
  on public.account_deletion_sagas (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- Every Alpha subscription discovered while deleting is recorded before it is
-- cancelled. A retry therefore retains the exact customer/subscription pair
-- and the last verified Stripe status without retaining subscriber PII.
create table public.account_deletion_alpha_subscriptions (
  user_id          uuid not null references public.account_deletion_sagas(user_id) on delete restrict,
  subscription_id  text not null,
  customer_id      text not null,
  terminal_status  text not null,
  discovered_at    timestamptz not null default now(),
  verified_at      timestamptz not null default now(),
  primary key (user_id, subscription_id)
);

create unique index account_deletion_alpha_subscription_reservation_idx
  on public.account_deletion_alpha_subscriptions (subscription_id);

-- Cancellation can end a renewal safely while the already-captured first
-- charge still needs a human refund decision. Keep that operational obligation
-- durable and PII-free instead of relying on a best-effort alert.
create table public.refund_reviews (
  session_id       text not null,
  subscription_id  text not null,
  customer_id      text not null,
  winner_subscription_id text,
  winner_customer_id text,
  reason            text not null check (
    reason in ('duplicate_checkout', 'unfulfillable_checkout', 'overdue_checkout')
  ),
  status            text not null default 'pending' check (
    status in ('pending', 'reviewed', 'refunded', 'not_required')
  ),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  primary key (session_id, subscription_id),
  check (
    (status = 'pending' and resolved_at is null)
    or (status <> 'pending' and resolved_at is not null)
  ),
  check (
    (winner_customer_id is null and winner_subscription_id is null)
    or (
      winner_customer_id is not null
      and winner_subscription_id is not null
      and (
        winner_customer_id <> customer_id
        or winner_subscription_id <> subscription_id
      )
    )
  )
);

create index refund_reviews_pending_created_idx
  on public.refund_reviews (created_at)
  where status = 'pending';

create index refund_reviews_current_cleanup_loser_idx
  on public.refund_reviews (customer_id, subscription_id)
  where winner_customer_id is not null
    and winner_subscription_id is not null;

alter table public.account_deletion_sagas enable row level security;
alter table public.account_deletion_alpha_subscriptions enable row level security;
alter table public.refund_reviews enable row level security;

-- A checkout that was already in flight may finish while deletion is being
-- prepared. Moving its profile to `deleting` makes both fulfillment paths
-- reject it. This trigger also closes the smaller race where a signed-in
-- reader starts a new checkout immediately after the deletion tombstone is
-- created.
create or replace function public.block_checkout_for_deleting_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
begin
  if new.owner_user_id is not null
     and new.provisioned_user_id is not null
     and new.owner_user_id <> new.provisioned_user_id then
    raise exception 'checkout owner and provisioned user must match';
  end if;
  if tg_op = 'UPDATE'
     and old.billing_state = 'recovering'
     and new.billing_state <> 'recovering'
     and new.recovery_lease_token is not null then
    raise exception 'checkout recovery lease must be settled or failed atomically';
  end if;
  if tg_op = 'UPDATE'
     and old.billing_state = 'deleting'
     and new.billing_state = 'ended' then
    if new.stripe_customer_id is null
       or new.stripe_subscription_id is null
       or not exists (
         select 1
           from public.account_deletion_alpha_subscriptions r
          where r.user_id = coalesce(old.owner_user_id, old.provisioned_user_id)
            and r.customer_id = new.stripe_customer_id
            and r.subscription_id = new.stripe_subscription_id
            and r.terminal_status in (
              'canceled',
              'incomplete_expired',
              'resource_missing',
              'no_longer_alpha'
            )
       ) then
      raise exception 'deleting checkout requires a durable terminal subscription proof';
    end if;
  end if;
  v_owner_id := coalesce(new.owner_user_id, new.provisioned_user_id);
  if v_owner_id is not null then
    -- UPDATE triggers run after the target row is already locked. Never wait
    -- here for deletion's owner lock, because deletion takes owner then row.
    if not pg_try_advisory_xact_lock(
      hashtextextended(v_owner_id::text, 80425080)
    ) then
      raise exception 'concurrent account operation; retry checkout mutation';
    end if;
    if new.billing_state in ('open', 'creating', 'paid', 'recovering')
       and exists (
      select 1
        from public.account_deletion_sagas s
       where s.user_id = v_owner_id
    ) then
      raise exception 'account deletion is already in progress';
    end if;
  end if;
  return new;
end;
$$;

create trigger checkout_profiles_block_deleting_owner
before insert or update of billing_state, owner_user_id, provisioned_user_id
on public.checkout_profiles
for each row execute function public.block_checkout_for_deleting_owner();

-- Once a saga snapshots the billing identity, no concurrent webhook may swap
-- it underneath the cancellation pass. Ordinary cancellation mirror updates
-- that leave both exact ids unchanged still pass.
create or replace function public.block_billing_rebind_during_account_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    new.stripe_customer_id is distinct from old.stripe_customer_id
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
  ) and exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = old.id
  ) then
    raise exception 'billing identity is frozen during account deletion';
  end if;
  return new;
end;
$$;

create trigger users_block_billing_rebind_during_account_deletion
before update of stripe_customer_id, stripe_subscription_id
on public.users
for each row execute function public.block_billing_rebind_during_account_deletion();

-- Long-running generation and webhook work may retain a stable user id before
-- prepare_account_deletion starts. Taking the same lock inside the write closes
-- the check/spend/write race and prevents profile or issue resurrection.
create or replace function public.block_user_mutation_during_account_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended(new.id::text, 80425080)) then
    raise exception 'concurrent account operation; retry user mutation';
  end if;
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = new.id
  ) then
    raise exception 'account deletion blocks user mutation';
  end if;
  return new;
end;
$$;

create trigger users_block_mutation_during_account_deletion
before insert or update on public.users
for each row execute function public.block_user_mutation_during_account_deletion();

create or replace function public.block_issue_mutation_during_account_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not pg_try_advisory_xact_lock(
    hashtextextended(new.user_id::text, 80425080)
  ) then
    raise exception 'concurrent account operation; retry issue mutation';
  end if;
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = new.user_id
  ) then
    raise exception 'account deletion blocks issue mutation';
  end if;
  return new;
end;
$$;

create trigger issues_block_mutation_during_account_deletion
before insert or update on public.issues
for each row execute function public.block_issue_mutation_during_account_deletion();

-- A signed-in support submission can race the privacy-cleanup step. Prevent a
-- linked ticket from being inserted or reassigned after deletion preparation.
-- Anonymous tickets have no trustworthy account id and remain covered by the
-- exact confirmed-email deletion performed before Auth removal.
create or replace function public.block_support_ticket_mutation_during_account_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is null then
    return new;
  end if;
  if not pg_try_advisory_xact_lock(
    hashtextextended(new.user_id::text, 80425080)
  ) then
    raise exception 'concurrent account operation; retry support mutation';
  end if;
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = new.user_id
  ) then
    raise exception 'account deletion blocks support mutation';
  end if;
  return new;
end;
$$;

create trigger support_tickets_block_mutation_during_account_deletion
before insert or update of user_id on public.support_tickets
for each row execute function public.block_support_ticket_mutation_during_account_deletion();

-- Exact billing-pair reservations use one shared advisory lock across account
-- deletion, hard-deadline recovery, and webhook/user binding. This prevents an
-- exact Subscription from being adopted after another transaction authorized
-- cancellation or recovery.
create or replace function public.block_user_billing_pair_conflict()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended(new.id::text, 80425080)) then
    raise exception 'concurrent account operation; retry billing mutation';
  end if;
  -- Once a current checkout is durably classified as the duplicate loser,
  -- freeze this owner's canonical billing pair to the recorded winner until
  -- the exact pending profile is terminally settled. This closes the local
  -- rebind window between database authorization and Stripe cancellation.
  if exists (
    select 1
      from public.checkout_profiles p
      join public.refund_reviews r
       on r.session_id = p.stripe_session_id
       and r.customer_id = p.stripe_customer_id
       and r.subscription_id = p.stripe_subscription_id
       and r.winner_customer_id is not null
       and r.winner_subscription_id is not null
     where p.owner_user_id = new.id
       and p.provisioned_user_id is null
       and p.billing_state in ('open', 'paid', 'recovering')
       and (
         new.stripe_customer_id is distinct from r.winner_customer_id
         or new.stripe_subscription_id is distinct from r.winner_subscription_id
       )
  ) then
    raise exception 'current duplicate cleanup freezes the canonical winner';
  end if;
  if new.stripe_customer_id is null then
    return new;
  end if;
  if not pg_try_advisory_xact_lock(
    hashtextextended('alpha-customer:' || new.stripe_customer_id, 80425082)
  ) then
    raise exception 'concurrent customer operation; retry billing mutation';
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
    raise exception 'concurrent subscription operation; retry billing mutation';
  end if;
  -- A paid current checkout reservation for this same confirmed owner wins
  -- over a legacy Session repair. Both writes take the owner lock above, so a
  -- legacy REST mutation cannot slip between the current checkout's prior read
  -- and its canonical compare-and-set.
  if exists (
    select 1
      from public.checkout_profiles p
     where p.owner_user_id = new.id
       and p.provisioned_user_id is null
       and p.billing_state in ('paid', 'recovering')
       and p.stripe_customer_id is not null
       and p.stripe_subscription_id is not null
       and (
         p.stripe_customer_id is distinct from new.stripe_customer_id
         or p.stripe_subscription_id is distinct from new.stripe_subscription_id
       )
       and not exists (
         select 1
           from public.refund_reviews r
          where r.session_id = p.stripe_session_id
            and r.customer_id = p.stripe_customer_id
            and r.subscription_id = p.stripe_subscription_id
            and r.winner_customer_id = new.stripe_customer_id
            and r.winner_subscription_id = new.stripe_subscription_id
       )
  ) then
    raise exception 'active current checkout owns this account billing transition';
  end if;
  if exists (
    select 1
      from public.checkout_profiles p
     where p.billing_state in ('open', 'creating', 'paid', 'recovering', 'deleting')
       and p.stripe_customer_id = new.stripe_customer_id
       and p.stripe_subscription_id = new.stripe_subscription_id
       and p.owner_user_id is distinct from new.id
       and p.provisioned_user_id is distinct from new.id
  ) then
    raise exception 'checkout recovery owns this exact billing pair';
  end if;
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id <> new.id
       and s.stripe_subscription_id = new.stripe_subscription_id
  ) or exists (
    select 1
      from public.account_deletion_alpha_subscriptions r
     where r.user_id <> new.id
       and r.subscription_id = new.stripe_subscription_id
  ) then
    raise exception 'account deletion owns this exact billing pair';
  end if;
  return new;
end;
$$;

create trigger users_block_billing_pair_conflict
before insert or update of stripe_customer_id, stripe_subscription_id
on public.users
for each row execute function public.block_user_billing_pair_conflict();

create or replace function public.block_checkout_billing_pair_conflict()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
begin
  v_owner_id := coalesce(new.owner_user_id, new.provisioned_user_id);
  if v_owner_id is not null then
    if not pg_try_advisory_xact_lock(
      hashtextextended(v_owner_id::text, 80425080)
    ) then
      raise exception 'concurrent account operation; retry checkout mutation';
    end if;
  end if;
  if new.stripe_customer_id is null then
    return new;
  end if;
  if not pg_try_advisory_xact_lock(
    hashtextextended('alpha-customer:' || new.stripe_customer_id, 80425082)
  ) then
    raise exception 'concurrent customer operation; retry checkout mutation';
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
    raise exception 'concurrent subscription operation; retry checkout mutation';
  end if;
  if exists (
    select 1
      from public.checkout_profiles p
     where p.id <> new.id
       and p.billing_state = 'recovering'
       and p.stripe_customer_id = new.stripe_customer_id
       and p.stripe_subscription_id = new.stripe_subscription_id
  ) then
    raise exception 'another checkout recovery owns this exact billing pair';
  end if;
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.stripe_subscription_id = new.stripe_subscription_id
       and (v_owner_id is null or s.user_id <> v_owner_id)
  ) or exists (
    select 1
      from public.account_deletion_alpha_subscriptions r
     where r.subscription_id = new.stripe_subscription_id
       and (v_owner_id is null or r.user_id <> v_owner_id)
  ) then
    raise exception 'account deletion owns this exact billing pair';
  end if;
  return new;
end;
$$;

create trigger checkout_profiles_block_billing_pair_conflict
before insert or update of stripe_customer_id, stripe_subscription_id
on public.checkout_profiles
for each row execute function public.block_checkout_billing_pair_conflict();

-- Checkout staging and account deletion use the same transaction-scoped lock
-- for the confirmed Auth owner. The validated profile is written to the
-- canonical user before billing starts. checkout_profiles retains only the
-- pseudonymous Session reservation, so no raw onboarding copy needs a later
-- privacy scrub if the buyer abandons Checkout.
create or replace function public.stage_checkout_profile(
  p_id uuid,
  p_email_hash text,
  p_email text,
  p_first_name text,
  p_city text,
  p_job_blurb text,
  p_project_blurb text,
  p_fun_blurb text,
  p_birthday date,
  p_gender text,
  p_topics text[],
  p_theme text,
  p_browser_nonce_hash text,
  p_owner_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_id is null
     or p_owner_user_id is null
     or p_email_hash is null
     or p_email_hash !~ '^[0-9a-f]{64}$'
     or p_browser_nonce_hash is null
     or p_browser_nonce_hash !~ '^[0-9a-f]{64}$'
     or coalesce(p_email, '') = ''
     or coalesce(p_first_name, '') = ''
     or p_topics is null
     or cardinality(p_topics) <> 5
     or coalesce(p_theme, '') = '' then
    return 'invalid';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_user_id::text, 80425080)
  );
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_owner_user_id
  ) then
    return 'deletion_pending';
  end if;

  update public.users u
     set email = p_email,
         first_name = p_first_name,
         city = p_city,
         job_blurb = p_job_blurb,
         project_blurb = p_project_blurb,
         fun_blurb = p_fun_blurb,
         birthday = p_birthday,
         gender = p_gender,
         topics = p_topics,
         theme = p_theme,
         stripe_email_sync_pending_at = case
           when lower(btrim(u.email)) is distinct from p_email
                and u.stripe_customer_id is not null
             then coalesce(u.stripe_email_sync_pending_at, now())
           else u.stripe_email_sync_pending_at
         end,
         updated_at = now()
   where u.id = p_owner_user_id;
  if not found then
    return 'owner_missing';
  end if;

  insert into public.checkout_profiles (
    id,
    email_hash,
    browser_nonce_hash,
    owner_user_id,
    billing_state,
    raw_profile_scrubbed_at
  ) values (
    p_id,
    p_email_hash,
    p_browser_nonce_hash,
    p_owner_user_id,
    'open',
    now()
  );
  return 'staged';
end;
$$;

create or replace function public.begin_checkout_session_creation(
  p_profile_id uuid,
  p_origin text,
  p_price_id text,
  p_params_version integer,
  p_customer_email_ciphertext text
)
returns table (
  decision text,
  session_started_at timestamptz,
  session_expires_at timestamptz,
  session_business_expires_at timestamptz,
  session_origin text,
  session_price_id text,
  session_params_version integer,
  session_customer_email_ciphertext text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_state text;
  v_session_id text;
  v_started_at timestamptz;
  v_expires_at timestamptz;
  v_business_expires_at timestamptz;
  v_origin text;
  v_price_id text;
  v_params_version integer;
  v_customer_email_ciphertext text;
begin
  if p_profile_id is null
     or coalesce(p_origin, '') !~ '^https?://[^[:space:]]+$'
     or char_length(p_origin) > 500
     or coalesce(p_price_id, '') = ''
     or p_params_version is distinct from 1
     or coalesce(p_customer_email_ciphertext, '') not like 'v1.%'
     or char_length(p_customer_email_ciphertext) > 512 then
    return query select 'invalid'::text,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::text, null::text, null::integer, null::text;
    return;
  end if;
  select p.owner_user_id
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return query select 'missing'::text,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::text, null::text, null::integer, null::text;
    return;
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
  end if;

  select p.billing_state,
         p.stripe_session_id,
         p.session_creation_started_at,
         p.stripe_session_expires_at,
         p.stripe_session_business_expires_at,
         p.stripe_session_origin,
         p.stripe_session_price_id,
         p.stripe_session_params_version,
         p.stripe_session_customer_email_ciphertext
    into v_state,
         v_session_id,
         v_started_at,
         v_expires_at,
         v_business_expires_at,
         v_origin,
         v_price_id,
         v_params_version,
         v_customer_email_ciphertext
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return query select 'missing'::text,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::text, null::text, null::integer, null::text;
    return;
  end if;
  if v_owner_id is not null and exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = v_owner_id
  ) then
    return query select 'deletion_pending'::text,
      v_started_at, v_expires_at, v_business_expires_at,
      v_origin, v_price_id, v_params_version, v_customer_email_ciphertext;
    return;
  end if;
  if v_session_id is not null then
    return query select 'already_bound'::text,
      v_started_at, v_expires_at, v_business_expires_at,
      v_origin, v_price_id, v_params_version, v_customer_email_ciphertext;
    return;
  end if;
  if v_state = 'creating' then
    if v_expires_at is null
       or v_started_at is null
       or v_business_expires_at is null
       or v_origin is null
       or v_price_id is null
       or v_params_version <> 1
       or v_customer_email_ciphertext is null then
      return query select 'invalid'::text,
        v_started_at, v_expires_at, v_business_expires_at,
        v_origin, v_price_id, v_params_version, v_customer_email_ciphertext;
      return;
    end if;
    return query select 'ready'::text,
      v_started_at, v_expires_at, v_business_expires_at,
      v_origin, v_price_id, v_params_version, v_customer_email_ciphertext;
    return;
  end if;
  if v_state <> 'open' then
    return query select 'rejected'::text,
      v_started_at, v_expires_at, v_business_expires_at,
      v_origin, v_price_id, v_params_version, v_customer_email_ciphertext;
    return;
  end if;

  v_started_at := date_trunc('second', now());
  v_expires_at := v_started_at + interval '23 hours';
  v_business_expires_at := v_started_at + interval '31 minutes';
  update public.checkout_profiles
     set billing_state = 'creating',
         session_creation_started_at = v_started_at,
         stripe_session_expires_at = v_expires_at,
         stripe_session_business_expires_at = v_business_expires_at,
         stripe_session_origin = p_origin,
         stripe_session_price_id = p_price_id,
         stripe_session_params_version = p_params_version,
         stripe_session_customer_email_ciphertext = p_customer_email_ciphertext,
         session_creation_lease_expires_at = v_started_at + interval '2 minutes',
         updated_at = now()
   where id = p_profile_id
     and billing_state = 'open'
     and stripe_session_id is null;
  if found then
    return query select 'ready'::text,
      v_started_at, v_expires_at, v_business_expires_at,
      p_origin, p_price_id, p_params_version, p_customer_email_ciphertext;
  else
    return query select 'rejected'::text,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::text, null::text, null::integer, null::text;
  end if;
end;
$$;

create or replace function public.bind_checkout_session(
  p_profile_id uuid,
  p_session_id text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_state text;
  v_session_id text;
  v_deleting boolean;
begin
  if coalesce(p_session_id, '') = '' then
    return 'rejected';
  end if;
  select p.owner_user_id
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return 'missing';
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
  end if;

  select p.billing_state, p.stripe_session_id
    into v_state, v_session_id
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return 'missing';
  end if;
  if v_session_id is not null then
    if v_session_id <> p_session_id then
      return 'conflict';
    end if;
    return case when v_state = 'deleting' then 'deletion_pending' else 'bound' end;
  end if;

  v_deleting := v_owner_id is not null and exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = v_owner_id
  );
  if v_deleting and v_state in ('creating', 'deleting') then
    update public.checkout_profiles
       set stripe_session_id = p_session_id,
           billing_state = 'deleting',
           session_creation_lease_expires_at = null,
           session_creation_replay_token = null,
           session_creation_replay_lease_expires_at = null,
           stripe_session_customer_email_ciphertext = null,
           updated_at = now()
     where id = p_profile_id
       and stripe_session_id is null
       and billing_state in ('creating', 'deleting');
    return case when found then 'deletion_pending' else 'rejected' end;
  end if;
  if not v_deleting and v_state = 'creating' then
    update public.checkout_profiles
       set stripe_session_id = p_session_id,
           billing_state = 'open',
           session_creation_lease_expires_at = null,
           session_creation_replay_token = null,
           session_creation_replay_lease_expires_at = null,
           stripe_session_customer_email_ciphertext = null,
           updated_at = now()
     where id = p_profile_id
       and stripe_session_id is null
       and billing_state = 'creating';
    return case when found then 'bound' else 'rejected' end;
  end if;
  return 'rejected';
end;
$$;

create or replace function public.settle_checkout_session_expiration(
  p_profile_id uuid,
  p_session_id text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_profile public.checkout_profiles%rowtype;
  v_fulfillment public.checkout_fulfillments%rowtype;
begin
  if p_profile_id is null or coalesce(p_session_id, '') = '' then
    return 'invalid';
  end if;
  select coalesce(p.owner_user_id, p.provisioned_user_id)
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return 'profile_missing';
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
  end if;
  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return 'profile_missing';
  end if;
  if v_profile.stripe_session_id is distinct from p_session_id then
    return 'session_conflict';
  end if;
  if v_profile.billing_state = 'expired' then
    return 'settled';
  end if;
  if v_profile.billing_state not in ('open', 'deleting')
     or v_profile.stripe_customer_id is not null
     or v_profile.stripe_subscription_id is not null then
    return 'billing_conflict';
  end if;
  update public.checkout_profiles p
     set billing_state = 'expired',
         session_creation_lease_expires_at = null,
         session_creation_replay_token = null,
         session_creation_replay_lease_expires_at = null,
         stripe_session_customer_email_ciphertext = null,
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
   where p.id = p_profile_id
     and p.stripe_session_id = p_session_id
     and p.billing_state in ('open', 'deleting')
     and p.stripe_customer_id is null
     and p.stripe_subscription_id is null;
  return case when found then 'settled' else 'billing_conflict' end;
end;
$$;

-- Invite-only mode must not replay an uncertain provider create. Move one due
-- row into the existing operator queue without clearing its encrypted exact
-- request, binding fields, or provider leases. A later operator resolution
-- still has to bind the exact Session or supply authoritative no-create proof.
create or replace function public.hold_checkout_session_creation_for_invite_review(
  p_profile_id uuid,
  p_now timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_profile public.checkout_profiles%rowtype;
  v_review_status text;
begin
  if p_profile_id is null or p_now is null then
    return 'invalid';
  end if;

  select coalesce(p.owner_user_id, p.provisioned_user_id)
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return 'profile_missing';
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
  end if;

  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return 'profile_missing';
  end if;
  if coalesce(v_profile.owner_user_id, v_profile.provisioned_user_id)
       is distinct from v_owner_id then
    return 'profile_owner_conflict';
  end if;
  if v_profile.stripe_session_id is not null then
    return 'already_bound';
  end if;
  if v_profile.billing_state not in ('creating', 'deleting') then
    return 'not_reviewable';
  end if;

  select r.status
    into v_review_status
    from public.checkout_creation_reviews r
   where r.profile_id = p_profile_id;
  if found then
    return case
      when v_review_status = 'pending' then 'review_required'
      else 'review_conflict'
    end;
  end if;
  if v_profile.session_creation_lease_expires_at is null
     or v_profile.session_creation_lease_expires_at > p_now then
    return 'not_due';
  end if;
  if v_profile.session_creation_replay_token is not null
     and v_profile.session_creation_replay_lease_expires_at > p_now then
    return 'in_progress';
  end if;

  insert into public.checkout_creation_reviews (
    profile_id,
    reason,
    status
  ) values (
    p_profile_id,
    'invite_mode_transition',
    'pending'
  );
  return 'review_required';
end;
$$;

-- A request can die after Stripe accepts Session creation but before the
-- Session id is bound. A bounded worker claims the persisted exact request,
-- replays it under the original idempotency key, and either binds Stripe's
-- returned Session or records the provider's authoritative no-create result.
create or replace function public.claim_checkout_session_creation_replay(
  p_profile_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 180
)
returns table (
  decision text,
  owner_user_id uuid,
  prior_billing_state text,
  session_started_at timestamptz,
  session_expires_at timestamptz,
  session_business_expires_at timestamptz,
  session_origin text,
  session_price_id text,
  session_params_version integer,
  session_customer_email_ciphertext text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_profile public.checkout_profiles%rowtype;
begin
  if p_profile_id is null
     or p_lease_token is null
     or p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 300 then
    return query select 'invalid'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::text, null::text, null::integer, null::text;
    return;
  end if;

  select coalesce(p.owner_user_id, p.provisioned_user_id)
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return query select 'profile_missing'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::text, null::text, null::integer, null::text;
    return;
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
  end if;

  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return query select 'profile_missing'::text, v_owner_id, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::text, null::text, null::integer, null::text;
    return;
  end if;
  if coalesce(v_profile.owner_user_id, v_profile.provisioned_user_id)
       is distinct from v_owner_id then
    return query select 'profile_owner_conflict'::text, v_owner_id,
      v_profile.billing_state, v_profile.session_creation_started_at,
      v_profile.stripe_session_expires_at,
      v_profile.stripe_session_business_expires_at,
      v_profile.stripe_session_origin, v_profile.stripe_session_price_id,
      v_profile.stripe_session_params_version,
      v_profile.stripe_session_customer_email_ciphertext;
    return;
  end if;
  if v_profile.stripe_session_id is not null then
    return query select 'already_bound'::text, v_owner_id,
      v_profile.billing_state, v_profile.session_creation_started_at,
      v_profile.stripe_session_expires_at,
      v_profile.stripe_session_business_expires_at,
      v_profile.stripe_session_origin, v_profile.stripe_session_price_id,
      v_profile.stripe_session_params_version, null::text;
    return;
  end if;
  if v_profile.billing_state not in ('creating', 'deleting') then
    return query select 'not_replayable'::text, v_owner_id,
      v_profile.billing_state, v_profile.session_creation_started_at,
      v_profile.stripe_session_expires_at,
      v_profile.stripe_session_business_expires_at,
      v_profile.stripe_session_origin, v_profile.stripe_session_price_id,
      v_profile.stripe_session_params_version, null::text;
    return;
  end if;
  if exists (
    select 1
      from public.checkout_creation_reviews review
     where review.profile_id = p_profile_id
       and review.status = 'pending'
  ) then
    return query select 'manual_review'::text, v_owner_id,
      v_profile.billing_state, v_profile.session_creation_started_at,
      v_profile.stripe_session_expires_at,
      v_profile.stripe_session_business_expires_at,
      v_profile.stripe_session_origin, v_profile.stripe_session_price_id,
      v_profile.stripe_session_params_version, null::text;
    return;
  end if;
  if v_profile.session_creation_lease_expires_at is null
     or v_profile.session_creation_lease_expires_at > now() then
    return query select 'not_due'::text, v_owner_id,
      v_profile.billing_state, v_profile.session_creation_started_at,
      v_profile.stripe_session_expires_at,
      v_profile.stripe_session_business_expires_at,
      v_profile.stripe_session_origin, v_profile.stripe_session_price_id,
      v_profile.stripe_session_params_version,
      v_profile.stripe_session_customer_email_ciphertext;
    return;
  end if;
  if v_profile.session_creation_started_at is null
     or v_profile.stripe_session_expires_at is null
     or v_profile.stripe_session_business_expires_at is null
     or v_profile.stripe_session_origin is null
     or v_profile.stripe_session_price_id is null
     or v_profile.stripe_session_params_version <> 1
     or v_profile.stripe_session_customer_email_ciphertext is null then
    return query select 'invalid_persisted_params'::text, v_owner_id,
      v_profile.billing_state, v_profile.session_creation_started_at,
      v_profile.stripe_session_expires_at,
      v_profile.stripe_session_business_expires_at,
      v_profile.stripe_session_origin, v_profile.stripe_session_price_id,
      v_profile.stripe_session_params_version,
      v_profile.stripe_session_customer_email_ciphertext;
    return;
  end if;
  -- Stripe retains idempotency results for at least 24 hours. Stop short of
  -- that boundary. Beyond it, an expired-parameter error cannot prove an old
  -- Session never existed, so the row remains fail-closed for manual review.
  if now() >= v_profile.session_creation_started_at + interval '23 hours 30 minutes' then
    insert into public.checkout_creation_reviews (
      profile_id,
      reason,
      status
    ) values (
      p_profile_id,
      'replay_window_missed',
      'pending'
    )
    on conflict (profile_id) do update
      set updated_at = now()
      where checkout_creation_reviews.status = 'pending';
    return query select 'replay_window_missed'::text, v_owner_id,
      v_profile.billing_state, v_profile.session_creation_started_at,
      v_profile.stripe_session_expires_at,
      v_profile.stripe_session_business_expires_at,
      v_profile.stripe_session_origin, v_profile.stripe_session_price_id,
      v_profile.stripe_session_params_version,
      v_profile.stripe_session_customer_email_ciphertext;
    return;
  end if;
  if v_profile.session_creation_replay_token = p_lease_token
     and v_profile.session_creation_replay_lease_expires_at > now() then
    return query select 'claimed'::text, v_owner_id,
      v_profile.billing_state, v_profile.session_creation_started_at,
      v_profile.stripe_session_expires_at,
      v_profile.stripe_session_business_expires_at,
      v_profile.stripe_session_origin, v_profile.stripe_session_price_id,
      v_profile.stripe_session_params_version,
      v_profile.stripe_session_customer_email_ciphertext;
    return;
  end if;
  if v_profile.session_creation_replay_token is not null
     and v_profile.session_creation_replay_lease_expires_at > now() then
    return query select 'in_progress'::text, v_owner_id,
      v_profile.billing_state, v_profile.session_creation_started_at,
      v_profile.stripe_session_expires_at,
      v_profile.stripe_session_business_expires_at,
      v_profile.stripe_session_origin, v_profile.stripe_session_price_id,
      v_profile.stripe_session_params_version, null::text;
    return;
  end if;

  update public.checkout_profiles p
     set session_creation_replay_token = p_lease_token,
         session_creation_replay_lease_expires_at =
           now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where p.id = p_profile_id
     and p.stripe_session_id is null
     and p.billing_state in ('creating', 'deleting')
     and (
       p.session_creation_replay_token is null
       or p.session_creation_replay_lease_expires_at <= now()
     );
  if not found then
    return query select 'in_progress'::text, v_owner_id,
      v_profile.billing_state, v_profile.session_creation_started_at,
      v_profile.stripe_session_expires_at,
      v_profile.stripe_session_business_expires_at,
      v_profile.stripe_session_origin, v_profile.stripe_session_price_id,
      v_profile.stripe_session_params_version, null::text;
    return;
  end if;
  return query select 'claimed'::text, v_owner_id,
    v_profile.billing_state, v_profile.session_creation_started_at,
    v_profile.stripe_session_expires_at,
    v_profile.stripe_session_business_expires_at,
    v_profile.stripe_session_origin, v_profile.stripe_session_price_id,
    v_profile.stripe_session_params_version,
    v_profile.stripe_session_customer_email_ciphertext;
end;
$$;

create or replace function public.settle_checkout_session_creation_replay(
  p_profile_id uuid,
  p_lease_token uuid,
  p_expected_session_expires_at timestamptz,
  p_terminal_reason text,
  p_provider_request_id text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_profile public.checkout_profiles%rowtype;
begin
  if p_profile_id is null
     or p_lease_token is null
     or p_expected_session_expires_at is null
     or p_terminal_reason is null
     or p_terminal_reason <> 'provider_rejected_expired_params'
     or coalesce(p_provider_request_id, '') !~ '^req_[A-Za-z0-9_]+$'
     or char_length(p_provider_request_id) > 255 then
    return 'invalid';
  end if;
  select coalesce(p.owner_user_id, p.provisioned_user_id)
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return 'profile_missing';
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
  end if;
  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return 'profile_missing';
  end if;
  if v_profile.billing_state not in ('creating', 'deleting')
     or v_profile.stripe_session_id is not null
     or v_profile.session_creation_replay_token is distinct from p_lease_token then
    return 'lease_lost';
  end if;
  if v_profile.stripe_session_expires_at is distinct from p_expected_session_expires_at
     or v_profile.session_creation_started_at is null
     or now() >= v_profile.session_creation_started_at + interval '23 hours 45 minutes' then
    insert into public.checkout_creation_reviews (
      profile_id,
      reason,
      status
    ) values (
      p_profile_id,
      'replay_window_missed',
      'pending'
    )
    on conflict (profile_id) do update
      set updated_at = now()
      where checkout_creation_reviews.status = 'pending';
    return 'replay_window_missed';
  end if;

  update public.checkout_profiles p
     set billing_state = 'expired',
         session_creation_lease_expires_at = null,
         session_creation_replay_token = null,
         session_creation_replay_lease_expires_at = null,
         session_creation_reconciled_at = now(),
         session_creation_terminal_reason = p_terminal_reason,
         session_creation_terminal_request_id = p_provider_request_id,
         stripe_session_customer_email_ciphertext = null,
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
   where p.id = p_profile_id
     and p.billing_state in ('creating', 'deleting')
     and p.stripe_session_id is null
     and p.session_creation_replay_token = p_lease_token;
  return case when found then 'settled' else 'lease_lost' end;
end;
$$;

create or replace function public.release_checkout_session_creation_replay(
  p_profile_id uuid,
  p_lease_token uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
begin
  if p_profile_id is null or p_lease_token is null then
    return 'invalid';
  end if;
  select coalesce(p.owner_user_id, p.provisioned_user_id)
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return 'profile_missing';
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
  end if;
  update public.checkout_profiles p
     set session_creation_lease_expires_at = now() + interval '5 minutes',
         session_creation_replay_token = null,
         session_creation_replay_lease_expires_at = null,
         updated_at = now()
   where p.id = p_profile_id
     and p.stripe_session_id is null
     and p.billing_state in ('creating', 'deleting')
     and p.session_creation_replay_token = p_lease_token;
  return case when found then 'released' else 'lease_lost' end;
end;
$$;

-- Close a missed-window review only after the exact Session has passed the
-- ordinary application validation and bind path. A crash between binding and
-- this marker is safe because the exact durable Session id is the retry proof.
create or replace function public.complete_checkout_creation_review_with_session(
  p_profile_id uuid,
  p_session_id text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_profile public.checkout_profiles%rowtype;
  v_review public.checkout_creation_reviews%rowtype;
begin
  if p_profile_id is null
     or coalesce(p_session_id, '') !~ '^cs_[A-Za-z0-9_]+$'
     or char_length(p_session_id) > 255 then
    return 'invalid';
  end if;
  select coalesce(p.owner_user_id, p.provisioned_user_id)
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return 'profile_missing';
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
  end if;
  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  select *
    into v_review
    from public.checkout_creation_reviews r
   where r.profile_id = p_profile_id
   for update;
  if not found then
    return 'review_missing';
  end if;
  if v_review.status = 'resolved_session'
     and v_review.resolved_session_id = p_session_id then
    return 'resolved';
  end if;
  if v_review.status <> 'pending' then
    return 'review_conflict';
  end if;
  if v_profile.id is null
     or v_profile.stripe_session_id is distinct from p_session_id
     or v_profile.stripe_session_customer_email_ciphertext is not null
     or v_profile.session_creation_replay_token is not null
     or v_profile.session_creation_replay_lease_expires_at is not null then
    return 'session_not_bound';
  end if;
  update public.checkout_creation_reviews
     set status = 'resolved_session',
         resolved_session_id = p_session_id,
         resolved_at = now(),
         updated_at = now()
   where profile_id = p_profile_id
     and status = 'pending';
  return case when found then 'resolved' else 'review_conflict' end;
end;
$$;

-- Age is never no-create proof. This terminal path requires a controlled,
-- PII-free reference to authoritative Stripe request, event, or support-case
-- evidence. It then releases the billing lock and encrypted email atomically.
create or replace function public.resolve_checkout_creation_review_no_create(
  p_profile_id uuid,
  p_proof_reference text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_profile public.checkout_profiles%rowtype;
  v_review public.checkout_creation_reviews%rowtype;
begin
  if p_profile_id is null
     or coalesce(p_proof_reference, '')
       !~ '^(req|evt|case|ticket)_[A-Za-z0-9_-]+$'
     or char_length(p_proof_reference) > 255 then
    return 'invalid';
  end if;
  select coalesce(p.owner_user_id, p.provisioned_user_id)
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return 'profile_missing';
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
  end if;
  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  select *
    into v_review
    from public.checkout_creation_reviews r
   where r.profile_id = p_profile_id
   for update;
  if not found then
    return 'review_missing';
  end if;
  if v_review.status = 'resolved_no_create'
     and v_review.proof_reference = p_proof_reference then
    return 'resolved';
  end if;
  if v_review.status <> 'pending' then
    return 'review_conflict';
  end if;
  if v_profile.id is null
     or v_profile.stripe_session_id is not null
     or v_profile.stripe_customer_id is not null
     or v_profile.stripe_subscription_id is not null
     or v_profile.billing_state not in ('creating', 'deleting')
     or v_profile.session_creation_started_at is null
     or now() < v_profile.session_creation_started_at + interval '23 hours 30 minutes' then
    return 'billing_not_releasable';
  end if;

  update public.checkout_profiles p
     set billing_state = 'expired',
         session_creation_lease_expires_at = null,
         session_creation_replay_token = null,
         session_creation_replay_lease_expires_at = null,
         session_creation_reconciled_at = now(),
         session_creation_terminal_reason = 'operator_proved_no_create',
         session_creation_terminal_request_id = p_proof_reference,
         stripe_session_customer_email_ciphertext = null,
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
   where p.id = p_profile_id
     and p.billing_state in ('creating', 'deleting')
     and p.stripe_session_id is null
     and p.stripe_customer_id is null
     and p.stripe_subscription_id is null;
  if not found then
    return 'billing_not_releasable';
  end if;
  update public.checkout_creation_reviews
     set status = 'resolved_no_create',
         proof_reference = p_proof_reference,
         resolved_at = now(),
         updated_at = now()
   where profile_id = p_profile_id
     and status = 'pending';
  if not found then
    raise exception 'checkout creation review changed during terminal resolution';
  end if;
  return 'resolved';
end;
$$;

create or replace function public.count_pending_checkout_creation_reviews()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
    from public.checkout_creation_reviews
   where status = 'pending';
$$;

-- Automated replay must never keep selecting a row that has already crossed
-- into the controlled operator-review lane. The pending review remains visible
-- to the maintenance red signal, but only an explicit service resolution may
-- touch that profile again.
create or replace function public.list_stale_checkout_session_creations(
  p_now timestamptz,
  p_limit integer default 5
)
returns table (profile_id uuid)
language sql
security definer
set search_path = public
stable
as $$
  select p.id
    from public.checkout_profiles p
   where p_now is not null
     and p_limit is not null
     and p_limit between 1 and 10
     and p.billing_state in ('creating', 'deleting')
     and p.stripe_session_id is null
     and p.session_creation_lease_expires_at <= p_now
     and not exists (
       select 1
         from public.checkout_creation_reviews review
        where review.profile_id = p.id
          and review.status = 'pending'
     )
   order by p.session_creation_lease_expires_at, p.id
   limit p_limit;
$$;

-- Atomically creates (or resumes) the deletion tombstone, freezes every
-- profile tied to this user, and scrubs all staged profile PII before any Auth
-- deletion can occur. Session-less rows that never started provider creation
-- are locally terminal. A timed-out create/bind gap stays nonterminal because
-- its lost Session could have completed and created a live subscription. Bound rows
-- remain in `deleting` until Stripe proves the Session expired or the exact
-- resulting Alpha subscription was cancelled.
create or replace function public.prepare_account_deletion(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_found boolean := false;
  v_user_customer text;
  v_user_subscription text;
  v_email_sync_lease_token uuid;
  v_email_sync_lease_expires_at timestamptz;
  v_saga public.account_deletion_sagas%rowtype;
  v_profiles jsonb;
  v_legacy_profiles jsonb;
begin
  if p_user_id is null then
    raise exception 'user id is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));

  select u.stripe_customer_id,
         u.stripe_subscription_id,
         u.stripe_email_sync_lease_token,
         u.stripe_email_sync_lease_expires_at
    into v_user_customer,
         v_user_subscription,
         v_email_sync_lease_token,
         v_email_sync_lease_expires_at
    from public.users u
   where u.id = p_user_id
   for update;
  v_user_found := found;
  if v_email_sync_lease_token is not null then
    if v_email_sync_lease_expires_at is null
       or v_email_sync_lease_expires_at > now() then
      raise exception 'Stripe email reconciliation is still in progress';
    end if;
  end if;
  -- The owner lock prevents either provider-mirror worker from taking new
  -- work between this cleanup and the saga insert. A live Stripe email lease
  -- was rejected above. Clear every pending/deferred marker now so a deleting
  -- account cannot remain the oldest poison row in either bounded mirror lane.
  -- Explicit unsubscribe, bounce, and complaint evidence is separate and is
  -- intentionally preserved for the required deletion privacy step.
  update public.users u
     set suppression_cleanup_pending_at = null,
         suppression_cleanup_next_attempt_at = null,
         stripe_email_sync_pending_at = null,
         stripe_email_sync_next_attempt_at = null,
         stripe_email_sync_lease_token = null,
         stripe_email_sync_lease_expires_at = null,
         updated_at = now()
   where u.id = p_user_id;
  if v_user_found and not found then
    raise exception 'provider mirror state changed during account deletion';
  end if;
  if v_user_customer is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('alpha-customer:' || v_user_customer, 80425082)
    );
  end if;
  if v_user_customer is not null and v_user_subscription is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(
        'alpha-billing:' || v_user_customer || ':' || v_user_subscription,
        80425081
      )
    );
  end if;

  select *
    into v_saga
    from public.account_deletion_sagas s
   where s.user_id = p_user_id
   for update;

  if not found then
    if not v_user_found then
      return jsonb_build_object('decision', 'missing_user');
    end if;
    insert into public.account_deletion_sagas (
      user_id,
      stripe_customer_id,
      stripe_subscription_id
    ) values (
      p_user_id,
      v_user_customer,
      v_user_subscription
    )
    returning * into v_saga;
  elsif v_user_found and (
    v_saga.stripe_customer_id is distinct from v_user_customer
    or (
      v_user_subscription is not null
      and v_saga.stripe_subscription_id is distinct from v_user_subscription
    )
  ) then
    raise exception 'billing identity changed after account deletion began';
  end if;

  if exists (
    select 1
      from public.checkout_profiles p
     where (
       p.provisioned_user_id = p_user_id
       and p.owner_user_id is not null
       and p.owner_user_id <> p_user_id
     ) or (
       p.owner_user_id = p_user_id
       and p.provisioned_user_id is not null
       and p.provisioned_user_id <> p_user_id
     )
  ) then
    raise exception 'checkout profile owner conflicts with provisioned user';
  end if;

  -- A paid current checkout may lose its final canonical-user CAS just before
  -- deletion takes ownership. Webhook provisioning alone is not fulfillment:
  -- a still-pending exact first-letter guard also retains the captured-charge
  -- review even after the profile was provisioned and scrubbed. A completed
  -- guard is excluded so a successfully fulfilled checkout is not misqueued.
  -- An already-recorded duplicate review remains authoritative.
  insert into public.refund_reviews (
    session_id,
    subscription_id,
    customer_id,
    reason
  )
  select p.stripe_session_id,
         p.stripe_subscription_id,
         p.stripe_customer_id,
         'unfulfillable_checkout'
    from public.checkout_profiles p
   where p.owner_user_id = p_user_id
     and (
       p.provisioned_user_id is null
       or exists (
         select 1
           from public.checkout_fulfillments f
          where f.profile_id = p.id
            and f.session_id = p.stripe_session_id
            and f.status = 'pending'
       )
     )
     and p.billing_state in ('open', 'paid', 'recovering')
     and p.stripe_session_id is not null
     and p.stripe_customer_id is not null
     and p.stripe_subscription_id is not null
  on conflict (session_id, subscription_id) do nothing;

  -- The account-deletion insert trigger may already have marked a pending
  -- legacy row aborted. Its exact billing fields remain until cancellation is
  -- proved, so preserve the first-charge decision before later identity scrub.
  insert into public.refund_reviews (
    session_id,
    subscription_id,
    customer_id,
    reason
  )
  select l.session_id,
         l.stripe_subscription_id,
         l.stripe_customer_id,
         'unfulfillable_checkout'
    from public.legacy_checkout_fulfillments l
   where l.user_id = p_user_id
     and l.status in ('pending', 'deleting', 'aborted')
     and l.session_id is not null
     and l.stripe_customer_id is not null
     and l.stripe_subscription_id is not null
  on conflict (session_id, subscription_id) do nothing;

  update public.checkout_profiles p
     set owner_user_id = coalesce(p.owner_user_id, p_user_id),
         billing_state = case
           when p.billing_state = 'open'
                and p.stripe_session_id is null then 'expired'
           when p.billing_state in ('open', 'creating', 'paid', 'recovering') then 'deleting'
           else p.billing_state
         end,
         session_creation_lease_expires_at = case
           when p.stripe_session_id is null
                and p.billing_state = 'open' then null
           else p.session_creation_lease_expires_at
         end,
         recovery_lease_token = case
           when p.billing_state = 'recovering' then null
           else p.recovery_lease_token
         end,
         recovery_lease_expires_at = case
           when p.billing_state = 'recovering' then null
           else p.recovery_lease_expires_at
         end,
         recovery_previous_state = case
           when p.billing_state = 'recovering' then null
           else p.recovery_previous_state
         end,
         recovery_attempt_count = 0,
         recovery_last_error_code = null,
         recovery_dead_lettered_at = null,
         owner_deletion_requested_at = coalesce(p.owner_deletion_requested_at, now()),
         raw_profile_scrubbed_at = coalesce(p.raw_profile_scrubbed_at, now()),
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
         updated_at = now()
   where p.owner_user_id = p_user_id
      or p.provisioned_user_id = p_user_id;

  -- Revoke any in-flight first-letter lease before external billing cleanup.
  -- A generator that already loaded the profile may finish its provider call,
  -- but its compare-and-set completion write can no longer succeed, so it
  -- cannot send the letter or resurrect fulfillment after deletion begins.
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

  update public.legacy_checkout_fulfillments l
     set status = case
           when l.status = 'deleting' then 'deleting'
           else 'aborted'
         end,
         lease_token = null,
         lease_expires_at = null,
         reconcile_attempt_count = 0,
         reconcile_last_error_code = null,
         reconcile_dead_lettered_at = null
   where l.user_id = p_user_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'stripe_session_id', p.stripe_session_id,
        'stripe_customer_id', p.stripe_customer_id,
        'stripe_subscription_id', p.stripe_subscription_id
      ) order by p.created_at
    ),
    '[]'::jsonb
  )
    into v_profiles
    from public.checkout_profiles p
   where p.owner_user_id = p_user_id
     and p.billing_state = 'deleting';

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'session_id', l.session_id,
        'stripe_customer_id', l.stripe_customer_id,
        'stripe_subscription_id', l.stripe_subscription_id
      ) order by l.created_at
    ),
    '[]'::jsonb
  )
    into v_legacy_profiles
    from public.legacy_checkout_fulfillments l
   where l.user_id = p_user_id;

  return jsonb_build_object(
    'decision', 'ready',
    'saga_state', v_saga.state,
    'stripe_customer_id', v_saga.stripe_customer_id,
    'stripe_subscription_id', v_saga.stripe_subscription_id,
    'exclusive_customer_binding',
      v_saga.stripe_customer_id is null or (
        select count(*) = 1
          from public.users u
         where u.stripe_customer_id = v_saga.stripe_customer_id
      ),
    'profiles', v_profiles,
    'legacy_profiles', v_legacy_profiles
  );
end;
$$;

-- Existing paid users predate users.stripe_subscription_id. Reconcile only a
-- single exact live Alpha candidate under a Customer that is bound to exactly
-- one public user. The application discovers and validates the candidate from
-- Stripe first. This RPC makes that authorization durable before cancellation.
create or replace function public.bind_account_deletion_subscription(
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saga public.account_deletion_sagas%rowtype;
  v_user_customer text;
  v_user_subscription text;
begin
  if p_user_id is null
     or coalesce(p_customer_id, '') = ''
     or coalesce(p_subscription_id, '') = ''
     or coalesce(p_status, '') = '' then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  perform pg_advisory_xact_lock(
    hashtextextended('alpha-customer:' || p_customer_id, 80425082)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
      80425081
    )
  );

  select *
    into v_saga
    from public.account_deletion_sagas s
   where s.user_id = p_user_id
   for update;
  select u.stripe_customer_id, u.stripe_subscription_id
    into v_user_customer, v_user_subscription
    from public.users u
   where u.id = p_user_id
   for update;
  if not found
     or v_saga.state <> 'prepared'
     or v_saga.stripe_customer_id <> p_customer_id
     or v_saga.stripe_subscription_id is not null
     or v_user_customer <> p_customer_id
     or v_user_subscription is not null
     or (
       select count(*)
         from public.users u
        where u.stripe_customer_id = p_customer_id
     ) <> 1
     or exists (
       select 1
         from public.users u
        where u.id <> p_user_id
          and u.stripe_subscription_id = p_subscription_id
     )
     or exists (
       select 1
         from public.checkout_profiles p
        where (
          p.stripe_customer_id = p_customer_id
          or p.stripe_subscription_id = p_subscription_id
        )
          and not (
            coalesce(p.owner_user_id = p_user_id, false)
            or coalesce(p.provisioned_user_id = p_user_id, false)
          )
     )
     or exists (
       select 1
         from public.legacy_checkout_fulfillments l
        where (
          l.stripe_customer_id = p_customer_id
          or l.stripe_subscription_id = p_subscription_id
        )
          and l.user_id is distinct from p_user_id
     )
     or exists (
       select 1
         from public.account_deletion_sagas other_saga
        where other_saga.user_id <> p_user_id
          and (
            other_saga.stripe_customer_id = p_customer_id
            or other_saga.stripe_subscription_id = p_subscription_id
          )
     )
     or exists (
       select 1
         from public.account_deletion_alpha_subscriptions other_ref
        where other_ref.user_id <> p_user_id
          and (
            other_ref.customer_id = p_customer_id
            or other_ref.subscription_id = p_subscription_id
          )
     ) then
    return false;
  end if;

  update public.account_deletion_sagas
     set stripe_subscription_id = p_subscription_id,
         updated_at = now()
   where user_id = p_user_id
     and stripe_customer_id = p_customer_id
     and stripe_subscription_id is null
     and state = 'prepared';
  if not found then
    return false;
  end if;

  insert into public.account_deletion_alpha_subscriptions (
    user_id,
    subscription_id,
    customer_id,
    terminal_status
  ) values (
    p_user_id,
    p_subscription_id,
    p_customer_id,
    p_status
  );
  return true;
end;
$$;

create or replace function public.record_account_deletion_subscription(
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null
     or coalesce(p_customer_id, '') = ''
     or coalesce(p_subscription_id, '') = ''
     or coalesce(p_status, '') = '' then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  perform pg_advisory_xact_lock(
    hashtextextended('alpha-customer:' || p_customer_id, 80425082)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
      80425081
    )
  );
  perform 1
    from public.account_deletion_sagas s
   where s.user_id = p_user_id
     and s.state = 'prepared'
   for update;
  if not found then
    return false;
  end if;

  insert into public.account_deletion_alpha_subscriptions (
    user_id,
    subscription_id,
    customer_id,
    terminal_status
  ) values (
    p_user_id,
    p_subscription_id,
    p_customer_id,
    p_status
  )
  on conflict (user_id, subscription_id) do update
     set terminal_status = excluded.terminal_status,
         verified_at = now()
   where public.account_deletion_alpha_subscriptions.customer_id = excluded.customer_id;
  return found;
end;
$$;

create or replace function public.settle_account_deletion_checkout_profile(
  p_user_id uuid,
  p_profile_id uuid,
  p_session_id text,
  p_customer_id text,
  p_subscription_id text,
  p_terminal_state text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_terminal_state is null
     or p_terminal_state not in ('ended', 'expired')
     or not exists (
       select 1
         from public.account_deletion_sagas s
        where s.user_id = p_user_id
          and s.state = 'prepared'
     ) then
    return false;
  end if;

  update public.checkout_profiles p
     set billing_state = p_terminal_state,
         stripe_customer_id = case
           when p_terminal_state = 'ended' then p_customer_id
           else p.stripe_customer_id
         end,
         stripe_subscription_id = case
           when p_terminal_state = 'ended' then p_subscription_id
           else p.stripe_subscription_id
         end,
         updated_at = now()
   where p.id = p_profile_id
     and p.owner_user_id = p_user_id
     and p.stripe_session_id = p_session_id
     and p.billing_state in ('deleting', p_terminal_state)
     and (
       (
         p_terminal_state = 'expired'
         and p_customer_id is null
         and p_subscription_id is null
         and p.stripe_customer_id is null
         and p.stripe_subscription_id is null
       )
        or (
          p_terminal_state = 'ended'
          and p_customer_id is not null
          and p_subscription_id is not null
          and (p.stripe_customer_id is null or p.stripe_customer_id = p_customer_id)
          and (p.stripe_subscription_id is null or p.stripe_subscription_id = p_subscription_id)
          and exists (
            select 1
              from public.account_deletion_alpha_subscriptions r
             where r.user_id = p_user_id
               and r.customer_id = p_customer_id
               and r.subscription_id = p_subscription_id
               and r.terminal_status in (
                 'canceled',
                 'incomplete_expired',
                 'resource_missing',
                 'no_longer_alpha'
               )
          )
        )
      );
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.confirm_account_deletion_billing(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saga public.account_deletion_sagas%rowtype;
  v_user_customer text;
  v_user_subscription text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select *
    into v_saga
    from public.account_deletion_sagas s
   where s.user_id = p_user_id
   for update;
  if not found then
    return false;
  end if;
  if v_saga.state in ('billing_clean', 'auth_delete_started', 'complete') then
    return true;
  end if;

  select u.stripe_customer_id, u.stripe_subscription_id
    into v_user_customer, v_user_subscription
    from public.users u
   where u.id = p_user_id
   for update;
  if not found
     or v_saga.stripe_customer_id is distinct from v_user_customer
     or (
       v_user_subscription is not null
       and v_saga.stripe_subscription_id is distinct from v_user_subscription
     )
     or (
       v_saga.stripe_subscription_id is not null
       and not exists (
         select 1
           from public.account_deletion_alpha_subscriptions r
          where r.user_id = p_user_id
            and r.customer_id = v_saga.stripe_customer_id
            and r.subscription_id = v_saga.stripe_subscription_id
            and r.terminal_status in (
              'canceled',
              'incomplete_expired',
              'resource_missing',
              'no_longer_alpha'
            )
       )
     )
     or exists (
       select 1
         from public.checkout_profiles p
        where p.owner_user_id = p_user_id
          and p.billing_state in ('open', 'creating', 'paid', 'deleting')
     )
     or exists (
       select 1
         from public.checkout_creation_reviews review
         join public.checkout_profiles p on p.id = review.profile_id
        where review.status = 'pending'
          and (
            p.owner_user_id = p_user_id
            or p.provisioned_user_id = p_user_id
          )
     )
     or exists (
       select 1
         from public.account_deletion_alpha_subscriptions r
        where r.user_id = p_user_id
          and r.terminal_status not in (
            'canceled',
            'incomplete_expired',
            'resource_missing',
            'no_longer_alpha'
          )
     )
     or exists (
       select 1
         from public.legacy_checkout_fulfillments l
       where l.user_id = p_user_id
          and not (
            l.status = 'deleting'
            and l.stripe_customer_id is null
            and l.stripe_subscription_id is null
            and l.lease_token is null
            and l.lease_expires_at is null
          )
          and (
            l.status <> 'aborted'
            or l.lease_token is not null
            or l.lease_expires_at is not null
            or not exists (
              select 1
                from public.account_deletion_alpha_subscriptions r
               where r.user_id = p_user_id
                 and r.customer_id = l.stripe_customer_id
                 and r.subscription_id = l.stripe_subscription_id
                 and r.terminal_status in (
                   'canceled',
                   'incomplete_expired',
                   'resource_missing',
                   'no_longer_alpha'
                 )
            )
          )
     ) then
    return false;
  end if;

  update public.account_deletion_sagas
     set state = 'billing_clean',
         billing_cleaned_at = coalesce(billing_cleaned_at, now()),
         updated_at = now()
   where user_id = p_user_id
     and state = 'prepared';
  return found;
end;
$$;

create or replace function public.begin_account_deletion_auth_removal(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.account_deletion_sagas
     set state = 'auth_delete_started',
         auth_delete_started_at = coalesce(auth_delete_started_at, now()),
         updated_at = now()
   where user_id = p_user_id
     and state in ('billing_clean', 'auth_delete_started')
     and support_deleted_at is not null
     and delivery_policy_settled_at is not null;
  return found;
end;
$$;

create or replace function public.mark_account_deletion_support_deleted(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.account_deletion_sagas
     set support_deleted_at = coalesce(support_deleted_at, now()),
         updated_at = now()
   where user_id = p_user_id
     and state = 'billing_clean';
  return found;
end;
$$;

-- Deletion preserves provider do-not-email protection. This marker confirms
-- that policy has been settled, never that a provider record was erased.
create or replace function public.mark_account_deletion_delivery_policy_settled(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.account_deletion_sagas
     set delivery_policy_settled_at = coalesce(delivery_policy_settled_at, now()),
         updated_at = now()
   where user_id = p_user_id
     and state = 'billing_clean';
  return found;
end;
$$;

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

  -- Exact billing references are needed only while a retry can still mutate
  -- Stripe. Completion has already proven billing and Auth terminal, so retain
  -- no Customer, Subscription, or observed-status identifiers afterward.
  delete from public.account_deletion_alpha_subscriptions
   where user_id = p_user_id;
  return true;
end;
$$;

-- Completed pseudonymous tombstones block stale replay for seven more days,
-- then this bounded worker removes them. It cannot prune an unfinished saga.
create or replace function public.prune_completed_account_deletion_sagas(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'prune limit out of range';
  end if;
  with doomed as (
    select s.user_id
      from public.account_deletion_sagas s
     where s.state = 'complete'
       and s.purge_after <= now()
     order by s.purge_after
     for update skip locked
     limit p_limit
  )
  delete from public.account_deletion_sagas s
   using doomed d
   where s.user_id = d.user_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create or replace function public.record_refund_review(
  p_session_id text,
  p_subscription_id text,
  p_customer_id text,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(p_session_id, '') = ''
     or coalesce(p_subscription_id, '') = ''
     or coalesce(p_customer_id, '') = ''
     or p_reason is null
     or p_reason not in (
       'duplicate_checkout',
       'unfulfillable_checkout',
       'overdue_checkout'
      ) then
    return false;
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('alpha-customer:' || p_customer_id, 80425082)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
      80425081
    )
  );
  insert into public.refund_reviews (
    session_id,
    subscription_id,
    customer_id,
    reason
  ) values (
    p_session_id,
    p_subscription_id,
    p_customer_id,
    p_reason
  )
  on conflict (session_id, subscription_id) do update
     set updated_at = now()
   where public.refund_reviews.customer_id = excluded.customer_id
     and public.refund_reviews.reason = excluded.reason;
  return found;
end;
$$;

-- A signed checkout webhook can discover that the newly-paid exact pair lost
-- to an already-live canonical pair before either fulfillment lane owns a
-- lease. Store both sides under the same owner and deterministic billing locks
-- before provider cancellation. An earlier charge-review reason is preserved.
create or replace function public.record_webhook_duplicate_refund_review(
  p_session_id text,
  p_user_id uuid,
  p_email_hash text,
  p_week_of date,
  p_loser_customer_id text,
  p_loser_subscription_id text,
  p_winner_customer_id text,
  p_winner_subscription_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_a text;
  v_customer_b text;
  v_pair_a text;
  v_pair_b text;
  v_user public.users%rowtype;
  v_current_cleanup_owned boolean;
begin
  if coalesce(p_session_id, '') = ''
     or p_user_id is null
     or p_email_hash is null
     or p_email_hash !~ '^[0-9a-f]{64}$'
     or p_week_of is null
     or coalesce(p_loser_customer_id, '') = ''
     or coalesce(p_loser_subscription_id, '') = ''
     or coalesce(p_winner_customer_id, '') = ''
     or coalesce(p_winner_subscription_id, '') = ''
     or (
       p_loser_customer_id = p_winner_customer_id
       and p_loser_subscription_id = p_winner_subscription_id
     ) then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  v_customer_a := least(
    'alpha-customer:' || p_loser_customer_id,
    'alpha-customer:' || p_winner_customer_id
  );
  v_customer_b := greatest(
    'alpha-customer:' || p_loser_customer_id,
    'alpha-customer:' || p_winner_customer_id
  );
  perform pg_advisory_xact_lock(hashtextextended(v_customer_a, 80425082));
  if v_customer_b <> v_customer_a then
    perform pg_advisory_xact_lock(hashtextextended(v_customer_b, 80425082));
  end if;
  v_pair_a := least(
    'alpha-billing:' || p_loser_customer_id || ':' || p_loser_subscription_id,
    'alpha-billing:' || p_winner_customer_id || ':' || p_winner_subscription_id
  );
  v_pair_b := greatest(
    'alpha-billing:' || p_loser_customer_id || ':' || p_loser_subscription_id,
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
    into v_user
    from public.users u
   where u.id = p_user_id
   for update;
  if not found
     or v_user.stripe_customer_id is distinct from p_winner_customer_id
     or v_user.stripe_subscription_id is distinct from p_winner_subscription_id
     or exists (
       select 1
         from public.users u
        where u.id <> p_user_id
          and u.stripe_customer_id = p_loser_customer_id
          and u.stripe_subscription_id = p_loser_subscription_id
     )
      or exists (
        select 1
          from public.checkout_profiles p
         where p.stripe_customer_id = p_loser_customer_id
           and p.stripe_subscription_id = p_loser_subscription_id
           and (
             (
               p.owner_user_id is not null
               and p.owner_user_id <> p_user_id
             )
             or (
               p.provisioned_user_id is not null
               and p.provisioned_user_id <> p_user_id
             )
             or (
               p.owner_user_id is distinct from p_user_id
               and p.provisioned_user_id is distinct from p_user_id
             )
           )
      ) then
    return false;
  end if;

  -- An unprovisioned current staged checkout has a profile-owned recovery lane.
  -- A provisioned profile cannot be claimed by that worker, so it needs the
  -- same exact legacy obligation as a Session with no current profile. Create
  -- that obligation in this transaction before cancellation is authorized.
  -- The later legacy migration owns its bounded retry, dead-letter, requeue,
  -- winner-freeze, and terminal-abort behavior, including ending an exact
  -- provisioned loser profile after terminal provider proof.
  select exists (
    select 1
      from public.checkout_profiles p
     where p.stripe_session_id = p_session_id
       and p.stripe_customer_id = p_loser_customer_id
       and p.stripe_subscription_id = p_loser_subscription_id
       and p.billing_state in ('open', 'paid', 'recovering')
       and p.owner_user_id = p_user_id
       and p.provisioned_user_id is null
  ) into v_current_cleanup_owned;
  if not v_current_cleanup_owned then
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
      p_loser_customer_id,
      p_loser_subscription_id,
      p_week_of,
      'pending',
      null,
      now()
    )
    on conflict (session_id) do nothing;

    perform 1
      from public.legacy_checkout_fulfillments l
     where l.session_id = p_session_id
       and l.user_id = p_user_id
       and l.stripe_customer_id = p_loser_customer_id
       and l.stripe_subscription_id = p_loser_subscription_id
       and l.status = 'pending'
       and l.identity_scrubbed_at is null
       and l.email_hash is not null
     for update;
    if not found then
      raise exception 'webhook duplicate cleanup reservation conflict';
    end if;
  end if;

  insert into public.refund_reviews (
    session_id,
    subscription_id,
    customer_id,
    winner_subscription_id,
    winner_customer_id,
    reason
  ) values (
    p_session_id,
    p_loser_subscription_id,
    p_loser_customer_id,
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
  if not found then
    -- Roll back a newly-created legacy obligation too. A bare false return here
    -- would commit a replay row without the exact winner review that freezes
    -- canonical rebinding and authorizes its cancellation finalizer.
    raise exception 'webhook duplicate refund review conflict';
  end if;
  return true;
end;
$$;

create or replace function public.count_pending_refund_reviews()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
    from public.refund_reviews
   where status = 'pending';
$$;

-- A subscription.created event can write the exact billing pair before the
-- checkout.completed handler copies the staged profile into public.users. The
-- retention worker must not treat that pair alone as proof of provisioning.
-- This RPC verifies and completes the canonical profile, access state, stage
-- binding, and raw-profile scrub in one transaction.
create or replace function public.recover_checkout_profile_provisioning(
  p_profile_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_lease_token uuid,
  p_grant_access boolean,
  p_prior_customer_id text,
  p_prior_subscription_id text,
  p_prior_binding_replaceable boolean
)
returns table (
  decision text,
  recovered_user_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_user public.users%rowtype;
  v_profile public.checkout_profiles%rowtype;
  v_fulfillment public.checkout_fulfillments%rowtype;
  v_issue_exists boolean := false;
  v_now timestamptz := now();
begin
  if p_profile_id is null
     or coalesce(p_customer_id, '') = ''
     or coalesce(p_subscription_id, '') = ''
     or p_lease_token is null
     or p_grant_access is null
     or p_prior_binding_replaceable is null
     or ((p_prior_customer_id is null) <> (p_prior_subscription_id is null)) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- Current Checkout requires a confirmed Auth owner before staging. That
  -- stable owner, the Session metadata, and the fresh exact Stripe pair are
  -- the recovery proof. The canonical row need not already hold the pair,
  -- because subscription.created and checkout.completed can arrive in either
  -- order and the latter may have crashed before mirroring it.
  select p.owner_user_id
    into v_user_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return query select 'profile_missing'::text, null::uuid;
    return;
  end if;
  if v_user_id is null then
    return query select 'profile_owner_missing'::text, null::uuid;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 80425080));
  perform pg_advisory_xact_lock(
    hashtextextended('alpha-customer:' || p_customer_id, 80425082)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
      80425081
    )
  );

  select *
    into v_user
    from public.users u
   where u.id = v_user_id
   for update;
  if not found then
    return query select 'canonical_user_missing'::text, v_user_id;
    return;
  end if;
  if v_user.stripe_customer_id is distinct from p_prior_customer_id
     or v_user.stripe_subscription_id is distinct from p_prior_subscription_id then
    return query select 'canonical_billing_conflict'::text, v_user_id;
    return;
  end if;
  if (
    p_prior_customer_id is distinct from p_customer_id
    or p_prior_subscription_id is distinct from p_subscription_id
  ) and not p_prior_binding_replaceable then
    return query select 'canonical_billing_conflict'::text, v_user_id;
    return;
  end if;
  if exists (
    select 1
      from public.users u
     where u.id <> v_user_id
       and (
         u.stripe_customer_id = p_customer_id
         or u.stripe_subscription_id = p_subscription_id
       )
  ) then
    return query select 'canonical_binding_conflict'::text, v_user_id;
    return;
  end if;
  if exists (
    select 1
      from public.checkout_profiles other_profile
     where other_profile.id <> p_profile_id
       and (
         other_profile.stripe_customer_id = p_customer_id
         or other_profile.stripe_subscription_id = p_subscription_id
       )
       and other_profile.owner_user_id is distinct from v_user_id
       and other_profile.provisioned_user_id is distinct from v_user_id
  ) or exists (
    select 1
      from public.legacy_checkout_fulfillments legacy
     where (
       legacy.stripe_customer_id = p_customer_id
       or legacy.stripe_subscription_id = p_subscription_id
     )
       and legacy.user_id is distinct from v_user_id
  ) or exists (
    select 1
      from public.account_deletion_sagas other_saga
     where other_saga.user_id <> v_user_id
       and (
         other_saga.stripe_customer_id = p_customer_id
         or other_saga.stripe_subscription_id = p_subscription_id
       )
  ) or exists (
    select 1
      from public.account_deletion_alpha_subscriptions other_ref
     where other_ref.user_id <> v_user_id
       and (
         other_ref.customer_id = p_customer_id
         or other_ref.subscription_id = p_subscription_id
       )
  ) then
    return query select 'local_billing_reservation_conflict'::text, v_user_id;
    return;
  end if;
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = v_user_id
  ) then
    return query select 'deletion_pending'::text, v_user_id;
    return;
  end if;

  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return query select 'profile_missing'::text, v_user_id;
    return;
  end if;
  if v_profile.billing_state <> 'recovering'
     or v_profile.recovery_lease_token is distinct from p_lease_token
     or v_profile.recovery_lease_expires_at <= now() then
    return query select 'lease_lost'::text, v_user_id;
    return;
  end if;
  select *
    into v_fulfillment
    from public.checkout_fulfillments f
   where f.profile_id = p_profile_id
   for update;
  if found
     and v_fulfillment.status = 'pending'
     and v_fulfillment.lease_token is not null
     and v_fulfillment.lease_expires_at is not null
     and v_fulfillment.lease_expires_at > now() then
    return query select 'lease_lost'::text, v_user_id;
    return;
  end if;
  if v_fulfillment.session_id is not null
     and v_fulfillment.status = 'pending' then
    v_issue_exists := exists (
      select 1
        from public.issues i
       where i.user_id = v_fulfillment.user_id
         and i.week_of = v_fulfillment.week_of
    );
  end if;
  if v_profile.owner_user_id is not null
     and v_profile.owner_user_id <> v_user_id then
    return query select 'profile_owner_conflict'::text, v_user_id;
    return;
  end if;
  if v_profile.provisioned_user_id is not null
     and v_profile.provisioned_user_id <> v_user_id then
    return query select 'profile_owner_conflict'::text, v_user_id;
    return;
  end if;
  if v_profile.stripe_customer_id is distinct from p_customer_id
     or v_profile.stripe_subscription_id is distinct from p_subscription_id then
    return query select 'profile_billing_conflict'::text, v_user_id;
    return;
  end if;
  if v_profile.raw_profile_scrubbed_at is null
     or v_profile.email is not null
     or v_profile.first_name is not null
     or v_profile.topics is not null
     or v_profile.theme is not null then
    return query select 'profile_privacy_invariant_failed'::text, v_user_id;
    return;
  end if;
  if v_profile.session_creation_started_at is null then
    return query select 'profile_checkout_clock_missing'::text, v_user_id;
    return;
  end if;
  if coalesce(btrim(v_user.first_name), '') = ''
     or v_user.topics is null
     or cardinality(v_user.topics) <> 5
     or coalesce(btrim(v_user.theme), '') = '' then
    return query select 'canonical_profile_incomplete'::text, v_user_id;
    return;
  end if;
  if exists (
    select 1
      from public.checkout_profiles other_profile
     where other_profile.id <> p_profile_id
       and other_profile.owner_user_id = v_user_id
       and other_profile.billing_state in ('open', 'creating', 'paid', 'recovering', 'deleting')
  ) then
    return query select 'active_owner_conflict'::text, v_user_id;
    return;
  end if;

  update public.users u
     set stripe_customer_id = p_customer_id,
         stripe_subscription_id = p_subscription_id,
         subscribed_at = case
           when p_grant_access then
             coalesce(u.subscribed_at, v_profile.session_creation_started_at)
           else u.subscribed_at
         end,
         cancelled_at = case
           when not p_grant_access then
             least(coalesce(u.cancelled_at, v_now), v_now)
           -- A freshly-authorized replacement pair supersedes the terminal
           -- access end carried by the old exact pair, even when a delayed
           -- old webhook wrote that timestamp after this checkout started.
           -- The CAS below proves the row still holds that exact prior pair.
           when p_prior_binding_replaceable
                and (
                  p_prior_customer_id is distinct from p_customer_id
                  or p_prior_subscription_id is distinct from p_subscription_id
                ) then null
           when u.cancelled_at is not null
                and u.cancelled_at <= v_profile.session_creation_started_at then null
           else u.cancelled_at
          end,
          -- Recovery runs only after a fresh live exact-Alpha classification.
          -- Use the original checkout timestamp as the provider-cleanup cutoff
          -- so the reconciler can preserve any newer explicit suppression.
          suppression_cleanup_pending_at = case
            when p_grant_access then coalesce(
              u.suppression_cleanup_pending_at,
              v_profile.session_creation_started_at
            )
            else u.suppression_cleanup_pending_at
          end,
          stripe_email_sync_pending_at = coalesce(
            u.stripe_email_sync_pending_at,
            v_profile.session_creation_started_at
          ),
          updated_at = v_now
   where u.id = v_user_id
     and u.stripe_customer_id is not distinct from p_prior_customer_id
     and u.stripe_subscription_id is not distinct from p_prior_subscription_id;
  if not found then
    raise exception 'canonical checkout binding changed during recovery';
  end if;

  update public.checkout_profiles p
     set owner_user_id = coalesce(p.owner_user_id, v_user_id),
         provisioned_user_id = v_user_id,
         billing_state = 'paid',
         stripe_customer_id = p_customer_id,
         stripe_subscription_id = p_subscription_id,
         session_creation_lease_expires_at = null,
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
         raw_profile_scrubbed_at = coalesce(p.raw_profile_scrubbed_at, v_now),
         updated_at = v_now
   where p.id = p_profile_id
     and p.billing_state = 'recovering'
     and p.recovery_lease_token = p_lease_token
     and p.recovery_lease_expires_at > now()
     and p.raw_profile_scrubbed_at is not null
     and p.owner_user_id = v_user_id
     and (p.provisioned_user_id is null or p.provisioned_user_id = v_user_id)
     and p.stripe_customer_id = p_customer_id
     and p.stripe_subscription_id = p_subscription_id;
  if not found then
    raise exception 'checkout profile changed during atomic recovery';
  end if;

  if v_fulfillment.session_id is not null
     and v_fulfillment.status = 'pending' then
    update public.checkout_fulfillments f
       set status = case when v_issue_exists then 'completed' else 'aborted' end,
           completed_at = case
             when v_issue_exists then coalesce(f.completed_at, v_now)
             else f.completed_at
           end,
           email_hash = null,
           user_id = null,
           lease_token = null,
           lease_expires_at = null,
           identity_scrubbed_at = coalesce(f.identity_scrubbed_at, v_now)
     where f.session_id = v_fulfillment.session_id
       and f.profile_id = p_profile_id
       and f.status = 'pending'
       and (
         f.lease_token is null
         or f.lease_expires_at is null
         or f.lease_expires_at <= now()
       );
    if not found then
      raise exception 'checkout fulfillment changed during atomic recovery';
    end if;
  end if;

  return query select case
    when p_grant_access then 'recovered'::text
    else 'recovered_no_access'::text
  end, v_user_id;
end;
$$;

create or replace function public.claim_checkout_profile_recovery(
  p_profile_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_lease_token uuid,
  p_lease_seconds integer default 300
)
returns table (
  decision text,
  recovered_user_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_profile public.checkout_profiles%rowtype;
  v_fulfillment public.checkout_fulfillments%rowtype;
  v_fulfillment_found boolean := false;
  v_has_pair boolean;
begin
  v_has_pair := p_customer_id is not null and p_subscription_id is not null;
  if p_profile_id is null
     or p_lease_token is null
     or p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 300
     or ((p_customer_id is null) <> (p_subscription_id is null))
     or (p_customer_id is not null and p_customer_id = '')
     or (p_subscription_id is not null and p_subscription_id = '') then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  select coalesce(p.owner_user_id, p.provisioned_user_id)
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return query select 'profile_missing'::text, null::uuid;
    return;
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
    if exists (
      select 1
        from public.account_deletion_sagas s
       where s.user_id = v_owner_id
    ) then
      return query select 'deletion_pending'::text, v_owner_id;
      return;
    end if;
  end if;
  if v_has_pair then
    perform pg_advisory_xact_lock(
      hashtextextended('alpha-customer:' || p_customer_id, 80425082)
    );
    perform pg_advisory_xact_lock(
      hashtextextended(
        'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
        80425081
      )
    );
  end if;

  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return query select 'profile_missing'::text, v_owner_id;
    return;
  end if;
  if coalesce(v_profile.owner_user_id, v_profile.provisioned_user_id)
       is distinct from v_owner_id then
    return query select 'profile_owner_conflict'::text, v_owner_id;
    return;
  end if;
  select *
    into v_fulfillment
    from public.checkout_fulfillments f
   where f.profile_id = p_profile_id
   for update;
  v_fulfillment_found := found;
  if v_fulfillment_found
     and v_profile.stripe_session_id is distinct from v_fulfillment.session_id then
    return query select 'profile_billing_conflict'::text, v_owner_id;
    return;
  end if;
  if v_fulfillment_found
     and v_fulfillment.status = 'pending'
     and v_fulfillment.lease_token is not null
     and v_fulfillment.lease_expires_at is not null
     and v_fulfillment.lease_expires_at > now() then
    return query select 'in_progress'::text, v_owner_id;
    return;
  end if;
  if v_profile.billing_state in ('ended', 'expired') then
    if v_fulfillment_found and v_fulfillment.status = 'pending' then
      update public.checkout_fulfillments f
         set status = 'aborted',
             email_hash = null,
             user_id = null,
             lease_token = null,
             lease_expires_at = null,
             identity_scrubbed_at = coalesce(f.identity_scrubbed_at, now())
       where f.session_id = v_fulfillment.session_id
         and f.profile_id = p_profile_id
         and f.status = 'pending';
    end if;
    return query select 'already_terminal'::text, v_owner_id;
    return;
  end if;
  if v_profile.billing_state = 'deleting' then
    return query select 'deletion_pending'::text, v_owner_id;
    return;
  end if;
  if v_profile.billing_state = 'creating' then
    return query select 'creation_binding_unknown'::text, v_owner_id;
    return;
  end if;
  if v_profile.provisioned_user_id is not null
     and v_profile.raw_profile_scrubbed_at is not null then
    if v_fulfillment_found and v_fulfillment.status = 'pending' then
      if exists (
        select 1
          from public.issues i
         where i.user_id = v_fulfillment.user_id
           and i.week_of = v_fulfillment.week_of
      ) then
        update public.checkout_fulfillments f
           set status = 'completed',
               completed_at = coalesce(f.completed_at, now()),
               email_hash = null,
               user_id = null,
               lease_token = null,
               lease_expires_at = null,
               identity_scrubbed_at = coalesce(f.identity_scrubbed_at, now())
         where f.session_id = v_fulfillment.session_id
           and f.profile_id = p_profile_id
           and f.status = 'pending';
      elsif v_fulfillment.created_at <= now() - interval '24 hours' then
        update public.checkout_fulfillments f
           set status = 'aborted',
               email_hash = null,
               user_id = null,
               lease_token = null,
               lease_expires_at = null,
               identity_scrubbed_at = coalesce(f.identity_scrubbed_at, now())
         where f.session_id = v_fulfillment.session_id
           and f.profile_id = p_profile_id
           and f.status = 'pending';
      else
        return query select 'in_progress'::text, v_profile.provisioned_user_id;
        return;
      end if;
    end if;
    return query select 'already_provisioned'::text, v_profile.provisioned_user_id;
    return;
  end if;
  if v_profile.recovery_dead_lettered_at is not null then
    return query select 'manual_review'::text, v_owner_id;
    return;
  end if;
  if v_profile.expires_at > now() then
    return query select 'not_due'::text, v_owner_id;
    return;
  end if;
  if v_profile.billing_state = 'recovering' then
    if v_profile.recovery_lease_token = p_lease_token
       and v_profile.recovery_lease_expires_at > now() then
      return query select 'claimed'::text, v_owner_id;
      return;
    end if;
    if v_profile.recovery_lease_expires_at > now() then
      return query select 'in_progress'::text, v_owner_id;
      return;
    end if;
  elsif v_profile.billing_state not in ('open', 'paid') then
    return query select 'profile_not_recoverable'::text, v_owner_id;
    return;
  end if;

  if v_has_pair then
    if (v_profile.stripe_customer_id is not null
        and v_profile.stripe_customer_id <> p_customer_id)
       or (v_profile.stripe_subscription_id is not null
           and v_profile.stripe_subscription_id <> p_subscription_id) then
      return query select 'profile_billing_conflict'::text, v_owner_id;
      return;
    end if;
  elsif v_profile.stripe_customer_id is not null
        or v_profile.stripe_subscription_id is not null then
    return query select 'profile_billing_conflict'::text, v_owner_id;
    return;
  end if;

  update public.checkout_profiles p
     set billing_state = 'recovering',
         recovery_previous_state = case
           when p.billing_state = 'recovering' then p.recovery_previous_state
           else p.billing_state
         end,
         recovery_lease_token = p_lease_token,
         recovery_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         stripe_customer_id = coalesce(p.stripe_customer_id, p_customer_id),
          stripe_subscription_id = coalesce(
            p.stripe_subscription_id,
            p_subscription_id
          ),
         updated_at = now()
   where p.id = p_profile_id
     and (
       p.billing_state in ('open', 'paid')
       or (
         p.billing_state = 'recovering'
          and p.recovery_lease_expires_at <= now()
        )
     )
     and p.recovery_dead_lettered_at is null
     and p.expires_at <= now();
  if not found then
    return query select 'in_progress'::text, v_owner_id;
    return;
  end if;
  if v_fulfillment_found and v_fulfillment.status = 'pending' then
    update public.checkout_fulfillments f
       set lease_token = null,
           lease_expires_at = null
     where f.session_id = v_fulfillment.session_id
       and f.profile_id = p_profile_id
       and f.status = 'pending'
       and (
         f.lease_token is null
         or f.lease_expires_at is null
         or f.lease_expires_at <= now()
       );
    if not found then
      raise exception 'checkout fulfillment lease changed during recovery claim';
    end if;
  end if;
  return query select 'claimed'::text, v_owner_id;
end;
$$;

create or replace function public.settle_checkout_profile_recovery(
  p_profile_id uuid,
  p_lease_token uuid,
  p_terminal_state text,
  p_customer_id text,
  p_subscription_id text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_profile public.checkout_profiles%rowtype;
  v_fulfillment public.checkout_fulfillments%rowtype;
begin
  if p_profile_id is null
     or p_lease_token is null
     or p_terminal_state is null
     or p_terminal_state not in ('ended', 'expired')
     or ((p_customer_id is null) <> (p_subscription_id is null)) then
    return 'invalid';
  end if;
  select coalesce(p.owner_user_id, p.provisioned_user_id)
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return 'profile_missing';
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
    if exists (
      select 1
        from public.account_deletion_sagas s
       where s.user_id = v_owner_id
    ) then
      return 'deletion_pending';
    end if;
  end if;
  if p_customer_id is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('alpha-customer:' || p_customer_id, 80425082)
    );
    perform pg_advisory_xact_lock(
      hashtextextended(
        'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
        80425081
      )
    );
  end if;
  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return 'profile_missing';
  end if;
  if v_profile.billing_state <> 'recovering'
     or v_profile.recovery_lease_token is distinct from p_lease_token
     or v_profile.recovery_lease_expires_at is null
     or v_profile.recovery_lease_expires_at <= now() then
    return 'lease_lost';
  end if;
  select *
    into v_fulfillment
    from public.checkout_fulfillments f
   where f.profile_id = p_profile_id
   for update;
  if found
     and v_fulfillment.status = 'pending'
     and v_fulfillment.lease_token is not null
     and v_fulfillment.lease_expires_at is not null
     and v_fulfillment.lease_expires_at > now() then
    return 'fulfillment_in_progress';
  end if;
  if p_terminal_state = 'expired' and (
    p_customer_id is not null
    or v_profile.stripe_customer_id is not null
    or v_profile.stripe_subscription_id is not null
  ) then
    return 'profile_billing_conflict';
  end if;
  if p_terminal_state = 'ended' and (
    p_customer_id is null
    or p_subscription_id is null
    or v_profile.stripe_customer_id is distinct from p_customer_id
    or v_profile.stripe_subscription_id is distinct from p_subscription_id
  ) then
    return 'profile_billing_conflict';
  end if;

  -- A webhook can mirror the exact pair to the canonical user and crash before
  -- it marks this reservation provisioned. Terminal provider proof must end
  -- access for that exact same local pair before the profile becomes terminal.
  -- A different or absent canonical pair is left untouched.
  if p_terminal_state = 'ended' and v_owner_id is not null then
    update public.users u
       set cancelled_at = least(coalesce(u.cancelled_at, now()), now()),
           updated_at = now()
     where u.id = v_owner_id
       and u.stripe_customer_id = p_customer_id
       and u.stripe_subscription_id = p_subscription_id;
  end if;

  update public.checkout_profiles
     set billing_state = p_terminal_state,
         recovery_lease_token = null,
         recovery_lease_expires_at = null,
         recovery_previous_state = null,
         recovery_attempt_count = 0,
         recovery_last_error_code = null,
         recovery_dead_lettered_at = null,
         session_creation_lease_expires_at = null,
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
         raw_profile_scrubbed_at = coalesce(raw_profile_scrubbed_at, now()),
         updated_at = now()
   where id = p_profile_id
     and billing_state = 'recovering'
     and recovery_lease_token = p_lease_token
     and recovery_lease_expires_at > now();
  if not found then
    return 'lease_lost';
  end if;
  update public.checkout_fulfillments f
     set status = 'aborted',
         email_hash = null,
         user_id = null,
         lease_token = null,
         lease_expires_at = null,
         identity_scrubbed_at = coalesce(f.identity_scrubbed_at, now())
   where f.profile_id = p_profile_id
     and f.status = 'pending'
     and (
       f.lease_token is null
       or f.lease_expires_at is null
       or f.lease_expires_at <= now()
     );
  return 'settled';
end;
$$;

create or replace function public.fail_checkout_profile_recovery(
  p_profile_id uuid,
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
  v_owner_id uuid;
  v_profile public.checkout_profiles%rowtype;
  v_fulfillment public.checkout_fulfillments%rowtype;
  v_fulfillment_found boolean := false;
  v_permanent boolean;
  v_next_attempt smallint;
begin
  if p_profile_id is null
     or p_lease_token is null
     or p_error_code is null
     or p_error_code not in (
       'provider_unavailable',
       'provider_rate_limited',
       'database_transient',
       'unexpected',
       'winner_binding_changed',
       'winner_missing',
       'winner_not_live_exact_alpha',
       'review_winner_missing',
       'loser_binding_changed',
       'loser_missing_unproven',
       'loser_not_exact_alpha',
       'profile_identity_invalid'
     )
     or p_retry_at is null
     or p_retry_at < now() + interval '1 minute'
     or p_retry_at > now() + interval '25 hours' then
    return 'invalid';
  end if;
  select coalesce(p.owner_user_id, p.provisioned_user_id)
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return 'profile_missing';
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
    if exists (
      select 1
        from public.account_deletion_sagas s
       where s.user_id = v_owner_id
    ) then
      return 'deletion_pending';
    end if;
  end if;
  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return 'profile_missing';
  end if;
  if v_profile.billing_state <> 'recovering'
     or v_profile.recovery_lease_token is distinct from p_lease_token
     or v_profile.recovery_lease_expires_at is null
     or v_profile.recovery_lease_expires_at <= now()
     or v_profile.recovery_previous_state not in ('open', 'paid') then
    return 'lease_lost';
  end if;
  select *
    into v_fulfillment
    from public.checkout_fulfillments f
   where f.profile_id = p_profile_id
   for update;
  v_fulfillment_found := found;
  if v_fulfillment_found
     and v_fulfillment.status = 'pending'
     and v_fulfillment.lease_token is not null
     and v_fulfillment.lease_expires_at is not null
     and v_fulfillment.lease_expires_at > now() then
    return 'fulfillment_in_progress';
  end if;
  v_permanent := p_error_code in (
    'winner_binding_changed',
    'winner_missing',
    'winner_not_live_exact_alpha',
    'review_winner_missing',
    'loser_binding_changed',
    'loser_missing_unproven',
    'loser_not_exact_alpha',
    'profile_identity_invalid'
  );
  v_next_attempt := least(8, v_profile.recovery_attempt_count + 1);
  if v_permanent or v_next_attempt >= 8 then
    update public.checkout_profiles p
       set billing_state = v_profile.recovery_previous_state,
           recovery_lease_token = null,
           recovery_lease_expires_at = null,
           recovery_previous_state = null,
           recovery_attempt_count = 8,
           recovery_last_error_code = p_error_code,
           recovery_dead_lettered_at = now(),
           updated_at = now()
     where p.id = p_profile_id
       and p.billing_state = 'recovering'
       and p.recovery_lease_token = p_lease_token
       and p.recovery_lease_expires_at > now();
    if not found then
      return 'lease_lost';
    end if;
    -- Manual review keeps the exact loser/winner proof in the profile and
    -- refund review, but no longer retains a subscriber id or email hash in
    -- an abandoned fulfillment row. A service-only requeue can later resume
    -- provider cleanup from the durable PII-free review.
    if v_fulfillment_found and v_fulfillment.status = 'pending' then
      update public.checkout_fulfillments f
         set status = 'aborted',
             email_hash = null,
             user_id = null,
             lease_token = null,
             lease_expires_at = null,
             identity_scrubbed_at = coalesce(f.identity_scrubbed_at, now())
       where f.session_id = v_fulfillment.session_id
         and f.profile_id = p_profile_id
         and f.status = 'pending'
         and (
           f.lease_token is null
           or f.lease_expires_at is null
           or f.lease_expires_at <= now()
         );
      if not found then
        raise exception 'checkout fulfillment changed during recovery escalation';
      end if;
    end if;
    return 'dead_lettered';
  end if;
  update public.checkout_profiles p
     set recovery_lease_expires_at = p_retry_at,
         recovery_attempt_count = v_next_attempt,
         recovery_last_error_code = p_error_code,
         recovery_dead_lettered_at = null,
         expires_at = p_retry_at,
         updated_at = now()
   where p.id = p_profile_id
     and p.billing_state = 'recovering'
     and p.recovery_lease_token = p_lease_token
     and p.recovery_lease_expires_at > now();
  return case when found then 'deferred' else 'lease_lost' end;
end;
$$;

-- Some malformed or provider-unreadable rows fail before the ordinary worker
-- can acquire its recovery lease. Give those exact snapshots the same bounded
-- retry deadline so one poison row cannot remain first in every limited run.
create or replace function public.defer_checkout_profile_recovery_candidate(
  p_profile_id uuid,
  p_expected_owner_user_id uuid,
  p_expected_billing_state text,
  p_expected_customer_id text,
  p_expected_subscription_id text,
  p_expected_recovery_lease_expires_at timestamptz,
  p_defer_token uuid,
  p_error_code text,
  p_retry_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.checkout_profiles%rowtype;
  v_fulfillment public.checkout_fulfillments%rowtype;
  v_fulfillment_found boolean := false;
  v_permanent boolean;
  v_next_attempt smallint;
begin
  if p_profile_id is null
     or p_defer_token is null
     or p_expected_billing_state is null
     or p_expected_billing_state not in ('open', 'paid', 'recovering')
     or p_error_code is null
     or p_error_code not in (
       'provider_unavailable',
       'provider_rate_limited',
       'database_transient',
       'unexpected',
       'winner_binding_changed',
       'winner_missing',
       'winner_not_live_exact_alpha',
       'review_winner_missing',
       'loser_binding_changed',
       'loser_missing_unproven',
       'loser_not_exact_alpha',
       'profile_identity_invalid'
     )
     or p_retry_at is null
     or p_retry_at < now() + interval '1 minute'
     or p_retry_at > now() + interval '25 hours' then
    return 'invalid';
  end if;
  if p_expected_owner_user_id is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(p_expected_owner_user_id::text, 80425080)
    );
    if exists (
      select 1
        from public.account_deletion_sagas s
       where s.user_id = p_expected_owner_user_id
    ) then
      return 'deletion_pending';
    end if;
  end if;

  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return 'profile_missing';
  end if;
  if v_profile.provisioned_user_id is not null
     or v_profile.owner_user_id is distinct from p_expected_owner_user_id
     or v_profile.billing_state is distinct from p_expected_billing_state
     or v_profile.stripe_customer_id is distinct from p_expected_customer_id
     or v_profile.stripe_subscription_id is distinct from p_expected_subscription_id
     or v_profile.recovery_lease_expires_at is distinct from
       p_expected_recovery_lease_expires_at then
    return 'state_changed';
  end if;
  if v_profile.recovery_dead_lettered_at is not null then
    return 'dead_lettered';
  end if;
  if v_profile.expires_at > now() then
    return 'not_due';
  end if;
  select *
    into v_fulfillment
    from public.checkout_fulfillments f
   where f.profile_id = p_profile_id
   for update;
  v_fulfillment_found := found;
  if v_fulfillment_found
     and v_fulfillment.status = 'pending'
     and v_fulfillment.lease_token is not null
     and v_fulfillment.lease_expires_at is not null
     and v_fulfillment.lease_expires_at > now() then
    return 'in_progress';
  end if;

  v_permanent := p_error_code in (
    'winner_binding_changed',
    'winner_missing',
    'winner_not_live_exact_alpha',
    'review_winner_missing',
    'loser_binding_changed',
    'loser_missing_unproven',
    'loser_not_exact_alpha',
    'profile_identity_invalid'
  );
  v_next_attempt := least(8, v_profile.recovery_attempt_count + 1);
  if v_permanent or v_next_attempt >= 8 then
    update public.checkout_profiles p
       set billing_state = case
             when p.billing_state = 'recovering' then p.recovery_previous_state
             else p.billing_state
           end,
           recovery_lease_token = null,
           recovery_lease_expires_at = null,
           recovery_previous_state = null,
           recovery_attempt_count = 8,
           recovery_last_error_code = p_error_code,
           recovery_dead_lettered_at = now(),
           updated_at = now()
     where p.id = p_profile_id
       and p.provisioned_user_id is null
       and p.owner_user_id is not distinct from p_expected_owner_user_id
       and p.billing_state = p_expected_billing_state
       and p.stripe_customer_id is not distinct from p_expected_customer_id
       and p.stripe_subscription_id is not distinct from p_expected_subscription_id;
    if not found then
      return 'state_changed';
    end if;
    if v_fulfillment_found and v_fulfillment.status = 'pending' then
      update public.checkout_fulfillments f
         set status = 'aborted',
             email_hash = null,
             user_id = null,
             lease_token = null,
             lease_expires_at = null,
             identity_scrubbed_at = coalesce(f.identity_scrubbed_at, now())
       where f.session_id = v_fulfillment.session_id
         and f.profile_id = p_profile_id
         and f.status = 'pending'
         and (
           f.lease_token is null
           or f.lease_expires_at is null
           or f.lease_expires_at <= now()
         );
      if not found then
        raise exception 'checkout fulfillment changed during recovery escalation';
      end if;
    end if;
    return 'dead_lettered';
  end if;

  update public.checkout_profiles p
     set billing_state = 'recovering',
         recovery_previous_state = case
           when p.billing_state = 'recovering' then p.recovery_previous_state
           else p.billing_state
         end,
         recovery_lease_token = p_defer_token,
         recovery_lease_expires_at = p_retry_at,
         recovery_attempt_count = v_next_attempt,
         recovery_last_error_code = p_error_code,
         recovery_dead_lettered_at = null,
         expires_at = p_retry_at,
         updated_at = now()
   where p.id = p_profile_id
     and p.provisioned_user_id is null
     and p.owner_user_id is not distinct from p_expected_owner_user_id
     and p.billing_state = p_expected_billing_state
     and p.stripe_customer_id is not distinct from p_expected_customer_id
     and p.stripe_subscription_id is not distinct from p_expected_subscription_id
     and p.recovery_lease_expires_at is not distinct from
       p_expected_recovery_lease_expires_at
     and p.recovery_dead_lettered_at is null
     and p.expires_at <= now()
     and (
       p.billing_state in ('open', 'paid')
       or (
         p.billing_state = 'recovering'
         and p.recovery_lease_expires_at <= now()
       )
     );
  if not found then
    return 'state_changed';
  end if;
  if v_fulfillment_found and v_fulfillment.status = 'pending' then
    update public.checkout_fulfillments f
       set lease_token = null,
           lease_expires_at = null
     where f.session_id = v_fulfillment.session_id
       and f.profile_id = p_profile_id
       and f.status = 'pending'
       and (
         f.lease_token is null
         or f.lease_expires_at is null
         or f.lease_expires_at <= now()
       );
    if not found then
      raise exception 'checkout fulfillment changed during recovery deferral';
    end if;
  end if;
  return 'deferred';
end;
$$;

-- Dead letters remain exact local obligations until an operator deliberately
-- requeues one. Requeueing does not call a provider, release a billing pair,
-- or restore fulfillment PII. It only makes the retained profile eligible for
-- the same bounded recovery state machine again.
create or replace function public.requeue_checkout_profile_recovery(
  p_profile_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_profile public.checkout_profiles%rowtype;
begin
  if p_profile_id is null then
    return 'invalid';
  end if;
  select coalesce(p.owner_user_id, p.provisioned_user_id)
    into v_owner_id
    from public.checkout_profiles p
   where p.id = p_profile_id;
  if not found then
    return 'profile_missing';
  end if;
  if v_owner_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_owner_id::text, 80425080));
    if exists (
      select 1
        from public.account_deletion_sagas s
       where s.user_id = v_owner_id
    ) then
      return 'deletion_pending';
    end if;
  end if;
  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return 'profile_missing';
  end if;
  if coalesce(v_profile.owner_user_id, v_profile.provisioned_user_id)
       is distinct from v_owner_id then
    return 'profile_owner_conflict';
  end if;
  if v_profile.recovery_dead_lettered_at is null then
    return 'not_dead_lettered';
  end if;
  if v_profile.billing_state not in ('open', 'paid')
     or v_profile.provisioned_user_id is not null
     or v_profile.recovery_attempt_count <> 8
     or v_profile.recovery_last_error_code is null
     or v_profile.recovery_lease_token is not null
     or v_profile.recovery_lease_expires_at is not null
     or v_profile.recovery_previous_state is not null then
    return 'state_changed';
  end if;
  update public.checkout_profiles p
     set recovery_attempt_count = 0,
         recovery_last_error_code = null,
         recovery_dead_lettered_at = null,
         expires_at = now(),
         updated_at = now()
   where p.id = p_profile_id
     and p.recovery_dead_lettered_at = v_profile.recovery_dead_lettered_at
     and p.recovery_attempt_count = 8
     and p.billing_state in ('open', 'paid')
     and p.provisioned_user_id is null;
  return case when found then 'requeued' else 'state_changed' end;
end;
$$;

create or replace function public.count_dead_lettered_checkout_profiles()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
    from public.checkout_profiles p
   where p.recovery_dead_lettered_at is not null;
$$;

-- Finish only stale local replay rows whose profile already reached a durable
-- terminal or provisioned state. This worker never decides provider state and
-- never consumes a current duplicate-refund obligation. It removes subscriber
-- linkage once the canonical issue or the 24-hour no-issue cutoff is proved.
create or replace function public.finalize_stale_checkout_fulfillments(
  p_now timestamptz,
  p_limit integer default 100
)
returns table (
  completed_count integer,
  aborted_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate record;
  v_profile public.checkout_profiles%rowtype;
  v_fulfillment public.checkout_fulfillments%rowtype;
  v_owner_id uuid;
  v_completed integer := 0;
  v_aborted integer := 0;
begin
  if p_now is null
     or p_limit is null
     or p_limit < 1
     or p_limit > 100 then
    raise exception 'stale checkout fulfillment finalizer input is invalid';
  end if;

  for v_candidate in
    select f.session_id, f.profile_id
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
     order by f.created_at, f.session_id
     limit p_limit
  loop
    select *
      into v_profile
      from public.checkout_profiles p
     where p.id = v_candidate.profile_id
     for update;
    if not found then
      continue;
    end if;
    v_owner_id := coalesce(v_profile.owner_user_id, v_profile.provisioned_user_id);
    if v_owner_id is not null
       and not pg_try_advisory_xact_lock(
         hashtextextended(v_owner_id::text, 80425080)
       ) then
      continue;
    end if;
    if v_owner_id is not null
       and exists (
         select 1
           from public.account_deletion_sagas s
          where s.user_id = v_owner_id
       ) then
      continue;
    end if;
    select *
      into v_fulfillment
      from public.checkout_fulfillments f
     where f.session_id = v_candidate.session_id
       and f.profile_id = v_candidate.profile_id
     for update;
    if not found
       or v_fulfillment.status <> 'pending'
       or (
         v_fulfillment.lease_token is not null
         and v_fulfillment.lease_expires_at is not null
         and v_fulfillment.lease_expires_at > p_now
       ) then
      continue;
    end if;

    if v_profile.billing_state in ('ended', 'expired') then
      update public.checkout_fulfillments f
         set status = 'aborted',
             email_hash = null,
             user_id = null,
             lease_token = null,
             lease_expires_at = null,
             identity_scrubbed_at = coalesce(f.identity_scrubbed_at, p_now)
       where f.session_id = v_fulfillment.session_id
         and f.profile_id = v_profile.id
         and f.status = 'pending';
      if found then
        v_aborted := v_aborted + 1;
      end if;
      continue;
    end if;

    if v_profile.provisioned_user_id is null
       or v_profile.raw_profile_scrubbed_at is null then
      continue;
    end if;
    if v_fulfillment.user_id = v_profile.provisioned_user_id
       and exists (
         select 1
           from public.issues i
          where i.user_id = v_profile.provisioned_user_id
            and i.week_of = v_fulfillment.week_of
       ) then
      update public.checkout_fulfillments f
         set status = 'completed',
             completed_at = coalesce(f.completed_at, p_now),
             email_hash = null,
             user_id = null,
             lease_token = null,
             lease_expires_at = null,
             identity_scrubbed_at = coalesce(f.identity_scrubbed_at, p_now)
       where f.session_id = v_fulfillment.session_id
         and f.profile_id = v_profile.id
         and f.status = 'pending';
      if found then
        v_completed := v_completed + 1;
      end if;
    elsif v_fulfillment.created_at <= p_now - interval '24 hours' then
      update public.checkout_fulfillments f
         set status = 'aborted',
             email_hash = null,
             user_id = null,
             lease_token = null,
             lease_expires_at = null,
             identity_scrubbed_at = coalesce(f.identity_scrubbed_at, p_now)
       where f.session_id = v_fulfillment.session_id
         and f.profile_id = v_profile.id
         and f.status = 'pending';
      if found then
        v_aborted := v_aborted + 1;
      end if;
    end if;
  end loop;

  return query select v_completed, v_aborted;
end;
$$;

-- Claim decisions:
--   claimed          this caller owns the lease and may generate
--   in_progress      another request still owns the same checkout
--   completed        this checkout was already consumed
--   cleanup_pending  duplicate-billing cleanup is durably owned by recovery
--   manual_review    bounded recovery exhausted and needs operator requeue
--   aborted          this replay guard was closed without a usable fulfillment
--   profile_mismatch the session/profile binding is inconsistent
--
-- The row lock makes the decision atomic across Worker isolates. A crashed
-- request becomes retryable after the lease expires. Ordinary failures release
-- their own lease immediately in application code.
create or replace function public.claim_checkout_fulfillment(
  p_session_id text,
  p_profile_id uuid,
  p_email_hash text,
  p_user_id uuid,
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
  v_row public.checkout_fulfillments%rowtype;
  v_profile public.checkout_profiles%rowtype;
begin
  if p_lease_seconds is null
     or p_lease_seconds < 30
     or p_lease_seconds > 300 then
    raise exception 'lease seconds out of range';
  end if;
  if p_session_id is null or p_session_id = ''
     or p_profile_id is null
     or p_email_hash is null
     or p_email_hash !~ '^[0-9a-f]{64}$'
     or p_user_id is null
     or p_week_of is null
     or p_lease_token is null then
    raise exception 'invalid checkout fulfillment claim';
  end if;

  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  if not found then
    return query select 'profile_mismatch'::text, null::uuid, p_week_of;
    return;
  end if;

  -- The exact row must be stable before deriving its owner. Use a nonblocking
  -- shared-owner lock after the row lock so deletion's owner-then-row order
  -- cannot deadlock. A retry gets a fresh decision after deletion commits.
  if v_profile.owner_user_id is distinct from p_user_id
     or (
       v_profile.provisioned_user_id is not null
       and v_profile.provisioned_user_id <> p_user_id
     ) then
    return query select 'profile_mismatch'::text, null::uuid, p_week_of;
    return;
  end if;
  if not pg_try_advisory_xact_lock(
    hashtextextended(p_user_id::text, 80425080)
  ) then
    return query select 'in_progress'::text, null::uuid, p_week_of;
    return;
  end if;
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_user_id
  ) then
    return query select 'aborted'::text, null::uuid, p_week_of;
    return;
  end if;

  if v_profile.recovery_dead_lettered_at is not null then
    return query select 'manual_review'::text, null::uuid, p_week_of;
    return;
  end if;
  if v_profile.stripe_customer_id is not null
     and v_profile.stripe_subscription_id is not null
     and exists (
       select 1
         from public.refund_reviews r
        where r.session_id = p_session_id
          and r.customer_id = v_profile.stripe_customer_id
          and r.subscription_id = v_profile.stripe_subscription_id
          and r.winner_customer_id is not null
          and r.winner_subscription_id is not null
     ) then
    return query select 'cleanup_pending'::text, null::uuid, p_week_of;
    return;
  end if;

  select *
    into v_row
    from public.checkout_fulfillments
   where session_id = p_session_id;
  if found and v_row.status = 'aborted' then
    return query select 'aborted'::text, null::uuid, v_row.week_of;
    return;
  end if;

  if v_profile.stripe_session_id is distinct from p_session_id
     or v_profile.email_hash is distinct from p_email_hash
     or v_profile.billing_state not in ('open', 'paid')
     or v_profile.identity_scrubbed_at is not null then
    return query select 'profile_mismatch'::text, null::uuid, p_week_of;
    return;
  end if;

  insert into public.checkout_fulfillments (
    session_id,
    profile_id,
    email_hash,
    week_of,
    status,
    lease_token,
    lease_expires_at,
    user_id
  ) values (
    p_session_id,
    p_profile_id,
    p_email_hash,
    p_week_of,
    'pending',
    p_lease_token,
    now() + make_interval(secs => p_lease_seconds),
    p_user_id
  )
  on conflict (session_id) do nothing;

  select *
    into v_row
    from public.checkout_fulfillments
   where session_id = p_session_id
   for update;

  if v_row.status = 'completed' then
    return query select 'completed'::text, v_row.user_id, v_row.week_of;
    return;
  end if;

  if v_row.status = 'aborted' then
    return query select 'aborted'::text, null::uuid, v_row.week_of;
    return;
  end if;

  if v_row.profile_id is distinct from p_profile_id
     or v_row.email_hash <> p_email_hash
     or v_row.user_id is distinct from p_user_id
     or v_row.week_of <> p_week_of then
    return query select 'profile_mismatch'::text, v_row.user_id, v_row.week_of;
    return;
  end if;

  if v_row.lease_token is distinct from p_lease_token
     and v_row.lease_expires_at is not null
     and v_row.lease_expires_at > now() then
    return query select 'in_progress'::text, v_row.user_id, v_row.week_of;
    return;
  end if;

  update public.checkout_fulfillments
     set lease_token = p_lease_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where session_id = p_session_id;

  return query select 'claimed'::text, v_row.user_id, v_row.week_of;
end;
$$;

-- Complete the lease and bind its canonical user in one database transaction.
-- The shared owner lock serializes this transition against account deletion.
create or replace function public.complete_checkout_fulfillment(
  p_session_id text,
  p_profile_id uuid,
  p_lease_token uuid,
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_checkout_started_at timestamptz,
  p_prior_customer_id text,
  p_prior_subscription_id text,
  p_prior_binding_replaceable boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.checkout_profiles%rowtype;
  v_fulfillment public.checkout_fulfillments%rowtype;
  v_new_customer_lock text := 'alpha-customer:' || p_customer_id;
  v_prior_customer_lock text;
  v_new_pair_lock text :=
    'alpha-billing:' || p_customer_id || ':' || p_subscription_id;
  v_prior_pair_lock text;
begin
  if coalesce(p_session_id, '') = ''
     or p_profile_id is null
     or p_lease_token is null
     or p_user_id is null
     or coalesce(p_customer_id, '') = ''
     or coalesce(p_subscription_id, '') = ''
     or p_checkout_started_at is null
     or p_checkout_started_at > now() + interval '5 minutes'
     or p_prior_binding_replaceable is null
     or ((p_prior_customer_id is null) <> (p_prior_subscription_id is null)) then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  v_prior_customer_lock := case
    when p_prior_customer_id is null then null
    else 'alpha-customer:' || p_prior_customer_id
  end;
  if v_prior_customer_lock is null
     or v_prior_customer_lock = v_new_customer_lock then
    perform pg_advisory_xact_lock(
      hashtextextended(v_new_customer_lock, 80425082)
    );
  elsif v_prior_customer_lock < v_new_customer_lock then
    perform pg_advisory_xact_lock(
      hashtextextended(v_prior_customer_lock, 80425082)
    );
    perform pg_advisory_xact_lock(
      hashtextextended(v_new_customer_lock, 80425082)
    );
  else
    perform pg_advisory_xact_lock(
      hashtextextended(v_new_customer_lock, 80425082)
    );
    perform pg_advisory_xact_lock(
      hashtextextended(v_prior_customer_lock, 80425082)
    );
  end if;
  v_prior_pair_lock := case
    when p_prior_customer_id is null then null
    else 'alpha-billing:' || p_prior_customer_id || ':' || p_prior_subscription_id
  end;
  if v_prior_pair_lock is null or v_prior_pair_lock = v_new_pair_lock then
    perform pg_advisory_xact_lock(
      hashtextextended(v_new_pair_lock, 80425081)
    );
  elsif v_prior_pair_lock < v_new_pair_lock then
    perform pg_advisory_xact_lock(
      hashtextextended(v_prior_pair_lock, 80425081)
    );
    perform pg_advisory_xact_lock(
      hashtextextended(v_new_pair_lock, 80425081)
    );
  else
    perform pg_advisory_xact_lock(
      hashtextextended(v_new_pair_lock, 80425081)
    );
    perform pg_advisory_xact_lock(
      hashtextextended(v_prior_pair_lock, 80425081)
    );
  end if;
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_user_id
  ) then
    return false;
  end if;

  select *
    into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  select *
    into v_fulfillment
    from public.checkout_fulfillments f
   where f.session_id = p_session_id
   for update;

  if v_profile.id is null
     or v_fulfillment.session_id is null
     or v_fulfillment.profile_id <> p_profile_id
     or v_fulfillment.status <> 'pending'
     or v_fulfillment.user_id is distinct from p_user_id
     or v_fulfillment.lease_token is distinct from p_lease_token
     or v_fulfillment.lease_expires_at is null
     or v_fulfillment.lease_expires_at <= now()
     or v_profile.stripe_session_id <> p_session_id
     or v_profile.billing_state <> 'paid'
     or v_profile.stripe_customer_id is distinct from p_customer_id
     or v_profile.stripe_subscription_id is distinct from p_subscription_id
     or v_profile.session_creation_started_at is null
     or p_checkout_started_at <
       v_profile.session_creation_started_at - interval '5 minutes'
     or v_profile.identity_scrubbed_at is not null
     or (
       v_profile.owner_user_id is not null
       and v_profile.owner_user_id <> p_user_id
     )
     or (
       v_profile.provisioned_user_id is not null
       and v_profile.provisioned_user_id <> p_user_id
     ) then
    return false;
  end if;
  if (
    p_prior_customer_id is distinct from p_customer_id
    or p_prior_subscription_id is distinct from p_subscription_id
  ) and not p_prior_binding_replaceable then
    return false;
  end if;

  -- Generation may win before checkout.completed finishes its user mutation.
  -- Grant the exact live pair and access in this same token-gated transaction
  -- so a missed webhook cannot leave a completed first issue with no future
  -- delivery. Newer opt-outs, delivery suppression, quota, and a future access
  -- end remain untouched. Existing reconcilers clear only evidence older than
  -- this exact checkout cutoff.
  update public.users u
     set stripe_customer_id = p_customer_id,
         stripe_subscription_id = p_subscription_id,
         subscribed_at = coalesce(u.subscribed_at, p_checkout_started_at),
         cancelled_at = case
           -- A replacement checkout was authorized from a fresh terminal or
           -- Alpha-absent classification of this exact prior pair. Clear its
           -- access end even if an old webhook arrived after checkout began.
           -- Same-pair replay still uses the immutable checkout cutoff below.
           when p_prior_binding_replaceable
                and (
                  p_prior_customer_id is distinct from p_customer_id
                  or p_prior_subscription_id is distinct from p_subscription_id
                ) then null
           when u.cancelled_at is not null
                and u.cancelled_at <= p_checkout_started_at then null
           else u.cancelled_at
         end,
         suppression_cleanup_pending_at = coalesce(
           u.suppression_cleanup_pending_at,
           p_checkout_started_at
         ),
         stripe_email_sync_pending_at = coalesce(
           u.stripe_email_sync_pending_at,
           p_checkout_started_at
         ),
         updated_at = now()
  where u.id = p_user_id
      and u.stripe_customer_id is not distinct from p_prior_customer_id
      and u.stripe_subscription_id is not distinct from p_prior_subscription_id;
  if not found then
    -- Commit a bounded recovery deadline instead of raising and rolling the
    -- marker back. The request will freshly classify the winner. If it dies
    -- before recording the duplicate, maintenance can do the same after the
    -- original fulfillment lease boundary.
    update public.checkout_profiles p
       set expires_at = greatest(
             now(),
             coalesce(v_fulfillment.lease_expires_at, now())
           ),
           updated_at = now()
     where p.id = p_profile_id
       and p.owner_user_id = p_user_id
       and p.provisioned_user_id is null
       and p.billing_state = 'paid'
       and p.stripe_session_id = p_session_id
       and p.stripe_customer_id = p_customer_id
       and p.stripe_subscription_id = p_subscription_id;
    return false;
  end if;

  update public.checkout_profiles
     set provisioned_user_id = p_user_id,
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
         raw_profile_scrubbed_at = coalesce(raw_profile_scrubbed_at, now()),
         updated_at = now()
   where id = p_profile_id
     and stripe_customer_id = p_customer_id
     and stripe_subscription_id = p_subscription_id;
  if not found then
    raise exception 'checkout profile binding changed during completion';
  end if;

  update public.checkout_fulfillments
     set status = 'completed',
         user_id = p_user_id,
         completed_at = now(),
         lease_token = null,
         lease_expires_at = null
   where session_id = p_session_id
     and profile_id = p_profile_id
     and status = 'pending'
     and lease_token = p_lease_token;
  if not found then
    raise exception 'checkout fulfillment lease changed during completion';
  end if;
  return true;
end;
$$;

-- A current fulfillment can lose its canonical billing CAS after it generated
-- and persisted the first issue. Persist the exact losing subscription review
-- under owner and deterministic pair locks before any caller may cancel it.
-- Moving the operational deadline to the current fulfillment lease boundary
-- makes a crash promptly visible without racing the synchronous canceller.
create or replace function public.record_current_checkout_duplicate_refund_review(
  p_session_id text,
  p_profile_id uuid,
  p_lease_token uuid,
  p_user_id uuid,
  p_loser_customer_id text,
  p_loser_subscription_id text,
  p_winner_customer_id text,
  p_winner_subscription_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_a text;
  v_customer_b text;
  v_pair_a text;
  v_pair_b text;
  v_profile public.checkout_profiles%rowtype;
  v_fulfillment public.checkout_fulfillments%rowtype;
  v_fulfillment_found boolean := false;
  v_direct_mode boolean := false;
  v_recovery_mode boolean := false;
  v_fulfillment_scrubbed boolean := false;
  v_cleanup_not_before timestamptz;
begin
  if coalesce(p_session_id, '') = ''
     or p_profile_id is null
     or p_lease_token is null
     or p_user_id is null
     or coalesce(p_loser_customer_id, '') = ''
     or coalesce(p_loser_subscription_id, '') = ''
     or coalesce(p_winner_customer_id, '') = ''
     or coalesce(p_winner_subscription_id, '') = ''
     or (
       p_loser_customer_id = p_winner_customer_id
       and p_loser_subscription_id = p_winner_subscription_id
     ) then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  v_customer_a := least(
    'alpha-customer:' || p_loser_customer_id,
    'alpha-customer:' || p_winner_customer_id
  );
  v_customer_b := greatest(
    'alpha-customer:' || p_loser_customer_id,
    'alpha-customer:' || p_winner_customer_id
  );
  perform pg_advisory_xact_lock(hashtextextended(v_customer_a, 80425082));
  if v_customer_b <> v_customer_a then
    perform pg_advisory_xact_lock(hashtextextended(v_customer_b, 80425082));
  end if;
  v_pair_a := least(
    'alpha-billing:' || p_loser_customer_id || ':' || p_loser_subscription_id,
    'alpha-billing:' || p_winner_customer_id || ':' || p_winner_subscription_id
  );
  v_pair_b := greatest(
    'alpha-billing:' || p_loser_customer_id || ':' || p_loser_subscription_id,
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
  select * into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  select * into v_fulfillment
    from public.checkout_fulfillments f
   where f.session_id = p_session_id
   for update;
  v_fulfillment_found := found;
  if v_profile.id is null
     or v_profile.owner_user_id is distinct from p_user_id
     or v_profile.provisioned_user_id is not null
     or v_profile.stripe_session_id is distinct from p_session_id
     or v_profile.stripe_customer_id is distinct from p_loser_customer_id
     or v_profile.stripe_subscription_id is distinct from p_loser_subscription_id
     or (
       v_fulfillment_found
       and v_fulfillment.profile_id is distinct from p_profile_id
     )
     or not exists (
       select 1
         from public.users u
        where u.id = p_user_id
          and u.stripe_customer_id = p_winner_customer_id
          and u.stripe_subscription_id = p_winner_subscription_id
  ) then
    return false;
  end if;
  v_fulfillment_scrubbed := coalesce(
    v_fulfillment_found
    and v_fulfillment.status = 'aborted'
    and v_fulfillment.identity_scrubbed_at is not null
    and v_fulfillment.email_hash is null
    and v_fulfillment.user_id is null
    and v_fulfillment.lease_token is null
    and v_fulfillment.lease_expires_at is null,
    false
  );
  v_direct_mode := coalesce(
    v_fulfillment_found
    and v_profile.billing_state = 'paid'
    and v_profile.recovery_dead_lettered_at is null
    and v_fulfillment.status = 'pending'
    and v_fulfillment.user_id = p_user_id
    and v_fulfillment.lease_token is not null
    and v_fulfillment.lease_token = p_lease_token
    and v_fulfillment.lease_expires_at is not null
    and v_fulfillment.lease_expires_at > now(),
    false
  );
  v_recovery_mode := coalesce(
    v_profile.billing_state = 'recovering'
    and v_profile.recovery_dead_lettered_at is null
    and v_profile.recovery_previous_state in ('open', 'paid')
    and v_profile.recovery_lease_token = p_lease_token
    and v_profile.recovery_lease_expires_at > now()
    and (
      not v_fulfillment_found
      or
      (
        v_fulfillment.status = 'pending'
        and v_fulfillment.user_id = p_user_id
        and (
          v_fulfillment.lease_token is null
          or v_fulfillment.lease_expires_at is null
          or v_fulfillment.lease_expires_at <= now()
        )
      )
      or v_fulfillment_scrubbed
    ),
    false
  );
  if not (v_direct_mode or v_recovery_mode) then
    return false;
  end if;
  -- An overdue or unfulfillable charge review may already reserve this exact
  -- Session/subscription. Preserve that refund reason while attaching the
  -- immutable canonical winner used by the cancellation state machine.
  insert into public.refund_reviews (
    session_id,
    subscription_id,
    customer_id,
    winner_subscription_id,
    winner_customer_id,
    reason
  ) values (
    p_session_id,
    p_loser_subscription_id,
    p_loser_customer_id,
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
  if not found then
    return false;
  end if;

  if v_direct_mode then
    v_cleanup_not_before := greatest(
      v_fulfillment.lease_expires_at,
      now() + interval '4 minutes'
    );
    update public.checkout_fulfillments f
       set lease_expires_at = v_cleanup_not_before
     where f.session_id = p_session_id
       and f.profile_id = p_profile_id
       and f.status = 'pending'
       and f.user_id = p_user_id
       and f.lease_token = p_lease_token
       and f.lease_expires_at > now();
    if not found then
      return false;
    end if;
  else
    v_cleanup_not_before := now();
  end if;
  update public.checkout_profiles p
     -- Keep the synchronous fulfillment owner exclusive until its short lease
     -- ends. A crash is still due within that bounded window, while the
     -- scheduled recovery lane cannot race an in-flight Stripe cancellation.
     set expires_at = v_cleanup_not_before,
         updated_at = now()
   where p.id = p_profile_id
     and p.owner_user_id = p_user_id
     and p.provisioned_user_id is null
     and p.stripe_customer_id = p_loser_customer_id
     and p.stripe_subscription_id = p_loser_subscription_id
     and (
       (v_direct_mode and p.billing_state = 'paid')
       or (
         v_recovery_mode
         and p.billing_state = 'recovering'
        and p.recovery_previous_state in ('open', 'paid')
         and p.recovery_lease_token = p_lease_token
       )
     );
  return found;
end;
$$;

-- After the exact losing subscription is freshly proved terminal, consume its
-- fulfillment and scrub every subscriber/billing link in one token-gated CAS.
-- The PII-free refund review retains the exact pair for the finite dispute
-- window and the Session id remains the replay guard.
create or replace function public.abort_current_checkout_duplicate_fulfillment(
  p_session_id text,
  p_profile_id uuid,
  p_lease_token uuid,
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_winner_customer_id text,
  p_winner_subscription_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_a text;
  v_customer_b text;
  v_pair_a text;
  v_pair_b text;
  v_profile public.checkout_profiles%rowtype;
  v_fulfillment public.checkout_fulfillments%rowtype;
  v_fulfillment_found boolean := false;
  v_direct_mode boolean := false;
  v_recovery_mode boolean := false;
  v_fulfillment_scrubbed boolean := false;
begin
  if coalesce(p_session_id, '') = ''
     or p_profile_id is null
     or p_lease_token is null
     or p_user_id is null
     or coalesce(p_customer_id, '') = ''
     or coalesce(p_subscription_id, '') = ''
     or coalesce(p_winner_customer_id, '') = ''
     or coalesce(p_winner_subscription_id, '') = ''
     or (
       p_customer_id = p_winner_customer_id
       and p_subscription_id = p_winner_subscription_id
     ) then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  v_customer_a := least(
    'alpha-customer:' || p_customer_id,
    'alpha-customer:' || p_winner_customer_id
  );
  v_customer_b := greatest(
    'alpha-customer:' || p_customer_id,
    'alpha-customer:' || p_winner_customer_id
  );
  perform pg_advisory_xact_lock(hashtextextended(v_customer_a, 80425082));
  if v_customer_b <> v_customer_a then
    perform pg_advisory_xact_lock(hashtextextended(v_customer_b, 80425082));
  end if;
  v_pair_a := least(
    'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
    'alpha-billing:' || p_winner_customer_id || ':' || p_winner_subscription_id
  );
  v_pair_b := greatest(
    'alpha-billing:' || p_customer_id || ':' || p_subscription_id,
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
  if not exists (
    select 1
      from public.refund_reviews r
     where r.session_id = p_session_id
       and r.customer_id = p_customer_id
       and r.subscription_id = p_subscription_id
       and r.winner_customer_id = p_winner_customer_id
       and r.winner_subscription_id = p_winner_subscription_id
  ) then
    return false;
  end if;
  select * into v_profile
    from public.checkout_profiles p
   where p.id = p_profile_id
   for update;
  select * into v_fulfillment
    from public.checkout_fulfillments f
   where f.session_id = p_session_id
   for update;
  v_fulfillment_found := found;
  if v_profile.id is null
     or v_profile.stripe_session_id is distinct from p_session_id
     or (
       v_fulfillment_found
       and v_fulfillment.profile_id is distinct from p_profile_id
     ) then
    return false;
  end if;

  -- A synchronous abort and its scheduled replay may cross after Stripe has
  -- already returned terminal. Treat the fully scrubbed exact replay as a
  -- success so neither path turns a completed cleanup into a false failure.
  if v_profile.billing_state = 'ended'
     and v_profile.identity_scrubbed_at is not null
     and v_profile.owner_user_id is null
     and v_profile.provisioned_user_id is null
     and v_profile.stripe_customer_id is null
     and v_profile.stripe_subscription_id is null
     and (
       not v_fulfillment_found
       or (
         v_fulfillment.status = 'aborted'
         and v_fulfillment.user_id is null
         and v_fulfillment.identity_scrubbed_at is not null
       )
     ) then
    return true;
  end if;

  if not exists (
    select 1
      from public.users u
     where u.id = p_user_id
       and u.stripe_customer_id = p_winner_customer_id
       and u.stripe_subscription_id = p_winner_subscription_id
  ) then
    return false;
  end if;

  v_fulfillment_scrubbed := coalesce(
    v_fulfillment_found
    and v_fulfillment.status = 'aborted'
    and v_fulfillment.identity_scrubbed_at is not null
    and v_fulfillment.email_hash is null
    and v_fulfillment.user_id is null
    and v_fulfillment.lease_token is null
    and v_fulfillment.lease_expires_at is null,
    false
  );

  v_direct_mode := coalesce(
    v_fulfillment_found
    and v_profile.owner_user_id = p_user_id
    and v_profile.provisioned_user_id is null
    and v_profile.billing_state = 'paid'
    and v_profile.stripe_customer_id = p_customer_id
    and v_profile.stripe_subscription_id = p_subscription_id
    and v_fulfillment.status = 'pending'
    and v_fulfillment.user_id = p_user_id
    and v_fulfillment.lease_token is not null
    and v_fulfillment.lease_token = p_lease_token
    and v_fulfillment.lease_expires_at is not null
    and v_fulfillment.lease_expires_at > now(),
    false
  );
  v_recovery_mode := coalesce(
    v_profile.owner_user_id = p_user_id
    and v_profile.provisioned_user_id is null
    and v_profile.billing_state = 'recovering'
    and v_profile.recovery_previous_state in ('open', 'paid')
    and v_profile.recovery_lease_token = p_lease_token
    and v_profile.recovery_lease_expires_at > now()
    and v_profile.stripe_customer_id = p_customer_id
    and v_profile.stripe_subscription_id = p_subscription_id
    and (
      not v_fulfillment_found
      or
      (
        v_fulfillment.status = 'pending'
        and v_fulfillment.user_id = p_user_id
        and (
          v_fulfillment.lease_token is null
          or v_fulfillment.lease_expires_at is null
          or v_fulfillment.lease_expires_at <= now()
        )
      )
      or v_fulfillment_scrubbed
    ),
    false
  );
  if not (v_direct_mode or v_recovery_mode) then
    return false;
  end if;

  update public.checkout_profiles p
     set billing_state = 'ended',
          email_hash = null,
          browser_nonce_hash = null,
          owner_user_id = null,
          provisioned_user_id = null,
          stripe_customer_id = null,
          stripe_subscription_id = null,
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
          recovery_lease_token = null,
          recovery_lease_expires_at = null,
          recovery_previous_state = null,
          recovery_attempt_count = 0,
          recovery_last_error_code = null,
          recovery_dead_lettered_at = null,
          raw_profile_scrubbed_at = coalesce(p.raw_profile_scrubbed_at, now()),
          identity_scrubbed_at = coalesce(p.identity_scrubbed_at, now()),
          updated_at = now()
    where p.id = p_profile_id
      and p.owner_user_id = p_user_id
      and p.provisioned_user_id is null
      and p.stripe_session_id = p_session_id
      and p.stripe_customer_id = p_customer_id
      and p.stripe_subscription_id = p_subscription_id
      and (
        (v_direct_mode and p.billing_state = 'paid')
        or (
          v_recovery_mode
          and p.billing_state = 'recovering'
          and p.recovery_lease_token = p_lease_token
        )
      );
  if not found then
    return false;
  end if;
  if v_fulfillment_found and not v_fulfillment_scrubbed then
    update public.checkout_fulfillments f
       set status = 'aborted',
           email_hash = null,
           user_id = null,
           lease_token = null,
           lease_expires_at = null,
           identity_scrubbed_at = coalesce(f.identity_scrubbed_at, now())
      where f.session_id = p_session_id
        and f.profile_id = p_profile_id
        and f.status = 'pending'
        and f.user_id = p_user_id
        and (
          (v_direct_mode and f.lease_token = p_lease_token)
          or (
            v_recovery_mode
            and (
              f.lease_token is null
              or f.lease_expires_at is null
              or f.lease_expires_at <= now()
            )
          )
        );
    if not found then
      raise exception 'current duplicate fulfillment lease changed during abort';
    end if;
  end if;
  return true;
end;
$$;

-- Keep exact Customer/Subscription and subscriber linkages only for a fixed
-- 180-day terminal billing-review window. After that window, the random
-- profile id plus immutable Checkout Session id remain as the replay guard,
-- while every account, email, browser, and recurring-billing binding is
-- removed. Completed fulfillment rows likewise retain only their Session,
-- profile, week, and terminal timestamps.
create or replace function public.scrub_terminal_checkout_tombstones(
  p_now timestamptz,
  p_limit integer default 100
)
returns table (
  profiles_scrubbed integer,
  fulfillments_scrubbed integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate record;
  v_profile public.checkout_profiles%rowtype;
  v_profiles_scrubbed integer := 0;
  v_fulfillments_scrubbed integer := 0;
begin
  if p_now is null
     or p_limit is null
     or p_limit < 1
     or p_limit > 100 then
    raise exception 'terminal checkout scrub input is invalid';
  end if;

  -- Owner locks keep a concurrent account deletion or billing reconciliation
  -- from observing a half-scrubbed terminal reservation. Busy owners are
  -- skipped and remain visible to the next bounded maintenance run.
  for v_candidate in
    select p.id,
           coalesce(p.owner_user_id, p.provisioned_user_id) as owner_id
      from public.checkout_profiles p
     where p.billing_state in ('ended', 'expired')
       and p.identity_scrubbed_at is null
       and p.updated_at <= p_now - interval '180 days'
     order by coalesce(
       p.owner_user_id::text,
       p.provisioned_user_id::text,
       ''
     ), p.updated_at, p.id
     limit p_limit
  loop
    if v_candidate.owner_id is not null
       and not pg_try_advisory_xact_lock(
         hashtextextended(v_candidate.owner_id::text, 80425080)
       ) then
      continue;
    end if;
    select *
      into v_profile
      from public.checkout_profiles p
     where p.id = v_candidate.id
     for update;
    if not found
       or v_profile.billing_state not in ('ended', 'expired')
       or v_profile.identity_scrubbed_at is not null
       or v_profile.updated_at > p_now - interval '180 days'
       or coalesce(v_profile.owner_user_id, v_profile.provisioned_user_id)
          is distinct from v_candidate.owner_id then
      continue;
    end if;
    update public.checkout_profiles p
       set email_hash = null,
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
           raw_profile_scrubbed_at = coalesce(
             p.raw_profile_scrubbed_at,
             p_now
           ),
           browser_nonce_hash = null,
           owner_user_id = null,
           provisioned_user_id = null,
           stripe_customer_id = null,
           stripe_subscription_id = null,
           identity_scrubbed_at = p_now,
           updated_at = p_now
     where p.id = v_candidate.id
       and p.billing_state in ('ended', 'expired')
       and p.identity_scrubbed_at is null;
    if found then
      v_profiles_scrubbed := v_profiles_scrubbed + 1;
    end if;
  end loop;

  with candidates as (
    select f.session_id
      from public.checkout_fulfillments f
     where f.status = 'completed'
       and f.identity_scrubbed_at is null
       and f.completed_at <= p_now - interval '180 days'
     order by f.completed_at, f.session_id
     limit p_limit
     for update skip locked
  )
  update public.checkout_fulfillments f
     set email_hash = null,
         user_id = null,
         lease_token = null,
         lease_expires_at = null,
         identity_scrubbed_at = p_now
   where f.session_id in (select c.session_id from candidates);
  get diagnostics v_fulfillments_scrubbed = row_count;

  return query select v_profiles_scrubbed, v_fulfillments_scrubbed;
end;
$$;

-- A failed saga must yield to later rows instead of monopolizing every
-- bounded reconciler run. This changes only scheduler metadata and keeps all
-- exact billing and privacy obligations intact.
create or replace function public.defer_account_deletion_reconciliation(
  p_user_id uuid,
  p_retry_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null
     or p_retry_at is null
     or p_retry_at < now() + interval '1 minute'
     or p_retry_at > now() + interval '1 hour' then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  update public.account_deletion_sagas s
     set reconcile_next_attempt_at = p_retry_at,
         reconcile_attempt_count = s.reconcile_attempt_count + 1,
         updated_at = now()
   where s.user_id = p_user_id
     and s.state in ('prepared', 'billing_clean', 'auth_delete_started');
  return found;
end;
$$;

revoke all on table public.checkout_profiles from anon, authenticated;
revoke all on table public.checkout_fulfillments from anon, authenticated;
revoke all on table public.checkout_creation_reviews from public, anon, authenticated;
revoke all on table public.account_deletion_sagas from anon, authenticated;
revoke all on table public.account_deletion_alpha_subscriptions from anon, authenticated;
revoke all on table public.refund_reviews from anon, authenticated;
revoke all on function public.claim_checkout_fulfillment(text, uuid, text, uuid, date, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.complete_checkout_fulfillment(text, uuid, uuid, uuid, text, text, timestamptz, text, text, boolean)
  from public, anon, authenticated;
revoke all on function public.record_current_checkout_duplicate_refund_review(text, uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.abort_current_checkout_duplicate_fulfillment(text, uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.scrub_terminal_checkout_tombstones(timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.block_checkout_for_deleting_owner()
  from public, anon, authenticated;
revoke all on function public.block_billing_rebind_during_account_deletion()
  from public, anon, authenticated;
revoke all on function public.stage_checkout_profile(uuid, text, text, text, text, text, text, text, date, text, text[], text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.begin_checkout_session_creation(uuid, text, text, integer, text)
  from public, anon, authenticated;
revoke all on function public.bind_checkout_session(uuid, text)
  from public, anon, authenticated;
revoke all on function public.settle_checkout_session_expiration(uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_checkout_session_creation_replay(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.hold_checkout_session_creation_for_invite_review(uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.settle_checkout_session_creation_replay(uuid, uuid, timestamptz, text, text)
  from public, anon, authenticated;
revoke all on function public.release_checkout_session_creation_replay(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_checkout_creation_review_with_session(uuid, text)
  from public, anon, authenticated;
revoke all on function public.resolve_checkout_creation_review_no_create(uuid, text)
  from public, anon, authenticated;
revoke all on function public.count_pending_checkout_creation_reviews()
  from public, anon, authenticated;
revoke all on function public.list_stale_checkout_session_creations(timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.prepare_account_deletion(uuid)
  from public, anon, authenticated;
revoke all on function public.bind_account_deletion_subscription(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.record_account_deletion_subscription(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.settle_account_deletion_checkout_profile(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.confirm_account_deletion_billing(uuid)
  from public, anon, authenticated;
revoke all on function public.begin_account_deletion_auth_removal(uuid)
  from public, anon, authenticated;
revoke all on function public.mark_account_deletion_support_deleted(uuid)
  from public, anon, authenticated;
revoke all on function public.mark_account_deletion_delivery_policy_settled(uuid)
  from public, anon, authenticated;
revoke all on function public.complete_account_deletion(uuid)
  from public, anon, authenticated;
revoke all on function public.defer_account_deletion_reconciliation(uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.recover_checkout_profile_provisioning(uuid, text, text, uuid, boolean, text, text, boolean)
  from public, anon, authenticated;
revoke all on function public.prune_completed_account_deletion_sagas(integer)
  from public, anon, authenticated;
revoke all on function public.claim_checkout_profile_recovery(uuid, text, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.settle_checkout_profile_recovery(uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.fail_checkout_profile_recovery(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.defer_checkout_profile_recovery_candidate(uuid, uuid, text, text, text, timestamptz, uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.requeue_checkout_profile_recovery(uuid)
  from public, anon, authenticated;
revoke all on function public.count_dead_lettered_checkout_profiles()
  from public, anon, authenticated;
revoke all on function public.finalize_stale_checkout_fulfillments(timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.block_user_mutation_during_account_deletion()
  from public, anon, authenticated;
revoke all on function public.block_issue_mutation_during_account_deletion()
  from public, anon, authenticated;
revoke all on function public.block_support_ticket_mutation_during_account_deletion()
  from public, anon, authenticated;
revoke all on function public.block_user_billing_pair_conflict()
  from public, anon, authenticated;
revoke all on function public.block_checkout_billing_pair_conflict()
  from public, anon, authenticated;
revoke all on function public.record_refund_review(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.record_webhook_duplicate_refund_review(text, uuid, text, date, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.count_pending_refund_reviews()
  from public, anon, authenticated;
grant execute on function public.claim_checkout_fulfillment(text, uuid, text, uuid, date, uuid, integer)
  to service_role;
grant execute on function public.complete_checkout_fulfillment(text, uuid, uuid, uuid, text, text, timestamptz, text, text, boolean)
  to service_role;
grant execute on function public.record_current_checkout_duplicate_refund_review(text, uuid, uuid, uuid, text, text, text, text)
  to service_role;
grant execute on function public.abort_current_checkout_duplicate_fulfillment(text, uuid, uuid, uuid, text, text, text, text)
  to service_role;
grant execute on function public.scrub_terminal_checkout_tombstones(timestamptz, integer)
  to service_role;
grant execute on function public.stage_checkout_profile(uuid, text, text, text, text, text, text, text, date, text, text[], text, text, uuid)
  to service_role;
grant execute on function public.begin_checkout_session_creation(uuid, text, text, integer, text)
  to service_role;
grant execute on function public.bind_checkout_session(uuid, text)
  to service_role;
grant execute on function public.settle_checkout_session_expiration(uuid, text)
  to service_role;
grant execute on function public.claim_checkout_session_creation_replay(uuid, uuid, integer)
  to service_role;
grant execute on function public.hold_checkout_session_creation_for_invite_review(uuid, timestamptz)
  to service_role;
grant execute on function public.settle_checkout_session_creation_replay(uuid, uuid, timestamptz, text, text)
  to service_role;
grant execute on function public.release_checkout_session_creation_replay(uuid, uuid)
  to service_role;
grant execute on function public.complete_checkout_creation_review_with_session(uuid, text)
  to service_role;
grant execute on function public.resolve_checkout_creation_review_no_create(uuid, text)
  to service_role;
grant execute on function public.count_pending_checkout_creation_reviews()
  to service_role;
grant execute on function public.list_stale_checkout_session_creations(timestamptz, integer)
  to service_role;
grant execute on function public.prepare_account_deletion(uuid)
  to service_role;
grant execute on function public.bind_account_deletion_subscription(uuid, text, text, text)
  to service_role;
grant execute on function public.record_account_deletion_subscription(uuid, text, text, text)
  to service_role;
grant execute on function public.settle_account_deletion_checkout_profile(uuid, uuid, text, text, text, text)
  to service_role;
grant execute on function public.confirm_account_deletion_billing(uuid)
  to service_role;
grant execute on function public.begin_account_deletion_auth_removal(uuid)
  to service_role;
grant execute on function public.mark_account_deletion_support_deleted(uuid)
  to service_role;
grant execute on function public.mark_account_deletion_delivery_policy_settled(uuid)
  to service_role;
grant execute on function public.complete_account_deletion(uuid)
  to service_role;
grant execute on function public.defer_account_deletion_reconciliation(uuid, timestamptz)
  to service_role;
grant execute on function public.recover_checkout_profile_provisioning(uuid, text, text, uuid, boolean, text, text, boolean)
  to service_role;
grant execute on function public.prune_completed_account_deletion_sagas(integer)
  to service_role;
grant execute on function public.claim_checkout_profile_recovery(uuid, text, text, uuid, integer)
  to service_role;
grant execute on function public.settle_checkout_profile_recovery(uuid, uuid, text, text, text)
  to service_role;
grant execute on function public.fail_checkout_profile_recovery(uuid, uuid, text, timestamptz)
  to service_role;
grant execute on function public.defer_checkout_profile_recovery_candidate(uuid, uuid, text, text, text, timestamptz, uuid, text, timestamptz)
  to service_role;
grant execute on function public.requeue_checkout_profile_recovery(uuid)
  to service_role;
grant execute on function public.count_dead_lettered_checkout_profiles()
  to service_role;
grant execute on function public.finalize_stale_checkout_fulfillments(timestamptz, integer)
  to service_role;
grant execute on function public.record_refund_review(text, text, text, text)
  to service_role;
grant execute on function public.record_webhook_duplicate_refund_review(text, uuid, text, date, text, text, text, text)
  to service_role;
grant execute on function public.count_pending_refund_reviews()
  to service_role;
