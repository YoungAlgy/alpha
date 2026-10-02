-- Local candidate only. Apply in one separately approved transaction with
-- migration ledger recording. No existing outage state, function or ACL changes.
-- Stores one fixed publisher identity, never a topic, query, reader or URL.
alter table public.alpha_public_source_circuits
  drop constraint alpha_public_source_circuits_provider_check;
alter table public.alpha_public_source_circuits
  add constraint alpha_public_source_circuits_provider_check check (provider in (
    'google-rss', 'publisher-nist', 'publisher-fda-medwatch',
    'publisher-fed-speeches', 'global-voices-rss', 'crossref-research',
    'gdelt', 'plos-research'
  ));
insert into public.alpha_public_source_circuits (provider)
values ('plos-research') on conflict (provider) do nothing;
