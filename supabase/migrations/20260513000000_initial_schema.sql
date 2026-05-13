-- Alpha · initial schema · 2026-05-13
-- RLS on every PII table per S4 locked rule.
-- Auth handled by Supabase Auth (magic-link); auth.users.id is the user pkey.

-- ============================================================
-- users — application profile, 1:1 with auth.users
-- ============================================================
create table public.users (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text unique not null,
  first_name      text,
  city            text,
  job_blurb       text,
  project_blurb   text,
  fun_blurb       text,
  theme           text default 'forest',
  topics          text[] default '{}'::text[],
  stripe_customer_id text,
  subscribed_at   timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table public.users enable row level security;

create policy "users self read"   on public.users for select using (auth.uid() = id);
create policy "users self update" on public.users for update using (auth.uid() = id);
create policy "users self insert" on public.users for insert with check (auth.uid() = id);

-- ============================================================
-- topic_blurbs — shared content per (topic, week_of)
-- Generated once per week per topic, served to all subscribers
-- ============================================================
create table public.topic_blurbs (
  id           bigserial primary key,
  topic_id     text not null,
  week_of      date not null,
  intro        text not null,
  items        jsonb not null,
  generated_at timestamptz default now(),
  unique (topic_id, week_of)
);

create index topic_blurbs_topic_idx on public.topic_blurbs (topic_id);
create index topic_blurbs_week_idx  on public.topic_blurbs (week_of);

-- Anyone (anonymous + authed) can read topic_blurbs; writes are service-role only
alter table public.topic_blurbs enable row level security;
create policy "topic_blurbs public read" on public.topic_blurbs for select using (true);

-- ============================================================
-- issues — each user's weekly letter (personalized wrapper around blurbs)
-- ============================================================
create table public.issues (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  week_of       date not null,
  volume        int default 1,
  number        int default 1,
  editor_intro  text not null,
  sections      jsonb not null,
  delivered_at  timestamptz,
  opened_at     timestamptz,
  created_at    timestamptz default now(),
  unique (user_id, week_of)
);

create index issues_user_idx on public.issues (user_id, week_of desc);

alter table public.issues enable row level security;
create policy "issues self read"   on public.issues for select using (auth.uid() = user_id);
create policy "issues self insert" on public.issues for insert with check (auth.uid() = user_id);
create policy "issues self update" on public.issues for update using (auth.uid() = user_id);

-- ============================================================
-- support_tickets — basic ticket inbox for /support form
-- Service-role only writes; users can see their own tickets via email match.
-- ============================================================
create table public.support_tickets (
  id          bigserial primary key,
  name        text,
  email       text not null,
  message     text not null,
  user_id     uuid references public.users(id) on delete set null,
  status      text default 'open',
  created_at  timestamptz default now()
);

alter table public.support_tickets enable row level security;
-- No SELECT/UPDATE/DELETE policies — only service role can touch.
-- Anonymous inserts allowed via the /api/support route using the anon key.
create policy "support tickets anyone insert" on public.support_tickets for insert with check (true);

-- ============================================================
-- updated_at trigger
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger users_touch_updated_at
  before update on public.users
  for each row execute function public.touch_updated_at();

-- ============================================================
-- handle_new_user — create public.users row when auth.users is created
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
