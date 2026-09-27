-- Candidate only. Apply with the matching sender, webhook, reclaim, backup, and
-- verification release. No Brevo route may dispatch against an older schema.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- These are the last installed definitions in the frozen migration chain.
-- Refuse a changed database instead of silently changing its delivery rules.
-- The September 26 read-only catalog check proved the claim/watchdog CRLF
-- bodies match the frozen LF source. Accept only those exact raw fingerprints.
-- Do not normalize arbitrary function text or alter installed functions here.
do $brevo_preflight$
declare
  expected record;
  installed pg_proc%rowtype;
begin
  for expected in
    select * from (values
      ('public.claim_resend_delivery_attempt(uuid,date,text,text,text,uuid,timestamptz)',
        array['a76d4d87de294392d6fd561b9b425140', 'c6a37e212ce0b5c8a9dc7e1b0ab7c26b'], 'plpgsql', false),
      ('public.finalize_resend_delivery_attempt(uuid,date,text,uuid,text,text)',
        array['8f5d0927021c0549d56a6b4fa2cab753'], 'plpgsql', false),
      ('public.watchdog_delivery_check(timestamptz)',
        array['c4140fc12e1be0a950d9b3f08e4b9380', '956f463881fd5b192be8e0f71491d356'], 'sql', true)
    ) as contracts(signature, body_md5s, language_name, allow_anon)
  loop
    select * into installed from pg_proc where oid = to_regprocedure(expected.signature);
    if not found
       or not (md5(installed.prosrc) = any(expected.body_md5s))
       or installed.proowner is distinct from 'postgres'::regrole
       or installed.prosecdef is distinct from true
       or coalesce(array_to_string(installed.proconfig, ','), '') <> 'search_path=public'
       or not exists (select 1 from pg_language where oid = installed.prolang and lanname = expected.language_name)
    then
      raise exception 'Brevo prerequisite function changed: %', expected.signature;
    end if;
    if not has_function_privilege('service_role', installed.oid, 'EXECUTE')
      or has_function_privilege('anon', installed.oid, 'EXECUTE') is distinct from expected.allow_anon
      or has_function_privilege('authenticated', installed.oid, 'EXECUTE')
      or (
        select count(*)
          from aclexplode(coalesce(installed.proacl, acldefault('f', installed.proowner))) acl
         where acl.privilege_type = 'EXECUTE'
      ) <> (case when expected.allow_anon then 3 else 2 end)
      or exists (
        select 1
          from aclexplode(coalesce(installed.proacl, acldefault('f', installed.proowner))) acl
         where acl.privilege_type = 'EXECUTE'
           and (
             (acl.grantee not in (installed.proowner, 'service_role'::regrole)
               and not (expected.allow_anon and acl.grantee = 'anon'::regrole))
             or (acl.is_grantable and acl.grantee <> installed.proowner)
           )
      )
    then
      raise exception 'Brevo prerequisite function grants changed: %', expected.signature;
    end if;
  end loop;
  if not exists (
    select 1 from pg_index i
     where i.indexrelid = to_regclass('public.resend_delivery_attempts_issue_lane_uidx')
       and i.indrelid = 'public.resend_delivery_attempts'::regclass
       and i.indisunique and i.indisvalid and i.indisready and i.indislive
       and i.indpred is null and i.indexprs is null
       and i.indnkeyatts = 2 and i.indnatts = 2
       and pg_get_indexdef(i.indexrelid) =
         'CREATE UNIQUE INDEX resend_delivery_attempts_issue_lane_uidx ON public.resend_delivery_attempts USING btree (issue_id, delivery_lane)'
  ) then
    raise exception 'Brevo attempt ledger contract changed';
  end if;
  for expected in
    select * from (values
      ('resend_delivery_attempts_retry_window_check',
        'CHECK (((retry_deadline_at = (started_at + ''23:00:00''::interval)) AND (retry_deadline_at > started_at)))'),
      ('resend_delivery_attempts_finalization_shape',
        'CHECK ((((resend_message_id IS NULL) AND (accepted_at IS NULL)) OR ((resend_message_id IS NOT NULL) AND (accepted_at IS NOT NULL) AND (accepted_at >= started_at) AND (lease_token IS NULL) AND (lease_expires_at IS NULL))))'),
      ('resend_delivery_attempts_manual_review_shape',
        'CHECK (((manual_review_required_at IS NULL) OR ((resend_message_id IS NULL) AND (manual_review_required_at >= retry_deadline_at))))')
    ) as contracts(name, definition)
  loop
    if not exists (
      select 1 from pg_constraint c
       where c.conrelid = 'public.resend_delivery_attempts'::regclass
         and c.conname = expected.name and c.contype = 'c' and c.convalidated
         and pg_get_constraintdef(c.oid) = expected.definition
    ) then
      raise exception 'Brevo attempt ledger constraint changed: %', expected.name;
    end if;
  end loop;
