-- Round 80 access-integrity follow-up: the 20260807000000 policy added the
-- cancellation-window half of reader access, but still treated every users
-- row with cancelled_at NULL as active. Admin free-access revocation clears
-- subscribed_at, so a cancellation-only policy left the revoked reader's
-- authenticated session able to select every existing issue.
--
-- Match lib/access.ts's hasSubscriberAccess(): access was granted
-- (subscribed_at IS NOT NULL) and has not ended (cancelled_at is null or in
-- the future). The tokenized /letter service-role path enforces the same rule
-- explicitly because service-role reads bypass RLS.

drop policy if exists "issues self read" on public.issues;

create policy "issues self read" on public.issues for select using (
  auth.uid() = user_id
  and exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and u.subscribed_at is not null
      and (u.cancelled_at is null or u.cancelled_at > now())
  )
);
