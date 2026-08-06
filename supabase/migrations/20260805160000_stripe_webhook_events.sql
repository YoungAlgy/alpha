-- alpha · stripe_webhook_events — structural redelivery dedup · 2026-08-05
--
-- Today idempotency on Stripe redelivery is emergent: every handler in
-- app/api/stripe/webhook/route.ts happens to do a careful "read existing
-- row, then non-destructive write" that tolerates being run twice. Nothing
-- enforces that discipline -- a future handler added to the switch that
-- does a naive write (blind insert, unconditional counter increment,
-- append-only side effect) would silently double-process on a genuine
-- Stripe redelivery, with no guardrail catching it.
--
-- This table makes dedup structural instead of per-handler-discipline: the
-- route inserts event.id here (ON CONFLICT DO NOTHING) before the switch
-- and short-circuits with 200 if the row already existed.
create table public.stripe_webhook_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz default now()
);

-- Service-role only (the webhook route uses supabaseServiceClient, which
-- bypasses RLS) -- no anon/authenticated access needed or granted.
alter table public.stripe_webhook_events enable row level security;
