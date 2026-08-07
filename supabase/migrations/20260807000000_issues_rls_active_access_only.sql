-- alpha-drift-r15-03 (found+fixed 2026-08-07): the "issues self read" RLS
-- policy only ever checked auth.uid() = user_id -- a subscriber's access to
-- their own already-generated letters was NEVER actually gated by
-- cancelled_at anywhere in the stack. lib/access.ts's hasActiveAccess() is
-- documented as "the single source of truth" for whether a subscriber has
-- access right now, but every read path that actually serves letter content
-- to a browser (app/inbox, app/archive, app/inbox/[issueId], all client
-- components querying via the user's own session + this RLS policy) never
-- called it -- only new-content paths (cron, /api/generate, checkout
-- guards) did. Concretely: the charge.dispute.created webhook handler sets
-- cancelled_at = now() and tells the operator "Access revoked immediately"
-- (app/api/stripe/webhook/route.ts), but nothing was actually revoked --
-- the disputing customer's existing session could keep reading every past
-- letter forever.
--
-- Fix: push hasActiveAccess()'s exact rule (cancelled_at IS NULL, or a
-- future date -- a scheduled "cancel at period end" still has access until
-- then) into the RLS policy itself, so it's enforced at the one layer nothing
-- can bypass by forgetting a client-side check. Matches lib/access.ts's own
-- comment that other equivalent expressions of this rule (the cron's
-- PostgREST .or filter) must be kept in sync with it.
--
-- Deliberately does NOT touch service-role reads (app/letter/page.tsx's
-- token-based view, app/api/account/export/route.ts's GDPR export,
-- app/api/admin/users/route.ts): RLS only applies to the anon/authenticated
-- roles those routes don't use, so this migration cannot affect them.
-- app/letter/page.tsx gets its own explicit cancelled_at check in the same
-- commit as this migration, since RLS can't reach it.

drop policy if exists "issues self read" on public.issues;

create policy "issues self read" on public.issues for select using (
  auth.uid() = user_id
  and exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and (u.cancelled_at is null or u.cancelled_at > now())
  )
);
