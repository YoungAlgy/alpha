-- Two real index gaps found in the round-6 fresh-angle audit (2026-08-06).
-- Both are free today (~5 real subscribers) and become real cost as the
-- users table grows past marketing/signup leads that never subscribe.

-- The "is this user an active subscriber" filter --
--   subscribed_at is not null and (cancelled_at is null or cancelled_at > now())
--   and unsubscribed_at is null
-- has zero index support. It's the primary WHERE clause of the weekly-send
-- cron's subscriber fetch (app/api/cron/weekly-send/route.ts) AND both
-- subqueries inside watchdog_delivery_check() (called by two separate
-- GitHub Actions crons daily). handle_new_user() inserts a public.users row
-- for every auth signup regardless of whether they ever subscribe, so this
-- table's growth is dominated by leads/free-granted/churned rows, not
-- paying subscribers -- the scan-to-match ratio gets worse over time, not
-- better. cancelled_at > now() can't go in a partial-index WHERE clause
-- (now() isn't immutable), but subscribed_at/unsubscribed_at can -- this
-- narrows to signed-up, non-opted-out rows via index before the remaining
-- cancelled_at check runs against the much smaller matching set.
create index if not exists users_active_candidates_idx
  on public.users (id)
  where subscribed_at is not null and unsubscribed_at is null;

-- support_tickets.user_id is a foreign key to users(id), but Postgres does
-- not auto-index FK columns, and no prior migration added one --
-- support_tickets had only its bigserial primary key. Both delete flows
-- (app/api/account/delete/route.ts, app/api/admin/users/route.ts) do
-- `delete from support_tickets where user_id = $1` on every account
-- deletion; as the table grows (contact-form spam, real tickets over time)
-- each deletion would sequential-scan the whole table to find that user's rows.
create index if not exists support_tickets_user_id_idx
  on public.support_tickets (user_id)
  where user_id is not null;
