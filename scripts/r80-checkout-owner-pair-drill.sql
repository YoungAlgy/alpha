\set ON_ERROR_STOP on

begin isolation level repeatable read read write;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
set local idle_in_transaction_session_timeout = '45s';
set local time zone 'UTC';
set local request.jwt.claims = '{"role":"service_role"}';

do $preflight$
begin
  if current_setting('transaction_read_only') <> 'off'
     or current_database() !~ '^alpha_drill_[a-f0-9]{16}$'
     or coalesce(inet_server_addr()::text, '') not in ('127.0.0.1', '127.0.0.1/32')
     or current_user <> 'postgres' then
    raise exception 'checkout owner-pair drill requires the reviewed writable local clone identity';
  end if;
  if to_regprocedure('public.block_checkout_for_deleting_owner()') is null
     or not exists (
       select 1
         from pg_trigger
        where tgrelid = 'public.checkout_profiles'::regclass
          and tgname = 'checkout_profiles_block_deleting_owner'
          and not tgisinternal
          and tgenabled = 'O'
     ) then
    raise exception 'checkout owner-pair guard is missing or disabled';
  end if;
  if exists (
    select 1 from auth.users
     where id in ('e8000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000002')
        or lower(email) in ('checkout-owner-a@fixture.invalid', 'checkout-owner-b@fixture.invalid')
  ) or exists (
    select 1 from public.users
     where id in ('e8000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000002')
        or lower(email) in ('checkout-owner-a@fixture.invalid', 'checkout-owner-b@fixture.invalid')
  ) or exists (
    select 1 from public.checkout_profiles
     where id in ('e8100000-0000-4000-8000-000000000001', 'e8100000-0000-4000-8000-000000000002')
        or stripe_session_id in ('cs_fixture_owner_pair_1', 'cs_fixture_owner_pair_2')
        or stripe_customer_id in ('cus_fixtureownerpair1', 'cus_fixtureownerpair2')
        or stripe_subscription_id in ('sub_fixtureownerpair1', 'sub_fixtureownerpair2')
  ) then
    raise exception 'checkout owner-pair fixture collision';
  end if;
end
$preflight$;

insert into auth.users (id, email, created_at) values
  ('e8000000-0000-4000-8000-000000000001', 'checkout-owner-a@fixture.invalid', transaction_timestamp()),
  ('e8000000-0000-4000-8000-000000000002', 'checkout-owner-b@fixture.invalid', transaction_timestamp());

-- ASSERTION 1: the actual trigger permits an exact same-user owner pair.
insert into public.checkout_profiles (
  id, email_hash, email, first_name, topics, theme, browser_nonce_hash,
  owner_user_id, provisioned_user_id, stripe_session_id,
  stripe_customer_id, stripe_subscription_id, billing_state
) values (
  'e8100000-0000-4000-8000-000000000001', repeat('a', 64),
  'checkout-owner-a@fixture.invalid', 'Fixture',
  array['ai-news','tech','business','science','health'], 'light', repeat('b', 64),
  'e8000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000001',
  'cs_fixture_owner_pair_1', 'cus_fixtureownerpair1',
  'sub_fixtureownerpair1', 'paid'
);

do $assert_valid$
begin
  if not exists (
    select 1 from public.checkout_profiles
     where id = 'e8100000-0000-4000-8000-000000000001'
       and owner_user_id = 'e8000000-0000-4000-8000-000000000001'
       and provisioned_user_id = 'e8000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'same-user checkout owner pair was not accepted';
  end if;
end
$assert_valid$;

-- ASSERTION 2: mismatched owners are rejected on INSERT, including a row
-- carrying a distinct billing identity. The trigger does not independently
-- map Stripe identifiers to users; this assertion proves the UUID pair guard.
do $assert_insert$
begin
  begin
    insert into public.checkout_profiles (
      id, email_hash, email, first_name, topics, theme, browser_nonce_hash,
      owner_user_id, provisioned_user_id, stripe_session_id,
      stripe_customer_id, stripe_subscription_id, billing_state
    ) values (
      'e8100000-0000-4000-8000-000000000002', repeat('c', 64),
      'checkout-owner-b@fixture.invalid', 'Fixture',
      array['ai-news','tech','business','science','health'], 'light', repeat('d', 64),
      'e8000000-0000-4000-8000-000000000001',
      'e8000000-0000-4000-8000-000000000002',
      'cs_fixture_owner_pair_2', 'cus_fixtureownerpair2',
      'sub_fixtureownerpair2', 'paid'
    );
    raise exception 'mismatched checkout owner pair insert was accepted';
  exception when raise_exception then
    if sqlerrm <> 'checkout owner and provisioned user must match' then
      raise;
    end if;
  end;
  if exists (select 1 from public.checkout_profiles where id = 'e8100000-0000-4000-8000-000000000002') then
    raise exception 'rejected mismatched checkout insert persisted';
  end if;
end
$assert_insert$;

-- ASSERTION 3: the guarded UPDATE columns cannot replace one half of an
-- existing valid owner pair with a different user.
do $assert_update$
begin
  begin
    update public.checkout_profiles
       set provisioned_user_id = 'e8000000-0000-4000-8000-000000000002'
     where id = 'e8100000-0000-4000-8000-000000000001';
    raise exception 'mismatched checkout owner pair update was accepted';
  exception when raise_exception then
    if sqlerrm <> 'checkout owner and provisioned user must match' then
      raise;
    end if;
  end;
  if not exists (
    select 1 from public.checkout_profiles
     where id = 'e8100000-0000-4000-8000-000000000001'
       and owner_user_id = 'e8000000-0000-4000-8000-000000000001'
       and provisioned_user_id = 'e8000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'rejected checkout owner update changed the valid pair';
  end if;
end
$assert_update$;

select 'R80 CHECKOUT OWNER PAIR DRILL PASS: 3 assertions';
rollback;
