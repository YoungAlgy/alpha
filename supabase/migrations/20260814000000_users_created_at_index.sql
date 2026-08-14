-- Found in round 24's fresh-angle audit (2026-08-14). GET /api/admin/users
-- (app/api/admin/users/route.ts) always orders by
-- `.order("created_at", { ascending: false })` and paginates with
-- `.lt("created_at", before).limit(200)` on the exact same column, but no
-- migration has ever indexed public.users.created_at -- every admin list
-- load and every "load more" page forces a full sequential scan plus an
-- in-memory sort. Same growth exposure the 2026-08-06 and 2026-08-07 index
-- migrations already called out by name for this table (handle_new_user()
-- inserts a row for every auth signup, not just paying subscribers, so the
-- table grows faster than the admin's actual working set). This closes the
-- one remaining hot query pattern on public.users with zero index support.
create index if not exists users_created_at_idx
  on public.users (created_at desc);
