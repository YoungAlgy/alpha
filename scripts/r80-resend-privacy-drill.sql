\set ON_ERROR_STOP on

-- Disposable local PostgreSQL fixture for the Round 80 Resend deletion/privacy
-- contract. The caller runs this inside the isolated recovery-drill database.
-- Every fixture is rolled back. No provider, network, or environment input is
-- used. The final SELECT is the only intentional output.
begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
set local request.jwt.claims = '{"role":"service_role"}';

do $drill$
declare
  v_assertions integer := 0;
  v_status text;
  v_count integer;
  v_received_before timestamptz;
  v_received_after timestamptz;
  v_pruned integer;
  v_remaining boolean;
  v_due boolean;
  v_user_id uuid;
  v_issue_id uuid;
  v_attempt_id uuid;
  v_now timestamptz := clock_timestamp();
  v_lease uuid := 'd0000000-0000-4000-8000-000000000001';
  v_fingerprint text := repeat('1', 64);
  v_recipient text := 'resend-privacy-fast@fixture.invalid';
  v_recipient_hash text;
begin
  -- The migration must leave the historical receipt clock immutable and
  -- non-null. A direct null insert is also expected to fail.
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'resend_webhook_events'
       and column_name = 'received_at'
       and is_nullable = 'NO'
  ) then
    raise exception 'received_at is still nullable';
  end if;
  v_assertions := v_assertions + 1;
  begin
    insert into public.resend_webhook_events (
      email_id, type, received_at, event_at, recipient_hashes,
      resolution_status, review_required_at
    ) values (
      'r80-null-receipt', 'email.bounced', null, clock_timestamp(),
      array[repeat('a', 64)]::text[], 'pending_owner', clock_timestamp()
    );
    raise exception 'received_at null insert unexpectedly succeeded';
  exception
    when not_null_violation then
      v_assertions := v_assertions + 1;
  end;

  -- A signed event older than the local seven-day unmatched window must not
  -- create a row, including when it is replayed.
  select delivery_status into v_status
    from public.record_resend_suppression_event(
      'r80-expired-unowned', 'email.bounced',
      v_now - interval '8 days',
      array['expired-unowned@fixture.invalid']
    );
  if v_status <> 'expired_unowned' then
    raise exception 'expired unmatched event was not rejected before insert';
  end if;
  v_assertions := v_assertions + 1;
  if exists (
    select 1 from public.resend_webhook_events
     where email_id = 'r80-expired-unowned'
  ) then
    raise exception 'expired unmatched event persisted recipient-derived data';
  end if;
  v_assertions := v_assertions + 1;
  select delivery_status into v_status
    from public.record_resend_suppression_event(
      'r80-expired-unowned', 'email.bounced',
      v_now - interval '8 days',
      array['expired-unowned@fixture.invalid']
    );
  if v_status <> 'expired_unowned' then
    raise exception 'expired unmatched replay was accepted';
  end if;
  v_assertions := v_assertions + 1;
  if exists (
    select 1 from public.resend_webhook_events
     where email_id = 'r80-expired-unowned'
  ) then
    raise exception 'expired unmatched replay recreated a row';
  end if;
  v_assertions := v_assertions + 1;

  -- A duplicate within the window may be acknowledged, but it must retain
  -- the first receipt clock.
  select delivery_status into v_status
    from public.record_resend_suppression_event(
      'r80-receipt-immutable', 'email.complained',
      v_now - interval '1 day',
      array['receipt-immutable@fixture.invalid']
    );
  if v_status <> 'pending_owner' then
    raise exception 'fresh unmatched event was not queued';
  end if;
  v_assertions := v_assertions + 1;
  select received_at into v_received_before
    from public.resend_webhook_events
   where email_id = 'r80-receipt-immutable'
     and type = 'email.complained';
  perform pg_sleep(0.01);
  select delivery_status into v_status
    from public.record_resend_suppression_event(
      'r80-receipt-immutable', 'email.complained',
      v_now - interval '1 day',
      array['receipt-immutable@fixture.invalid']
    );
  select received_at into v_received_after
    from public.resend_webhook_events
   where email_id = 'r80-receipt-immutable'
     and type = 'email.complained';
  if v_status <> 'pending_owner'
     or v_received_after is distinct from v_received_before then
    raise exception 'duplicate replay refreshed the receipt clock';
  end if;
  v_assertions := v_assertions + 1;

  -- Run this part before the recovery harness adds its unrelated synthetic
  -- queues. The expired ownerless row alone must wake maintenance.
  v_due := public.alpha_scheduled_maintenance_due(v_now);
  if v_due then
    raise exception 'maintenance was due before the expired ownerless fixture';
  end if;
  v_assertions := v_assertions + 1;
  insert into public.resend_webhook_events (
    email_id, type, received_at, event_at, recipient_hashes,
    resolution_status, review_required_at
  ) values (
    'r80-maintenance-wake', 'email.bounced', v_now - interval '9 days',
    v_now - interval '9 days', array[repeat('d', 64)]::text[],
    'pending_owner', v_now - interval '9 days'
  );
  v_due := public.alpha_scheduled_maintenance_due(v_now);
  if not v_due then
    raise exception 'expired ownerless evidence did not wake maintenance';
  end if;
  v_assertions := v_assertions + 1;
  delete from public.resend_webhook_events
   where email_id = 'r80-maintenance-wake'
     and type = 'email.bounced';

  -- Bounded pruning must include legacy and manual-review ownerless material,
  -- while stopping at the requested maximum and reporting remaining work.
  insert into public.resend_webhook_events (
    email_id, type, received_at, event_at, recipient_hashes,
    resolution_status, review_required_at
  )
  select 'r80-prune-' || lpad(g::text, 4, '0'),
         'email.bounced',
         v_now - interval '9 days',
         v_now - interval '9 days',
         array[repeat('b', 64)]::text[],
         'pending_owner',
         v_now - interval '9 days'
    from generate_series(1, 1000) as series(g);
  insert into public.resend_webhook_events (
    email_id, type, received_at, event_at, recipient_hashes,
    resolution_status, review_required_at
  ) values
    ('r80-prune-legacy', 'email.bounced', v_now - interval '9 days', null,
     '{}'::text[], 'legacy_review', v_now - interval '9 days'),
    ('r80-prune-manual', 'email.complained', v_now - interval '9 days',
     v_now - interval '9 days', array[repeat('c', 64)]::text[],
     'manual_review', v_now - interval '9 days');
  select pruned_count, remaining into v_pruned, v_remaining
    from public.prune_unowned_resend_webhook_events(1000);
  if v_pruned <> 1000 or not v_remaining then
    raise exception 'pruner did not enforce the 1000-row bound';
  end if;
  v_assertions := v_assertions + 1;
  select pruned_count, remaining into v_pruned, v_remaining
    from public.prune_unowned_resend_webhook_events(1000);
  if v_pruned <> 2 or v_remaining then
    raise exception 'pruner did not remove legacy/manual ownerless rows';
  end if;
  v_assertions := v_assertions + 1;
  select count(*) into v_count
    from public.resend_webhook_events
   where email_id like 'r80-prune-%';
  if v_count <> 0 then
    raise exception 'expired ownerless rows remain after bounded pruning';
  end if;
  v_assertions := v_assertions + 1;

  -- Create disposable Auth identities. The production Auth trigger creates
  -- their public profile rows. Service-role updates then make only the
  -- delivery fixtures eligible for claim.
  insert into auth.users (id, email, created_at) values
    ('d1000000-0000-4000-8000-000000000001', 'owned-old@fixture.invalid', v_now - interval '30 days'),
    ('d1000000-0000-4000-8000-000000000002', 'fast-before-finalize@fixture.invalid', v_now),
    ('d1000000-0000-4000-8000-000000000003', 'same-address@fixture.invalid', '2026-08-01T00:00:00Z'),
    ('d1000000-0000-4000-8000-000000000005', 'late-finalizer@fixture.invalid', v_now),
    ('d1000000-0000-4000-8000-000000000006', 'valid-finalizer@fixture.invalid', v_now),
    ('d1000000-0000-4000-8000-000000000007', 'policy-gate@fixture.invalid', v_now);
  update public.users
     set subscribed_at = v_now,
         access_granted_at = v_now
   where id in (
     'd1000000-0000-4000-8000-000000000002'::uuid,
     'd1000000-0000-4000-8000-000000000005'::uuid,
     'd1000000-0000-4000-8000-000000000006'::uuid
   );

  -- Exact message ownership permits a bounce older than seven days to apply.
  v_user_id := 'd1000000-0000-4000-8000-000000000001';
  v_issue_id := 'd2000000-0000-4000-8000-000000000001';
  v_attempt_id := 'd3000000-0000-4000-8000-000000000001';
  v_recipient_hash := encode(sha256(convert_to('owned-old@fixture.invalid', 'UTF8')), 'hex');
  insert into public.issues (id, user_id, week_of, editor_intro, sections)
  values (v_issue_id, v_user_id, (v_now - interval '17 days')::date, 'R80 fixture', '{}'::jsonb);
  insert into public.resend_delivery_attempts (
    attempt_id, user_id, issue_id, recipient, delivery_lane,
    request_fingerprint, started_at, retry_deadline_at,
    resend_message_id, accepted_at
  ) values (
    v_attempt_id, v_user_id, v_issue_id, 'owned-old@fixture.invalid', 'live',
    repeat('2', 64), v_now - interval '29 days',
    v_now - interval '29 days' + interval '23 hours',
    'r80-owned-old-message', v_now - interval '29 days' + interval '1 second'
  );
  select delivery_status into v_status
    from public.record_resend_suppression_event(
      'r80-owned-old-message', 'email.bounced', v_now - interval '8 days',
      array['owned-old@fixture.invalid']
    );
  if v_status <> 'applied' then
    raise exception 'owned old event was cut off instead of applied';
  end if;
  v_assertions := v_assertions + 1;
  if not exists (
    select 1 from public.users
     where id = v_user_id and bounced_at is not null
  ) then
    raise exception 'owned old bounce did not update the user suppression mirror';
  end if;
  v_assertions := v_assertions + 1;

  -- A fast event arriving before provider finalization remains pending and is
  -- applied only after the exact provider message binds to the attempt.
  v_user_id := 'd1000000-0000-4000-8000-000000000002';
  v_issue_id := 'd2000000-0000-4000-8000-000000000002';
  v_attempt_id := 'd3000000-0000-4000-8000-000000000002';
  insert into public.issues (id, user_id, week_of, editor_intro, sections)
  values (v_issue_id, v_user_id, '2026-09-01', 'R80 fixture', '{}'::jsonb);
  insert into public.resend_delivery_attempts (
    attempt_id, user_id, issue_id, recipient, delivery_lane,
    request_fingerprint, started_at, retry_deadline_at,
    lease_token, lease_expires_at
  ) values (
    v_attempt_id, v_user_id, v_issue_id,
    'fast-before-finalize@fixture.invalid',
    'force-10000000-0000-4000-8000-000000000001',
    v_fingerprint, v_now, v_now + interval '23 hours',
    v_lease, v_now + interval '1 minute'
  );
  select delivery_status into v_status
    from public.record_resend_suppression_event(
      'r80-fast-message', 'email.complained', v_now + interval '1 minute',
      array['fast-before-finalize@fixture.invalid']
    );
  if v_status <> 'pending_owner' then
    raise exception 'fast webhook was not queued as pending owner';
  end if;
  v_assertions := v_assertions + 1;
  select delivery_status into v_status
    from public.finalize_resend_delivery_attempt(
      v_user_id, '2026-09-01',
      'force-10000000-0000-4000-8000-000000000001', v_lease,
      v_fingerprint, 'r80-fast-message'
    );
  if v_status <> 'recorded' then
    raise exception 'fast webhook finalization did not record exact message';
  end if;
  v_assertions := v_assertions + 1;
  if not exists (
    select 1 from public.resend_webhook_events
     where email_id = 'r80-fast-message'
       and owner_user_id = v_user_id
       and resolution_status = 'applied'
  ) then
    select count(*) into v_count from public.resend_webhook_events
     where email_id = 'r80-fast-message';
    select coalesce(max(resolution_status), 'none') into v_status
      from public.resend_webhook_events
     where email_id = 'r80-fast-message';
    raise exception 'fast webhook did not apply after exact finalization: count %, status %', v_count, v_status;
  end if;
  v_assertions := v_assertions + 1;

  -- Deleting account A must not let an ownerless event transfer to a new
  -- account B that later reuses the same address.
  select delivery_status into v_status
    from public.record_resend_suppression_event(
      'r80-same-address-message', 'email.bounced', v_now - interval '1 day',
      array['same-address@fixture.invalid']
    );
  if v_status <> 'pending_owner' then
    raise exception 'same-address event was not left ownerless';
  end if;
  v_assertions := v_assertions + 1;
  delete from auth.users
   where id = 'd1000000-0000-4000-8000-000000000003';
  insert into auth.users (id, email, created_at)
  values (
    'd1000000-0000-4000-8000-000000000004',
    'same-address@fixture.invalid',
    v_now
  );
  select delivery_status into v_status
    from public.record_resend_suppression_event(
      'r80-same-address-message', 'email.bounced', v_now - interval '1 day',
      array['same-address@fixture.invalid']
    );
  if v_status <> 'pending_owner' then
    raise exception 'same-address replay changed the ownerless status';
  end if;
  v_assertions := v_assertions + 1;
  if exists (
    select 1 from public.resend_webhook_events
     where email_id = 'r80-same-address-message'
       and owner_user_id is not null
  ) then
    raise exception 'ownerless event transferred to same-address new account';
  end if;
  v_assertions := v_assertions + 1;

  -- An attempt with an unknown provider result at or after 23 hours must fail
  -- closed and leave the issue without a delivered proof.
  v_user_id := 'd1000000-0000-4000-8000-000000000005';
  v_issue_id := 'd2000000-0000-4000-8000-000000000005';
  v_attempt_id := 'd3000000-0000-4000-8000-000000000005';
  insert into public.issues (id, user_id, week_of, editor_intro, sections)
  values (v_issue_id, v_user_id, '2026-09-02', 'R80 fixture', '{}'::jsonb);
  insert into public.resend_delivery_attempts (
    attempt_id, user_id, issue_id, recipient, delivery_lane,
    request_fingerprint, started_at, retry_deadline_at,
    lease_token, lease_expires_at
  ) values (
    v_attempt_id, v_user_id, v_issue_id, 'late-finalizer@fixture.invalid', 'live',
    repeat('3', 64), v_now - interval '24 hours', v_now - interval '1 hour',
    'd0000000-0000-4000-8000-000000000005', v_now - interval '1 minute'
  );
  select delivery_status into v_status
    from public.finalize_resend_delivery_attempt(
      v_user_id, '2026-09-02', 'live',
      'd0000000-0000-4000-8000-000000000005', repeat('3', 64),
      'r80-late-finalizer-message'
    );
  if v_status <> 'ambiguous_expired' then
    raise exception 'late unknown finalizer did not fail closed';
  end if;
  v_assertions := v_assertions + 1;
  if exists (
    select 1 from public.resend_delivery_attempts
     where attempt_id = v_attempt_id and resend_message_id is not null
  ) or not exists (
    select 1 from public.resend_delivery_attempts
     where attempt_id = v_attempt_id and manual_review_required_at is not null
  ) or exists (
    select 1 from public.issues
     where id = v_issue_id and delivered_at is not null
  ) then
    raise exception 'late unknown finalizer wrote provider proof';
  end if;
  v_assertions := v_assertions + 1;

  -- A valid finalizer ten minutes before the relative deadline still records
  -- its exact message. The margin keeps this stable on slower CI hosts.
  v_user_id := 'd1000000-0000-4000-8000-000000000006';
  v_issue_id := 'd2000000-0000-4000-8000-000000000006';
  v_attempt_id := 'd3000000-0000-4000-8000-000000000006';
  insert into public.issues (id, user_id, week_of, editor_intro, sections)
  values (v_issue_id, v_user_id, '2026-09-02', 'R80 fixture', '{}'::jsonb);
  insert into public.resend_delivery_attempts (
    attempt_id, user_id, issue_id, recipient, delivery_lane,
    request_fingerprint, started_at, retry_deadline_at,
    lease_token, lease_expires_at
  ) values (
    v_attempt_id, v_user_id, v_issue_id, 'valid-finalizer@fixture.invalid', 'live',
    repeat('4', 64), v_now - interval '23 hours' + interval '10 minutes',
    v_now + interval '10 minutes',
    'd0000000-0000-4000-8000-000000000006', v_now + interval '1 minute'
  );
  select delivery_status into v_status
    from public.finalize_resend_delivery_attempt(
      v_user_id, '2026-09-02', 'live',
      'd0000000-0000-4000-8000-000000000006', repeat('4', 64),
      'r80-valid-finalizer-message'
    );
  if v_status <> 'recorded' then
    raise exception 'valid pre-deadline finalizer was rejected';
  end if;
  v_assertions := v_assertions + 1;
  if not exists (
    select 1 from public.resend_delivery_attempts
     where attempt_id = v_attempt_id
       and resend_message_id = 'r80-valid-finalizer-message'
       and accepted_at is not null
  ) then
    raise exception 'valid pre-deadline finalizer did not store message proof';
  end if;
  v_assertions := v_assertions + 1;

  -- The deletion saga can proceed after the support marker and the new
  -- delivery-policy marker. It does not require provider suppression removal.
  v_user_id := 'd1000000-0000-4000-8000-000000000007';
  insert into public.account_deletion_sagas (
    user_id, state, billing_cleaned_at
  ) values (v_user_id, 'billing_clean', v_now);
  if not public.mark_account_deletion_support_deleted(v_user_id) then
    raise exception 'support deletion marker was not accepted';
  end if;
  v_assertions := v_assertions + 1;
  if not public.mark_account_deletion_delivery_policy_settled(v_user_id) then
    raise exception 'new delivery policy marker was not accepted';
  end if;
  v_assertions := v_assertions + 1;
  if not public.begin_account_deletion_auth_removal(v_user_id) then
    raise exception 'deletion saga still requires obsolete provider-clear marker';
  end if;
  v_assertions := v_assertions + 1;
  if not exists (
    select 1 from public.account_deletion_sagas
     where user_id = v_user_id
       and state = 'auth_delete_started'
       and delivery_policy_settled_at is not null
  ) then
    raise exception 'deletion saga did not advance with new policy marker';
  end if;
  v_assertions := v_assertions + 1;
  if v_assertions <> 29 then
    raise exception 'privacy drill assertion count drifted: %', v_assertions;
  end if;
end
$drill$;

rollback;
select 'R80 RESEND PRIVACY DRILL PASS: 29 assertions' as drill_result;
