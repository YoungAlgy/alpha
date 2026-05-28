-- 2026-05-24 — SECURITY: lock privileged columns on public.users + index
-- stripe_customer_id.
--
-- Why: the "users self update" RLS policy gates WHICH row a user can update
-- (auth.uid() = id) but NOT WHICH columns. With the public publishable key
-- + their own session JWT, a signed-in user could run
--   update users set topic_quota = 25, subscribed_at = now(),
--                    stripe_customer_id = '...' where id = <self>
-- and grant themselves the full topic catalogue + an active subscription
-- without ever paying. This is the same PERMISSIVE-policy / column-scope
-- trap fixed previously on Toggle profiles.role and Ava public_employers.tier
-- (see ~/.claude memory: feedback_code_standards S4).
--
-- Fix: a BEFORE UPDATE trigger that, for any non-service_role caller, pins the
-- billing + identity columns back to their OLD values. Profile fields
-- (first_name, city, theme, topics, *_blurb) remain freely user-editable, so
-- the onboarding sync, topic-picker, and theme-picker keep working. The
-- service_role (server-side secret key: webhook, update-quantity, generate,
-- cron) bypasses the lock and may write anything.
--
-- Verified post-apply via simulated authenticated vs service_role contexts:
--   authenticated update of topic_quota/subscribed_at/stripe_customer_id → reverted
--   authenticated update of theme → applied
--   service_role update of topic_quota → applied

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
  return new;
end$$;

drop trigger if exists protect_user_privileged_columns_trg on public.users;
create trigger protect_user_privileged_columns_trg
  before update on public.users
  for each row execute function public.protect_user_privileged_columns();

-- Webhook + portal + update-quantity look up users by stripe_customer_id.
-- Partial index keeps Stripe-event handling from full-scanning the table.
create index if not exists users_stripe_customer_id_idx
  on public.users (stripe_customer_id)
  where stripe_customer_id is not null;

-- Hard DB cap on topics array length (defense beyond the app-level clamps in
-- the cron + /api/generate). The RLS trigger lets users write the topics
-- column, so without this a crafted browser-client write could set a
-- 1000-element array that the Sunday cron would fan out into that many
-- Claude calls. Cap matches the maximum paid quota (25).
alter table public.users drop constraint if exists users_topics_len_chk;
alter table public.users
  add constraint users_topics_len_chk
  check (topics is null or array_length(topics, 1) <= 25);
