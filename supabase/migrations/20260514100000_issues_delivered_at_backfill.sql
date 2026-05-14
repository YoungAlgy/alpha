-- 2026-05-14 — backfill issues.delivered_at so the new idempotency gate in
-- /alpha/api/cron/weekly-send and /alpha/api/generate doesn't re-send any
-- letter that already went out for a prior week.
--
-- Context: before today the cron upserted issues without stamping
-- delivered_at after a successful send, so re-triggering the endpoint sent
-- another email. One user got hit five times in a single week. The fix
-- short-circuits when delivered_at is set; this backfill marks every
-- existing row as "already delivered" so we don't re-send historical weeks.

update public.issues
set delivered_at = coalesce(delivered_at, now())
where delivered_at is null;

-- Helpful index for the cron's per-user-per-week idempotency lookup.
-- (Existing unique(user_id, week_of) covers it, but a partial index on
--  delivered_at IS NULL would speed up "who haven't we sent to yet" if we
--  ever switch to a single-query batch. Skipping for now — unique index is
--  fine at our row count.)
