-- Synthetic legacy critical-table rows for a disposable local backup/restore drill.
-- The caller has already inserted auth.users, public.users, public.issues,
-- public.resend_delivery_attempts, and public.brevo_suppression_events.
begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.resend_webhook_events (
  email_id, type, received_at, event_at, recipient_hashes,
  owner_user_id, resolution_status, review_required_at, resolved_at
) values (
  'resend-recovery-unowned',
  'email.bounced',
  '2026-08-30T12:05:02Z',
  '2026-08-30T12:05:00Z',
  array['e1424f359149365651d639f175c5a49eedb202b59e2bc72488583fdfa17daa82']::text[],
  null,
  'pending_owner',
  '2026-08-30T12:05:02Z',
  null
);

insert into public.support_tickets (id, name, email, message, user_id, status)
values (
  42,
  'Recovery Drill',
  'recovery-drill@fixture.invalid',
  'Synthetic local recovery fixture.',
  '11111111-1111-4111-8111-111111111111',
  'open'
);

insert into public.checkout_profiles (
  id, email_hash, email, first_name, topics, theme, browser_nonce_hash,
  owner_user_id, billing_state
) values (
  '33333333-3333-4333-8333-333333333333',
  repeat('a', 64),
  'checkout-recovery@fixture.invalid',
  'Checkout',
  array['healthcare-recruiting','sales-persuasion','founder-operator','marketing-growth','personal-finance'],
  'forest',
  repeat('b', 64),
  '11111111-1111-4111-8111-111111111111',
  'open'
);

insert into public.checkout_fulfillments (
  session_id, profile_id, email_hash, week_of, status, user_id
) values (
  'cs_test_recovery_drill',
  '33333333-3333-4333-8333-333333333333',
  repeat('a', 64),
  '2026-08-24',
  'pending',
  '11111111-1111-4111-8111-111111111111'
);

insert into public.checkout_creation_reviews (profile_id, reason, status)
values ('33333333-3333-4333-8333-333333333333', 'replay_window_missed', 'pending');

insert into public.account_deletion_sagas (
  user_id, stripe_customer_id, stripe_subscription_id, state
) values (
  '11111111-1111-4111-8111-111111111111',
  'cus_test_recovery_saga',
  'sub_test_recovery_saga',
  'prepared'
);

insert into public.account_deletion_alpha_subscriptions (
  user_id, subscription_id, customer_id, terminal_status
) values (
  '11111111-1111-4111-8111-111111111111',
  'sub_test_recovery_saga',
  'cus_test_recovery_saga',
  'active'
);

insert into public.refund_reviews (
  session_id, subscription_id, customer_id, reason, status
) values (
  'cs_test_recovery_refund',
  'sub_test_recovery_refund',
  'cus_test_recovery_refund',
  'duplicate_checkout',
  'pending'
);

insert into public.legacy_checkout_fulfillments (
  session_id, email_hash, user_id, stripe_customer_id,
  stripe_subscription_id, week_of, status
) values (
  'cs_test_recovery_legacy',
  repeat('a', 64),
  '11111111-1111-4111-8111-111111111111',
  'cus_test_recovery_legacy',
  'sub_test_recovery_legacy',
  '2026-08-24',
  'pending'
);

commit;
