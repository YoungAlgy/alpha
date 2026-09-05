-- A durable recovery clock orders delayed signed Resend events against an
-- explicitly reviewed suppression clear. Signup and checkout preserve blocks.
-- A staged, one-way attempt record keeps every accepted message bound to its
-- real owner, including older message ids replaced by a forced resend.

alter table public.users
  add column if not exists delivery_suppression_cleared_at timestamptz,
  add column if not exists suppression_recovery_token uuid,
  add column if not exists suppression_recovery_started_at timestamptz,
  add column if not exists suppression_recovery_snapshot jsonb;

-- This fence has no automatic expiry. A timed-out DELETE may still mutate
-- the provider. Only a confirmed terminal response may settle its owner token.
alter table public.users
  add constraint users_suppression_recovery_state_check check (
    (
      suppression_recovery_token is null
      and suppression_recovery_started_at is null
      and suppression_recovery_snapshot is null
    ) or (
      suppression_recovery_token is not null
      and suppression_recovery_started_at is not null
      and isfinite(suppression_recovery_started_at)
      and suppression_recovery_snapshot is not null
      and jsonb_typeof(suppression_recovery_snapshot) = 'object'
    )
  );

create index if not exists users_suppression_recovery_pending_idx
  on public.users (suppression_recovery_started_at)
  where suppression_recovery_token is not null;

-- Keep future public identity clocks exact before scanning historical rows.
-- The original Auth trigger let public.users use its own now() default, which
-- could drift from the Auth row this causality boundary represents.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_at is null then
    raise exception 'Auth user creation clock is required';
  end if;
  insert into public.users (id, email, created_at)
  values (new.id, new.email, new.created_at)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- The account creation clock is part of suppression ownership causality. The
-- initial schema left it nullable, so recover only missing values from the
-- exact Auth identity clock before making that invariant structural. Never
-- invent a cutover-time value: that could make a real earlier provider event
-- look older than the account that actually owned its recipient.
do $$
declare
  v_prior_claims text := current_setting('request.jwt.claims', true);
begin
  if exists (
    select 1
      from public.users user_row
      left join auth.users auth_user on auth_user.id = user_row.id
     where user_row.created_at is null
       and auth_user.created_at is null
  ) then
    raise exception 'Cannot recover public.users.created_at from auth.users.created_at';
  end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.users user_row
     set created_at = auth_user.created_at
    from auth.users auth_user
   where user_row.id = auth_user.id
     and user_row.created_at is null;
  perform set_config(
    'request.jwt.claims',
    coalesce(nullif(v_prior_claims, ''), '{}'),
    true
  );
end;
$$;

alter table public.users
  alter column created_at set not null;

alter table public.resend_webhook_events
  add column if not exists event_at timestamptz,
  add column if not exists recipient_hashes text[] not null default '{}'::text[],
  add column if not exists owner_user_id uuid references public.users(id) on delete cascade,
  add column if not exists resolution_status text not null default 'legacy_review',
  add column if not exists review_required_at timestamptz,
  add column if not exists resolved_at timestamptz;

-- Historical receipt clocks were nullable. A missing clock gets one fixed
-- migration-time retention anchor, not a claim about when delivery occurred.
-- Existing event clocks are preferred when available. Replays never reset it.
update public.resend_webhook_events
   set received_at = least(coalesce(event_at, now()), now())
 where received_at is null;
alter table public.resend_webhook_events
  alter column received_at set not null;

update public.resend_webhook_events
   set resolution_status = 'legacy_review',
       review_required_at = coalesce(review_required_at, received_at, now()),
       resolved_at = null
 where event_at is null;

alter table public.resend_webhook_events
  alter column resolution_status set default 'pending_owner',
  add constraint resend_webhook_events_resolution_status_check check (
    resolution_status in (
      'legacy_review',
      'pending_owner',
      'manual_review',
      'applied',
      'causally_ignored'
    )
  ),
  add constraint resend_webhook_events_resolution_marker_check check (
    (
      resolution_status in ('legacy_review', 'pending_owner', 'manual_review')
      and review_required_at is not null
      and resolved_at is null
    )
    or (
      resolution_status in ('applied', 'causally_ignored')
      and review_required_at is null
      and resolved_at is not null
    )
  ),
  add constraint resend_webhook_events_event_clock_check check (
    event_at is not null or resolution_status = 'legacy_review'
  );

create index resend_webhook_events_pending_review_idx
  on public.resend_webhook_events (review_required_at, email_id, type)
  where review_required_at is not null;

-- An unmatched event is a short recovery record, never a deleted-user archive.
-- LEAST ignores a null legacy event clock. Receipt time is never refreshed on
-- replay, and a newly replayed old event is rejected before insertion below.
create index resend_webhook_events_unowned_retention_idx
  on public.resend_webhook_events (least(event_at, received_at), email_id, type)
  where owner_user_id is null;

revoke all on table public.resend_webhook_events
  from public, anon, authenticated, service_role;
grant select on table public.resend_webhook_events to service_role;

create unique index issues_id_user_id_uidx
  on public.issues (id, user_id);

