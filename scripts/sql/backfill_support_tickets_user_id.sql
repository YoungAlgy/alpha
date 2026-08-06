-- alpha · support_tickets.user_id historical backfill · reviewed 2026-08-06
--
-- NOT a migration -- deliberately NOT auto-applied. This links PII rows to
-- an account by email match, which is a product/privacy judgment call
-- (should an anonymous ticket ever be silently attributed to a signed-in
-- account after the fact?), not a plain correctness bug fix. Written for
-- Algy to read and run himself via the Supabase SQL editor, on his own call.
--
-- Why this exists: app/api/support/route.ts only sets user_id from the
-- CURRENT session at submission time (fixed 2026-08-06, review finding).
-- Before that fix -- and for any signed-out submitter who typed an email
-- that happens to match an existing subscriber -- support_tickets rows were
-- saved with user_id = NULL even though a real public.users row exists for
-- that email. deleteSupportTicketsBeforeDelete (lib/stripe-cancel.ts) keys
-- ONLY on user_id, so these orphaned rows are invisible to it: if that
-- subscriber later deletes their account, their old support tickets are
-- NOT deleted, falling short of the privacy page's "delete your account and
-- all associated data" promise for pre-existing rows specifically.
--
-- Match is case-insensitive + trimmed (support_tickets.email is whatever the
-- submitter typed; public.users.email is stored lowercased by the checkout
-- webhook). public.users.email is effectively unique (backed by Supabase
-- auth), so this can't create an ambiguous one-ticket-to-many-users match.

-- Step 1 — PREVIEW first. Run this alone and read the output before running
-- the UPDATE below. Confirm the row count and a few sample emails look right
-- (no unexpected matches, no email you don't recognize as a real user).
select
  st.id,
  st.email as ticket_email,
  st.created_at,
  u.id as matched_user_id,
  u.email as matched_user_email
from public.support_tickets st
join public.users u on lower(trim(st.email)) = u.email
where st.user_id is null
order by st.created_at desc;

-- Step 2 — the actual backfill. Only run after reviewing Step 1's output.
-- Safe to re-run: the `st.user_id is null` filter means an already-linked
-- row (from a prior run of this script, or from the live route's own
-- session-based linking) is never touched again.
--
-- update public.support_tickets st
-- set user_id = u.id
-- from public.users u
-- where lower(trim(st.email)) = u.email
--   and st.user_id is null;
