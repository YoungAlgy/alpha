-- Follow-up only. The frozen Round 80 migration remains byte-for-byte unchanged.
-- Refresh clocks only after lock points that can wait. Contracts and ACLs are retained.

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
  v_now timestamptz;
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

  v_now := clock_timestamp();

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
