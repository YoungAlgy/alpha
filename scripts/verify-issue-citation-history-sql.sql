-- LOCAL DISPOSABLE DATABASE ONLY. Requires a superuser and an empty public
-- schema without public.issues. Creates inert fixtures, includes the proposed
-- migration, verifies the contract and rolls back every table/function/index.
-- No managed database, environment values, private records or network calls.
\set ON_ERROR_STOP on
begin;

do $$
begin
  if to_regclass('public.issues') is not null then
    raise exception 'citation fixture requires an empty disposable database';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end;
$$;
create table public.issues (
  id bigint generated always as identity primary key,
  week_of date not null,
  sections jsonb not null,
  delivered_at timestamptz,
  resend_message_id text,
  brevo_message_id text
);
alter table public.issues enable row level security;
revoke all on public.issues from public, anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

\ir ../supabase/migrations/20261003000000_issue_citation_history.sql

-- Pending/unfinalized issues deliberately have no delivery stamp or ID.
insert into public.issues (week_of, sections) values
('2026-10-02', '[{"topicId":"ai-news","topicLabel":"Generic topic","intro":"Generic intro","items":[{"kind":"read","headline":"Generic headline","body":"Generic excerpt","primaryRef":{"label":"Generic source","url":"https://example.test/old"},"supplementaryRefs":[{"label":"Generic source","url":"https://example.test/shared","note":null}]}]}]'),
('2026-10-02', '[{"topicId":"ai-news","topicLabel":"Generic topic","intro":"Generic intro","items":[{"kind":"note","headline":"Generic headline","body":"Generic excerpt"},{"kind":"read","headline":"Generic headline","body":"Generic excerpt","primaryRef":{"label":"Generic source","url":"https://example.test/shared"}}]}]'),
('2026-10-03', '[{"topicId":"ai-news","topicLabel":"Generic topic","intro":"Generic intro","items":[{"kind":"read","headline":"Generic headline","body":"Generic excerpt","primaryRef":{"label":"Generic source","url":"https://example.test/today"}}]}]'),
('2026-09-18', '[{"topicId":"ai-news","topicLabel":"Generic topic","intro":"Generic intro","items":[{"kind":"read","headline":"Generic headline","body":"Generic excerpt","primaryRef":{"label":"Generic source","url":"https://example.test/outside"}}]}]'),
('2026-10-02', '[{"topicId":"music","topicLabel":"Generic topic","intro":"Generic intro","items":[{}, {"kind":"read","headline":"Generic headline","body":"Generic excerpt","primaryRef":{"label":"Generic source","url":"https://example.test/known"},"supplementaryRefs":[null]}]}]'),
('2026-09-20', '[null, {"topicId":"ai-news","topicLabel":"Generic topic","intro":"Generic intro","items":[{"kind":"read","headline":"Generic headline","body":"Generic excerpt","primaryRef":{"label":"Generic source","url":"https://example.test/preserved"}}]}]'),
('2026-09-21', '{}');

-- Legacy links remain part of persisted/rendered history. A source name alone
-- is valid linkless metadata, and sourceUrl needs no supplied display label.
insert into public.issues (week_of, sections) values
('2026-10-02', '[{"topicId":"legacy","topicLabel":"Generic topic","intro":"Generic intro","items":[{"kind":"read","headline":"Generic headline","body":"Generic excerpt","source":"Generic publisher","sourceUrl":"https://example.test/legacy-a"},{"kind":"read","headline":"Generic headline","body":"Generic excerpt","sourceUrl":"https://example.test/legacy-b"},{"kind":"note","headline":"Generic headline","body":"Generic excerpt","source":"Generic publisher"}]}]');
insert into public.issues (week_of, sections)
select '2026-10-02'::date, jsonb_build_array(jsonb_build_object(
  'topicId','bad-legacy-' || n,'topicLabel','Generic topic','intro','Generic intro',
  'items',jsonb_build_array(jsonb_build_object('kind','read','headline','Generic headline','body','Generic excerpt',
    'primaryRef',jsonb_build_object('label','Generic source','url','https://example.test/legacy-kept-' || n)) || bad)))
from (values
  (1,'{"source":42,"sourceUrl":"https://example.test/legacy-known"}'::jsonb),
  (2,'{"source":"Generic publisher","sourceUrl":42}'::jsonb),
  (3,'{"source":42}'::jsonb),
  (4,'{"sourceUrl":"javascript:genericFixture()"}'::jsonb),
  (5,'{"sourceUrl":null}'::jsonb)
) as t(n,bad);

