-- alpha · Resend bounce/complaint suppression + webhook dedup · 2026-08-06
--
-- alpha-deliverability-01: nothing in the app currently reacts to a hard
-- bounce or a spam complaint. A dead address (typo'd domain, closed mailbox)
-- or a subscriber who hits "report spam" instead of unsubscribing keeps
-- getting sent to every single day, indefinitely -- accumulating hard
-- bounces/complaints against everyday.report's sender reputation with
-- Resend/the receiving mailbox providers, which over time degrades or tanks
-- inbox placement for EVERY subscriber, not just the bad address.
--
-- bounced_at/complained_at mirror unsubscribed_at's shape and role (a
-- timestamp the cron's subscriber query excludes on) but are a DISTINCT
-- signal from it: unsubscribed_at is the reader's own choice, these are
-- Resend/the mailbox provider telling us delivery itself is broken or
-- unwanted. Only a HARD (Permanent) bounce sets bounced_at -- see the
-- webhook route's own comment for why a soft/transient bounce must NOT
-- suppress (that's normal, temporary, and un-suppressing it would be wrong).

alter table public.users
  add column if not exists bounced_at timestamptz,
  add column if not exists complained_at timestamptz;

-- Same reasoning as the cron's other suppression-relevant filters
-- (unsubscribed_at, cancelled_at) -- the weekly-send query filters on these,
-- so an index keeps that filter cheap as the table grows. Partial (only
-- non-null rows) since the vast majority of rows will never be suppressed.
create index if not exists users_bounced_at_idx
  on public.users (bounced_at)
  where bounced_at is not null;
create index if not exists users_complained_at_idx
  on public.users (complained_at)
  where complained_at is not null;

-- Lock both new columns the same way unsubscribed_at/cancelled_at/etc. are
-- locked (20260524000000_security_user_column_lock) -- this is
-- deliverability/reputation-protection state set by the Resend webhook
-- (service_role only), not something a signed-in reader should be able to
-- clear on themselves via a direct authenticated write. Re-declaring the
-- WHOLE function (not just appending) since Postgres has no "add one more
-- locked column" syntax for an existing trigger function -- copy of
-- 20260524000000's body plus the two new lines.
create or replace function public.protect_user_privileged_columns()
returns trigger language plpgsql security definer as $$
begin
  if (coalesce(current_setting('request.jwt.claims', true), '{}')::json->>'role') = 'service_role' then
    return new;
  end if;
  new.id := old.id;
  new.email := old.email;
  new.stripe_customer_id := old.stripe_customer_id;
  new.subscribed_at := old.subscribed_at;
  new.cancelled_at := old.cancelled_at;
  new.unsubscribed_at := old.unsubscribed_at;
  new.topic_quota := old.topic_quota;
  new.created_at := old.created_at;
  new.bounced_at := old.bounced_at;
  new.complained_at := old.complained_at;
  return new;
end$$;

-- Structural redelivery dedup, same pattern as stripe_webhook_events
-- (20260805160000) -- Resend/Svix, like Stripe, delivers at-least-once, so
-- any event can arrive twice. email_id + type is the natural dedup key here
-- (Resend doesn't hand webhooks a top-level event id the way Stripe does).
create table public.resend_webhook_events (
  email_id    text not null,
  type        text not null,
  received_at timestamptz default now(),
  primary key (email_id, type)
);

-- Service-role only (the webhook route uses supabaseServiceClient, which
-- bypasses RLS) -- no anon/authenticated access needed or granted.
alter table public.resend_webhook_events enable row level security;
