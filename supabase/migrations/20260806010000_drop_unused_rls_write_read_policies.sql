-- alpha · drop unused/overly-open RLS policies + tighten a helper's EXECUTE grant
-- Round-10 fresh-angle audit, 2026-08-06.

-- "topic_blurbs public read" (select using (true), no `to` clause) applies to
-- BOTH anon and authenticated. topic_blurbs.items/intro is the AI-generated
-- newsletter content -- the paid $5/mo product payload. The app reads this
-- table exclusively via supabaseServiceClient() (lib/engine/blurb-cache.ts,
-- all 3 call sites, verified) -- no browser-client code anywhere touches it
-- (verified via repo-wide grep). This public-read policy served no purpose
-- the app needs and let anyone holding the publishable key read every
-- week's full paid content via GET /rest/v1/topic_blurbs?select=* with no
-- signup and no Stripe subscription -- a real paywall bypass.
drop policy if exists "topic_blurbs public read" on public.topic_blurbs;

-- "users self insert" (with check (auth.uid() = id)) restricts WHICH row a
-- signed-in user can insert but not what values go into it.
-- protect_user_privileged_columns (20260524000000_security_user_column_lock)
-- is a BEFORE UPDATE trigger only -- it never fires on INSERT, so nothing
-- pins subscribed_at/cancelled_at/stripe_customer_id/topic_quota on a direct
-- insert. Both real INSERT paths into public.users
-- (lib/engine/persist.ts:108, app/api/stripe/webhook/route.ts:158) use
-- supabaseServiceClient() (verified) -- this policy has zero legitimate
-- caller. handle_new_user()'s SECURITY DEFINER trigger on auth.users is the
-- only row-creation path the app relies on. Without this policy, a signed-in
-- user whose public.users row is somehow missing could otherwise POST
-- directly to /rest/v1/users with their own id plus arbitrary
-- subscribed_at/stripe_customer_id/topic_quota and grant themselves a paid
-- subscription with zero Stripe involvement. Matches the established
-- pattern of dropping unused RLS write policies with no legitimate caller
-- (issues insert/update dropped in 20260701055830_drop_unused_issues_write_policies.sql;
-- support_tickets insert dropped in 20260805110000_drop_unused_support_tickets_insert_policy.sql).
drop policy if exists "users self insert" on public.users;

-- topics_all_valid(text[]) backs the users_topics_valid_chk CHECK constraint
-- (20260805170000_users_topics_catalog_check.sql) but was left on the
-- default open EXECUTE grant, unlike this same migration wave's other two
-- helpers (watchdog_delivery_check, prior_issue_counts), which both
-- explicitly revoke PUBLIC execute. A CHECK constraint runs under the
-- constraint owner's privileges regardless of the calling role's own grants,
-- so revoking this has no functional impact on the constraint itself -- it
-- only closes the ability for any anon/authenticated caller to invoke it
-- directly via POST /rest/v1/rpc/topics_all_valid.
--
-- Revoking from `public` alone is NOT enough -- confirmed live (2026-08-06)
-- that Supabase grants EXECUTE to `anon`/`authenticated` directly at
-- function-creation time, not merely via PUBLIC membership, so each role
-- needs its own explicit revoke. Matches the 3-statement pattern
-- watchdog_delivery_check's and prior_issue_counts's own migrations already
-- use for exactly this reason.
revoke all on function public.topics_all_valid(text[]) from public;
revoke all on function public.topics_all_valid(text[]) from authenticated;
revoke all on function public.topics_all_valid(text[]) from anon;
