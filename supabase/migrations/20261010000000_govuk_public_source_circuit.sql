-- Local default-off candidate. Apply only in a separately approved transaction
-- with migration ledger recording. Preserve all ten prior states, RPCs and ACLs.
-- One fixed upstream identity. Never a topic, reader, query or result URL.
lock table public.alpha_public_source_circuits in share row exclusive mode;
do $$
declare
  v_prior constant text[] := array[
    'ccmixter-uploads', 'crossref-research', 'federal-register-finance',
    'gdelt', 'global-voices-rss', 'google-rss', 'plos-research',
    'publisher-fda-medwatch', 'publisher-fed-speeches', 'publisher-nist'
  ];
  v_rows text[];
  v_constraint text[];
  v_definition text;
begin
  select array_agg(provider order by provider) into v_rows
    from public.alpha_public_source_circuits where provider <> 'govuk-news';
  if v_rows is distinct from v_prior then
    raise exception 'GOV.UK migration requires the exact ten prior source identities';
  end if;
  select array_agg(parts[1] order by parts[1]) into v_constraint
    from pg_constraint c,
         lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') parts
   where c.conrelid = 'public.alpha_public_source_circuits'::regclass
     and c.conname = 'alpha_public_source_circuits_provider_check'
     and c.contype = 'c' and c.convalidated;
  if v_constraint is distinct from v_prior and v_constraint is distinct from array[
    'ccmixter-uploads', 'crossref-research', 'federal-register-finance',
    'gdelt', 'global-voices-rss', 'google-rss', 'govuk-news', 'plos-research',
    'publisher-fda-medwatch', 'publisher-fed-speeches', 'publisher-nist'
  ]::text[] then
    raise exception 'GOV.UK migration found an unexpected provider constraint';
  end if;
  -- A matching literal list alone cannot establish the allowed identities.
  -- Reject boolean widening such as the same IN list followed by OR true.
  -- pg_get_constraintdef canonicalizes an IN list to this bounded ANY shape.
  select pg_get_constraintdef(c.oid) into strict v_definition
    from pg_constraint c
   where c.conrelid = 'public.alpha_public_source_circuits'::regclass
     and c.conname = 'alpha_public_source_circuits_provider_check'
     and c.contype = 'c' and c.convalidated;
  if regexp_replace(v_definition, '''[^'']+''::text', '@', 'g')
       is distinct from 'CHECK ((provider = ANY (ARRAY[' ||
         array_to_string(array_fill('@'::text, array[cardinality(v_constraint)]), ', ')
         || '])))' then
    raise exception 'GOV.UK migration found an unexpected provider constraint shape';
  end if;
end;
$$;
alter table public.alpha_public_source_circuits
  drop constraint alpha_public_source_circuits_provider_check;
alter table public.alpha_public_source_circuits
  add constraint alpha_public_source_circuits_provider_check check (provider in (
    'google-rss', 'publisher-nist', 'publisher-fda-medwatch',
    'publisher-fed-speeches', 'global-voices-rss', 'crossref-research',
    'gdelt', 'plos-research', 'ccmixter-uploads', 'federal-register-finance',
    'govuk-news'
  ));
insert into public.alpha_public_source_circuits (provider)
values ('govuk-news') on conflict (provider) do nothing;
