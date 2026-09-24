-- Additive rollout gate. Subscriber letters remain source-paused until a
-- separately approved release. Enrollment starts off for every existing and
-- future account; an owner-controlled service action can enroll exact readers
-- only after the live callback and delivery checks pass.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The four functions below are replaced in full. Fail before any schema
-- change if the installed bodies or execution contracts differ from the
-- frozen Round 80 and clock-fence sources used to prepare this migration.
do $alpha_delivery_enrollment_preflight$
declare
  expected record;
  installed pg_proc%rowtype;
begin
  for expected in
    select * from (values
      ('public.protect_user_privileged_columns()', 'b7a33bef545c2822fe4f290b5192cfe0', 'plpgsql'),
      ('public.block_user_delivery_change_with_active_attempt()', 'aee55e0bda9053a0c0e2b75032a0e7c5', 'plpgsql'),
      ('public.claim_resend_delivery_attempt(uuid,date,text,text,text,uuid,timestamptz)', '7ded1a1e247ba9956c97e93cfb2e0967', 'plpgsql'),
      ('public.watchdog_delivery_check(timestamptz)', '076e3ac164dc1d36824bb7a7f9b7605c', 'sql')
    ) as contracts(signature, body_md5, language_name)
  loop
    select * into installed
      from pg_proc
     where oid = to_regprocedure(expected.signature);
    if not found
       or md5(installed.prosrc) is distinct from expected.body_md5
       or installed.proowner is distinct from 'postgres'::regrole
       or installed.prosecdef is distinct from true
       or coalesce(array_to_string(installed.proconfig, ','), '') <> 'search_path=public'
       or not exists (
         select 1 from pg_language
          where oid = installed.prolang and lanname = expected.language_name
       ) then
      raise exception 'delivery enrollment prerequisite function contract changed: %', expected.signature;
    end if;
    if expected.signature = 'public.claim_resend_delivery_attempt(uuid,date,text,text,text,uuid,timestamptz)' and (
      not has_function_privilege('service_role', installed.oid, 'EXECUTE')
      or has_function_privilege('anon', installed.oid, 'EXECUTE')
      or has_function_privilege('authenticated', installed.oid, 'EXECUTE')
      or exists (
        select 1
          from aclexplode(coalesce(installed.proacl, acldefault('f', installed.proowner))) acl
         where acl.privilege_type = 'EXECUTE'
           and acl.grantee not in (installed.proowner, 'service_role'::regrole)
      )
    ) then
      raise exception 'delivery enrollment claim execute grants changed';
    end if;
  end loop;
end;
$alpha_delivery_enrollment_preflight$;

alter table public.users
  add column delivery_enrolled boolean not null default false;

-- A normal account insert uses the default. Pin this field even if a future
-- authenticated insert policy is added to public.users.
create function public.protect_delivery_enrollment_insert()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if (coalesce(current_setting('request.jwt.claims', true), '{}')::json->>'role') is distinct from 'service_role' then
    new.delivery_enrolled := false;
  end if;
  return new;
end;
$$;

revoke all on function public.protect_delivery_enrollment_insert()
  from public, anon, authenticated, service_role;

create trigger protect_delivery_enrollment_insert_trg
before insert on public.users
for each row execute function public.protect_delivery_enrollment_insert();

-- Preserve the latest full privileged-column trigger body and protect the
-- new field from client updates. Service-role writes remain owner-controlled.
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
  new.delivery_enrolled := old.delivery_enrolled;
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

-- A disable cannot commit while an unresolved provider call has an active
-- lease. The claim locks this same user row before its eligibility check.
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
    or new.delivery_enrolled is distinct from old.delivery_enrolled
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

drop trigger users_active_delivery_state_guard on public.users;
create trigger users_active_delivery_state_guard
before update of
  email,
  subscribed_at,
  cancelled_at,
  unsubscribed_at,
  access_granted_at,
  delivery_enrolled,
  bounced_at,
  complained_at,
  suppression_cleanup_pending_at,
  delivery_suppression_cleared_at
on public.users
for each row execute function public.block_user_delivery_change_with_active_attempt();

-- This is the post-clock-fence claim body. It keeps the same provider lane,
-- retry, lock, and timing behavior, with enrollment checked under the user
-- row lock before creating or replaying any provider lease.
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
  v_now timestamptz;
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

  v_now := clock_timestamp();
  if lower(btrim(v_user.email)) <> p_recipient
     or v_user.created_at is null
     or v_user.subscribed_at is null
     or not v_user.delivery_enrolled
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

  v_now := clock_timestamp();
  v_lease_expires_at := v_now + interval '5 minutes';

  -- An existing attempt can make this row lock wait while its paid period
  -- ends. Do not renew or return that attempt as claimable after the cutoff.
  -- New rows did not wait on an existing attempt, so this narrow fence cannot
  -- leave behind a newly-created ineligible attempt.
  if v_inserted = 0
     and v_user.access_granted_at is null
     and v_user.cancelled_at is not null
     and v_user.cancelled_at <= v_now then
    return query select 'ineligible'::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
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

-- Match the sender's enrolled population. Saved-issue read policies are not
-- part of delivery eligibility and are unchanged.
create or replace function public.watchdog_delivery_check(cutoff timestamptz)
returns table(uncovered_count bigint, active_subscriber_count bigint)
language sql
security definer
set search_path = public
as $$
  select
    (
      select count(*) from public.users u
      where u.delivery_enrolled
        and u.subscribed_at is not null
        and (
          u.access_granted_at is not null
          or u.cancelled_at is null
          or u.cancelled_at > now()
        )
        and u.unsubscribed_at is null
        and u.bounced_at is null
        and u.complained_at is null
        and u.suppression_cleanup_pending_at is null
        and not exists (
          select 1 from public.issues i
          where i.user_id = u.id
            and i.delivered_at >= date_trunc('hour', cutoff)
            and (
              i.resend_message_id is not null
              or i.delivered_at < '2026-08-05T19:10:00Z'::timestamptz
            )
        )
    ) as uncovered_count,
    (
      select count(*) from public.users u
      where u.delivery_enrolled
        and u.subscribed_at is not null
        and (
          u.access_granted_at is not null
          or u.cancelled_at is null
          or u.cancelled_at > now()
        )
        and u.unsubscribed_at is null
        and u.bounced_at is null
        and u.complained_at is null
        and u.suppression_cleanup_pending_at is null
    ) as active_subscriber_count;
$$;

revoke all on function public.watchdog_delivery_check(timestamptz) from public;
revoke all on function public.watchdog_delivery_check(timestamptz) from authenticated;
grant execute on function public.watchdog_delivery_check(timestamptz) to anon;

commit;
