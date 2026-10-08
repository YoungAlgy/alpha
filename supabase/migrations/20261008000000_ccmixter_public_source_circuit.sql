-- Local default-off candidate. Apply only in a separately approved transaction
-- with migration ledger recording. Preserve existing state, functions and ACLs.
-- One fixed upstream identity. Never a topic, reader, query or result URL.
alter table public.alpha_public_source_circuits
  drop constraint alpha_public_source_circuits_provider_check;
alter table public.alpha_public_source_circuits
  add constraint alpha_public_source_circuits_provider_check check (provider in (
    'google-rss', 'publisher-nist', 'publisher-fda-medwatch',
    'publisher-fed-speeches', 'global-voices-rss', 'crossref-research',
    'gdelt', 'plos-research', 'ccmixter-uploads'
  ));
insert into public.alpha_public_source_circuits (provider)
values ('ccmixter-uploads') on conflict (provider) do nothing;
