\set ON_ERROR_STOP on

-- Disposable local PostgreSQL fixture for the account-level Resend suppression
-- recovery fence. The caller runs this in an isolated database. All rows are
-- rolled back and no provider or environment state is read.
begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
set local request.jwt.claims = '{"role":"service_role"}';

do $drill$
declare
  v_assertions integer := 0;
  v_status text;
  v_token uuid;
  v_started timestamptz;
  v_recipient text;
  v_snapshot jsonb;
  v_before jsonb;
  v_blocked boolean := false;
  v_now timestamptz := clock_timestamp();
  v_user_id uuid := 'e1000000-0000-4000-8000-000000000001';
  v_clear_user_id uuid := 'e1000000-0000-4000-8000-000000000002';
  v_issue_id uuid := 'e2000000-0000-4000-8000-000000000001';
  v_attempt_id uuid := 'e3000000-0000-4000-8000-000000000001';
begin
  insert into auth.users (id, email, created_at)
  values
    (v_user_id, 'suppression-recovery@fixture.invalid', v_now),
    (v_clear_user_id, 'suppression-recovery-clear@fixture.invalid', v_now);
  update public.users
     set subscribed_at = v_now,
         access_granted_at = v_now
   where id in (v_user_id, v_clear_user_id);

  select recovery_status into v_status
    from public.claim_resend_suppression_recovery(v_user_id);
  if v_status <> 'already_clear' then
    raise exception 'clean user did not return already_clear';
  end if;
  v_assertions := v_assertions + 1;

  update auth.users
     set email = 'identity-conflict@fixture.invalid'
   where id = v_user_id;
  select recovery_status into v_status
    from public.claim_resend_suppression_recovery(v_user_id);
  if v_status <> 'identity_conflict' then
    raise exception 'Auth/public identity mismatch was not rejected';
  end if;
  v_assertions := v_assertions + 1;
  update auth.users
     set email = 'suppression-recovery@fixture.invalid'
   where id = v_user_id;

  update public.users set subscribed_at = null where id = v_user_id;
  select recovery_status into v_status
    from public.claim_resend_suppression_recovery(v_user_id);
  if v_status <> 'ineligible' then
    raise exception 'unsubscribed profile was not rejected';
  end if;
  v_assertions := v_assertions + 1;
  update public.users set subscribed_at = v_now where id = v_user_id;

  update public.users
     set access_granted_at = null,
         cancelled_at = v_now - interval '1 hour'
   where id = v_user_id;
  select recovery_status into v_status
    from public.claim_resend_suppression_recovery(v_user_id);
  if v_status <> 'ineligible' then
    raise exception 'cancelled profile without access was not rejected';
  end if;
  v_assertions := v_assertions + 1;
  update public.users
     set access_granted_at = v_now,
         cancelled_at = null
   where id = v_user_id;

  update public.users
     set bounced_at = v_now - interval '1 hour'
   where id = v_user_id;
  select recovery_status, recovery_token, recovery_started_at, recipient_email
    into v_status, v_token, v_started, v_recipient
    from public.claim_resend_suppression_recovery(v_user_id);
  if v_status <> 'claimed'
     or v_token is null
     or v_started is null
     or v_recipient <> 'suppression-recovery@fixture.invalid' then
    raise exception 'eligible suppression recovery was not claimed';
  end if;
  v_assertions := v_assertions + 1;
  select suppression_recovery_snapshot into v_snapshot
    from public.users where id = v_user_id;
  if not (v_snapshot ? 'email') or v_snapshot ? 'city' then
    raise exception 'recovery snapshot contains the wrong identity surface';
  end if;
  v_assertions := v_assertions + 1;

  select recovery_status into v_status
    from public.claim_resend_suppression_recovery(v_user_id);
  if v_status <> 'review_required' then
    raise exception 'duplicate recovery claim was not fenced';
  end if;
  v_assertions := v_assertions + 1;
  if not public.alpha_scheduled_maintenance_due(v_now) then
    raise exception 'pending suppression recovery did not wake maintenance';
  end if;
  v_assertions := v_assertions + 1;

  update public.users
     set suppression_recovery_started_at = v_now - interval '100 years'
   where id = v_user_id;
  select recovery_status into v_status
    from public.claim_resend_suppression_recovery(v_user_id);
  if v_status <> 'review_required' or not exists (
    select 1 from public.users where id = v_user_id
      and suppression_recovery_token = v_token
      and suppression_recovery_started_at = v_now - interval '100 years'
  ) then
    raise exception 'old unresolved recovery was expired or reclaimed';
  end if;
  v_assertions := v_assertions + 1;
  update public.users set suppression_recovery_started_at = v_started
   where id = v_user_id;

  select to_jsonb(u) into v_before from public.users u where id = v_user_id;
  begin
    perform public.prepare_account_deletion(v_user_id);
    raise exception 'deletion preparation bypassed the recovery guard';
  exception when others then
    if sqlerrm <> 'account deletion blocked by unresolved suppression recovery' then
      raise;
    end if;
  end;
  if exists (select 1 from public.account_deletion_sagas where user_id = v_user_id)
     or v_before is distinct from (
       select to_jsonb(u) from public.users u where id = v_user_id
     ) then
    raise exception 'rejected deletion preparation changed the user or saga';
  end if;
  v_assertions := v_assertions + 1;

  begin
    update auth.users
       set email = 'auth-email-during-recovery@fixture.invalid'
     where id = v_user_id;
    if exists (
      select 1 from auth.users
       where id = v_user_id
         and email = 'auth-email-during-recovery@fixture.invalid'
    ) then
      raise exception 'auth identity update was not blocked by recovery fence';
    end if;
  exception
    when others then
      if sqlerrm = 'auth identity update was not blocked by recovery fence' then
        raise;
      end if;
      if sqlerrm <> 'Auth identity change blocked by unresolved suppression recovery' then
        raise exception 'unexpected Auth recovery guard error: %', sqlerrm;
      end if;
      v_blocked := true;
  end;
  if not v_blocked or not exists (
    select 1 from auth.users
     where id = v_user_id
       and email = 'suppression-recovery@fixture.invalid'
  ) then
    raise exception 'Auth email changed during suppression recovery';
  end if;
  v_assertions := v_assertions + 1;

  v_blocked := false;
  begin
    update public.users
       set email = 'public-email-during-recovery@fixture.invalid'
     where id = v_user_id;
    raise exception 'public identity update was not blocked by recovery fence';
  exception
    when others then
      if sqlerrm = 'public identity update was not blocked by recovery fence' then
        raise;
      end if;
      if sqlerrm <> 'account identity change blocked by unresolved suppression recovery' then
        raise exception 'unexpected public recovery guard error: %', sqlerrm;
      end if;
      v_blocked := true;
  end;
  if not v_blocked or not exists (
    select 1 from public.users
     where id = v_user_id
       and email = 'suppression-recovery@fixture.invalid'
  ) then
    raise exception 'public email changed during suppression recovery';
  end if;
  v_assertions := v_assertions + 1;

  v_blocked := false;
  begin
    delete from public.users where id = v_user_id;
    raise exception 'public deletion was not blocked by recovery fence';
  exception
    when others then
      if sqlerrm = 'public deletion was not blocked by recovery fence' then
        raise;
      end if;
      if sqlerrm <> 'account deletion blocked by unresolved suppression recovery' then
        raise exception 'unexpected public deletion recovery guard error: %', sqlerrm;
      end if;
      v_blocked := true;
  end;
  if not v_blocked or not exists (
    select 1 from public.users where id = v_user_id
  ) then
    raise exception 'public user was deleted during suppression recovery';
  end if;
  v_assertions := v_assertions + 1;

  if public.finalize_resend_suppression_recovery(v_user_id, gen_random_uuid())
       <> 'not_owner' then
    raise exception 'wrong suppression recovery token was accepted';
  end if;
  v_assertions := v_assertions + 1;

  update public.users
     set complained_at = v_now
   where id = v_user_id;
  if public.finalize_resend_suppression_recovery(v_user_id, v_token)
       <> 'state_changed' then
    raise exception 'new complaint did not win recovery finalization';
  end if;
  v_assertions := v_assertions + 1;
  if not exists (
    select 1 from public.users
     where id = v_user_id
       and bounced_at is not null
       and complained_at is not null
       and suppression_recovery_token is not null
       and suppression_recovery_started_at is not null
       and suppression_recovery_snapshot is not null
  ) then
    raise exception 'state-changed recovery did not retain the recovery fence';
  end if;
  v_assertions := v_assertions + 1;

  select recovery_status into v_status
    from public.claim_resend_suppression_recovery(v_user_id);
  if v_status <> 'review_required' then
    raise exception 'state-changed recovery fence was reclaimed automatically';
  end if;
  v_assertions := v_assertions + 1;

  v_user_id := v_clear_user_id;
  update public.users
     set bounced_at = v_now - interval '1 hour'
   where id = v_user_id;
  select recovery_status, recovery_token, recovery_started_at
    into v_status, v_token, v_started
    from public.claim_resend_suppression_recovery(v_user_id);
  if v_status <> 'claimed' or v_token is null then
    raise exception 'unchanged recovery fixture was not claimed';
  end if;
  v_assertions := v_assertions + 1;
  if public.finalize_resend_suppression_recovery(v_user_id, v_token)
       <> 'cleared' then
    raise exception 'unchanged recovery did not clear local suppression';
  end if;
  v_assertions := v_assertions + 1;
  if not exists (
    select 1 from public.users
     where id = v_user_id
       and bounced_at is null
       and complained_at is null
       and suppression_cleanup_pending_at is null
       and suppression_recovery_token is null
       and delivery_suppression_cleared_at = v_started
  ) then
    raise exception 'cleared recovery left suppression state behind';
  end if;
  v_assertions := v_assertions + 1;
  select recovery_status into v_status
    from public.claim_resend_suppression_recovery(v_user_id);
  if v_status <> 'already_clear' then
    raise exception 'post-clear recovery was not idempotent';
  end if;
  v_assertions := v_assertions + 1;

  update public.users set bounced_at = v_now where id = v_user_id;
  insert into public.account_deletion_sagas (user_id, state)
  values (v_user_id, 'prepared');
  select recovery_status into v_status
    from public.claim_resend_suppression_recovery(v_user_id);
  if v_status <> 'deletion_pending' then
    raise exception 'deletion saga did not fence recovery claim';
  end if;
  v_assertions := v_assertions + 1;
  delete from public.account_deletion_sagas where user_id = v_user_id;

  update public.users
     set bounced_at = null,
         complained_at = null,
         suppression_cleanup_pending_at = null
   where id = v_user_id;
  insert into public.issues (id, user_id, week_of, editor_intro, sections)
  values (v_issue_id, v_user_id, (v_now + interval '1 day')::date, 'R80 fixture', '{}'::jsonb);
  insert into public.resend_delivery_attempts (
    attempt_id, user_id, issue_id, recipient, delivery_lane,
    request_fingerprint, started_at, retry_deadline_at,
    lease_token, lease_expires_at
  ) values (
    v_attempt_id, v_user_id, v_issue_id,
    'suppression-recovery@fixture.invalid',
    'force-e1000000-0000-4000-8000-000000000001', repeat('a', 64),
    v_now, v_now + interval '23 hours',
    'e4000000-0000-4000-8000-000000000001', v_now + interval '1 minute'
  );
  select recovery_status into v_status
    from public.claim_resend_suppression_recovery(v_user_id);
  if v_status <> 'delivery_busy' then
    raise exception 'active delivery lease did not fence recovery claim';
  end if;
  v_assertions := v_assertions + 1;
  delete from public.resend_delivery_attempts where attempt_id = v_attempt_id;
  delete from public.issues where id = v_issue_id;

  if v_assertions <> 23 then
    raise exception 'suppression recovery drill assertion count drifted: %', v_assertions;
  end if;
end
$drill$;

rollback;
select 'R80 SUPPRESSION RECOVERY DRILL PASS: 23 assertions' as drill_result;
