-- 2026-08-05 — schema-drift repair: birthday, gender
--
-- Same class of gap as 20260610000000_users_unsubscribed_at.sql: these two
-- columns have existed on the LIVE database for a while (app/api/cron/weekly-
-- send/route.ts, lib/engine/persist.ts, app/api/account/profile/route.ts, and
-- app/api/admin/users/route.ts all read/write them, and all work in
-- production) but were added out-of-band and never captured as a migration.
-- A fresh environment built from this folder (`supabase db reset`, a staging
-- branch) would be missing both, and the cron's subscriber SELECT would fail
-- outright. Idempotent: a no-op against the live DB if the columns already
-- match.
--
-- Types inferred from application code, not cross-checked against the live
-- schema directly (this session's Supabase MCP connection points at a
-- different/unconnected account than alpha's project, per prior session
-- notes) -- birthday is validated end-to-end as an ISO "YYYY-MM-DD" string
-- (lib/demographics.ts parseBirthday, app/api/generate/route.ts's zod schema)
-- so `date` is the correct semantic type; gender is constrained to exactly
-- "male" | "female" everywhere it's written (lib/demographics.ts coerceGender,
-- the same zod schema). If the live columns turn out to already be typed
-- differently (e.g. birthday as `text`), this migration is safe to skip or
-- adjust -- verify with `select column_name, data_type from
-- information_schema.columns where table_name = 'users'` before relying on it
-- for a schema rebuild.

alter table public.users
  add column if not exists birthday date;

alter table public.users
  add column if not exists gender text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_gender_check'
  ) then
    alter table public.users
      add constraint users_gender_check check (gender is null or gender in ('male', 'female'));
  end if;
end $$;