-- Invalid opaque IDs cannot safely bind a section to an unrelated topic.
-- Keep a known requested citation while conservatively marking it incomplete.
insert into public.issues (week_of, sections)
select '2026-09-26'::date, jsonb_build_array(
  jsonb_build_object('topicId',U&'\00A0generic','topicLabel','Generic topic','intro','Generic intro',
    'items',jsonb_build_array(jsonb_build_object('kind','note','headline','Generic headline','body','Generic excerpt'))),
  jsonb_build_object('topicId','ai-news','topicLabel','Generic topic','intro','Generic intro',
    'items',jsonb_build_array(jsonb_build_object('kind','read','headline','Generic headline','body','Generic excerpt',
      'primaryRef',jsonb_build_object('label','Generic source','url','https://example.test/invalid-bound-kept')))));

-- Validly bound topic/section overflows preserve early known URLs, while an
-- empty issue-section array is not equivalent to no prior issue rows.
insert into public.issues (week_of, sections) values ('2026-09-22','[]');
insert into public.issues (week_of, sections)
select '2026-09-23'::date, jsonb_agg(jsonb_build_object(
  'topicId','ai-news','topicLabel','Generic topic','intro','Generic intro',
  'items',jsonb_build_array(jsonb_build_object('kind','read','headline','Generic headline','body','Generic excerpt',
    'primaryRef',jsonb_build_object('label','Generic source','url','https://example.test/section-' || n)))) order by n)
from generate_series(1,65) as t(n);
insert into public.issues (week_of, sections)
select '2026-09-24'::date, jsonb_build_array(jsonb_build_object(
  'topicId','ai-news','topicLabel','Generic topic','intro','Generic intro',
  'items',jsonb_agg(jsonb_build_object('kind','read','headline','Generic headline','body','Generic excerpt',
    'primaryRef',jsonb_build_object('label','Generic source','url','https://example.test/item-' || n)) order by n)))
from generate_series(1,129) as t(n);
insert into public.issues (week_of, sections)
select '2026-09-25'::date, jsonb_build_array(jsonb_build_object(
  'topicId','ai-news','topicLabel','Generic topic','intro','Generic intro',
  'items',jsonb_build_array(jsonb_build_object('kind','read','headline','Generic headline','body','Generic excerpt',
    'primaryRef',jsonb_build_object('label','Generic source','url','https://example.test/ref-primary'),
    'supplementaryRefs',jsonb_agg(jsonb_build_object('label','Generic source','url','https://example.test/ref-' || n) order by n)))))
from generate_series(1,33) as t(n);

-- 2001 distinct URLs for one topic must retain at most 2000 and mark only that
-- topic incomplete. Each issue remains within the ordinary structural bounds.
insert into public.issues (week_of, sections)
select '2026-10-02'::date, jsonb_build_array(jsonb_build_object(
  'topicId','overflow','topicLabel','Generic topic','intro','Generic intro',
  'items',jsonb_build_array(jsonb_build_object('kind','read','headline','Generic headline','body','Generic excerpt',
    'primaryRef',jsonb_build_object('label','Generic source','url','https://example.test/overflow-' || n)))))
from generate_series(1,2001) as t(n);

-- Relevant malformed reference shapes must retain known valid refs, but never
-- call the topic complete. An unrelated malformed topic cannot poison ai-news.
insert into public.issues (week_of, sections)
select '2026-10-02'::date, jsonb_build_array(jsonb_build_object(
  'topicId','bad-ref-' || n,'topicLabel','Generic topic','intro','Generic intro',
  'items',jsonb_build_array(jsonb_build_object('kind','read','headline','Generic headline','body','Generic excerpt',
    'primaryRef',jsonb_build_object('label','Generic source','url','https://example.test/kept-' || n),
    'supplementaryRefs',jsonb_build_array(bad)))))
from (values (1,null::jsonb), (2,'{"label":"Generic source","url":42}'::jsonb),
  (3,'{"label":"Generic source","url":"javascript:genericFixture()"}'::jsonb),
  (4,'{"label":42,"url":"https://example.test/known-invalid-label"}'::jsonb)) as t(n,bad);

-- An isolated day contains only valid linkless sections. Exactly 100000 prior
-- rows is complete, while the extra lookahead row alone makes it incomplete.
-- Malformed fixtures on other dates cannot cause this result independently.
insert into public.issues (week_of, sections)
select '2026-09-10'::date, '[{"topicId":"row-cap","topicLabel":"Generic topic","intro":"Generic intro","items":[{"kind":"note","headline":"Generic headline","body":"Generic excerpt"}]}]'::jsonb
from generate_series(1,100000);
do $$
declare v_row record;
begin
  select * into v_row from public.get_alpha_issue_citation_history(array['row-cap'],'2026-09-10','2026-09-11');
  if not v_row.complete or cardinality(v_row.urls) <> 0 then
    raise exception 'exact issue row ceiling counted as incomplete';
  end if;
