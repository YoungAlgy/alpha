-- 2026-06-10 — schema-drift repair: unsubscribed_at
--
-- The unsubscribed_at column has existed on the LIVE database for weeks (the
-- unsubscribe endpoint, weekly cron filter, admin stats, and the 20260524
-- security trigger all read/write it, and all work in production) but it was
-- added out-of-band and never captured as a migration. A fresh environment
-- built from this folder would be missing it and those four code paths would
-- fail. Idempotent: a no-op against the live DB.

alter table public.users
  add column if not exists unsubscribed_at timestamptz;
