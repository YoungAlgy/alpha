-- 2026-08-05 — SECURITY: DB-level validity check on users.topics elements.
--
-- Why: topics is deliberately open to direct browser writes (lib/theme.ts,
-- lib/user-sync.ts) under the "users self update" RLS policy, and
-- users_topics_len_chk (20260524000000) only caps the ARRAY LENGTH. Element
-- VALIDITY -- is each entry a real topic? -- is enforced only in app code
-- (lib/topics.ts's isValidTopicId, checked client-side in user-sync.ts and
-- server-side in /api/account/topics). A signed-in user hitting the Supabase
-- REST API directly with their own JWT (bypassing the app, and thus
-- isValidTopicId, entirely) can write ANY array of up to 25 strings into
-- their own row -- RLS scopes WHICH row, not what's in it. That garbage
-- topic_id would then flow into the weekly generation pipeline
-- (lib/engine/assemble.ts, read by app/api/generate + the cron), which
-- trusts the DB is already clean and has no read-side gate.
--
-- Fix: a CHECK constraint, via a helper function since Postgres forbids
-- subqueries directly inside a CHECK expression, that accepts only "zodiac",
-- a well-formed "custom:<1-80 chars>" topic (mirrors isValidTopicId's shape
-- check; the app's stricter makeCustomTopic-normalized-form check stays
-- app-side only, since that's a display/dedup concern, not a security one),
-- or one of the fixed catalog ids below. The catalog list is a snapshot of
-- TOPICS in lib/topics.ts -- adding a new catalog topic there needs a
-- matching migration here, the same trade-off already accepted for
-- topic_quota's hardcoded tiers. This is a second, independent check on the
-- same column the app validates, not a replacement for it.

create or replace function public.topics_all_valid(topics text[])
returns boolean
language plpgsql
immutable
as $$
declare
  t text;
begin
  if topics is null then
    return true;
  end if;
  foreach t in array topics loop
    if t = 'zodiac' then
      continue;
    end if;
    -- length('custom:') = 7; body must be 1-80 chars (MAX_CUSTOM_TOPIC_LEN).
    if t like 'custom:%' and length(t) between 8 and 87 then
      continue;
    end if;
    if t = any(array[
      'healthcare-recruiting','sales-persuasion','founder-operator','marketing-growth',
      'personal-finance','real-estate','macro-markets',
      'longevity-wellness','nutrition-food','mental-health','womens-health',
      'books-worth-your-time','psychology-behavior','parenting',
      'inspiring-people','movies-tv','music','music-edm','music-hiphop','music-indie','music-country',
      'style-fashion','sports-betting','trading-cards',
      'ai-news','web3-updates',
      'fl-gardening','gardening-plants','sustainable-living','startups-vc',
      'faith-meaning','faith-christianity','faith-islam','faith-judaism','faith-hinduism','faith-buddhism','faith-spiritual'
    ]) then
      continue;
    end if;
    return false;
  end loop;
  return true;
end;
$$;

alter table public.users drop constraint if exists users_topics_valid_chk;
alter table public.users
  add constraint users_topics_valid_chk
  check (public.topics_all_valid(topics));
