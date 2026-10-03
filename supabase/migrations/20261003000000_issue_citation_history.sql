-- LOCAL PROPOSAL ONLY. This is separate from the current cache-read repair.
-- Apply only in a separately reviewed atomic migration/ledger transaction.
-- Reads existing persisted issue sections, including pending/unfinalized ones.
-- Returns only requested topic IDs, citation URLs and completeness flags.
-- No new reader/query/history rows are stored and no issue content is changed.
-- Finite ceilings: 100000 issues plus one lookahead, 64 sections/issue,
-- 128 items/section, 32 supplementary refs/item and 2000 unique URLs/topic.
-- Crossing a ceiling preserves bounded known refs but reports complete=false.
-- A global 14-day scan repeated per reader remains a scale/cost limitation.

-- The existing (user_id, week_of DESC) index cannot lead a global date-window
-- read. The leading date plus stable ID supports window scan and lookahead.
-- Cost: one additional date/ID B-tree entry and maintenance per issue write.
-- Ordinary CREATE INDEX also takes a write-blocking lock while it is built.
create index if not exists alpha_issue_citation_history_week_idx
  on public.issues (week_of, id);

create or replace function public.get_alpha_issue_citation_history(
  p_topic_ids text[], p_since date, p_before date
)
returns table (topic_id text, urls text[], complete boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_topic_ids is null
     or array_ndims(p_topic_ids) is distinct from 1
     or cardinality(p_topic_ids) not between 1 and 64
     or p_since is null or p_before is null
     or not isfinite(p_since) or not isfinite(p_before)
     or p_before - p_since not between 1 and 14
     or exists (
       select 1 from unnest(p_topic_ids) as t(id)
        where id is null or char_length(id) not between 1 and 512
           or octet_length(id) > 2048
           -- Match the reader's exact String.trim() boundary, including
           -- Unicode space separators and the byte-order-mark character.
           or btrim(id, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> id
           or id ~ '[[:cntrl:]]'
     ) then
    raise exception 'citation history request invalid' using errcode = '22023';
  end if;

  return query
  with requested as materialized (
    select distinct t.id from unnest(p_topic_ids) as t(id)
  ), issue_pool as materialized (
    select i.id, i.sections from public.issues i
     where i.week_of >= p_since and i.week_of < p_before
     order by i.week_of, i.id
     limit 100001
  ), scanned as materialized (
    select p.id, p.sections from issue_pool p limit 100000
  ), raw_sections as materialized (
    select s.sections -> e.position as section from scanned s
    -- Bound index expansion before visiting JSON values, rather than filtering
    -- a full jsonb_array_elements expansion after it already happened.
    cross join lateral generate_series(0,
      case when jsonb_typeof(s.sections) = 'array'
           then least(jsonb_array_length(s.sections),64) - 1 else -1 end
    ) as e(position)
  ), global_state as (
    select
      (select count(*) from issue_pool) > 100000
      or exists (
        select 1 from scanned s
         where jsonb_typeof(s.sections) is distinct from 'array'
            or case when jsonb_typeof(s.sections) = 'array'
                    then jsonb_array_length(s.sections) not between 1 and 64 else false end
      )
      or exists (
        select 1 from raw_sections s
         where jsonb_typeof(s.section) is distinct from 'object'
            or jsonb_typeof(s.section -> 'topicId') is distinct from 'string'
            or char_length(coalesce(s.section ->> 'topicId', '')) not between 1 and 512
            or octet_length(s.section ->> 'topicId') > 2048
            or btrim(s.section ->> 'topicId', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> s.section ->> 'topicId'
            or (s.section ->> 'topicId') ~ '[[:cntrl:]]'
      ) as incomplete
  ), topic_sections as materialized (
    select s.section ->> 'topicId' as topic, s.section,
      not coalesce(
        jsonb_typeof(s.section -> 'topicLabel') = 'string'
        and jsonb_typeof(s.section -> 'intro') = 'string'
        and jsonb_typeof(s.section -> 'items') = 'array'
        and case when jsonb_typeof(s.section -> 'items') = 'array'
                 then jsonb_array_length(s.section -> 'items') between 1 and 128 else false end,
        false
      ) as incomplete
    from raw_sections s join requested r on r.id = s.section ->> 'topicId'
  ), items as materialized (
    select s.topic, e.item,
      not coalesce(
        jsonb_typeof(e.item) = 'object'
        and jsonb_typeof(e.item -> 'kind') = 'string'
        and e.item ->> 'kind' in ('read','watch','listen','try','post','book','event','note')
        and jsonb_typeof(e.item -> 'headline') = 'string'
        and (e.item ->> 'headline') ~ '[^[:space:]]'
        and jsonb_typeof(e.item -> 'body') = 'string'
        and (e.item ->> 'body') ~ '[^[:space:]]'
        and (not (e.item ? 'source') or jsonb_typeof(e.item -> 'source') = 'string')
        and (not (e.item ? 'supplementaryRefs') or (
          jsonb_typeof(e.item -> 'supplementaryRefs') = 'array'
          and case when jsonb_typeof(e.item -> 'supplementaryRefs') = 'array'
                   then jsonb_array_length(e.item -> 'supplementaryRefs') <= 32 else false end
        )), false
      ) as incomplete
    from topic_sections s
    cross join lateral generate_series(0,
      case when jsonb_typeof(s.section -> 'items') = 'array'
           then least(jsonb_array_length(s.section -> 'items'),128) - 1 else -1 end
    ) as idx(position)
    cross join lateral (select (s.section -> 'items') -> idx.position as item) as e
  ), refs as materialized (
    select i.topic, i.item -> 'primaryRef' as ref from items i where i.item ? 'primaryRef'
    union all
    select i.topic, (i.item -> 'supplementaryRefs') -> e.position as ref from items i
    cross join lateral generate_series(0,
      case when jsonb_typeof(i.item -> 'supplementaryRefs') = 'array'
           then least(jsonb_array_length(i.item -> 'supplementaryRefs'),32) - 1 else -1 end
    ) as e(position)
    union all
    -- Legacy DigestItem links are still rendered. A source name without a
    -- link is valid, while malformed source/sourceUrl fields are incomplete.
    select i.topic, jsonb_build_object(
      'label', case when jsonb_typeof(i.item -> 'source') = 'string'
                        and (i.item ->> 'source') ~ '[^[:space:]]'
                   then i.item ->> 'source' else 'Legacy source' end,
      'url', i.item -> 'sourceUrl'
    ) as ref from items i where i.item ? 'sourceUrl'
  ), ref_state as materialized (
    select r.topic, r.ref ->> 'url' as url,
      coalesce(
        jsonb_typeof(r.ref) = 'object'
        and jsonb_typeof(r.ref -> 'url') = 'string'
        and char_length(r.ref ->> 'url') between 1 and 2048
        -- Conservative absolute HTTP(S) URL syntax. Application consumers
        -- must still run normalizeUrl before using an exclusion identity.
        and (r.ref ->> 'url') ~* '^https?://[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?([/?#][^[:space:][:cntrl:]<>]*)?$',
        false
      ) as usable_url,
      not coalesce(
        jsonb_typeof(r.ref) = 'object'
        and jsonb_typeof(r.ref -> 'label') = 'string'
        and (r.ref ->> 'label') ~ '[^[:space:]]'
        and (not (r.ref ? 'note') or jsonb_typeof(r.ref -> 'note') in ('string','null')),
        false
      ) as incomplete_shape
    from refs r
  ), distinct_urls as materialized (
    select distinct r.topic, r.url from ref_state r where r.usable_url
  ), numbered_urls as (
    select d.topic, d.url, row_number() over (partition by d.topic order by d.url) as position
      from distinct_urls d
  ), url_lists as (
    select n.topic,
      coalesce(array_agg(n.url order by n.url) filter (where n.position <= 2000), '{}'::text[]) as urls,
      count(*) > 2000 as overflow
    from numbered_urls n group by n.topic
  ), incomplete_topics as (
    select s.topic from topic_sections s where s.incomplete
    union
    select i.topic from items i where i.incomplete
    union
    select r.topic from ref_state r where not r.usable_url or r.incomplete_shape
  )
  select r.id, coalesce(u.urls, '{}'::text[]),
    not (g.incomplete or coalesce(u.overflow, false)
         or exists (select 1 from incomplete_topics t where t.topic = r.id))
    from requested r cross join global_state g
    left join url_lists u on u.topic = r.id
   order by r.id;
end;
$$;

revoke all on function public.get_alpha_issue_citation_history(text[],date,date)
  from public, anon, authenticated;
grant execute on function public.get_alpha_issue_citation_history(text[],date,date)
  to service_role;

comment on function public.get_alpha_issue_citation_history(text[],date,date) is
  'Private read-only bounded citation aggregate from persisted prior issue sections. Completeness is false on malformed or capped history. No delivery proof is inferred.';