end;
$$;
insert into public.issues (week_of, sections) values
('2026-09-10', '[{"topicId":"row-cap","topicLabel":"Generic topic","intro":"Generic intro","items":[{"kind":"note","headline":"Generic headline","body":"Generic excerpt"}]}]');

create function public.citation_fixture_reject_issue_write() returns trigger language plpgsql as $$
begin raise exception 'citation aggregate attempted a write'; end;
$$;
create trigger citation_fixture_no_writes before insert or update or delete on public.issues
for each statement execute function public.citation_fixture_reject_issue_write();

do $$
declare
  v_row record;
  v_role name;
  v_count integer;
  v_before text;
  v_after text;
  v_message text;
  v_ids text[];
  v_dates date[];
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.get_alpha_issue_citation_history(text[],date,date)'::regprocedure
      and p.provolatile = 's' and p.prosecdef
      and 'search_path=public, pg_temp' = any(p.proconfig)) then
    raise exception 'citation aggregate volatility, definer or path mismatch';
  end if;
  if has_function_privilege('anon','public.get_alpha_issue_citation_history(text[],date,date)','execute')
     or has_function_privilege('authenticated','public.get_alpha_issue_citation_history(text[],date,date)','execute')
     or not has_function_privilege('service_role','public.get_alpha_issue_citation_history(text[],date,date)','execute') then
    raise exception 'citation aggregate execute privilege mismatch';
  end if;
  foreach v_role in array array['anon'::name,'authenticated'::name,'service_role'::name] loop
    if has_table_privilege(v_role,'public.issues','select')
       or has_table_privilege(v_role,'public.issues','insert')
       or has_table_privilege(v_role,'public.issues','update')
       or has_table_privilege(v_role,'public.issues','delete') then
      raise exception 'citation fixture unexpectedly granted direct issue access';
    end if;
  end loop;
  select md5(jsonb_agg(to_jsonb(i) order by i.id)::text) into v_before from public.issues i;

  select count(*) into v_count from public.get_alpha_issue_citation_history(array['ai-news','ai-news','music','empty','overflow'],'2026-10-02','2026-10-03');
  if v_count <> 4 then raise exception 'citation topic deduplication failed'; end if;
  select * into v_row from public.get_alpha_issue_citation_history(array['ai-news'],'2026-10-02','2026-10-03');
  if not v_row.complete or v_row.urls is distinct from array['https://example.test/old','https://example.test/shared'] then
    raise exception 'pending citations, deduplication, date fence or topic isolation failed';
  end if;
  select * into v_row from public.get_alpha_issue_citation_history(array['empty'],'2026-10-02','2026-10-03');
  if not v_row.complete or cardinality(v_row.urls) <> 0 then raise exception 'verified empty citation history failed'; end if;
  select * into v_row from public.get_alpha_issue_citation_history(array['legacy'],'2026-10-02','2026-10-03');
  if not v_row.complete or v_row.urls is distinct from array['https://example.test/legacy-a','https://example.test/legacy-b'] then
    raise exception 'legacy citation links or linkless source handling failed';
  end if;
  for v_count in 1..5 loop
    select * into v_row from public.get_alpha_issue_citation_history(array['bad-legacy-' || v_count],'2026-10-02','2026-10-03');
    if v_row.complete or not (('https://example.test/legacy-kept-' || v_count) = any(v_row.urls)) then
      raise exception 'malformed legacy history lost known citations';
    end if;
    if v_count = 1 and not ('https://example.test/legacy-known' = any(v_row.urls)) then
      raise exception 'malformed legacy source erased its valid URL';
    end if;
  end loop;
  select * into v_row from public.get_alpha_issue_citation_history(array['music'],'2026-10-02','2026-10-03');
  if v_row.complete or not ('https://example.test/known' = any(v_row.urls)) then raise exception 'malformed topic lost known citations'; end if;
  select * into v_row from public.get_alpha_issue_citation_history(array['overflow'],'2026-10-02','2026-10-03');
  if v_row.complete or cardinality(v_row.urls) <> 2000 then raise exception 'citation URL ceiling failed'; end if;
  for v_count in 1..4 loop
    select * into v_row from public.get_alpha_issue_citation_history(array['bad-ref-' || v_count],'2026-10-02','2026-10-03');
    if v_row.complete or not (('https://example.test/kept-' || v_count) = any(v_row.urls)) then raise exception 'malformed citation reference failed'; end if;
  end loop;
  select * into v_row from public.get_alpha_issue_citation_history(array['ai-news'],'2026-09-20','2026-09-21');
  if v_row.complete or not ('https://example.test/preserved' = any(v_row.urls)) then raise exception 'unbound section completeness failed'; end if;
  select * into v_row from public.get_alpha_issue_citation_history(array['empty'],'2026-09-21','2026-09-22');
  if v_row.complete then raise exception 'malformed issue sections counted as empty'; end if;
  select * into v_row from public.get_alpha_issue_citation_history(array['empty'],'2026-09-22','2026-09-23');
  if v_row.complete then raise exception 'empty issue sections counted as complete history'; end if;
  select * into v_row from public.get_alpha_issue_citation_history(array['ai-news'],'2026-09-23','2026-09-24');
  if v_row.complete or cardinality(v_row.urls) <> 64 then raise exception 'section ceiling lost bounded known citations'; end if;
  select * into v_row from public.get_alpha_issue_citation_history(array['ai-news'],'2026-09-24','2026-09-25');
  if v_row.complete or cardinality(v_row.urls) <> 128 then raise exception 'item ceiling lost bounded known citations'; end if;
  select * into v_row from public.get_alpha_issue_citation_history(array['ai-news'],'2026-09-25','2026-09-26');
  if v_row.complete or cardinality(v_row.urls) <> 33 then raise exception 'reference ceiling lost bounded known citations'; end if;
  select * into v_row from public.get_alpha_issue_citation_history(array['ai-news'],'2026-09-26','2026-09-27');
  if v_row.complete or not ('https://example.test/invalid-bound-kept' = any(v_row.urls)) then
    raise exception 'invalid opaque section ID was treated as bound history';
  end if;
  select * into v_row from public.get_alpha_issue_citation_history(array['row-cap'],'2026-09-10','2026-09-11');
  if v_row.complete or cardinality(v_row.urls) <> 0 then
    raise exception 'issue row lookahead ceiling failed';
  end if;

  foreach v_ids slice 1 in array array[
    array[null::text], array[''], array[' generic'], array[repeat('x',513)], array[E'generic\nprivate-marker'],
    array[U&'\00A0generic'], array[U&'generic\FEFF'], array[U&'\2000']
  ] loop
    begin
      perform * from public.get_alpha_issue_citation_history(v_ids,'2026-10-02','2026-10-03');
      raise exception using errcode='P0002', message='invalid citation request accepted';
    exception when invalid_parameter_value then
      get stacked diagnostics v_message = message_text;
      if v_message <> 'citation history request invalid' then raise exception 'citation request leaked details'; end if;
    end;
  end loop;
  for v_count in 1..4 loop
    v_ids := case v_count when 1 then null::text[] when 2 then '{}'::text[]
      when 3 then array(select 'generic-' || n from generate_series(1,65) as t(n))
      else array[array['generic','other'],array['third','fourth']] end;
    begin
      perform * from public.get_alpha_issue_citation_history(v_ids,'2026-10-02','2026-10-03');
      raise exception using errcode='P0002', message='invalid citation topic cardinality accepted';
    exception when invalid_parameter_value then
      get stacked diagnostics v_message = message_text;
      if v_message <> 'citation history request invalid' then raise exception 'citation cardinality leaked details'; end if;
    end;
  end loop;
  for v_count in 1..4 loop
    v_dates := case v_count when 1 then array['2026-10-03'::date,'2026-10-03'::date]
      when 2 then array['2026-10-04'::date,'2026-10-03'::date]
      when 3 then array['2026-09-18'::date,'2026-10-03'::date]
      else array[null::date,'2026-10-03'::date] end;
    begin
      perform * from public.get_alpha_issue_citation_history(array['generic'],v_dates[1],v_dates[2]);
      raise exception using errcode='P0002', message='invalid citation date accepted';
    exception when invalid_parameter_value then
      get stacked diagnostics v_message = message_text;
      if v_message <> 'citation history request invalid' then raise exception 'citation date leaked details'; end if;
    end;
  end loop;
  select md5(jsonb_agg(to_jsonb(i) order by i.id)::text) into v_after from public.issues i;
  if v_after is distinct from v_before then raise exception 'citation aggregate mutated issue state'; end if;
end;
$$;

-- Actual invoker denial supplements ACL inspection. Fixture errors use only
-- fixed generic messages, never supplied IDs, bodies or custom request text.
do $$
declare v_role name;
begin
  foreach v_role in array array['anon'::name,'authenticated'::name] loop
    execute format('set local role %I',v_role);
    begin
      perform * from public.get_alpha_issue_citation_history(array['generic'],'2026-10-02','2026-10-03');
      raise exception using errcode='P0002', message='non-service citation call accepted';
    exception when insufficient_privilege then null;
    end;
    execute 'reset role';
  end loop;
end;
$$;
set local role service_role;
select topic_id, cardinality(urls) as citation_count, complete
from public.get_alpha_issue_citation_history(array['ai-news','empty'],'2026-10-02','2026-10-03');
reset role;
rollback;
