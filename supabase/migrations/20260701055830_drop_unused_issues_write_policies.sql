-- Alpha · drop dead issues INSERT/UPDATE self-policies · 2026-07-01
--
-- The initial schema gave a signed-in reader INSERT/UPDATE on their own
-- `issues` row (auth.uid() = user_id), matching a generic "users own their
-- row" template. Verified via grep across app/**/*.tsx and every server
-- route: the app NEVER writes to issues from a user-session client — every
-- write (cron, /api/generate, /api/admin/users, lib/engine/persist.ts) goes
-- through supabaseServiceClient() (service-role, bypasses RLS). The 3
-- client-facing pages that touch issues (inbox, inbox/[issueId], archive,
-- letter) only ever .select().
--
-- Those two policies have no legitimate caller, so they're pure unused
-- attack surface: with no column restriction, a signed-in reader could call
-- the PostgREST API directly (the anon/publishable key is shipped to the
-- browser for Supabase Auth) and mutate their own delivered_at, sections,
-- editor_intro, week_of, volume, or number — fields the idempotent-delivery
-- logic (lib/letter-delivery.ts, the cron's atomic delivered_at CAS) assumes
-- only server code ever touches. Dropping write access removes that path
-- with zero effect on real functionality (nothing uses it). Read access
-- (`issues self read`) is untouched — every client page needs it.

drop policy if exists "issues self insert" on public.issues;
drop policy if exists "issues self update" on public.issues;