create table public.resend_delivery_attempts (
  attempt_id        uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  issue_id          uuid not null,
  recipient         text not null,
  delivery_lane     text not null,
  request_fingerprint text not null,
  started_at        timestamptz not null,
  retry_deadline_at timestamptz not null,
  manual_review_required_at timestamptz,
  lease_token       uuid,
  lease_expires_at  timestamptz,
  resend_message_id text,
  accepted_at       timestamptz,
  recorded_at       timestamptz not null default now(),
  foreign key (issue_id, user_id)
    references public.issues(id, user_id) on delete cascade,
  constraint resend_delivery_attempts_message_id_key unique (resend_message_id),
  constraint resend_delivery_attempts_message_id_shape check (
    resend_message_id is null
    or (
      resend_message_id = btrim(resend_message_id)
      and length(resend_message_id) between 1 and 512
    )
  ),
  constraint resend_delivery_attempts_recipient_shape check (
    recipient = lower(btrim(recipient))
    and length(recipient) between 3 and 254
  ),
  constraint resend_delivery_attempts_lane_shape check (
    delivery_lane = 'live'
    or delivery_lane ~ '^force-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint resend_delivery_attempts_request_fingerprint_shape check (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint resend_delivery_attempts_retry_window_check check (
    retry_deadline_at = started_at + interval '23 hours'
    and retry_deadline_at > started_at
  ),
  constraint resend_delivery_attempts_lease_shape check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint resend_delivery_attempts_finalization_shape check (
    (
      resend_message_id is null
      and accepted_at is null
    )
    or (
      resend_message_id is not null
      and accepted_at is not null
      and accepted_at >= started_at
      and lease_token is null
      and lease_expires_at is null
    )
  ),
  constraint resend_delivery_attempts_manual_review_shape check (
    manual_review_required_at is null
    or (
      resend_message_id is null
      and manual_review_required_at >= retry_deadline_at
    )
  )
);

create index resend_delivery_attempts_user_idx
  on public.resend_delivery_attempts (user_id, started_at, attempt_id);
create unique index resend_delivery_attempts_issue_lane_uidx
  on public.resend_delivery_attempts (issue_id, delivery_lane);

alter table public.resend_delivery_attempts enable row level security;
revoke all on table public.resend_delivery_attempts
  from public, anon, authenticated, service_role;
grant select on table public.resend_delivery_attempts to service_role;

create index if not exists issues_resend_message_id_idx
  on public.issues (resend_message_id)
  where resend_message_id is not null;

-- Claim holds the users row while creating its lease. This trigger provides
-- the other half of that ordering: a delivery-critical user mutation that
-- starts first commits before claim rechecks eligibility, while one that
-- starts after claim sees the active lease and must retry after the bounded
-- provider leg. A committed unsubscribe/email/suppression change can therefore
-- never be followed by a send using the older state.
create or replace function public.block_user_delivery_change_with_active_attempt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    new.email is distinct from old.email
    or new.subscribed_at is distinct from old.subscribed_at
    or new.cancelled_at is distinct from old.cancelled_at
    or new.unsubscribed_at is distinct from old.unsubscribed_at
    or new.access_granted_at is distinct from old.access_granted_at
    or new.bounced_at is distinct from old.bounced_at
    or new.complained_at is distinct from old.complained_at
    or new.suppression_cleanup_pending_at is distinct from old.suppression_cleanup_pending_at
    or new.delivery_suppression_cleared_at is distinct from old.delivery_suppression_cleared_at
  ) and exists (
    select 1
      from public.resend_delivery_attempts a
     where a.user_id = old.id
       and a.resend_message_id is null
       and a.lease_expires_at > clock_timestamp()
  ) then
    raise exception 'delivery state change blocked by active provider lease';
  end if;
  return new;
end;
$$;

revoke all on function public.block_user_delivery_change_with_active_attempt()
  from public, anon, authenticated, service_role;

create trigger users_active_delivery_state_guard
before update of
  email,
  subscribed_at,
  cancelled_at,
  unsubscribed_at,
  access_granted_at,
  bounced_at,
  complained_at,
  suppression_cleanup_pending_at,
  delivery_suppression_cleared_at
on public.users
for each row execute function public.block_user_delivery_change_with_active_attempt();

-- Keep the new causal clock service-owned. This is the latest full definition
-- of the privileged-column trigger function, including all Round 80 markers.
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
  new.delivery_suppression_cleared_at := old.delivery_suppression_cleared_at;
  new.suppression_recovery_token := old.suppression_recovery_token;
  new.suppression_recovery_started_at := old.suppression_recovery_started_at;
  new.suppression_recovery_snapshot := old.suppression_recovery_snapshot;
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

revoke all on function public.protect_user_privileged_columns()
  from public, anon, authenticated;