end;
$brevo_preflight$;

-- Preserve every historical attempt as Resend. The existing unique issue/lane
-- index becomes the cross-provider reservation. IDs remain separate namespaces.
alter table public.resend_delivery_attempts
  add column provider text not null default 'resend',
  add column brevo_message_id text;
alter table public.issues
  add column brevo_message_id text;
alter table public.users
  add column brevo_unsubscribed_at timestamptz;

-- The existing Resume, deletion, and deferred Resend recovery paths do not
-- own a Brevo provider opt-out. A later reviewed provider-specific clearance
-- can replace this guard; this release cannot clear the marker automatically.
create function public.guard_brevo_unsubscribe_hold()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (coalesce(current_setting('request.jwt.claims', true), '{}')::json->>'role')
       is distinct from 'service_role' then
    new.brevo_unsubscribed_at := old.brevo_unsubscribed_at;
  end if;
  if old.brevo_unsubscribed_at is not null
     and new.brevo_unsubscribed_at is distinct from old.brevo_unsubscribed_at then
    raise exception 'Brevo unsubscribe marker requires reviewed recovery';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_brevo_unsubscribe_hold()
  from public, anon, authenticated, service_role;
create trigger users_brevo_unsubscribe_guard
before update of brevo_unsubscribed_at on public.users
for each row execute function public.guard_brevo_unsubscribe_hold();

alter table public.resend_delivery_attempts
  alter column retry_deadline_at drop not null,
  drop constraint resend_delivery_attempts_retry_window_check,
  drop constraint resend_delivery_attempts_finalization_shape,
  drop constraint resend_delivery_attempts_manual_review_shape,
  add constraint resend_delivery_attempts_provider_check check (provider in ('resend', 'brevo')),
  add constraint resend_delivery_attempts_retry_window_check check (
    (provider = 'resend' and retry_deadline_at is not null
      and retry_deadline_at = started_at + interval '23 hours')
    or (provider = 'brevo' and retry_deadline_at is null)
  ),
  add constraint resend_delivery_attempts_finalization_shape check (
    (provider = 'resend' and brevo_message_id is null and (
      (resend_message_id is null and accepted_at is null)
      or (resend_message_id is not null and accepted_at is not null
          and accepted_at >= started_at and lease_token is null and lease_expires_at is null)
    ))
    or (provider = 'brevo' and resend_message_id is null and (
      (brevo_message_id is null and accepted_at is null)
      or (brevo_message_id is not null and accepted_at is not null
          and accepted_at >= started_at and lease_token is null and lease_expires_at is null)
    ))
  ),
  add constraint resend_delivery_attempts_manual_review_shape check (
    (provider = 'resend' and (manual_review_required_at is null
      or (resend_message_id is null and manual_review_required_at >= retry_deadline_at)))
    or (provider = 'brevo' and (
      (brevo_message_id is null and manual_review_required_at is not null
        and manual_review_required_at >= started_at)
      or (brevo_message_id is not null and (
        manual_review_required_at is null
        or manual_review_required_at >= started_at
      ))
    ))
  ),
  add constraint resend_delivery_attempts_brevo_id_shape check (
    brevo_message_id is null or (
      length(brevo_message_id) between 1 and 512
      and brevo_message_id ~ '^[!-~]+$'
      and position('<' in brevo_message_id) = 0
      and position('>' in brevo_message_id) = 0
    )
  ),
  add constraint resend_delivery_attempts_brevo_lane_check check (
    provider <> 'brevo' or delivery_lane = 'live'
  );

create unique index resend_delivery_attempts_brevo_message_uidx
  on public.resend_delivery_attempts (brevo_message_id)
  where brevo_message_id is not null;
create unique index issues_brevo_message_uidx
  on public.issues (brevo_message_id)
  where brevo_message_id is not null;
alter table public.issues
  add constraint issues_brevo_message_id_shape check (
    brevo_message_id is null or (
      length(brevo_message_id) between 1 and 512
      and brevo_message_id ~ '^[!-~]+$'
      and position('<' in brevo_message_id) = 0
      and position('>' in brevo_message_id) = 0
    )
  );

