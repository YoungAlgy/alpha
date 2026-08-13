-- Found in round 19's fresh-angle audit (2026-08-07). GET /api/admin/users
-- runs `usersQuery.ilike("email", `%${q}%`)` for any search -- a
-- leading-wildcard ILIKE cannot use a standard B-tree index (including the
-- implicit unique index Postgres auto-creates for users.email text unique
-- not null), so every admin search forces a full sequential scan of
-- public.users. This is the SAME table the 2026-08-06 index migration
-- (20260806000000_indexes_active_subscriber_and_support_tickets.sql)
-- already flagged as growth-skewed toward non-paying rows ("handle_new_user
-- () inserts a public.users row for every auth signup regardless of
-- whether they ever subscribe... the scan-to-match ratio gets worse over
-- time, not better") -- that fix addressed the cron's active-subscriber
-- filter but never touched this admin search path, which has the identical
-- growth exposure and, unlike the cron's filter, no index support of any
-- kind today. Not urgent at current subscriber counts, but it's the one
-- hot query pattern in the app with zero index support, on the one table
-- already called out by name for this exact risk.
create extension if not exists pg_trgm;

create index if not exists users_email_trgm_idx
  on public.users
  using gin (email gin_trgm_ops);