-- Claim the exact provider idempotency lane before sending. A retry may only
-- reuse the immutable recipient first stored for that lane. The bounded lease
-- also prevents account deletion from racing an in-flight provider request.
create or replace function public.claim_resend_delivery_attempt(
  p_user_id uuid,
  p_week_of date,
  p_recipient text,
  p_delivery_lane text,
  p_request_fingerprint text,
  p_lease_token uuid,
  p_expected_claimed_at timestamptz
)
returns table(
  delivery_status text,
  stored_recipient text,
  stored_message_id text,
  stored_accepted_at timestamptz,
  stored_lease_expires_at timestamptz,
  stored_retry_deadline_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
  v_issue_id uuid;
  v_current_delivered_at timestamptz;
  v_current_message_id text;
  v_attempt public.resend_delivery_attempts%rowtype;
  v_inserted integer := 0;
  v_now timestamptz := clock_timestamp();
  v_lease_expires_at timestamptz;
begin
  if p_user_id is null
     or p_week_of is null
     or p_recipient is null
     or p_recipient <> lower(btrim(p_recipient))
     or length(p_recipient) < 3
     or length(p_recipient) > 254
     or p_delivery_lane is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or p_lease_token is null
     or (
       p_delivery_lane <> 'live'
       and p_delivery_lane !~ '^force-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     )
     or (
       p_delivery_lane <> 'live'
       and p_expected_claimed_at is not null
     )
     or (
       p_delivery_lane = 'live'
       and p_expected_claimed_at is null
     ) then
    return query select 'invalid'::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  if exists (
    select 1
      from public.account_deletion_sagas s
     where s.user_id = p_user_id
  ) then
    return query select 'deletion_pending'::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;
  select *
    into v_user
    from public.users
   where id = p_user_id
   for update;
  if not found then
    return query select 'missing'::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;
  if lower(btrim(v_user.email)) <> p_recipient
     or v_user.created_at is null
     or v_user.subscribed_at is null
     or (
       v_user.access_granted_at is null
       and v_user.cancelled_at is not null
       and v_user.cancelled_at <= v_now
     )
     or v_user.unsubscribed_at is not null
     or v_user.bounced_at is not null
     or v_user.complained_at is not null
     or v_user.suppression_cleanup_pending_at is not null
     or v_user.suppression_recovery_token is not null then
    return query select 'ineligible'::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;
  select id, delivered_at, resend_message_id
    into v_issue_id, v_current_delivered_at, v_current_message_id
    from public.issues
   where user_id = p_user_id
     and week_of = p_week_of
   for update;
  if not found then
    return query select 'missing'::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;
  if p_delivery_lane = 'live'
     and v_current_delivered_at is distinct from p_expected_claimed_at then
    return query select 'claim_conflict'::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;
  if exists (
    select 1
      from public.resend_delivery_attempts a
     where a.issue_id = v_issue_id
       and a.delivery_lane <> p_delivery_lane
       and a.resend_message_id is null
  ) then
    return query select 'other_lane_pending'::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  v_lease_expires_at := v_now + interval '5 minutes';

  insert into public.resend_delivery_attempts (
    user_id,
    issue_id,
    recipient,
    delivery_lane,
    request_fingerprint,
    started_at,
    retry_deadline_at,
    lease_token,
    lease_expires_at
  ) values (
    p_user_id,
    v_issue_id,
    p_recipient,
    p_delivery_lane,
    p_request_fingerprint,
    v_now,
    v_now + interval '23 hours',
    p_lease_token,
    v_lease_expires_at
  )
  on conflict (issue_id, delivery_lane) do nothing;
  get diagnostics v_inserted = row_count;

  select *
    into v_attempt
    from public.resend_delivery_attempts
   where issue_id = v_issue_id
     and delivery_lane = p_delivery_lane
   for update;
  if not found or v_attempt.user_id <> p_user_id then
    raise exception 'Resend delivery attempt ownership conflict';
  end if;

  if v_attempt.resend_message_id is not null then
    if v_current_message_id is null
       or v_current_message_id = v_attempt.resend_message_id
       or v_current_delivered_at is null
       or v_current_delivered_at <= v_attempt.accepted_at then
      update public.issues
         set resend_message_id = v_attempt.resend_message_id,
             delivered_at = v_attempt.accepted_at
       where id = v_issue_id;
    end if;
    return query select 'finalized'::text, v_attempt.recipient,
      v_attempt.resend_message_id, v_attempt.accepted_at,
      null::timestamptz, v_attempt.retry_deadline_at;
    return;
  end if;
  if v_attempt.recipient <> p_recipient then
    return query select 'recipient_changed'::text, v_attempt.recipient,
      null::text, null::timestamptz, v_attempt.lease_expires_at,
      v_attempt.retry_deadline_at;
    return;
  end if;
  if v_attempt.request_fingerprint <> p_request_fingerprint then
    return query select 'payload_changed'::text, v_attempt.recipient,
      null::text, null::timestamptz, v_attempt.lease_expires_at,
      v_attempt.retry_deadline_at;
    return;
  end if;
  if v_inserted = 0
     and v_attempt.lease_token is distinct from p_lease_token
     and v_attempt.lease_expires_at > clock_timestamp() then
    return query select 'busy'::text, v_attempt.recipient,
      null::text, null::timestamptz, v_attempt.lease_expires_at,
      v_attempt.retry_deadline_at;
    return;
  end if;
  if v_now >= v_attempt.retry_deadline_at then
    update public.resend_delivery_attempts
       set manual_review_required_at = coalesce(
         manual_review_required_at,
         v_now
       ),
           lease_token = null,
           lease_expires_at = null
     where attempt_id = v_attempt.attempt_id;
    return query select 'ambiguous_expired'::text, v_attempt.recipient,
      null::text, null::timestamptz, null::timestamptz,
      v_attempt.retry_deadline_at;
    return;
  end if;

  update public.resend_delivery_attempts
     set lease_token = p_lease_token,
         lease_expires_at = v_lease_expires_at
   where attempt_id = v_attempt.attempt_id;
  return query select
    case when v_inserted = 1 then 'claimed'::text else 'replayed'::text end,
    v_attempt.recipient,
    null::text,
    null::timestamptz,
    v_lease_expires_at,
    v_attempt.retry_deadline_at;
end;
$$;

revoke all on function public.claim_resend_delivery_attempt(uuid, date, text, text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_resend_delivery_attempt(uuid, date, text, text, text, uuid, timestamptz)
  to service_role;

-- Shared causal mutation used by both the webhook transaction and a delivery
-- finalization that discovers an earlier fast webhook. The current email is
-- compared by hash so the audit table never needs to retain recipient text.
create or replace function public.apply_resend_suppression_to_user(
  p_user_id uuid,
  p_recipient_hashes text[],
  p_event_type text,
  p_event_at timestamptz
)
returns table(resolution_status text, updated_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
  v_current_hash text;
begin
  if p_user_id is null
     or p_event_type not in ('email.bounced', 'email.complained')
     or p_event_at is null
     or p_recipient_hashes is null
     or cardinality(p_recipient_hashes) < 1 then
    return query select 'manual_review'::text, 0;
    return;
  end if;

  select *
    into v_user
    from public.users
   where id = p_user_id
   for update;
  if not found or v_user.email is null or v_user.created_at is null then
    return query select 'manual_review'::text, 0;
    return;
  end if;

  v_current_hash := encode(
    sha256(convert_to(lower(btrim(v_user.email)), 'UTF8')),
    'hex'
  );
  if not (v_current_hash = any(p_recipient_hashes))
     or v_user.created_at > p_event_at then
    return query select 'manual_review'::text, 0;
    return;
  end if;
  if v_user.delivery_suppression_cleared_at is not null
     and v_user.delivery_suppression_cleared_at > p_event_at then
    return query select 'causally_ignored'::text, 0;
    return;
  end if;

  if p_event_type = 'email.bounced' then
    if v_user.bounced_at is not null and v_user.bounced_at >= p_event_at then
      return query select 'causally_ignored'::text, 0;
      return;
    end if;
    update public.users
       set bounced_at = p_event_at
     where id = p_user_id;
  else
    if v_user.complained_at is not null and v_user.complained_at >= p_event_at then
      return query select 'causally_ignored'::text, 0;
      return;
    end if;
    update public.users
       set complained_at = p_event_at
     where id = p_user_id;
  end if;

  return query select 'applied'::text, 1;
end;
$$;

revoke all on function public.apply_resend_suppression_to_user(uuid, text[], text, timestamptz)
  from public, anon, authenticated, service_role;

-- Finalization is a one-way transition under the exact lease. The immutable
-- attempt becomes webhook ownership authority, and its stored acceptance time
-- repairs the legacy issue proof pointer on both first completion and replay.
create or replace function public.finalize_resend_delivery_attempt(
  p_user_id uuid,
  p_week_of date,
  p_delivery_lane text,
  p_lease_token uuid,
  p_request_fingerprint text,
  p_message_id text
)
returns table(
  delivery_status text,
  stored_accepted_at timestamptz,
  suppression_review_required boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_issue_id uuid;
  v_current_delivered_at timestamptz;
  v_current_message_id text;
  v_attempt public.resend_delivery_attempts%rowtype;
  v_status text := 'recorded';
  v_now timestamptz := clock_timestamp();
  v_recipient_hash text;
  v_event record;
  v_apply_status text;
  v_apply_count integer;
  v_review boolean := false;
begin
  if p_user_id is null
     or p_week_of is null
     or p_lease_token is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or p_message_id is null
     or p_message_id <> btrim(p_message_id)
     or length(p_message_id) < 1
     or length(p_message_id) > 512
     or p_delivery_lane is null
     or (
       p_delivery_lane <> 'live'
       and p_delivery_lane !~ '^force-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     ) then
    return query select 'invalid'::text, null::timestamptz, true;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  perform pg_advisory_xact_lock(
    hashtextextended('alpha-resend-message:' || p_message_id, 80425083)
  );
  select id, delivered_at, resend_message_id
    into v_issue_id, v_current_delivered_at, v_current_message_id
    from public.issues
   where user_id = p_user_id
     and week_of = p_week_of
   for update;
  if not found then
    return query select 'missing'::text, null::timestamptz, true;
    return;
  end if;

  select *
    into v_attempt
    from public.resend_delivery_attempts
   where issue_id = v_issue_id
     and delivery_lane = p_delivery_lane
   for update;
  if not found or v_attempt.user_id <> p_user_id then
    return query select 'missing'::text, null::timestamptz, true;
    return;
  end if;
  if v_attempt.request_fingerprint <> p_request_fingerprint then
    return query select 'payload_changed'::text, null::timestamptz, true;
    return;
  end if;

  if v_attempt.resend_message_id is not null then
    if v_attempt.resend_message_id <> p_message_id then
      return query select 'conflict'::text, null::timestamptz, true;
      return;
    end if;
    v_status := 'replayed';
  else
    if v_attempt.lease_token is distinct from p_lease_token then
      return query select 'lease_lost'::text, null::timestamptz, true;
      return;
    end if;
    -- An unrecorded provider result cannot be attached indefinitely after its
    -- fast-event recovery evidence has expired. Keep the existing 23-hour
    -- automatic retry horizon, well inside the seven-day unowned-event limit.
    if v_now >= v_attempt.retry_deadline_at then
      update public.resend_delivery_attempts
         set manual_review_required_at = coalesce(manual_review_required_at, v_now),
             lease_token = null,
             lease_expires_at = null
       where attempt_id = v_attempt.attempt_id;
      return query select 'ambiguous_expired'::text, null::timestamptz, true;
      return;
    end if;
    update public.resend_delivery_attempts
       set resend_message_id = p_message_id,
           accepted_at = v_now,
           lease_token = null,
           lease_expires_at = null
     where attempt_id = v_attempt.attempt_id;
    v_attempt.resend_message_id := p_message_id;
    v_attempt.accepted_at := v_now;
  end if;

  if v_current_message_id is null
     or v_current_message_id = v_attempt.resend_message_id
     or v_current_delivered_at is null
     or v_current_delivered_at <= v_attempt.accepted_at then
    update public.issues
       set resend_message_id = v_attempt.resend_message_id,
           delivered_at = v_attempt.accepted_at
     where id = v_issue_id;
  else
    v_status := v_status || '_stale';
  end if;

  v_recipient_hash := encode(
    sha256(convert_to(v_attempt.recipient, 'UTF8')),
    'hex'
  );
  for v_event in
    select email_id,
           type,
           event_at,
           recipient_hashes,
           resolution_status
      from public.resend_webhook_events
     where email_id = p_message_id
     for update
  loop
    if v_event.event_at is null then
      update public.resend_webhook_events
         set owner_user_id = p_user_id,
             resolution_status = 'legacy_review',
             review_required_at = coalesce(review_required_at, v_now),
             resolved_at = null
       where email_id = v_event.email_id
         and type = v_event.type;
      v_review := true;
      continue;
    end if;
    if cardinality(v_event.recipient_hashes) = 0 then
      v_event.recipient_hashes := array[v_recipient_hash];
    elsif not (v_recipient_hash = any(v_event.recipient_hashes)) then
      update public.resend_webhook_events
         set owner_user_id = p_user_id,
             resolution_status = 'manual_review',
             review_required_at = coalesce(review_required_at, v_now),
             resolved_at = null
       where email_id = v_event.email_id
         and type = v_event.type;
      v_review := true;
      continue;
    end if;

    select applied.resolution_status, applied.updated_count
      into v_apply_status, v_apply_count
      from public.apply_resend_suppression_to_user(
        p_user_id,
        v_event.recipient_hashes,
        v_event.type,
        v_event.event_at
      ) applied;
    if v_apply_status = 'manual_review' then
      update public.resend_webhook_events
         set recipient_hashes = v_event.recipient_hashes,
             owner_user_id = p_user_id,
             resolution_status = 'manual_review',
             review_required_at = coalesce(review_required_at, v_now),
             resolved_at = null
       where email_id = v_event.email_id
         and type = v_event.type;
      v_review := true;
    else
      update public.resend_webhook_events
         set recipient_hashes = v_event.recipient_hashes,
             owner_user_id = p_user_id,
             resolution_status = v_apply_status,
             review_required_at = null,
             resolved_at = v_now
       where email_id = v_event.email_id
         and type = v_event.type;
    end if;
  end loop;

  return query select v_status, v_attempt.accepted_at, v_review;
end;
$$;

revoke all on function public.finalize_resend_delivery_attempt(uuid, date, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_resend_delivery_attempt(uuid, date, text, uuid, text, text)
  to service_role;

-- prepare_account_deletion already holds this same per-user advisory lock.
-- An unresolved suppression recovery blocks deletion without automatic expiry.
-- The existing delivery-attempt lane separately retains its bounded lease stop.
create or replace function public.block_account_deletion_with_active_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 80425080));
  if exists (
    select 1 from public.users u
     where u.id = new.user_id
       and u.suppression_recovery_token is not null
  ) then
    raise exception 'account deletion blocked by unresolved suppression recovery';
  end if;
  if new.state <> 'complete' then
    if exists (
      select 1
        from public.resend_delivery_attempts a
       where a.user_id = new.user_id
         and a.resend_message_id is null
         and a.lease_expires_at > clock_timestamp()
    ) then
      raise exception 'account deletion blocked by active delivery lease';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.block_account_deletion_with_active_delivery()
  from public, anon, authenticated, service_role;

create trigger account_deletion_active_delivery_guard
before insert or update on public.account_deletion_sagas
for each row execute function public.block_account_deletion_with_active_delivery();

-- Record the signed event clock and apply local suppression in one transaction.
-- New duplicate deliveries rerun the monotonic update safely. Historical audit
-- rows have no causal clock and are surfaced for manual cutover review instead
-- of guessing whether an older suppression had already been cleared.
create or replace function public.record_resend_suppression_event(
  p_email_id text,
  p_event_type text,
  p_event_at timestamptz,
  p_recipients text[]
)
returns table(delivery_status text, updated_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt_user_id uuid;
  v_attempt_recipient text;
  v_attempt_started_at timestamptz;
  v_attempt_recipient_hash text;
  v_issue_count integer := 0;
  v_issue_user_id uuid;
  v_issue_delivered_at timestamptz;
  v_target_user_id uuid;
  v_recipient_hashes text[] := '{}'::text[];
  v_effective_hashes text[] := '{}'::text[];
  v_existing_hashes text[];
  v_existing_owner uuid;
  v_recipient_conflict boolean := false;
  v_existing_event_at timestamptz;
  v_existing_received_at timestamptz;
  v_inserted integer := 0;
  v_apply_status text;
  v_updated integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  if p_email_id is null
     or p_email_id <> btrim(p_email_id)
     or p_email_id = ''
     or length(p_email_id) > 512
     or p_event_type not in ('email.bounced', 'email.complained')
     or p_event_at is null
     or p_event_at < '2000-01-01T00:00:00Z'::timestamptz
     or p_event_at > clock_timestamp() + interval '10 minutes'
     or p_recipients is null
     or cardinality(p_recipients) > 20
     or exists (
       select 1
         from unnest(p_recipients) as recipient(email)
        where recipient.email is null
           or recipient.email <> lower(btrim(recipient.email))
           or length(recipient.email) < 3
           or length(recipient.email) > 254
     ) then
    raise exception 'invalid Resend suppression event';
  end if;

  select coalesce(array_agg(recipient_hash order by recipient_hash), '{}'::text[])
    into v_recipient_hashes
    from (
      select distinct encode(
        sha256(convert_to(recipient.email, 'UTF8')),
        'hex'
      ) as recipient_hash
        from unnest(p_recipients) as recipient(email)
    ) hashes;
  v_effective_hashes := v_recipient_hashes;

  -- Serialize provider finalization and event ownership on the exact message.
  -- If the event commits first, finalization sees and applies it. If the
  -- message commits first, this transaction sees its owner immediately.
  perform pg_advisory_xact_lock(
    hashtextextended('alpha-resend-message:' || p_email_id, 80425083)
  );

  select user_id, recipient, started_at
    into v_attempt_user_id, v_attempt_recipient, v_attempt_started_at
    from public.resend_delivery_attempts
   where resend_message_id = p_email_id;
  if found then
    v_attempt_recipient_hash := encode(
      sha256(convert_to(v_attempt_recipient, 'UTF8')),
      'hex'
    );
    if v_attempt_started_at > p_event_at + interval '10 minutes' then
      raise exception 'Resend suppression event conflicts with delivery attempt';
    end if;
    if cardinality(v_effective_hashes) = 0 then
      v_effective_hashes := array[v_attempt_recipient_hash];
    elsif not (v_attempt_recipient_hash = any(v_effective_hashes)) then
      v_recipient_conflict := true;
    end if;
    v_target_user_id := v_attempt_user_id;
  else
    -- One statement keeps the legacy count and selected owner on one READ
    -- COMMITTED snapshot while the nonunique historical pointer is retired.
    select
      count(*)::integer,
      (array_agg(user_id))[1],
      (array_agg(delivered_at))[1]
      into v_issue_count, v_issue_user_id, v_issue_delivered_at
      from public.issues
     where resend_message_id = p_email_id;
    if v_issue_count > 1 then
      raise exception 'Resend message id maps to multiple issues';
    elsif v_issue_count = 1 then
      if v_issue_delivered_at is null
         or v_issue_delivered_at > p_event_at + interval '10 minutes' then
        raise exception 'Resend message issue has invalid delivery time';
      end if;
      v_target_user_id := v_issue_user_id;
    end if;
  end if;

  -- This is a local recovery policy, not a provider last-arrival guarantee.
  -- Exact owned messages still apply regardless of age. An unowned replay
  -- must not recreate expired recipient hashes or extend its original window.
  if v_target_user_id is null then
    select received_at into v_existing_received_at
      from public.resend_webhook_events
     where email_id = p_email_id and type = p_event_type
       and owner_user_id is null;
    if least(p_event_at, coalesce(v_existing_received_at, v_now))
         <= v_now - interval '7 days' then
      delete from public.resend_webhook_events
       where email_id = p_email_id and type = p_event_type
         and owner_user_id is null;
      return query select 'expired_unowned'::text, 0;
      return;
    end if;
  end if;

  insert into public.resend_webhook_events (
    email_id,
    type,
    event_at,
    recipient_hashes,
    owner_user_id,
    resolution_status,
    review_required_at,
    resolved_at
  ) values (
    p_email_id,
    p_event_type,
    p_event_at,
    v_effective_hashes,
    v_target_user_id,
    'pending_owner',
    v_now,
    null
  )
  on conflict (email_id, type) do nothing;
  get diagnostics v_inserted = row_count;

  select event_at, recipient_hashes, owner_user_id
    into v_existing_event_at, v_existing_hashes, v_existing_owner
    from public.resend_webhook_events
   where email_id = p_email_id
     and type = p_event_type
   for update;
  if v_existing_event_at is null then
    update public.resend_webhook_events
       set event_at = p_event_at,
           recipient_hashes = case
             when cardinality(recipient_hashes) = 0 then v_effective_hashes
             else recipient_hashes
           end,
           owner_user_id = coalesce(owner_user_id, v_target_user_id),
           resolution_status = 'legacy_review',
           review_required_at = coalesce(review_required_at, v_now),
           resolved_at = null
     where email_id = p_email_id
       and type = p_event_type;
    return query select 'legacy_review'::text, 0;
    return;
  end if;
  if v_existing_event_at <> p_event_at then
    raise exception 'Resend suppression event clock conflicts with audit row';
  end if;
  if v_existing_owner is not null
     and v_target_user_id is not null
     and v_existing_owner <> v_target_user_id then
    raise exception 'Resend suppression event owner conflicts with audit row';
  end if;
  if cardinality(v_existing_hashes) = 0 then
    v_existing_hashes := v_effective_hashes;
  elsif cardinality(v_effective_hashes) > 0
        and v_existing_hashes <> v_effective_hashes then
    raise exception 'Resend suppression event recipients conflict with audit row';
  end if;

  if v_target_user_id is null then
    update public.resend_webhook_events
       set recipient_hashes = v_existing_hashes,
           resolution_status = 'pending_owner',
           review_required_at = coalesce(review_required_at, v_now),
           resolved_at = null
     where email_id = p_email_id
       and type = p_event_type;
    return query select 'pending_owner'::text, 0;
    return;
  end if;
  if v_recipient_conflict or cardinality(v_existing_hashes) = 0 then
    update public.resend_webhook_events
       set recipient_hashes = v_existing_hashes,
           owner_user_id = v_target_user_id,
           resolution_status = 'manual_review',
           review_required_at = coalesce(review_required_at, v_now),
           resolved_at = null
     where email_id = p_email_id
       and type = p_event_type;
    return query select 'manual_review'::text, 0;
    return;
  end if;

  select applied.resolution_status, applied.updated_count
    into v_apply_status, v_updated
    from public.apply_resend_suppression_to_user(
      v_target_user_id,
      v_existing_hashes,
      p_event_type,
      p_event_at
    ) applied;
  if v_apply_status = 'manual_review' then
    update public.resend_webhook_events
       set recipient_hashes = v_existing_hashes,
           owner_user_id = v_target_user_id,
           resolution_status = 'manual_review',
           review_required_at = coalesce(review_required_at, v_now),
           resolved_at = null
     where email_id = p_email_id
       and type = p_event_type;
  else
    update public.resend_webhook_events
       set recipient_hashes = v_existing_hashes,
           owner_user_id = v_target_user_id,
           resolution_status = v_apply_status,
           review_required_at = null,
           resolved_at = v_now
     where email_id = p_email_id
       and type = p_event_type;
  end if;

  return query select v_apply_status, v_updated;
end;
$$;

revoke all on function public.record_resend_suppression_event(text, text, timestamptz, text[])
  from public, anon, authenticated;
grant execute on function public.record_resend_suppression_event(text, text, timestamptz, text[])
  to service_role;

-- Scheduled bounded removal of recipient-derived evidence that never acquired
-- an exact message owner. SKIP LOCKED lets finalization finish first. No email,
-- message identifier, or recipient hash leaves this aggregate-only RPC.
create or replace function public.prune_unowned_resend_webhook_events(
  p_limit integer default 1000
)
returns table(pruned_count integer, remaining boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
  v_cutoff timestamptz := clock_timestamp() - interval '7 days';
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'Resend retention limit out of range';
  end if;
  with doomed as (
    select e.email_id, e.type
      from public.resend_webhook_events e
     where e.owner_user_id is null
       and least(e.event_at, e.received_at) <= v_cutoff
     order by least(e.event_at, e.received_at), e.email_id, e.type
     for update skip locked
     limit p_limit
  )
  delete from public.resend_webhook_events e
   using doomed d
   where e.email_id = d.email_id and e.type = d.type
     and e.owner_user_id is null;
  get diagnostics v_deleted = row_count;
  return query select v_deleted, exists (
    select 1 from public.resend_webhook_events e
     where e.owner_user_id is null
       and least(e.event_at, e.received_at) <= v_cutoff
  );
end;
$$;

revoke all on function public.prune_unowned_resend_webhook_events(integer)
  from public, anon, authenticated;
grant execute on function public.prune_unowned_resend_webhook_events(integer)
  to service_role;

-- Retention must wake scheduled maintenance even when every reader already
-- has a letter. Preserve all previous billing/privacy maintenance predicates.
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
        select 1 from public.users u
         where u.suppression_recovery_token is not null
      )
      or
      exists (
        select 1 from public.resend_webhook_events e
         where e.owner_user_id is null
           and least(e.event_at, e.received_at) <= p_now - interval '7 days'
      )
      or exists (
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

-- A fixed projection avoids copying profile text into the recovery record.
-- It is private to the RPCs below and contains only their comparison fields.
create or replace function public.resend_suppression_recovery_snapshot(p_user jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'email', p_user->'email',
    'created_at', p_user->'created_at',
    'subscribed_at', p_user->'subscribed_at',
    'cancelled_at', p_user->'cancelled_at',
    'access_granted_at', p_user->'access_granted_at',
    'unsubscribed_at', p_user->'unsubscribed_at',
    'bounced_at', p_user->'bounced_at',
    'complained_at', p_user->'complained_at',
    'suppression_cleanup_pending_at', p_user->'suppression_cleanup_pending_at',
    'delivery_suppression_cleared_at', p_user->'delivery_suppression_cleared_at',
    'stripe_customer_id', p_user->'stripe_customer_id',
    'stripe_subscription_id', p_user->'stripe_subscription_id'
  );
$$;

revoke all on function public.resend_suppression_recovery_snapshot(jsonb)
  from public, anon, authenticated, service_role;

-- Both this claim and deletion prepare use the same owner lock. The fence is
-- committed before any remote DELETE and is never renewed/reclaimed by time.
create or replace function public.claim_resend_suppression_recovery(p_user_id uuid)
returns table(
  recovery_status text,
  recovery_token uuid,
  recovery_started_at timestamptz,
  recipient_email text
)
language plpgsql
security definer
set search_path = public
set timezone = 'UTC'
as $$
declare
  v_user public.users%rowtype;
  v_token uuid;
  v_started timestamptz;
begin
  if p_user_id is null then
    return query select 'missing'::text, null::uuid, null::timestamptz, null::text;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select * into v_user from public.users where id = p_user_id for update;
  if not found then
    return query select 'missing'::text, null::uuid, null::timestamptz, null::text;
    return;
  end if;
  if v_user.suppression_recovery_token is not null then
    return query select 'review_required'::text, null::uuid, null::timestamptz, null::text;
    return;
  end if;
  if exists (select 1 from public.account_deletion_sagas where user_id = p_user_id) then
    return query select 'deletion_pending'::text, null::uuid, null::timestamptz, null::text;
    return;
  end if;
  if v_user.email is null
     or v_user.email <> lower(btrim(v_user.email))
     or length(v_user.email) < 3 or length(v_user.email) > 254
     or not exists (
       select 1 from auth.users a
        where a.id = p_user_id
          and lower(btrim(a.email)) = v_user.email
          and a.created_at = v_user.created_at
     ) then
    return query select 'identity_conflict'::text, null::uuid, null::timestamptz, null::text;
    return;
  end if;
  v_started := clock_timestamp();
  if v_user.subscribed_at is null
     or (v_user.access_granted_at is null
         and v_user.cancelled_at is not null and v_user.cancelled_at <= v_started) then
    return query select 'ineligible'::text, null::uuid, null::timestamptz, null::text;
    return;
  end if;
  if exists (
    select 1 from public.resend_delivery_attempts a
     where a.user_id = p_user_id and a.resend_message_id is null
       and a.lease_expires_at > v_started
  ) then
    return query select 'delivery_busy'::text, null::uuid, null::timestamptz, null::text;
    return;
  end if;
  if v_user.bounced_at is null and v_user.complained_at is null
     and v_user.suppression_cleanup_pending_at is null then
    return query select 'already_clear'::text, null::uuid, null::timestamptz, null::text;
    return;
  end if;
  v_token := gen_random_uuid();
  v_user.suppression_cleanup_pending_at := coalesce(
    v_user.suppression_cleanup_pending_at, v_started
  );
  update public.users
     set suppression_cleanup_pending_at = v_user.suppression_cleanup_pending_at,
         suppression_recovery_token = v_token,
         suppression_recovery_started_at = v_started,
         suppression_recovery_snapshot = public.resend_suppression_recovery_snapshot(to_jsonb(v_user))
   where id = p_user_id;
  if not found then raise exception 'suppression recovery claim lost its owner'; end if;
  return query select 'claimed'::text, v_token, v_started, v_user.email;
end;
$$;

revoke all on function public.claim_resend_suppression_recovery(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_resend_suppression_recovery(uuid)
  to service_role;

-- The caller may invoke this only after the strict provider response confirms
-- deletion. A failed/unknown provider request MUST NOT invoke it. If the reply
-- to this RPC is lost, a future clean-state claim is a no-op, not a new DELETE.
create or replace function public.finalize_resend_suppression_recovery(
  p_user_id uuid,
  p_recovery_token uuid
)
returns text
language plpgsql
security definer
set search_path = public
set timezone = 'UTC'
as $$
declare
  v_user public.users%rowtype;
  v_unchanged boolean;
begin
  if p_user_id is null or p_recovery_token is null then return 'not_owner'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select * into v_user from public.users where id = p_user_id for update;
  if not found or v_user.suppression_recovery_token is distinct from p_recovery_token then
    return 'not_owner';
  end if;
  if exists (select 1 from public.account_deletion_sagas where user_id = p_user_id) then
    raise exception 'suppression recovery conflicts with account deletion';
  end if;
  v_unchanged :=
    public.resend_suppression_recovery_snapshot(to_jsonb(v_user))
      = v_user.suppression_recovery_snapshot
    and v_user.subscribed_at is not null
    and (v_user.access_granted_at is not null or v_user.cancelled_at is null
         or v_user.cancelled_at > clock_timestamp())
    and exists (
      select 1 from auth.users a
       where a.id = p_user_id and lower(btrim(a.email)) = v_user.email
         and a.created_at = v_user.created_at
    );
  if v_unchanged then
    update public.users
       set bounced_at = null,
           complained_at = null,
           suppression_cleanup_pending_at = null,
           delivery_suppression_cleared_at = v_user.suppression_recovery_started_at,
           suppression_recovery_token = null,
           suppression_recovery_started_at = null,
           suppression_recovery_snapshot = null
     where id = p_user_id and suppression_recovery_token = p_recovery_token;
    if not found then raise exception 'suppression recovery settlement lost its owner'; end if;
    return 'cleared';
  end if;
  -- A new complaint, opt-out, or identity/access change wins. Even though this
  -- provider request finished, its effect on the NEW state was not reviewed.
  -- Keep the fence so deletion cannot discard the remaining local protection
  -- and free the address for an unblocked new identity. No automatic override.
  return 'state_changed';
end;
$$;

revoke all on function public.finalize_resend_suppression_recovery(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_resend_suppression_recovery(uuid, uuid)
  to service_role;

-- DELETE's row lock serializes with the claim's FOR UPDATE even for direct
-- Auth deletion cascades. Do not acquire the advisory lock after this row
-- lock, which would invert the claim/prepare lock order. Public email remains
-- reserved to this identity until the provider request is confirmed finished.
create or replace function public.block_identity_change_with_suppression_recovery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.suppression_recovery_token is not null then
    if tg_op = 'DELETE' then
      raise exception 'account deletion blocked by unresolved suppression recovery';
    end if;
    if new.id is distinct from old.id or new.email is distinct from old.email
       or new.created_at is distinct from old.created_at then
      raise exception 'account identity change blocked by unresolved suppression recovery';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.block_identity_change_with_suppression_recovery()
  from public, anon, authenticated, service_role;

create trigger users_suppression_recovery_identity_guard
before delete or update of id, email, created_at on public.users
for each row execute function public.block_identity_change_with_suppression_recovery();

-- Auth confirms an address before public.users mirrors it. Serialize that
-- direct Auth path on the same public row without taking an advisory lock
-- after a row lock. Claim/finalize read Auth without locking it, so there is
-- no reverse Auth-row dependency. A change that starts first commits before
-- claim checks the anchor, and a change that starts later sees the fence.
create or replace function public.block_auth_identity_change_with_suppression_recovery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid;
begin
  if new.id is not distinct from old.id
     and new.email is not distinct from old.email
     and new.created_at is not distinct from old.created_at then
    return new;
  end if;
  select suppression_recovery_token into v_token
    from public.users where id = old.id for update;
  if v_token is not null then
    raise exception 'Auth identity change blocked by unresolved suppression recovery';
  end if;
  return new;
end;
$$;

revoke all on function public.block_auth_identity_change_with_suppression_recovery()
  from public, anon, authenticated, service_role;

create trigger auth_users_suppression_recovery_identity_guard
before update of id, email, created_at on auth.users
for each row execute function public.block_auth_identity_change_with_suppression_recovery();