-- The old Resend claim sees a Brevo row as unresolved because its Resend ID
-- is null. It must never renew that row's lease and reach its Resend callback.
-- Brevo only creates the lease on INSERT and can later clear it once.
create function public.guard_brevo_attempt_ownership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.provider is distinct from old.provider then
    raise exception 'delivery attempt provider cannot change';
  end if;
  if old.provider = 'brevo' then
    if new.attempt_id is distinct from old.attempt_id
       or new.user_id is distinct from old.user_id
       or new.issue_id is distinct from old.issue_id
       or new.recipient is distinct from old.recipient
       or new.delivery_lane is distinct from old.delivery_lane
       or new.request_fingerprint is distinct from old.request_fingerprint
       or new.started_at is distinct from old.started_at
       or new.retry_deadline_at is distinct from old.retry_deadline_at
       or (old.brevo_message_id is not null
           and new.brevo_message_id is distinct from old.brevo_message_id)
       or (old.accepted_at is not null
           and new.accepted_at is distinct from old.accepted_at)
       or (new.lease_token is not null and (
         new.lease_token is distinct from old.lease_token
         or new.lease_expires_at is distinct from old.lease_expires_at
       )) then
      raise exception 'Brevo delivery ownership is immutable';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_brevo_attempt_ownership() from public, anon, authenticated, service_role;
create trigger resend_delivery_attempts_brevo_owner_guard
before update on public.resend_delivery_attempts
for each row execute function public.guard_brevo_attempt_ownership();

-- Legacy Resend claim checks its own preexisting suppression columns. This
-- lease guard adds Brevo's separate immutable opt-out to both new Resend rows
-- and retries of old Resend rows, without modifying the frozen claim body.
create function public.guard_brevo_unsubscribe_delivery_lease()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_new_lease boolean;
begin
  if tg_op = 'INSERT' then
    v_new_lease := new.lease_token is not null;
  else
    v_new_lease := new.lease_token is not null and (
      new.lease_token is distinct from old.lease_token
      or new.lease_expires_at is distinct from old.lease_expires_at
    );
  end if;
  if v_new_lease and exists (
    select 1 from public.users u
     where u.id = new.user_id and u.brevo_unsubscribed_at is not null
  ) then
    raise exception 'Brevo unsubscribe blocks delivery lease';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_brevo_unsubscribe_delivery_lease()
  from public, anon, authenticated, service_role;
create trigger resend_delivery_attempts_brevo_unsubscribe_guard
before insert or update on public.resend_delivery_attempts
for each row execute function public.guard_brevo_unsubscribe_delivery_lease();

-- Operator preference applies only when no attempt exists. Existing Resend
-- retries stay on Resend even if Brevo becomes the preferred fresh transport.
create function public.resolve_subscriber_delivery_provider(
  p_user_id uuid, p_week_of date, p_delivery_lane text
)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((
    select a.provider
      from public.issues i
      join public.resend_delivery_attempts a on a.issue_id = i.id
     where i.user_id = p_user_id and i.week_of = p_week_of
       and a.user_id = p_user_id and a.delivery_lane = p_delivery_lane
  ), 'none'::text);
$$;
revoke all on function public.resolve_subscriber_delivery_provider(uuid,date,text)
  from public, anon, authenticated;
grant execute on function public.resolve_subscriber_delivery_provider(uuid,date,text)
  to service_role;

