-- Alpha invite-only access. A request is stored on the existing profile row.
-- Approval records an independent permanent entitlement and does not alter the
-- Stripe billing mirror.

alter table public.users
  add column if not exists access_requested_at timestamptz,
  add column if not exists access_granted_at timestamptz;

-- Protect the new entitlement fields in the same migration that creates them.
-- A sequential migration runner must never expose a window where an
-- authenticated profile update can forge its own request or grant marker.
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

create index if not exists users_pending_access_request_idx
  on public.users (access_requested_at)
  where access_requested_at is not null
    and access_granted_at is null;

-- The paid cancellation timestamp must keep mirroring Stripe even after the
-- owner grants permanent invite access. Extend the issue policy so that an
-- explicit protected grant is an independent access path.
drop policy if exists "issues self read" on public.issues;

create policy "issues self read" on public.issues for select using (
  auth.uid() = user_id
  and exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and u.subscribed_at is not null
      and (
        u.access_granted_at is not null
        or u.cancelled_at is null
        or u.cancelled_at > now()
      )
  )
);

-- Keep the watchdog's delivery population identical to the weekly sender.
-- Permanent invite access remains active after a paid billing window ends.
create or replace function public.watchdog_delivery_check(cutoff timestamptz)
returns table(uncovered_count bigint, active_subscriber_count bigint)
language sql
security definer
set search_path = public
as $$
  select
    (
      select count(*) from public.users u
      where u.subscribed_at is not null
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
      where u.subscribed_at is not null
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
