-- Local default-off draft. Does not authorize managed installation.
-- Require the current exact thirteen identities. Never install another source.
lock table public.alpha_public_source_circuits in share row exclusive mode;
do $$
declare
  v_prior constant text[] := array[
    'ccmixter-uploads', 'crossref-research', 'federal-register-finance',
    'gdelt', 'global-voices-rss', 'google-rss', 'govuk-news', 'openalex-research',
    'plos-research', 'publisher-fda-medwatch', 'publisher-fed-speeches',
    'publisher-nist', 'statcan-labour'
  ];
  v_rows text[];
  v_constraint text[];
  v_definition text;
  v_literals text;
begin
  select array_agg(provider order by provider) into v_rows
    from public.alpha_public_source_circuits where provider <> 'cdm-music';
  if v_rows is distinct from v_prior then
    raise exception 'CDM migration requires exact prior source identities';
  end if;
  select array_agg(parts[1] order by parts[1]) into v_constraint
    from pg_constraint c,
         lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') parts
   where c.conrelid = 'public.alpha_public_source_circuits'::regclass
     and c.conname = 'alpha_public_source_circuits_provider_check'
     and c.contype = 'c' and c.convalidated;
  if array_remove(v_constraint, 'cdm-music') is distinct from v_rows or
     cardinality(v_constraint) not in (cardinality(v_rows), cardinality(v_rows) + 1) then
    raise exception 'CDM migration found an unexpected provider constraint';
  end if;
  select pg_get_constraintdef(c.oid) into strict v_definition
    from pg_constraint c
   where c.conrelid = 'public.alpha_public_source_circuits'::regclass
     and c.conname = 'alpha_public_source_circuits_provider_check'
     and c.contype = 'c' and c.convalidated;
  if regexp_replace(v_definition, '''[^'']+''::text', '@', 'g')
       is distinct from 'CHECK ((provider = ANY (ARRAY[' ||
         array_to_string(array_fill('@'::text, array[cardinality(v_constraint)]), ', ')
         || '])))' then
    raise exception 'CDM migration found an unexpected provider constraint shape';
  end if;
  select string_agg(quote_literal(provider), ', ' order by provider) into v_literals
    from unnest(v_rows || array['cdm-music']::text[]) as identities(provider);
  alter table public.alpha_public_source_circuits drop constraint alpha_public_source_circuits_provider_check;
  execute 'alter table public.alpha_public_source_circuits add constraint alpha_public_source_circuits_provider_check check (provider in (' || v_literals || '))';
  insert into public.alpha_public_source_circuits (provider) values ('cdm-music') on conflict (provider) do nothing;
end;
$$;