-- Existing user-change and account-deletion guards still see any unresolved
-- Brevo row through resend_message_id IS NULL and its active lease. The Brevo
-- claim uses the same per-user advisory lock, user lock, and issue lock.
create function public.claim_brevo_delivery_attempt(
  p_user_id uuid, p_week_of date, p_recipient text,
  p_request_fingerprint text, p_attempt_id uuid, p_lease_token uuid,
  p_expected_claimed_at timestamptz
)
returns table(
  delivery_status text, stored_recipient text, stored_attempt_id uuid,
  stored_message_id text, stored_accepted_at timestamptz,
  stored_lease_expires_at timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_user public.users%rowtype;
  v_issue public.issues%rowtype;
  v_attempt public.resend_delivery_attempts%rowtype;
  v_inserted integer := 0;
  v_now timestamptz;
begin
  if p_user_id is null or p_week_of is null or p_attempt_id is null
     or p_lease_token is null or p_expected_claimed_at is null
     or p_recipient is null or p_recipient <> lower(btrim(p_recipient))
     or length(p_recipient) not between 3 and 254
     or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    return query select 'invalid'::text, null::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  if exists (select 1 from public.account_deletion_sagas where user_id = p_user_id) then
    return query select 'deletion_pending'::text, null::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz;
    return;
  end if;
  select * into v_user from public.users where id = p_user_id for update;
  if not found then
    return query select 'missing'::text, null::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz;
    return;
  end if;
  select * into v_issue from public.issues
   where user_id = p_user_id and week_of = p_week_of for update;
  if not found then
    return query select 'missing'::text, null::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz;
    return;
  end if;
  -- A completed row may have repaired the issue stamp since the caller's
  -- original claim. Return its exact proof before testing that stale stamp.
  select * into v_attempt from public.resend_delivery_attempts
   where issue_id = v_issue.id and delivery_lane = 'live' for update;
  if found then
    if v_attempt.provider <> 'brevo' then
      return query select 'provider_conflict'::text, v_attempt.recipient,
        v_attempt.attempt_id, null::text, null::timestamptz, null::timestamptz;
      return;
    end if;
    if v_attempt.brevo_message_id is not null then
      return query select 'accepted'::text, v_attempt.recipient,
        v_attempt.attempt_id, v_attempt.brevo_message_id,
        v_attempt.accepted_at, null::timestamptz;
      return;
    end if;
    return query select 'manual_review'::text, v_attempt.recipient,
      v_attempt.attempt_id, null::text, null::timestamptz,
      v_attempt.lease_expires_at;
    return;
  end if;
  if v_issue.delivered_at is distinct from p_expected_claimed_at
     or v_issue.resend_message_id is not null
     or v_issue.brevo_message_id is not null then
    return query select 'claim_conflict'::text, null::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz;
    return;
  end if;
  v_now := clock_timestamp();
  if lower(btrim(v_user.email)) <> p_recipient or v_user.created_at is null
     or v_user.subscribed_at is null or not v_user.delivery_enrolled
     or (v_user.access_granted_at is null and v_user.cancelled_at is not null
         and v_user.cancelled_at <= v_now)
     or v_user.unsubscribed_at is not null
     or v_user.brevo_unsubscribed_at is not null
     or v_user.bounced_at is not null
     or v_user.complained_at is not null
     or v_user.suppression_cleanup_pending_at is not null
     or v_user.suppression_recovery_token is not null then
    return query select 'ineligible'::text, null::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz;
    return;
  end if;
  if exists (select 1 from public.resend_delivery_attempts a
              where a.issue_id = v_issue.id and a.delivery_lane <> 'live'
                and a.resend_message_id is null and a.brevo_message_id is null) then
    return query select 'other_lane_pending'::text, null::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz;
    return;
  end if;

  insert into public.resend_delivery_attempts (
    attempt_id, user_id, issue_id, recipient, delivery_lane, provider,
    request_fingerprint, started_at, retry_deadline_at,
    manual_review_required_at, lease_token, lease_expires_at
  ) values (
    p_attempt_id, p_user_id, v_issue.id, p_recipient, 'live', 'brevo',
    p_request_fingerprint, v_now, null, v_now, p_lease_token,
    v_now + interval '5 minutes'
  ) on conflict (issue_id, delivery_lane) do nothing;
  get diagnostics v_inserted = row_count;
  select * into v_attempt from public.resend_delivery_attempts
   where issue_id = v_issue.id and delivery_lane = 'live' for update;
  if not found or v_attempt.user_id <> p_user_id then
    raise exception 'Brevo delivery attempt ownership conflict';
  end if;
  if v_attempt.provider <> 'brevo' then
    return query select 'provider_conflict'::text, v_attempt.recipient, v_attempt.attempt_id,
      null::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_attempt.brevo_message_id is not null then
    return query select 'accepted'::text, v_attempt.recipient, v_attempt.attempt_id,
      v_attempt.brevo_message_id, v_attempt.accepted_at, null::timestamptz;
    return;
  end if;
  if v_inserted = 0 then
    return query select 'manual_review'::text, v_attempt.recipient, v_attempt.attempt_id,
      null::text, null::timestamptz, v_attempt.lease_expires_at;
    return;
  end if;
  return query select 'claimed'::text, v_attempt.recipient, v_attempt.attempt_id,
    null::text, null::timestamptz, v_attempt.lease_expires_at;
end;
$$;
revoke all on function public.claim_brevo_delivery_attempt(uuid,date,text,text,uuid,uuid,timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_brevo_delivery_attempt(uuid,date,text,text,uuid,uuid,timestamptz)
  to service_role;

-- No raw webhook body or recipient address is retained. A message may emit
-- more than one event of a type, so event time is part of the dedup key.
create table public.brevo_suppression_events (
  message_id text not null,
  event_type text not null,
  event_at timestamptz not null,
  recipient_hash text not null,
  recipient_conflict boolean not null default false,
  received_at timestamptz not null default now(),
  owner_user_id uuid references public.users(id) on delete cascade,
  resolution_status text not null default 'pending_owner',
  review_required_at timestamptz,
  resolved_at timestamptz,
  primary key (message_id, event_type, event_at),
  constraint brevo_suppression_events_id_shape check (
    length(message_id) between 1 and 512 and message_id ~ '^[!-~]+$'
    and position('<' in message_id) = 0 and position('>' in message_id) = 0
  ),
  constraint brevo_suppression_events_type_check check (
    event_type in ('unsubscribed', 'hard_bounce', 'spam')
  ),
  constraint brevo_suppression_events_hash_shape check (
    recipient_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint brevo_suppression_events_status_check check (
    resolution_status in ('pending_owner', 'manual_review', 'applied', 'causally_ignored')
  ),
  constraint brevo_suppression_events_marker_check check (
    (resolution_status in ('pending_owner', 'manual_review')
       and review_required_at is not null and resolved_at is null)
    or (resolution_status in ('applied', 'causally_ignored')
       and review_required_at is null and resolved_at is not null)
  )
);
create index brevo_suppression_events_pending_idx
  on public.brevo_suppression_events (review_required_at, message_id)
  where review_required_at is not null;
create index brevo_suppression_events_unowned_idx
  on public.brevo_suppression_events (least(event_at, received_at), message_id)
  where owner_user_id is null;
alter table public.brevo_suppression_events enable row level security;
revoke all on table public.brevo_suppression_events
  from public, anon, authenticated, service_role;
grant select on table public.brevo_suppression_events to service_role;

-- Reuse the causal Resend helper for hard bounce and spam. Unsubscribe has its
-- own protected marker: self-serve Resume cannot clear the provider hold.
create function public.apply_brevo_suppression_to_user(
  p_user_id uuid, p_recipient_hash text, p_event_type text, p_event_at timestamptz
)
returns table(resolution_status text, updated_count integer)
language plpgsql security definer set search_path = public as $$
declare
  v_user public.users%rowtype;
  v_current_hash text;
begin
  if p_user_id is null or p_recipient_hash is null
     or p_recipient_hash !~ '^[0-9a-f]{64}$'
     or p_event_type not in ('unsubscribed', 'hard_bounce', 'spam')
     or p_event_at is null then
    return query select 'manual_review'::text, 0;
    return;
  end if;
  select * into v_user from public.users where id = p_user_id for update;
  if not found or v_user.email is null or v_user.created_at is null then
    return query select 'manual_review'::text, 0;
    return;
  end if;
  v_current_hash := encode(sha256(convert_to(lower(btrim(v_user.email)), 'UTF8')), 'hex');
  if v_current_hash <> p_recipient_hash or v_user.created_at > p_event_at then
    return query select 'manual_review'::text, 0;
    return;
  end if;
  if p_event_type <> 'unsubscribed'
     and v_user.delivery_suppression_cleared_at is not null
     and v_user.delivery_suppression_cleared_at > p_event_at then
    return query select 'causally_ignored'::text, 0;
    return;
  end if;
  if p_event_type = 'hard_bounce' then
    return query select applied.resolution_status, applied.updated_count
      from public.apply_resend_suppression_to_user(
        p_user_id, array[p_recipient_hash], 'email.bounced', p_event_at
      ) applied;
    return;
  elsif p_event_type = 'spam' then
    return query select applied.resolution_status, applied.updated_count
      from public.apply_resend_suppression_to_user(
        p_user_id, array[p_recipient_hash], 'email.complained', p_event_at
      ) applied;
    return;
  end if;
  if v_user.unsubscribed_at is not null and v_user.unsubscribed_at >= p_event_at
     and v_user.brevo_unsubscribed_at is not null then
    return query select 'causally_ignored'::text, 0;
    return;
  end if;
  update public.users
     set unsubscribed_at = greatest(coalesce(unsubscribed_at, p_event_at), p_event_at),
         brevo_unsubscribed_at = coalesce(brevo_unsubscribed_at, p_event_at)
   where id = p_user_id;
  return query select 'applied'::text, 1;
end;
$$;
revoke all on function public.apply_brevo_suppression_to_user(uuid,text,text,timestamptz)
  from public, anon, authenticated, service_role;

create function public.record_brevo_suppression_event(
  p_message_id text, p_event_type text, p_event_at timestamptz, p_recipient text
)
returns table(delivery_status text, updated_count integer)
language plpgsql security definer set search_path = public as $$
declare
  v_attempt public.resend_delivery_attempts%rowtype;
  v_hash text;
  v_existing public.brevo_suppression_events%rowtype;
  v_status text;
  v_count integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_message_id is null or length(p_message_id) not between 1 and 512
     or p_message_id !~ '^[!-~]+$'
     or position('<' in p_message_id) > 0 or position('>' in p_message_id) > 0
     or p_event_type not in ('unsubscribed', 'hard_bounce', 'spam')
     or p_event_at is null or p_event_at < '2000-01-01T00:00:00Z'::timestamptz
     or p_event_at > v_now + interval '10 minutes'
     or p_recipient is null or p_recipient <> lower(btrim(p_recipient))
     or length(p_recipient) not between 3 and 254 then
    raise exception 'invalid Brevo suppression event';
  end if;
  v_hash := encode(sha256(convert_to(p_recipient, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(
    hashtextextended('alpha-brevo-message:' || p_message_id, 80425084)
  );
  select * into v_attempt from public.resend_delivery_attempts
   where provider = 'brevo' and brevo_message_id = p_message_id;
  if found and (v_attempt.started_at > p_event_at + interval '10 minutes'
                or v_attempt.recipient <> p_recipient) then
    -- Keep an audit row and require review; never suppress a different owner.
    insert into public.brevo_suppression_events (
      message_id, event_type, event_at, recipient_hash, owner_user_id,
      resolution_status, review_required_at
    ) values (
      p_message_id, p_event_type, p_event_at, v_hash, v_attempt.user_id,
      'manual_review', v_now
    ) on conflict (message_id, event_type, event_at) do nothing;
    update public.brevo_suppression_events
       set owner_user_id = coalesce(owner_user_id, v_attempt.user_id),
           recipient_conflict = true,
           resolution_status = 'manual_review',
           review_required_at = coalesce(review_required_at, v_now),
           resolved_at = null
     where message_id = p_message_id and event_type = p_event_type
       and event_at = p_event_at;
    return query select 'manual_review'::text, 0;
    return;
  end if;
  if not found and p_event_at <= v_now - interval '7 days' then
    delete from public.brevo_suppression_events
     where message_id = p_message_id and event_type = p_event_type
       and event_at = p_event_at and owner_user_id is null;
    return query select 'expired_unowned'::text, 0;
    return;
  end if;
  insert into public.brevo_suppression_events (
    message_id, event_type, event_at, recipient_hash, owner_user_id,
    resolution_status, review_required_at
  ) values (
    p_message_id, p_event_type, p_event_at, v_hash,
    case when v_attempt.attempt_id is null then null else v_attempt.user_id end,
    'pending_owner', v_now
  ) on conflict (message_id, event_type, event_at) do nothing;
  select * into v_existing from public.brevo_suppression_events
   where message_id = p_message_id and event_type = p_event_type
     and event_at = p_event_at for update;
  if v_existing.recipient_hash <> v_hash
     or (v_existing.owner_user_id is not null and v_attempt.attempt_id is not null
         and v_existing.owner_user_id <> v_attempt.user_id) then
    update public.brevo_suppression_events
       set recipient_conflict = true, resolution_status = 'manual_review',
           review_required_at = coalesce(review_required_at, v_now), resolved_at = null
     where message_id = p_message_id and event_type = p_event_type
       and event_at = p_event_at;
    return query select 'manual_review'::text, 0;
    return;
  end if;
  if v_existing.recipient_conflict then
    return query select 'manual_review'::text, 0;
    return;
  end if;
  if v_attempt.attempt_id is null then
    return query select 'pending_owner'::text, 0;
    return;
  end if;
  select applied.resolution_status, applied.updated_count into v_status, v_count
    from public.apply_brevo_suppression_to_user(
      v_attempt.user_id, v_hash, p_event_type, p_event_at
    ) applied;
  update public.brevo_suppression_events
     set owner_user_id = v_attempt.user_id, resolution_status = v_status,
         review_required_at = case when v_status = 'manual_review'
           then coalesce(review_required_at, v_now) else null end,
         resolved_at = case when v_status = 'manual_review' then null else v_now end
   where message_id = p_message_id and event_type = p_event_type
     and event_at = p_event_at;
  return query select v_status, v_count;
end;
$$;
revoke all on function public.record_brevo_suppression_event(text,text,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.record_brevo_suppression_event(text,text,timestamptz,text)
  to service_role;

-- A post-dispatch uncertainty leaves the original short lease to expire, since
-- the provider might still be processing the request. The issue/lane remains
-- permanently reserved. No subsequent call may dispatch it again.
create function public.mark_brevo_delivery_unconfirmed(
  p_user_id uuid, p_week_of date, p_attempt_id uuid,
  p_lease_token uuid, p_request_fingerprint text
)
returns table(delivery_status text)
language plpgsql security definer set search_path = public as $$
declare
  v_attempt public.resend_delivery_attempts%rowtype;
begin
  if p_user_id is null or p_week_of is null or p_attempt_id is null
     or p_lease_token is null or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    return query select 'invalid'::text;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  select a.* into v_attempt from public.resend_delivery_attempts a
    join public.issues i on i.id = a.issue_id
   where a.attempt_id = p_attempt_id and a.user_id = p_user_id
     and i.week_of = p_week_of and a.delivery_lane = 'live'
   for update of a;
  if not found or v_attempt.provider <> 'brevo' then
    return query select 'missing'::text;
    return;
  end if;
  if v_attempt.request_fingerprint <> p_request_fingerprint then
    return query select 'payload_changed'::text;
    return;
  end if;
  if v_attempt.brevo_message_id is not null then
    return query select 'accepted'::text;
    return;
  end if;
  if v_attempt.lease_token is distinct from p_lease_token then
    return query select 'manual_review'::text;
    return;
  end if;
  update public.resend_delivery_attempts
     set manual_review_required_at = coalesce(manual_review_required_at, clock_timestamp())
   where attempt_id = p_attempt_id;
  return query select 'manual_review'::text;
end;
$$;
revoke all on function public.mark_brevo_delivery_unconfirmed(uuid,date,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.mark_brevo_delivery_unconfirmed(uuid,date,uuid,uuid,text)
  to service_role;

create function public.finalize_brevo_delivery_attempt(
  p_user_id uuid, p_week_of date, p_attempt_id uuid,
  p_lease_token uuid, p_request_fingerprint text, p_message_id text
)
returns table(
  delivery_status text, stored_accepted_at timestamptz,
  suppression_review_required boolean
)
language plpgsql security definer set search_path = public as $$
declare
  v_issue public.issues%rowtype;
  v_attempt public.resend_delivery_attempts%rowtype;
  v_event public.brevo_suppression_events%rowtype;
  v_status text := 'recorded';
  v_apply_status text;
  v_apply_count integer;
  v_recipient_hash text;
  v_now timestamptz;
  v_review boolean := false;
begin
  if p_user_id is null or p_week_of is null or p_attempt_id is null
     or p_lease_token is null or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or p_message_id is null or length(p_message_id) not between 1 and 512
     or p_message_id !~ '^[!-~]+$'
     or position('<' in p_message_id) > 0 or position('>' in p_message_id) > 0 then
    return query select 'invalid'::text, null::timestamptz, true;
    return;
  end if;
  -- The event writer takes this message lock before touching any user row.
  perform pg_advisory_xact_lock(
    hashtextextended('alpha-brevo-message:' || p_message_id, 80425084)
  );
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080));
  if exists (select 1 from public.account_deletion_sagas
              where user_id = p_user_id) then
    return query select 'deletion_pending'::text, null::timestamptz, true;
    return;
  end if;
  select * into v_issue from public.issues
   where user_id = p_user_id and week_of = p_week_of for update;
  if not found then
    return query select 'missing'::text, null::timestamptz, true;
    return;
  end if;
  select * into v_attempt from public.resend_delivery_attempts
   where attempt_id = p_attempt_id and issue_id = v_issue.id
     and user_id = p_user_id and delivery_lane = 'live' for update;
  if not found or v_attempt.provider <> 'brevo' then
    return query select 'provider_conflict'::text, null::timestamptz, true;
    return;
  end if;
  if v_attempt.request_fingerprint <> p_request_fingerprint then
    return query select 'payload_changed'::text, null::timestamptz, true;
    return;
  end if;
  v_now := clock_timestamp();
  if v_attempt.brevo_message_id is not null then
    if v_attempt.brevo_message_id <> p_message_id then
      return query select 'conflict'::text, null::timestamptz, true;
      return;
    end if;
    v_status := 'replayed';
  else
    if v_attempt.lease_token is distinct from p_lease_token then
      return query select 'lease_lost'::text, null::timestamptz, true;
      return;
    end if;
    -- This limits attachment of a previously unknown result to the event
    -- retention horizon. It is not permission to replay a Brevo send.
    if v_now >= v_attempt.started_at + interval '23 hours' then
      return query select 'ambiguous_expired'::text, null::timestamptz, true;
      return;
    end if;
    update public.resend_delivery_attempts
       set brevo_message_id = p_message_id, accepted_at = v_now,
           lease_token = null, lease_expires_at = null,
           manual_review_required_at = null
     where attempt_id = p_attempt_id;
    v_attempt.brevo_message_id := p_message_id;
    v_attempt.accepted_at := v_now;
  end if;
  if v_issue.resend_message_id is not null
     or (v_issue.brevo_message_id is not null
         and v_issue.brevo_message_id <> p_message_id) then
    v_status := v_status || '_stale';
    v_review := true;
    update public.resend_delivery_attempts
       set manual_review_required_at = coalesce(manual_review_required_at, v_now)
     where attempt_id = p_attempt_id;
  else
    update public.issues
       set brevo_message_id = p_message_id,
           delivered_at = v_attempt.accepted_at
     where id = v_issue.id;
  end if;
  v_recipient_hash := encode(
    sha256(convert_to(v_attempt.recipient, 'UTF8')), 'hex'
  );
  for v_event in
    select * from public.brevo_suppression_events
     where message_id = p_message_id for update
  loop
    if v_event.recipient_conflict
       or v_event.recipient_hash <> v_recipient_hash
       or v_attempt.started_at > v_event.event_at + interval '10 minutes'
       or (v_event.owner_user_id is not null
           and v_event.owner_user_id <> p_user_id) then
      update public.brevo_suppression_events
         set owner_user_id = coalesce(owner_user_id, p_user_id),
             resolution_status = 'manual_review',
             review_required_at = coalesce(review_required_at, v_now),
             resolved_at = null
       where message_id = v_event.message_id and event_type = v_event.event_type
         and event_at = v_event.event_at;
      v_review := true;
      continue;
    end if;
    select applied.resolution_status, applied.updated_count
      into v_apply_status, v_apply_count
      from public.apply_brevo_suppression_to_user(
        p_user_id, v_event.recipient_hash, v_event.event_type, v_event.event_at
      ) applied;
    update public.brevo_suppression_events
       set owner_user_id = p_user_id, resolution_status = v_apply_status,
           review_required_at = case when v_apply_status = 'manual_review'
             then coalesce(review_required_at, v_now) else null end,
           resolved_at = case when v_apply_status = 'manual_review' then null else v_now end
     where message_id = v_event.message_id and event_type = v_event.event_type
       and event_at = v_event.event_at;
    v_review := v_review or v_apply_status = 'manual_review';
  end loop;
  return query select v_status, v_attempt.accepted_at, v_review;
end;
$$;
revoke all on function public.finalize_brevo_delivery_attempt(uuid,date,uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.finalize_brevo_delivery_attempt(uuid,date,uuid,uuid,text,text)
  to service_role;

-- Keep early, unowned recipient hashes bounded. An owned event remains part of
-- the user's protected delivery record and cascades on account deletion.
create function public.prune_unowned_brevo_suppression_events(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_deleted integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'invalid Brevo pruning limit';
  end if;
  delete from public.brevo_suppression_events e
   where (e.message_id, e.event_type, e.event_at) in (
     select pending.message_id, pending.event_type, pending.event_at
       from public.brevo_suppression_events pending
      where pending.owner_user_id is null
        and least(pending.event_at, pending.received_at) < clock_timestamp() - interval '7 days'
      order by least(pending.event_at, pending.received_at), pending.message_id
      limit p_limit for update skip locked
   );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.prune_unowned_brevo_suppression_events(integer)
  from public, anon, authenticated;
grant execute on function public.prune_unowned_brevo_suppression_events(integer)
  to service_role;

-- Keep the original Resend-era counter stable for its current callers. New
-- provider-aware senders count only accepted provider proof, with the same
-- grandfather window used by the delivery watchdog for historical issues.
create function public.prior_provider_issue_counts(
  week_of_cutoff date, target_user_ids uuid[]
)
returns table(user_id uuid, prior_count bigint)
language sql
security definer
set search_path = public
as $$
  select i.user_id, count(*) as prior_count
  from public.issues i
  where i.week_of < week_of_cutoff
    and i.delivered_at is not null
    and i.user_id = any(target_user_ids)
    and (
      i.resend_message_id is not null
      or i.brevo_message_id is not null
      or i.delivered_at < '2026-08-05T19:10:00Z'::timestamptz
    )
  group by i.user_id
$$;
revoke all on function public.prior_provider_issue_counts(date, uuid[])
  from public, anon, authenticated;
grant execute on function public.prior_provider_issue_counts(date, uuid[])
  to service_role;

-- The existing historical cutoff still grandfathers real pre-proof sends.
-- Future coverage requires either provider's own accepted message ID.
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
        and u.brevo_unsubscribed_at is null
        and u.bounced_at is null
        and u.complained_at is null
        and u.suppression_cleanup_pending_at is null
        and not exists (
          select 1 from public.issues i
          where i.user_id = u.id
            and i.delivered_at >= date_trunc('hour', cutoff)
            and (
              i.resend_message_id is not null
              or i.brevo_message_id is not null
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
        and u.brevo_unsubscribed_at is null
        and u.bounced_at is null
        and u.complained_at is null
        and u.suppression_cleanup_pending_at is null
    ) as active_subscriber_count;
$$;
revoke all on function public.watchdog_delivery_check(timestamptz) from public;
revoke all on function public.watchdog_delivery_check(timestamptz) from authenticated;
grant execute on function public.watchdog_delivery_check(timestamptz) to anon;

commit;
