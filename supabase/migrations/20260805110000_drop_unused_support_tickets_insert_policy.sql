-- Alpha · drop dead support_tickets anonymous-insert policy · 2026-08-05
--
-- Same class as 20260701055830_drop_unused_issues_write_policies.sql. The
-- initial schema's comment justified `"support tickets anyone insert"` as
-- "Anonymous inserts allowed via the /api/support route using the anon key" --
-- that's no longer true: app/api/support/route.ts writes via
-- supabaseServiceClient() (service role, bypasses RLS entirely), and grep
-- across the codebase turns up no other writer of this table.
--
-- With no legitimate caller, the policy is pure attack surface: the
-- NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is compiled into the client bundle, so
-- anyone can POST directly to /rest/v1/support_tickets with `with check
-- (true)` and skip the route's rate limit (5/IP/hour) and message-length cap
-- (5000 chars) entirely, inserting arbitrarily many arbitrarily large rows
-- into the free-tier Postgres. Dropping it has zero effect on real
-- functionality -- the route never used the anon key for this.

drop policy if exists "support tickets anyone insert" on public.support_tickets;
