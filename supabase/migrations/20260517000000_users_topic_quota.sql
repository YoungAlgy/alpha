-- 2026-05-17 — users.topic_quota tracks the max number of topics a user can
-- pick, derived from their Stripe subscription quantity. Base $5/5-topic
-- bundle ⇒ quota 5; each $5 add-on bumps quota by 5; cap at 25 (catalog has
-- only 24 distinct topics today so 25 = "all topics").
--
-- Webhook handler in app/api/stripe/webhook/route.ts and the manual update
-- route at app/api/stripe/update-quantity mirror subscription.quantity * 5
-- into this column whenever it changes.

alter table public.users
  add column if not exists topic_quota int not null default 5;

-- Best-effort backfill: anyone with a stripe_customer_id but no explicit
-- quota gets 5 (the base tier). We can't read Stripe state from here so
-- we trust the default. The webhook will overwrite on next subscription
-- event.
update public.users
  set topic_quota = 5
  where topic_quota is null;
