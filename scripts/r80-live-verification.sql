-- Alpha Round 80 canonical live database verification
--
-- READ ONLY. Every statement in this file is SELECT-only. Do not add DDL,
-- DML, DO blocks, stored-procedure calls, temporary objects, or transaction
-- settings that can change the target database.
--
-- Run only against the confirmed Alpha Supabase project, using the exact role
-- planned for the migration, after receiving explicit approval for the live
-- read. Run PRE-APPLY before the atomic bundle. Stop unless every documented
-- pass condition is met. Run POST-APPLY only after one confirmed atomic commit.
-- Never run the PRE and POST sections as one unattended batch.

-- ============================================================================
-- PRE-APPLY
-- ============================================================================

-- PASS: this identifies the reviewed database and migration execution role.
-- Record the result with the release evidence.
select
  current_database() as database_name,
  current_user as migration_execution_role,
  session_user as session_role,
  now() as observed_at;

-- PASS: the exact migration role can install the Auth identity trigger.
-- A false result blocks this bundle. Do not change Auth ownership to bypass it.
select has_table_privilege(current_user, to_regclass('auth.users'), 'TRIGGER')
  as migration_role_can_guard_auth_identity;

-- PASS: every expected baseline relation reports present = true.
with expected(name) as (
  values
    ('auth.users'),
    ('public.users'),
    ('public.issues'),
    ('public.support_tickets'),
    ('public.resend_webhook_events'),
    ('public.stripe_webhook_events'),
    ('supabase_migrations.schema_migrations')
)
select
  name,
  to_regclass(name) is not null as present
from expected
order by name;

-- PASS: all three application roles and both required built-ins report true.
with expected(role_name) as (
  values ('anon'), ('authenticated'), ('service_role')
)
select
  e.role_name,
  r.oid is not null as present
from expected e
left join pg_roles r on r.rolname = e.role_name
order by e.role_name;

select
  to_regprocedure('gen_random_uuid()') is not null as has_uuid_generator,
  to_regprocedure('hashtextextended(text,bigint)') is not null as has_lock_hash;

-- PASS: all 12 rows report absent = true. Any existing relation means
-- partial or unledgered Round 80 DDL and stops the release.
with expected(name) as (
  values
    ('checkout_profiles'),
    ('checkout_fulfillments'),
    ('checkout_creation_reviews'),
    ('account_deletion_sagas'),
    ('account_deletion_alpha_subscriptions'),
    ('refund_reviews'),
    ('legacy_checkout_fulfillments'),
    ('alpha_paid_call_budgets'),
    ('weekly_send_delivery_cursors'),
    ('alpha_rate_limit_buckets'),
    ('alpha_quantity_update_leases'),
    ('resend_delivery_attempts')
)
select
  e.name,
  to_regclass('public.' || e.name) is null as absent,
  to_regclass('public.' || e.name) as existing_relation
from expected e
order by e.name;

-- PASS: all 40 rows report absent = true. These are every column added to an
-- existing table by the 14 Round 80 migrations.
with expected(table_name, column_name) as (
  values
    ('stripe_webhook_events', 'status'),
    ('stripe_webhook_events', 'lease_token'),
    ('stripe_webhook_events', 'lease_expires_at'),
    ('stripe_webhook_events', 'updated_at'),
    ('account_deletion_sagas', 'reconcile_last_error_code'),
    ('account_deletion_sagas', 'reconcile_dead_lettered_at'),
    ('resend_webhook_events', 'event_at'),
    ('resend_webhook_events', 'recipient_hashes'),
    ('resend_webhook_events', 'owner_user_id'),
    ('resend_webhook_events', 'resolution_status'),
    ('resend_webhook_events', 'review_required_at'),
    ('resend_webhook_events', 'resolved_at'),
    ('users', 'stripe_subscription_id'),
    ('users', 'access_requested_at'),
    ('users', 'access_granted_at'),
    ('users', 'delivery_suppression_cleared_at'),
    ('users', 'suppression_recovery_token'),
    ('users', 'suppression_recovery_started_at'),
    ('users', 'suppression_recovery_snapshot'),
    ('users', 'suppression_cleanup_pending_at'),
    ('users', 'suppression_cleanup_next_attempt_at'),
    ('users', 'stripe_email_sync_pending_at'),
    ('users', 'stripe_email_sync_next_attempt_at'),
    ('users', 'stripe_email_sync_lease_token'),
    ('users', 'stripe_email_sync_lease_expires_at'),
    ('users', 'stripe_email_sync_attempt_count'),
    ('users', 'stripe_email_sync_last_error_code'),
    ('users', 'stripe_email_sync_dead_lettered_at'),
    ('users', 'suppression_cleanup_attempt_count'),
    ('users', 'suppression_cleanup_last_error_code'),
    ('users', 'suppression_cleanup_dead_lettered_at'),
    ('users', 'renewal_cancel_pending_at'),
    ('users', 'renewal_cancel_customer_id'),
    ('users', 'renewal_cancel_subscription_id'),
    ('users', 'renewal_cancel_next_attempt_at'),
    ('users', 'renewal_cancel_lease_token'),
    ('users', 'renewal_cancel_lease_expires_at'),
    ('users', 'renewal_cancel_attempt_count'),
    ('users', 'renewal_cancel_last_error_code'),
    ('users', 'renewal_cancel_escalated_at')
)
select
  e.table_name,
  e.column_name,
  c.column_name is null as absent,
  c.udt_name as existing_udt_name,
  c.is_nullable as existing_is_nullable,
  c.column_default as existing_default
from expected e
left join information_schema.columns c
  on c.table_schema = 'public'
 and c.table_name = e.table_name
 and c.column_name = e.column_name
order by e.table_name, e.column_name;

-- PASS: all 21 rows report absent = true. A same-name constraint is drift,
-- even if its definition happens to resemble the intended constraint.
with expected(name, table_name) as (
  values
    ('account_deletion_sagas_reconcile_attempt_count_check', 'account_deletion_sagas'),
    ('account_deletion_sagas_reconcile_error_code_check', 'account_deletion_sagas'),
    ('account_deletion_sagas_reconcile_marker_check', 'account_deletion_sagas'),
    ('resend_webhook_events_resolution_status_check', 'resend_webhook_events'),
    ('resend_webhook_events_resolution_marker_check', 'resend_webhook_events'),
    ('resend_webhook_events_event_clock_check', 'resend_webhook_events'),
    ('users_suppression_recovery_state_check', 'users'),
    ('users_stripe_email_sync_lease_pair', 'users'),
    ('users_delivery_retry_deadlines_require_pending', 'users'),
    ('users_stripe_customer_id_format_check', 'users'),
    ('users_stripe_subscription_id_format_check', 'users'),
    ('users_stripe_subscription_requires_customer_check', 'users'),
    ('users_renewal_cancel_attempt_count_check', 'users'),
    ('users_renewal_cancel_last_error_code_check', 'users'),
    ('users_renewal_cancel_marker_shape_check', 'users'),
    ('users_stripe_email_sync_attempt_count_check', 'users'),
    ('users_stripe_email_sync_error_code_check', 'users'),
    ('users_stripe_email_sync_retry_marker_check', 'users'),
    ('users_suppression_cleanup_attempt_count_check', 'users'),
    ('users_suppression_cleanup_error_code_check', 'users'),
    ('users_suppression_cleanup_retry_marker_check', 'users')
)
select
  e.name,
  e.table_name,
  count(c.oid) = 0 as absent,
  string_agg(pg_get_constraintdef(c.oid), ' | ' order by c.oid) as existing_definition
from expected e
left join pg_constraint c on c.conname = e.name
group by e.name, e.table_name
order by e.name;

-- PASS: all 37 rows report absent = true. This detects same-name indexes that
-- would otherwise be silently retained by CREATE INDEX IF NOT EXISTS.
with expected(name) as (
  values
    ('account_deletion_alpha_subscription_reservation_idx'),
    ('account_deletion_sagas_completed_purge_idx'),
    ('account_deletion_sagas_exact_subscription_idx'),
    ('account_deletion_sagas_reconcile_dead_letter_idx'),
    ('account_deletion_sagas_reconcile_due_idx'),
    ('alpha_quantity_update_leases_expiry_idx'),
    ('alpha_rate_limit_buckets_expiry_idx'),
    ('checkout_creation_reviews_pending_created_idx'),
    ('checkout_fulfillments_terminal_scrub_idx'),
    ('checkout_profiles_active_email_idx'),
    ('checkout_profiles_active_owner_idx'),
    ('checkout_profiles_creation_lease_idx'),
    ('checkout_profiles_customer_state_idx'),
    ('checkout_profiles_operational_expiry_idx'),
    ('checkout_profiles_recovery_dead_letter_idx'),
    ('checkout_profiles_recovery_lease_idx'),
    ('checkout_profiles_terminal_scrub_idx'),
    ('legacy_checkout_fulfillments_dead_letter_idx'),
    ('legacy_checkout_fulfillments_subscription_idx'),
    ('issues_id_user_id_uidx'),
    ('issues_resend_message_id_idx'),
    ('refund_reviews_current_cleanup_loser_idx'),
    ('refund_reviews_pending_created_idx'),
    ('refund_reviews_resolved_retention_idx'),
    ('resend_delivery_attempts_issue_lane_uidx'),
    ('resend_delivery_attempts_user_idx'),
    ('resend_webhook_events_pending_review_idx'),
    ('resend_webhook_events_unowned_retention_idx'),
    ('users_pending_access_request_idx'),
    ('users_renewal_cancel_escalated_idx'),
    ('users_renewal_cancel_pending_idx'),
    ('users_stripe_email_sync_pending_idx'),
    ('users_stripe_email_sync_dead_letter_idx'),
    ('users_stripe_subscription_id_unique_idx'),
    ('users_suppression_recovery_pending_idx'),
    ('users_suppression_cleanup_pending_idx'),
    ('users_suppression_cleanup_dead_letter_idx')
)
select
  e.name,
  c.oid is null as absent,
  c.relkind as existing_relkind,
  case
    when c.relkind in ('i', 'I') then pg_get_indexdef(c.oid)
    else null
  end as existing_definition
from expected e
left join pg_class c
  on c.oid = to_regclass('public.' || e.name)
order by e.name;

-- PASS: all 16 rows report absent = true. The existing protected-column
-- trigger is checked separately below.
with expected(trigger_name, table_name) as (
  values
    ('account_deletion_abort_legacy_checkout', 'account_deletion_sagas'),
    ('account_deletion_active_delivery_guard', 'account_deletion_sagas'),
    ('users_suppression_recovery_identity_guard', 'users'),
    ('auth_users_suppression_recovery_identity_guard', 'auth.users'),
    ('account_deletion_scrub_legacy_checkout', 'account_deletion_sagas'),
    ('checkout_profiles_block_billing_pair_conflict', 'checkout_profiles'),
    ('checkout_profiles_block_deleting_owner', 'checkout_profiles'),
    ('issues_block_mutation_during_account_deletion', 'issues'),
    ('legacy_checkout_billing_pair_conflict', 'legacy_checkout_fulfillments'),
    ('support_tickets_block_mutation_during_account_deletion', 'support_tickets'),
    ('users_block_billing_pair_conflict', 'users'),
    ('users_block_billing_rebind_during_account_deletion', 'users'),
    ('users_block_legacy_duplicate_winner_mutation', 'users'),
    ('users_block_mutation_during_account_deletion', 'users'),
    ('users_normalize_delivery_retry_deadlines', 'users'),
    ('users_active_delivery_state_guard', 'users')
)
select
  e.trigger_name,
  e.table_name,
  count(t.oid) = 0 as absent,
  string_agg(pg_get_triggerdef(t.oid), ' | ' order by t.oid) as existing_definition
from expected e
left join pg_class rel
  on rel.oid = to_regclass(case when e.table_name = 'auth.users' then e.table_name else 'public.' || e.table_name end)
left join pg_trigger t
  on t.tgrelid = rel.oid
 and t.tgname = e.trigger_name
 and not t.tgisinternal
group by e.trigger_name, e.table_name
order by e.trigger_name;

-- PASS: every genuinely new Round 80 function name reports
-- existing_overloads = 0 and absent = true. This checks every overload by
-- name, so an unledgered function with a wrong signature still blocks apply.
with expected(name) as (
  values
    ('abort_current_checkout_duplicate_fulfillment'),
    ('abort_legacy_checkout_for_account_deletion'),
    ('abort_legacy_checkout_fulfillment'),
    ('advance_weekly_send_cursor'),
    ('alpha_scheduled_maintenance_due'),
    ('apply_resend_suppression_to_user'),
    ('authorize_stripe_email_sync'),
    ('begin_account_deletion_auth_removal'),
    ('begin_checkout_session_creation'),
    ('bind_account_deletion_subscription'),
    ('bind_checkout_session'),
    ('bind_existing_alpha_subscription'),
    ('block_account_deletion_with_active_delivery'),
    ('block_identity_change_with_suppression_recovery'),
    ('block_auth_identity_change_with_suppression_recovery'),
    ('block_billing_rebind_during_account_deletion'),
    ('block_checkout_billing_pair_conflict'),
    ('block_checkout_for_deleting_owner'),
    ('block_issue_mutation_during_account_deletion'),
    ('block_legacy_checkout_billing_pair_conflict'),
    ('block_support_ticket_mutation_during_account_deletion'),
    ('block_user_billing_pair_conflict'),
    ('block_user_delivery_change_with_active_attempt'),
    ('block_user_legacy_duplicate_winner_mutation'),
    ('block_user_mutation_during_account_deletion'),
    ('claim_alpha_quantity_update'),
    ('claim_alpha_renewal_cancellation'),
    ('claim_alpha_renewal_cancellation_retirement'),
    ('claim_checkout_fulfillment'),
    ('claim_checkout_profile_recovery'),
    ('claim_checkout_session_creation_replay'),
    ('claim_legacy_checkout_fulfillment'),
    ('claim_resend_delivery_attempt'),
    ('claim_resend_suppression_recovery'),
    ('finalize_resend_suppression_recovery'),
    ('resend_suppression_recovery_snapshot'),
    ('claim_stripe_email_sync'),
    ('claim_stripe_webhook_event'),
    ('complete_account_deletion'),
    ('complete_checkout_creation_review_with_session'),
    ('complete_checkout_fulfillment'),
    ('complete_legacy_checkout_fulfillment'),
    ('complete_stripe_email_sync'),
    ('confirm_account_deletion_billing'),
    ('consume_alpha_rate_limit'),
    ('count_dead_lettered_account_deletions'),
    ('count_dead_lettered_checkout_profiles'),
    ('count_dead_lettered_legacy_checkout_fulfillments'),
    ('count_dead_lettered_stripe_email_sync'),
    ('count_dead_lettered_suppression_cleanups'),
    ('count_pending_alpha_renewal_cancellations'),
    ('count_pending_checkout_creation_reviews'),
    ('count_pending_refund_reviews'),
    ('count_prunable_resolved_refund_reviews'),
    ('count_unresolved_refund_reviews'),
    ('defer_account_deletion_reconciliation'),
    ('defer_checkout_profile_recovery_candidate'),
    ('defer_legacy_checkout_fulfillment'),
    ('fail_account_deletion_reconciliation'),
    ('fail_checkout_profile_recovery'),
    ('fail_legacy_checkout_fulfillment'),
    ('fail_stripe_email_sync'),
    ('fail_suppression_cleanup'),
    ('finalize_resend_delivery_attempt'),
    ('finalize_stale_checkout_fulfillments'),
    ('find_legacy_current_checkout_conflict'),
    ('hold_checkout_session_creation_for_invite_review'),
    ('list_legacy_fulfillments_awaiting_issue'),
    ('list_pending_legacy_duplicate_finalizations'),
    ('list_stale_checkout_session_creations'),
    ('list_stale_pending_legacy_fulfillments'),
    ('mark_account_deletion_support_deleted'),
    ('mark_account_deletion_delivery_policy_settled'),
    ('normalize_delivery_retry_deadlines'),
    ('prepare_account_deletion'),
    ('prune_completed_account_deletion_sagas'),
    ('prune_unowned_resend_webhook_events'),
    ('prune_resolved_refund_reviews'),
    ('record_account_deletion_subscription'),
    ('record_current_checkout_duplicate_refund_review'),
    ('record_legacy_current_checkout_conflict_refund_review'),
    ('record_legacy_duplicate_refund_review'),
    ('record_refund_review'),
    ('record_resend_suppression_event'),
    ('record_webhook_duplicate_refund_review'),
    ('recover_checkout_profile_provisioning'),
    ('release_alpha_quantity_update'),
    ('release_alpha_renewal_cancellation_lease'),
    ('release_checkout_session_creation_replay'),
    ('release_stripe_email_sync'),
    ('requeue_checkout_profile_recovery'),
    ('requeue_legacy_checkout_fulfillment'),
    ('requeue_account_deletion_reconciliation'),
    ('requeue_stripe_email_sync'),
    ('requeue_suppression_cleanup'),
    ('reserve_alpha_paid_calls'),
    ('resolve_checkout_creation_review_no_create'),
    ('resolve_refund_review'),
    ('retire_alpha_renewal_cancellation_marker'),
    ('scrub_legacy_checkout_after_account_deletion'),
    ('scrub_terminal_checkout_tombstones'),
    ('settle_account_deletion_checkout_profile'),
    ('settle_alpha_renewal_cancellation'),
    ('settle_alpha_renewal_cancellation_no_access'),
    ('settle_checkout_profile_recovery'),
    ('settle_checkout_session_creation_replay'),
    ('settle_checkout_session_expiration'),
    ('settle_legacy_fulfillment_awaiting_issue'),
    ('stage_checkout_profile')
)
select
  e.name,
  count(p.oid) as existing_overloads,
  count(p.oid) = 0 as absent
from expected e
left join pg_namespace n on n.nspname = 'public'
left join pg_proc p
  on p.pronamespace = n.oid
 and p.proname = e.name
group by e.name
order by e.name;

-- PASS: the pre-existing protected-column trigger exists exactly once, is
-- enabled normally, and still calls protect_user_privileged_columns().
select
  count(t.oid) = 1 as exact_one_trigger,
  coalesce(bool_and(t.tgenabled = 'O'), false) as enabled_normally,
  coalesce(bool_and(p.proname = 'protect_user_privileged_columns'), false)
    as calls_expected_function,
  string_agg(pg_get_triggerdef(t.oid), ' | ' order by t.oid) as definition
from pg_trigger t
join pg_class rel on rel.oid = t.tgrelid
join pg_namespace n on n.oid = rel.relnamespace
join pg_proc p on p.oid = t.tgfoid
where n.nspname = 'public'
  and rel.relname = 'users'
  and t.tgname = 'protect_user_privileged_columns_trg'
  and not t.tgisinternal;

-- PASS: the baseline function exists once. Every Round 80 marker and
-- search_path_already_pinned reports false. A true marker means an unledgered
-- partial replacement and stops the release.
with f as (
  select
    p.oid,
    p.proconfig,
    pg_get_functiondef(p.oid) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'protect_user_privileged_columns'
    and pg_get_function_identity_arguments(p.oid) = ''
)
select
  count(*) = 1 as exact_one_baseline_function,
  coalesce(bool_or('search_path=public' = any(proconfig)), false)
    as search_path_already_pinned,
  coalesce(bool_or(position('new.stripe_subscription_id := old.stripe_subscription_id' in definition) > 0), false)
    as round80_subscription_marker_present,
  coalesce(bool_or(position('new.access_requested_at := old.access_requested_at' in definition) > 0), false)
    as round80_access_request_marker_present,
  coalesce(bool_or(position('new.access_granted_at := old.access_granted_at' in definition) > 0), false)
    as round80_access_grant_marker_present,
  coalesce(bool_or(position('new.delivery_suppression_cleared_at := old.delivery_suppression_cleared_at' in definition) > 0), false)
    as round80_delivery_causality_marker_present,
  coalesce(bool_or(position('new.suppression_cleanup_pending_at := old.suppression_cleanup_pending_at' in definition) > 0), false)
    as round80_suppression_marker_present,
  coalesce(bool_or(position('new.stripe_email_sync_pending_at := old.stripe_email_sync_pending_at' in definition) > 0), false)
    as round80_email_sync_marker_present,
  coalesce(bool_or(position('new.stripe_email_sync_attempt_count := old.stripe_email_sync_attempt_count' in definition) > 0), false)
    as round80_email_sync_retry_marker_present,
  coalesce(bool_or(position('new.suppression_cleanup_attempt_count := old.suppression_cleanup_attempt_count' in definition) > 0), false)
    as round80_suppression_retry_marker_present,
  coalesce(bool_or(position('new.renewal_cancel_pending_at := old.renewal_cancel_pending_at' in definition) > 0), false)
    as round80_renewal_marker_present
from f;

-- PASS: the baseline Auth trigger function exists once and still creates the
-- matching public row. The POST proof verifies its deterministic clock update.
with f as (
  select
    p.oid,
    p.prosecdef,
    p.proconfig,
    lower(p.prosrc) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'handle_new_user'
    and pg_get_function_identity_arguments(p.oid) = ''
)
select
  count(*) = 1 as exact_one_baseline_handle_new_user,
  coalesce(bool_and(prosecdef), false) as security_definer,
  coalesce(bool_and('search_path=public' = any(proconfig)), false)
    as pinned_search_path,
  coalesce(bool_and(position('insert into public.users' in definition) > 0), false)
    as inserts_public_user,
  coalesce(bool_or(position('new.created_at' in definition) > 0), false)
    as deterministic_auth_clock_marker_already_present
from f;

-- PASS: the baseline watchdog exists at the exact signature, is a pinned
-- SECURITY DEFINER function, remains callable only by anon, and still has its
-- paid-window delivery filters and proof-of-send test. Both Round 80 markers
-- report false. A true marker means an unledgered partial replacement.
with f as (
  select
    p.oid,
    p.prokind,
    p.prosecdef,
    p.proconfig,
    p.proacl,
    p.proowner,
    lower(p.prosrc) as definition
  from pg_proc p
  where p.oid = to_regprocedure(
    'public.watchdog_delivery_check(timestamptz)'
  )
)
select
  count(*) = 1 as exact_one_baseline_watchdog,
  coalesce(bool_and(prokind = 'f'), false) as regular_function,
  coalesce(bool_and(prosecdef), false) as security_definer,
  coalesce(bool_and('search_path=public' = any(proconfig)), false)
    as pinned_search_path,
  coalesce(bool_and(has_function_privilege('anon', oid, 'EXECUTE')), false)
    as anon_execute,
  coalesce(bool_and(not has_function_privilege('authenticated', oid, 'EXECUTE')), false)
    as authenticated_no_execute,
  coalesce(bool_and(not exists (
    select 1
    from aclexplode(coalesce(proacl, acldefault('f', proowner))) privilege
    where privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  )), false) as public_no_execute,
  coalesce(bool_and(position('--' in definition) = 0), false)
    and coalesce(bool_and(position('/*' in definition) = 0), false)
    as body_has_no_comments,
  coalesce(bool_and(position('subscribed_at is not null' in definition) > 0), false)
    as has_access_stamp_marker,
  coalesce(bool_and(position('cancelled_at is null' in definition) > 0), false)
    and coalesce(bool_and(position('cancelled_at > now()' in definition) > 0), false)
    as has_paid_window_markers,
  coalesce(bool_and(position('unsubscribed_at is null' in definition) > 0), false)
    and coalesce(bool_and(position('bounced_at is null' in definition) > 0), false)
    and coalesce(bool_and(position('complained_at is null' in definition) > 0), false)
    as has_delivery_exclusion_markers,
  coalesce(bool_and(position('i.user_id = u.id' in definition) > 0), false)
    and coalesce(bool_and(position('i.delivered_at >= date_trunc(''hour'', cutoff)' in definition) > 0), false)
    and coalesce(bool_and(position('i.resend_message_id is not null' in definition) > 0), false)
    as has_proof_of_send_markers,
  coalesce(bool_or(position('access_granted_at is not null' in definition) > 0), false)
    as round80_access_grant_marker_present,
  coalesce(bool_or(position('suppression_cleanup_pending_at is null' in definition) > 0), false)
    as round80_suppression_marker_present
from f;

-- PASS: the baseline issue policy exists exactly once, is SELECT-only, keeps
-- the self and cancellation markers, and does not yet contain subscribed_at.
select
  count(*) = 1 as exact_one_policy,
  coalesce(bool_and(cmd = 'SELECT'), false) as select_only,
  coalesce(bool_and(position('auth.uid()' in lower(qual)) > 0), false)
    as has_self_marker,
  coalesce(bool_and(position('cancelled_at' in lower(qual)) > 0), false)
    as has_cancellation_marker,
  coalesce(bool_or(position('subscribed_at' in lower(qual)) > 0), false)
    as final_subscribed_marker_present,
  coalesce(bool_or(position('access_granted_at' in lower(qual)) > 0), false)
    as final_access_grant_marker_present,
  string_agg(qual, ' | ' order by policyname) as qualifier
from pg_policies
where schemaname = 'public'
  and tablename = 'issues'
  and policyname = 'issues self read';


-- PASS: every anomaly count is zero. active_access_rows is evidence only.
-- The customer format check must be clean before the validated constraint can
-- be added by the atomic bundle.
select
  count(*) filter (
    where stripe_customer_id is not null
      and stripe_customer_id !~ '^cus_[A-Za-z0-9]+$'
  ) as malformed_customer_ids,
  count(*) filter (
    where stripe_customer_id is not null
      and subscribed_at is null
      and (cancelled_at is null or cancelled_at > now())
  ) as billed_rows_missing_access_stamp,
  count(*) filter (
    where subscribed_at is not null
      and (cancelled_at is null or cancelled_at > now())
  ) as active_access_rows
from public.users;

-- PASS: duplicate_customer_groups = 0.
select count(*) as duplicate_customer_groups
from (
  select stripe_customer_id
  from public.users
  where stripe_customer_id is not null
  group by stripe_customer_id
  having count(*) > 1
) duplicate_customers;

-- PASS: users_missing_deterministic_auth_clock = 0 and
-- public_users_without_auth_owner = 0. public_users_missing_created_at is
-- evidence for the reviewed deterministic backfill from auth.users.created_at.
-- Any public NULL without that source clock stops the release before apply.
select
  count(*) filter (where u.created_at is null)
    as public_users_missing_created_at,
  count(*) filter (
    where u.created_at is null
      and au.created_at is null
  ) as users_missing_deterministic_auth_clock,
  count(*) filter (where au.id is null)
    as public_users_without_auth_owner
from public.users u
left join auth.users au on au.id = u.id;

-- PASS: canonical_email_collision_groups = 0. Delivery ownership compares the
-- canonical lower-trimmed address, so case-variant duplicates stop the release.
select count(*) as canonical_email_collision_groups
from (
  select lower(btrim(email)) as canonical_email
  from public.users
  group by lower(btrim(email))
  having count(*) > 1
) collisions;

-- PASS: duplicate_legacy_resend_message_groups = 0. A legacy provider message
-- id must map to at most one issue before it can be used as ownership evidence.
select count(*) as duplicate_legacy_resend_message_groups
from (
  select resend_message_id
  from public.issues
  where resend_message_id is not null
  group by resend_message_id
  having count(*) > 1
) duplicate_messages;

-- EVIDENCE: record this count. Every historical row has no signed event clock
-- and will enter legacy_review. Review remains manual after the atomic apply.
select count(*) as historical_resend_events_requiring_legacy_review
from public.resend_webhook_events;

-- Ledger shape preflight. Run these statements using the exact role that will
-- apply the bundle.

-- PASS: review the returned schema. version is non-null text or varchar. Every
-- other non-null column has a default or is identity/generated.
select
  ordinal_position,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default,
  is_identity,
  is_generated
from information_schema.columns
where table_schema = 'supabase_migrations'
  and table_name = 'schema_migrations'
order by ordinal_position;

-- PASS: every boolean is true. The unique version index must be ready, live,
-- valid, non-partial, non-expression, and contain no key or INCLUDE column
-- other than version. SELECT and INSERT must belong to the actual apply role.
select
  to_regclass('supabase_migrations.schema_migrations') is not null
    as ledger_exists,
  exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'supabase_migrations'
      and c.table_name = 'schema_migrations'
      and c.column_name = 'version'
      and c.data_type in ('text', 'character varying')
      and c.is_nullable = 'NO'
  ) as version_column_compatible,
  not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'supabase_migrations'
      and c.table_name = 'schema_migrations'
      and c.column_name <> 'version'
      and c.is_nullable = 'NO'
      and c.column_default is null
      and c.is_identity = 'NO'
      and c.is_generated = 'NEVER'
  ) as other_required_columns_compatible,
  exists (
    select 1
    from pg_index i
    join pg_attribute a
      on a.attrelid = i.indrelid
     and a.attname = 'version'
     and a.attnum = any(i.indkey)
    where i.indrelid = to_regclass('supabase_migrations.schema_migrations')
      and i.indisunique
      and i.indisvalid
      and i.indisready
      and i.indislive
      and i.indnkeyatts = 1
      and i.indnatts = 1
      and i.indexprs is null
      and i.indpred is null
  ) as exact_nonpartial_unique_version_index,
  coalesce(
    has_schema_privilege(
      current_user,
      (select oid from pg_namespace where nspname = 'supabase_migrations'),
      'USAGE'
    ),
    false
  ) as execution_role_has_schema_usage,
  coalesce(
    has_table_privilege(
      current_user,
      to_regclass('supabase_migrations.schema_migrations'),
      'SELECT'
    ),
    false
  ) as execution_role_can_select_ledger,
  coalesce(
    has_table_privilege(
      current_user,
      to_regclass('supabase_migrations.schema_migrations'),
      'INSERT'
    ),
    false
  ) as execution_role_can_insert_ledger;

-- PASS: inspect the full definition. At least one row must be the exact
-- non-partial unique version index accepted above.
select
  ci.relname as index_name,
  i.indisunique,
  i.indisvalid,
  i.indisready,
  i.indislive,
  i.indnkeyatts,
  i.indnatts,
  pg_get_expr(i.indpred, i.indrelid) as predicate,
  pg_get_indexdef(i.indexrelid) as definition
from pg_index i
join pg_class ci on ci.oid = i.indexrelid
where i.indrelid = to_regclass('supabase_migrations.schema_migrations')
order by ci.relname;

-- Continue only after the ledger_exists and shape checks above pass. PASS: all
-- 14 rows report absent = true. A present version with absent DDL is drift.
with expected(version) as (
  values
    ('20260827000000'),
    ('20260827010000'),
    ('20260827020000'),
    ('20260827030000'),
    ('20260827040000'),
    ('20260827050000'),
    ('20260827200000'),
    ('20260828000000'),
    ('20260830000000'),
    ('20260830010000'),
    ('20260830020000'),
    ('20260830030000'),
    ('20260830040000'),
    ('20260830050000')
)
select
  e.version,
  sm.version is null as absent
from expected e
left join supabase_migrations.schema_migrations sm
  on sm.version = e.version
order by e.version;

-- PASS: record recent history for release evidence. Unexpected ordering or a
-- competing migration stops the release.
select version
from supabase_migrations.schema_migrations
order by version desc
limit 20;

-- ============================================================================
-- POST-APPLY
-- ============================================================================

-- PASS: record the same database and role identity used for PRE-APPLY.
select
  current_database() as database_name,
  current_user as migration_execution_role,
  session_user as session_role,
  now() as observed_at;

-- PASS: every ledger-shape and execution-role boolean remains true after the
-- atomic commit.
select
  to_regclass('supabase_migrations.schema_migrations') is not null
    as ledger_exists,
  exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'supabase_migrations'
      and c.table_name = 'schema_migrations'
      and c.column_name = 'version'
      and c.data_type in ('text', 'character varying')
      and c.is_nullable = 'NO'
  ) as version_column_compatible,
  not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'supabase_migrations'
      and c.table_name = 'schema_migrations'
      and c.column_name <> 'version'
      and c.is_nullable = 'NO'
      and c.column_default is null
      and c.is_identity = 'NO'
      and c.is_generated = 'NEVER'
  ) as other_required_columns_compatible,
  exists (
    select 1
    from pg_index i
    join pg_attribute a
      on a.attrelid = i.indrelid
     and a.attname = 'version'
     and a.attnum = any(i.indkey)
    where i.indrelid = to_regclass('supabase_migrations.schema_migrations')
      and i.indisunique
      and i.indisvalid
      and i.indisready
      and i.indislive
      and i.indnkeyatts = 1
      and i.indnatts = 1
      and i.indexprs is null
      and i.indpred is null
  ) as exact_nonpartial_unique_version_index,
  coalesce(
    has_schema_privilege(
      current_user,
      (select oid from pg_namespace where nspname = 'supabase_migrations'),
      'USAGE'
    ),
    false
  ) as execution_role_has_schema_usage,
  coalesce(
    has_table_privilege(
      current_user,
      to_regclass('supabase_migrations.schema_migrations'),
      'SELECT'
    ),
    false
  ) as execution_role_can_select_ledger,
  coalesce(
    has_table_privilege(
      current_user,
      to_regclass('supabase_migrations.schema_migrations'),
      'INSERT'
    ),
    false
  ) as execution_role_can_insert_ledger;

-- PASS: all 14 rows report present = true. Missing rows cannot disappear
-- from this expected-value join.
with expected(version) as (
  values
    ('20260827000000'),
    ('20260827010000'),
    ('20260827020000'),
    ('20260827030000'),
    ('20260827040000'),
    ('20260827050000'),
    ('20260827200000'),
    ('20260828000000'),
    ('20260830000000'),
    ('20260830010000'),
    ('20260830020000'),
    ('20260830030000'),
    ('20260830040000'),
    ('20260830050000')
)
select
  e.version,
  sm.version is not null as present
from expected e
left join supabase_migrations.schema_migrations sm
  on sm.version = e.version
order by e.version;

-- PASS: all 12 service-only tables exist as ordinary or partitioned tables,
-- have RLS enabled, and have zero policies. Every anon/authenticated no_*
-- boolean must be true. This covers every table privilege and every available
-- column-level privilege. A PUBLIC grant is inherited by these roles and also
-- makes the applicable no_* result false.
with expected(name) as (
  values
    ('checkout_profiles'),
    ('checkout_fulfillments'),
    ('checkout_creation_reviews'),
    ('account_deletion_sagas'),
    ('account_deletion_alpha_subscriptions'),
    ('refund_reviews'),
    ('legacy_checkout_fulfillments'),
    ('alpha_paid_call_budgets'),
    ('weekly_send_delivery_cursors'),
    ('alpha_rate_limit_buckets'),
    ('alpha_quantity_update_leases'),
    ('resend_delivery_attempts')
)
select
  e.name,
  c.oid is not null and c.relkind in ('r', 'p') as exists_as_table,
  coalesce(c.relrowsecurity, false) as rls_enabled,
  coalesce(policies.policy_count, 0) = 0 as has_zero_policies,
  not coalesce(has_table_privilege('anon', c.oid, 'SELECT'), false)
    as anon_no_select,
  not coalesce(has_table_privilege('anon', c.oid, 'INSERT'), false)
    as anon_no_insert,
  not coalesce(has_table_privilege('anon', c.oid, 'UPDATE'), false)
    as anon_no_update,
  not coalesce(has_table_privilege('anon', c.oid, 'DELETE'), false)
    as anon_no_delete,
  not coalesce(has_table_privilege('anon', c.oid, 'TRUNCATE'), false)
    as anon_no_truncate,
  not coalesce(has_table_privilege('anon', c.oid, 'REFERENCES'), false)
    as anon_no_references,
  not coalesce(has_table_privilege('anon', c.oid, 'TRIGGER'), false)
    as anon_no_trigger,
  not coalesce(has_any_column_privilege('anon', c.oid, 'SELECT'), false)
    as anon_no_column_select,
  not coalesce(has_any_column_privilege('anon', c.oid, 'INSERT'), false)
    as anon_no_column_insert,
  not coalesce(has_any_column_privilege('anon', c.oid, 'UPDATE'), false)
    as anon_no_column_update,
  not coalesce(has_any_column_privilege('anon', c.oid, 'REFERENCES'), false)
    as anon_no_column_references,
  not coalesce(has_table_privilege('authenticated', c.oid, 'SELECT'), false)
    as authenticated_no_select,
  not coalesce(has_table_privilege('authenticated', c.oid, 'INSERT'), false)
    as authenticated_no_insert,
  not coalesce(has_table_privilege('authenticated', c.oid, 'UPDATE'), false)
    as authenticated_no_update,
  not coalesce(has_table_privilege('authenticated', c.oid, 'DELETE'), false)
    as authenticated_no_delete,
  not coalesce(has_table_privilege('authenticated', c.oid, 'TRUNCATE'), false)
    as authenticated_no_truncate,
  not coalesce(has_table_privilege('authenticated', c.oid, 'REFERENCES'), false)
    as authenticated_no_references,
  not coalesce(has_table_privilege('authenticated', c.oid, 'TRIGGER'), false)
    as authenticated_no_trigger,
  not coalesce(has_any_column_privilege('authenticated', c.oid, 'SELECT'), false)
    as authenticated_no_column_select,
  not coalesce(has_any_column_privilege('authenticated', c.oid, 'INSERT'), false)
    as authenticated_no_column_insert,
  not coalesce(has_any_column_privilege('authenticated', c.oid, 'UPDATE'), false)
    as authenticated_no_column_update,
  not coalesce(has_any_column_privilege('authenticated', c.oid, 'REFERENCES'), false)
    as authenticated_no_column_references
from expected e
left join pg_class c
  on c.oid = to_regclass('public.' || e.name)
left join lateral (
  select count(*) as policy_count
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename = e.name
) policies on true
order by e.name;

-- PASS: all 14 coordination-table columns report exists and shape_matches as
-- true. These tables are the durable weekly cursor, distributed request cap,
-- and per-account quantity lease used by the final application code.
with expected(
  table_name,
  column_name,
  expected_udt_name,
  expected_is_nullable,
  default_kind
) as (
  values
    ('weekly_send_delivery_cursors', 'week_of', 'date', 'NO', 'none'),
    ('weekly_send_delivery_cursors', 'cursor_user_id', 'uuid', 'YES', 'none'),
    ('weekly_send_delivery_cursors', 'updated_at', 'timestamptz', 'NO', 'now'),
    ('alpha_rate_limit_buckets', 'scope', 'text', 'NO', 'none'),
    ('alpha_rate_limit_buckets', 'key_hash', 'text', 'NO', 'none'),
    ('alpha_rate_limit_buckets', 'bucket_start', 'timestamptz', 'NO', 'none'),
    ('alpha_rate_limit_buckets', 'window_seconds', 'int4', 'NO', 'none'),
    ('alpha_rate_limit_buckets', 'request_count', 'int4', 'NO', 'none'),
    ('alpha_rate_limit_buckets', 'expires_at', 'timestamptz', 'NO', 'none'),
    ('alpha_rate_limit_buckets', 'updated_at', 'timestamptz', 'NO', 'now'),
    ('alpha_quantity_update_leases', 'user_id', 'uuid', 'NO', 'none'),
    ('alpha_quantity_update_leases', 'lease_token', 'uuid', 'NO', 'none'),
    ('alpha_quantity_update_leases', 'lease_expires_at', 'timestamptz', 'NO', 'none'),
    ('alpha_quantity_update_leases', 'updated_at', 'timestamptz', 'NO', 'now')
), actual as (
  select
    e.*,
    c.column_name as actual_column_name,
    c.udt_name as actual_udt_name,
    c.is_nullable as actual_is_nullable,
    c.column_default as actual_default
  from expected e
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = e.table_name
   and c.column_name = e.column_name
)
select
  table_name,
  column_name,
  actual_column_name is not null as exists,
  actual_udt_name,
  actual_is_nullable,
  actual_default,
  (
    select count(*)
    from information_schema.columns table_column
    where table_column.table_schema = 'public'
      and table_column.table_name = actual.table_name
  ) = count(*) over (partition by table_name) as exact_table_column_count,
  actual_column_name is not null
    and actual_udt_name = expected_udt_name
    and actual_is_nullable = expected_is_nullable
    and case default_kind
      when 'none' then actual_default is null
      when 'now' then position('now()' in lower(coalesce(actual_default, ''))) > 0
      else false
    end as shape_matches
from actual
order by table_name, column_name;

-- PASS: all three rows report exists and columns_match as true. Column order is
-- part of the distributed limiter key and the cursor and lease ownership keys.
with expected(table_name, expected_columns) as (
  values
    ('weekly_send_delivery_cursors', array['week_of']::text[]),
    (
      'alpha_rate_limit_buckets',
      array['scope', 'key_hash', 'bucket_start', 'window_seconds']::text[]
    ),
    ('alpha_quantity_update_leases', array['user_id']::text[])
)
select
  e.table_name,
  c.oid is not null as exists,
  coalesce(c.convalidated, false) as validated,
  key_columns.names as actual_columns,
  coalesce(key_columns.names = e.expected_columns, false) as columns_match,
  coalesce(i.indisready, false) as index_ready,
  coalesce(i.indisvalid, false) as index_valid,
  coalesce(i.indislive, false) as index_live,
  pg_get_constraintdef(c.oid) as definition
from expected e
left join pg_constraint c
 on c.conrelid = to_regclass('public.' || e.table_name)
 and c.contype = 'p'
left join pg_index i on i.indexrelid = c.conindid
left join lateral (
  select array_agg(a.attname::text order by key_position.ordinality) as names
  from unnest(c.conkey) with ordinality as key_position(attnum, ordinality)
  join pg_attribute a
    on a.attrelid = c.conrelid
   and a.attnum = key_position.attnum
) key_columns on true
order by e.table_name;

-- PASS: all six distributed-limiter bounds report exact_one_validated = true.
with expected(marker) as (
  values
    ('^[a-z0-9][a-z0-9:_-]{0,63}$'),
    ('^[0-9a-f]{64}$'),
    ('window_seconds >= 1'),
    ('window_seconds <= 2592000'),
    ('request_count >= 1'),
    ('request_count <= 10001')
)
select
  e.marker,
  count(c.oid) = 1 and coalesce(bool_and(c.convalidated), false)
    as exact_one_validated,
  string_agg(pg_get_constraintdef(c.oid), ' | ' order by c.oid) as definition
from expected e
left join pg_constraint c
  on c.conrelid = to_regclass('public.alpha_rate_limit_buckets')
 and c.contype = 'c'
 and position(e.marker in lower(pg_get_constraintdef(c.oid))) > 0
group by e.marker
order by e.marker;

-- PASS: exact_four_checks = true. Unexpected extra checks can throttle or
-- reject traffic differently from the reviewed distributed-limiter schema.
select count(*) = 4 as exact_four_checks
from pg_constraint c
where c.conrelid = to_regclass('public.alpha_rate_limit_buckets')
  and c.contype = 'c';

-- PASS: all 40 rows report exists = true and shape_matches = true. Defaults
-- are checked only where the migration defines one. Every other added column
-- must retain no default.
with expected(
  table_name,
  column_name,
  expected_udt_name,
  expected_is_nullable,
  default_kind
) as (
  values
    ('stripe_webhook_events', 'status', 'text', 'NO', 'succeeded'),
    ('stripe_webhook_events', 'lease_token', 'uuid', 'YES', 'none'),
    ('stripe_webhook_events', 'lease_expires_at', 'timestamptz', 'YES', 'none'),
    ('stripe_webhook_events', 'updated_at', 'timestamptz', 'NO', 'now'),
    ('account_deletion_sagas', 'reconcile_last_error_code', 'text', 'YES', 'none'),
    ('account_deletion_sagas', 'reconcile_dead_lettered_at', 'timestamptz', 'YES', 'none'),
    ('resend_webhook_events', 'event_at', 'timestamptz', 'YES', 'none'),
    ('resend_webhook_events', 'recipient_hashes', '_text', 'NO', 'empty_array'),
    ('resend_webhook_events', 'owner_user_id', 'uuid', 'YES', 'none'),
    ('resend_webhook_events', 'resolution_status', 'text', 'NO', 'pending_owner'),
    ('resend_webhook_events', 'review_required_at', 'timestamptz', 'YES', 'none'),
    ('resend_webhook_events', 'resolved_at', 'timestamptz', 'YES', 'none'),
    ('users', 'stripe_subscription_id', 'text', 'YES', 'none'),
    ('users', 'access_requested_at', 'timestamptz', 'YES', 'none'),
    ('users', 'access_granted_at', 'timestamptz', 'YES', 'none'),
    ('users', 'delivery_suppression_cleared_at', 'timestamptz', 'YES', 'none'),
    ('users', 'suppression_recovery_token', 'uuid', 'YES', 'none'),
    ('users', 'suppression_recovery_started_at', 'timestamptz', 'YES', 'none'),
    ('users', 'suppression_recovery_snapshot', 'jsonb', 'YES', 'none'),
    ('users', 'suppression_cleanup_pending_at', 'timestamptz', 'YES', 'none'),
    ('users', 'suppression_cleanup_next_attempt_at', 'timestamptz', 'YES', 'none'),
    ('users', 'stripe_email_sync_pending_at', 'timestamptz', 'YES', 'none'),
    ('users', 'stripe_email_sync_next_attempt_at', 'timestamptz', 'YES', 'none'),
    ('users', 'stripe_email_sync_lease_token', 'uuid', 'YES', 'none'),
    ('users', 'stripe_email_sync_lease_expires_at', 'timestamptz', 'YES', 'none'),
    ('users', 'stripe_email_sync_attempt_count', 'int2', 'NO', 'zero'),
    ('users', 'stripe_email_sync_last_error_code', 'text', 'YES', 'none'),
    ('users', 'stripe_email_sync_dead_lettered_at', 'timestamptz', 'YES', 'none'),
    ('users', 'suppression_cleanup_attempt_count', 'int2', 'NO', 'zero'),
    ('users', 'suppression_cleanup_last_error_code', 'text', 'YES', 'none'),
    ('users', 'suppression_cleanup_dead_lettered_at', 'timestamptz', 'YES', 'none'),
    ('users', 'renewal_cancel_pending_at', 'timestamptz', 'YES', 'none'),
    ('users', 'renewal_cancel_customer_id', 'text', 'YES', 'none'),
    ('users', 'renewal_cancel_subscription_id', 'text', 'YES', 'none'),
    ('users', 'renewal_cancel_next_attempt_at', 'timestamptz', 'YES', 'none'),
    ('users', 'renewal_cancel_lease_token', 'uuid', 'YES', 'none'),
    ('users', 'renewal_cancel_lease_expires_at', 'timestamptz', 'YES', 'none'),
    ('users', 'renewal_cancel_attempt_count', 'int2', 'NO', 'zero'),
    ('users', 'renewal_cancel_last_error_code', 'text', 'YES', 'none'),
    ('users', 'renewal_cancel_escalated_at', 'timestamptz', 'YES', 'none')
), actual as (
  select
    e.*,
    c.column_name as actual_column_name,
    c.udt_name as actual_udt_name,
    c.is_nullable as actual_is_nullable,
    c.column_default as actual_default
  from expected e
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = e.table_name
   and c.column_name = e.column_name
)
select
  table_name,
  column_name,
  actual_column_name is not null as exists,
  actual_udt_name,
  actual_is_nullable,
  actual_default,
  actual_column_name is not null
    and actual_udt_name = expected_udt_name
    and actual_is_nullable = expected_is_nullable
    and case default_kind
      when 'none' then actual_default is null
      when 'succeeded' then position('succeeded' in coalesce(actual_default, '')) > 0
      when 'now' then position('now()' in lower(coalesce(actual_default, ''))) > 0
      when 'zero' then regexp_replace(coalesce(actual_default, ''), '[^0-9-]', '', 'g') = '0'
      when 'empty_array' then position('''{}''::text[]' in lower(coalesce(actual_default, ''))) > 0
      when 'pending_owner' then position('pending_owner' in coalesce(actual_default, '')) > 0
      else false
    end as shape_matches
from actual
order by table_name, column_name;

-- PASS: both booleans are true. The migration must deterministically backfill
-- from auth.users.created_at and then make the causal lower bound NOT NULL.
select
  exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'users'
      and c.column_name = 'created_at'
      and c.udt_name = 'timestamptz'
      and c.is_nullable = 'NO'
  ) as users_created_at_is_not_null,
  not exists (
    select 1
    from public.users u
    where u.created_at is null
  ) as zero_users_missing_created_at;

-- PASS: every boolean is true. Future public rows inherit the exact Auth clock
-- instead of a separate transaction-time default.
with f as (
  select lower(pg_get_functiondef(
    to_regprocedure('public.handle_new_user()')
  )) as definition
)
select
  position('if new.created_at is null then' in definition) > 0
    as auth_creation_clock_required,
  position('insert into public.users (id, email, created_at)' in definition) > 0
    as public_insert_includes_created_at,
  position('values (new.id, new.email, new.created_at)' in definition) > 0
    as exact_auth_creation_clock_copied
from f;

-- PASS: both collision counts are zero after apply as well. This preserves the
-- one canonical recipient and one legacy provider-message ownership invariants.
select
  (
    select count(*)
    from (
      select lower(btrim(email))
      from public.users
      group by lower(btrim(email))
      having count(*) > 1
    ) canonical_collisions
  ) as canonical_email_collision_groups,
  (
    select count(*)
    from (
      select resend_message_id
      from public.issues
      where resend_message_id is not null
      group by resend_message_id
      having count(*) > 1
    ) duplicate_messages
  ) as duplicate_legacy_resend_message_groups;

-- PASS: all 14 staged-delivery columns report exists, exact_table_column_count,
-- and shape_matches as true. The retry and acceptance clocks are database data.
with expected(
  column_name,
  expected_udt_name,
  expected_is_nullable,
  default_kind
) as (
  values
    ('attempt_id', 'uuid', 'NO', 'uuid'),
    ('user_id', 'uuid', 'NO', 'none'),
    ('issue_id', 'uuid', 'NO', 'none'),
    ('recipient', 'text', 'NO', 'none'),
    ('delivery_lane', 'text', 'NO', 'none'),
    ('request_fingerprint', 'text', 'NO', 'none'),
    ('started_at', 'timestamptz', 'NO', 'none'),
    ('retry_deadline_at', 'timestamptz', 'NO', 'none'),
    ('manual_review_required_at', 'timestamptz', 'YES', 'none'),
    ('lease_token', 'uuid', 'YES', 'none'),
    ('lease_expires_at', 'timestamptz', 'YES', 'none'),
    ('resend_message_id', 'text', 'YES', 'none'),
    ('accepted_at', 'timestamptz', 'YES', 'none'),
    ('recorded_at', 'timestamptz', 'NO', 'now')
), actual as (
  select
    e.*,
    c.column_name as actual_column_name,
    c.udt_name as actual_udt_name,
    c.is_nullable as actual_is_nullable,
    c.column_default as actual_default
  from expected e
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = 'resend_delivery_attempts'
   and c.column_name = e.column_name
)
select
  column_name,
  actual_column_name is not null as exists,
  (
    select count(*) = 14
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'resend_delivery_attempts'
  ) as exact_table_column_count,
  actual_udt_name,
  actual_is_nullable,
  actual_default,
  actual_column_name is not null
    and actual_udt_name = expected_udt_name
    and actual_is_nullable = expected_is_nullable
    and case default_kind
      when 'none' then actual_default is null
      when 'uuid' then position('gen_random_uuid()' in lower(coalesce(actual_default, ''))) > 0
      when 'now' then position('now()' in lower(coalesce(actual_default, ''))) > 0
      else false
    end as shape_matches
from actual
order by column_name;

-- PASS: every boolean is true. This proves the staged ledger's ownership,
-- fingerprint, one-way finalization, 23-hour retry, lease, and review bounds.
with constraints as (
  select
    c.contype,
    lower(pg_get_constraintdef(c.oid)) as definition
  from pg_constraint c
  where c.conrelid = to_regclass('public.resend_delivery_attempts')
)
select
  count(*) filter (where contype = 'p') = 1 as exact_one_primary_key,
  count(*) filter (where contype = 'u') = 1 as exact_one_message_unique,
  count(*) filter (where contype = 'f') = 1 as exact_one_issue_owner_foreign_key,
  count(*) filter (where contype = 'c') = 8 as exact_eight_checks,
  coalesce(bool_or(
    contype = 'f'
    and position('foreign key (issue_id, user_id)' in definition) > 0
    and position('references issues(id, user_id) on delete cascade' in definition) > 0
  ), false) as issue_owner_fk_cascades,
  coalesce(bool_or(
    contype = 'u'
    and position('unique (resend_message_id)' in definition) > 0
  ), false) as message_id_is_unique,
  coalesce(bool_or(position('request_fingerprint ~ ''^[0-9a-f]{64}$''' in definition) > 0), false)
    as exact_fingerprint_shape,
  coalesce(bool_or(position('delivery_lane = ''live''' in definition) > 0), false)
    as lane_shape_present,
  coalesce(bool_or(position('retry_deadline_at = (started_at + ''23:00:00''::interval)' in definition) > 0
    or position('retry_deadline_at = started_at + ''23:00:00''::interval' in definition) > 0), false)
    as exact_23_hour_retry_window,
  coalesce(bool_or(
    position('lease_token is null' in definition) > 0
    and position('lease_expires_at is null' in definition) > 0
  ), false) as lease_pair_present,
  coalesce(bool_or(
    position('accepted_at >= started_at' in definition) > 0
    and position('resend_message_id is not null' in definition) > 0
  ), false) as one_way_finalization_present,
  coalesce(bool_or(
    position('manual_review_required_at >= retry_deadline_at' in definition) > 0
  ), false) as manual_review_after_retry_deadline
from constraints;

-- PASS: every boolean is true. Both delivery and suppression audit relations
-- are service-read-only, RLS-protected, and have no row policies.
with expected(name) as (
  values ('resend_delivery_attempts'), ('resend_webhook_events')
)
select
  e.name,
  c.oid is not null and c.relkind in ('r', 'p') as exists_as_table,
  coalesce(c.relrowsecurity, false) as rls_enabled,
  coalesce(policies.policy_count, 0) = 0 as has_zero_policies,
  coalesce(has_table_privilege('service_role', c.oid, 'SELECT'), false)
    as service_select,
  not coalesce(has_table_privilege('service_role', c.oid, 'INSERT'), false)
    as service_no_insert,
  not coalesce(has_table_privilege('service_role', c.oid, 'UPDATE'), false)
    as service_no_update,
  not coalesce(has_table_privilege('service_role', c.oid, 'DELETE'), false)
    as service_no_delete,
  not coalesce(has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE'), false)
    as anon_no_write_or_read,
  not coalesce(has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'), false)
    as authenticated_no_write_or_read
from expected e
left join pg_class c on c.oid = to_regclass('public.' || e.name)
left join lateral (
  select count(*) as policy_count
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename = e.name
) policies on true
order by e.name;

-- PASS: all nine audit columns report exists, exact_table_column_count, and
-- shape_matches as true. recipient_hashes stores only SHA-256 hashes.
with expected(
  column_name,
  expected_udt_name,
  expected_is_nullable,
  default_kind
) as (
  values
    ('email_id', 'text', 'NO', 'none'),
    ('type', 'text', 'NO', 'none'),
    ('received_at', 'timestamptz', 'YES', 'now'),
    ('event_at', 'timestamptz', 'YES', 'none'),
    ('recipient_hashes', '_text', 'NO', 'empty_array'),
    ('owner_user_id', 'uuid', 'YES', 'none'),
    ('resolution_status', 'text', 'NO', 'pending_owner'),
    ('review_required_at', 'timestamptz', 'YES', 'none'),
    ('resolved_at', 'timestamptz', 'YES', 'none')
), actual as (
  select
    e.*,
    c.column_name as actual_column_name,
    c.udt_name as actual_udt_name,
    c.is_nullable as actual_is_nullable,
    c.column_default as actual_default
  from expected e
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = 'resend_webhook_events'
   and c.column_name = e.column_name
)
select
  column_name,
  actual_column_name is not null as exists,
  (
    select count(*) = 9
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'resend_webhook_events'
  ) as exact_table_column_count,
  actual_udt_name,
  actual_is_nullable,
  actual_default,
  actual_column_name is not null
    and actual_udt_name = expected_udt_name
    and actual_is_nullable = expected_is_nullable
    and case default_kind
      when 'none' then actual_default is null
      when 'now' then position('now()' in lower(coalesce(actual_default, ''))) > 0
      when 'empty_array' then position('''{}''::text[]' in lower(coalesce(actual_default, ''))) > 0
      when 'pending_owner' then position('pending_owner' in coalesce(actual_default, '')) > 0
      else false
    end as shape_matches
from actual
order by column_name;

-- PASS: every boolean is true. The audit state machine, owner cascade, and
-- pending-review index must exactly match the reviewed migration.
with constraints as (
  select
    c.conname,
    c.contype,
    c.convalidated,
    c.confdeltype,
    lower(pg_get_constraintdef(c.oid)) as definition
  from pg_constraint c
  where c.conrelid = to_regclass('public.resend_webhook_events')
), pending_index as (
  select
    i.indisready,
    i.indisvalid,
    i.indislive,
    lower(pg_get_expr(i.indpred, i.indrelid)) as predicate,
    lower(pg_get_indexdef(i.indexrelid)) as definition
  from pg_index i
  where i.indexrelid = to_regclass(
    'public.resend_webhook_events_pending_review_idx'
  )
)
select
  count(*) filter (where contype = 'p') = 1 as exact_one_audit_primary_key,
  count(*) filter (
    where contype = 'f'
      and confdeltype = 'c'
      and position('foreign key (owner_user_id)' in definition) > 0
      and position('references users(id) on delete cascade' in definition) > 0
  ) = 1 as owner_foreign_key_cascades,
  count(*) filter (
    where conname in (
      'resend_webhook_events_resolution_status_check',
      'resend_webhook_events_resolution_marker_check',
      'resend_webhook_events_event_clock_check'
    )
      and contype = 'c'
      and convalidated
  ) = 3 as exact_three_validated_audit_checks,
  coalesce(bool_or(
    conname = 'resend_webhook_events_resolution_status_check'
    and position('legacy_review' in definition) > 0
    and position('pending_owner' in definition) > 0
    and position('manual_review' in definition) > 0
    and position('applied' in definition) > 0
    and position('causally_ignored' in definition) > 0
  ), false) as exact_resolution_states_present,
  coalesce(bool_or(
    conname = 'resend_webhook_events_resolution_marker_check'
    and position('review_required_at is not null' in definition) > 0
    and position('resolved_at is not null' in definition) > 0
  ), false) as review_resolution_marker_shape_present,
  coalesce(bool_or(
    conname = 'resend_webhook_events_event_clock_check'
    and position('event_at is not null' in definition) > 0
    and position('legacy_review' in definition) > 0
  ), false) as legacy_only_null_event_clock_present,
  coalesce((select indisready and indisvalid and indislive from pending_index), false)
    as pending_review_index_ready,
  coalesce((select position('review_required_at is not null' in predicate) > 0 from pending_index), false)
    as pending_review_index_predicate_present,
  coalesce((select position('(review_required_at, email_id, type)' in definition) > 0 from pending_index), false)
    as pending_review_index_columns_present
from constraints;

-- PASS: every invalid count is zero. The unresolved counts are operational
-- evidence and must be reviewed. legacy_review, pending_owner, and
-- manual_review remain deliberately visible until a human resolves them.
select
  count(*) filter (where resolution_status = 'legacy_review')
    as legacy_review,
  count(*) filter (where resolution_status = 'pending_owner')
    as pending_owner,
  count(*) filter (where resolution_status = 'manual_review')
    as manual_review,
  count(*) filter (
    where resolution_status in ('legacy_review', 'pending_owner', 'manual_review')
  ) as unresolved_suppression_reviews,
  count(*) filter (
    where resolution_status not in (
      'legacy_review',
      'pending_owner',
      'manual_review',
      'applied',
      'causally_ignored'
    )
  ) as invalid_resolution_status,
  count(*) filter (
    where (
      resolution_status in ('legacy_review', 'pending_owner', 'manual_review')
      and (review_required_at is null or resolved_at is not null)
    ) or (
      resolution_status in ('applied', 'causally_ignored')
      and (review_required_at is not null or resolved_at is null)
    )
  ) as invalid_resolution_markers,
  count(*) filter (
    where event_at is null and resolution_status <> 'legacy_review'
  ) as invalid_event_clock_state,
  count(*) filter (
    where exists (
      select 1
      from unnest(recipient_hashes) recipient_hash
      where recipient_hash !~ '^[0-9a-f]{64}$'
    )
  ) as invalid_recipient_hash_rows
from public.resend_webhook_events;

-- PASS before any release: every unresolved delivery count is zero. An expired
-- unfinalized attempt is visible even before a retry stamps manual review.
select
  count(*) filter (
    where resend_message_id is null
      and lease_expires_at > now()
  ) as active_delivery_leases,
  count(*) filter (
    where resend_message_id is null
      and retry_deadline_at <= now()
      and manual_review_required_at is null
  ) as expired_attempts_awaiting_review_stamp,
  count(*) filter (
    where resend_message_id is null
      and manual_review_required_at is not null
  ) as delivery_attempts_in_manual_review,
  (
    select count(*)
    from (
      select issue_id
      from public.resend_delivery_attempts
      where resend_message_id is null
      group by issue_id
      having count(*) > 1
    ) cross_lane
  ) as issues_with_multiple_unresolved_lanes
from public.resend_delivery_attempts;

-- PASS: all 21 named constraints exist on their expected tables, are CHECK
-- constraints, and report validated = true. Compare every returned definition
-- to its migration source before accepting the result.
with expected(name, table_name) as (
  values
    ('account_deletion_sagas_reconcile_attempt_count_check', 'account_deletion_sagas'),
    ('account_deletion_sagas_reconcile_error_code_check', 'account_deletion_sagas'),
    ('account_deletion_sagas_reconcile_marker_check', 'account_deletion_sagas'),
    ('resend_webhook_events_resolution_status_check', 'resend_webhook_events'),
    ('resend_webhook_events_resolution_marker_check', 'resend_webhook_events'),
    ('resend_webhook_events_event_clock_check', 'resend_webhook_events'),
    ('users_suppression_recovery_state_check', 'users'),
    ('users_stripe_email_sync_lease_pair', 'users'),
    ('users_delivery_retry_deadlines_require_pending', 'users'),
    ('users_stripe_customer_id_format_check', 'users'),
    ('users_stripe_subscription_id_format_check', 'users'),
    ('users_stripe_subscription_requires_customer_check', 'users'),
    ('users_renewal_cancel_attempt_count_check', 'users'),
    ('users_renewal_cancel_last_error_code_check', 'users'),
    ('users_renewal_cancel_marker_shape_check', 'users'),
    ('users_stripe_email_sync_attempt_count_check', 'users'),
    ('users_stripe_email_sync_error_code_check', 'users'),
    ('users_stripe_email_sync_retry_marker_check', 'users'),
    ('users_suppression_cleanup_attempt_count_check', 'users'),
    ('users_suppression_cleanup_error_code_check', 'users'),
    ('users_suppression_cleanup_retry_marker_check', 'users')
)
select
  e.name,
  e.table_name,
  c.oid is not null as exists,
  coalesce(c.contype = 'c', false) as is_check_constraint,
  coalesce(c.convalidated, false) as validated,
  pg_get_constraintdef(c.oid) as definition
from expected e
left join pg_constraint c
  on c.conname = e.name
 and c.conrelid = to_regclass('public.' || e.table_name)
order by e.name;

-- PASS: exactly one validated CHECK constraint on stripe_webhook_events.status
-- contains both allowed states. This unnamed constraint is created with the
-- status column and is separate from the 17 named constraints above.
select
  count(*) = 1 as exact_one_status_check,
  coalesce(bool_and(c.convalidated), false) as validated,
  string_agg(pg_get_constraintdef(c.oid), ' | ' order by c.oid) as definition
from pg_constraint c
where c.conrelid = to_regclass('public.stripe_webhook_events')
  and c.contype = 'c'
  and position('status' in lower(pg_get_constraintdef(c.oid))) > 0
  and position('processing' in lower(pg_get_constraintdef(c.oid))) > 0
  and position('succeeded' in lower(pg_get_constraintdef(c.oid))) > 0;

-- PASS: all 37 rows report exists, on_expected_table, uniqueness_matches,
-- ready, valid, and live as true. Compare definition to the migration source,
-- including keys and predicates.
with expected(name, table_name, expected_unique) as (
  values
    ('account_deletion_alpha_subscription_reservation_idx', 'account_deletion_alpha_subscriptions', true),
    ('account_deletion_sagas_completed_purge_idx', 'account_deletion_sagas', false),
    ('account_deletion_sagas_exact_subscription_idx', 'account_deletion_sagas', true),
    ('account_deletion_sagas_reconcile_dead_letter_idx', 'account_deletion_sagas', false),
    ('account_deletion_sagas_reconcile_due_idx', 'account_deletion_sagas', false),
    ('alpha_quantity_update_leases_expiry_idx', 'alpha_quantity_update_leases', false),
    ('alpha_rate_limit_buckets_expiry_idx', 'alpha_rate_limit_buckets', false),
    ('checkout_creation_reviews_pending_created_idx', 'checkout_creation_reviews', false),
    ('checkout_fulfillments_terminal_scrub_idx', 'checkout_fulfillments', false),
    ('checkout_profiles_active_email_idx', 'checkout_profiles', true),
    ('checkout_profiles_active_owner_idx', 'checkout_profiles', true),
    ('checkout_profiles_creation_lease_idx', 'checkout_profiles', false),
    ('checkout_profiles_customer_state_idx', 'checkout_profiles', false),
    ('checkout_profiles_operational_expiry_idx', 'checkout_profiles', false),
    ('checkout_profiles_recovery_dead_letter_idx', 'checkout_profiles', false),
    ('checkout_profiles_recovery_lease_idx', 'checkout_profiles', false),
    ('checkout_profiles_terminal_scrub_idx', 'checkout_profiles', false),
    ('legacy_checkout_fulfillments_dead_letter_idx', 'legacy_checkout_fulfillments', false),
    ('legacy_checkout_fulfillments_subscription_idx', 'legacy_checkout_fulfillments', true),
    ('issues_id_user_id_uidx', 'issues', true),
    ('issues_resend_message_id_idx', 'issues', false),
    ('refund_reviews_current_cleanup_loser_idx', 'refund_reviews', false),
    ('refund_reviews_pending_created_idx', 'refund_reviews', false),
    ('refund_reviews_resolved_retention_idx', 'refund_reviews', false),
    ('resend_delivery_attempts_issue_lane_uidx', 'resend_delivery_attempts', true),
    ('resend_delivery_attempts_user_idx', 'resend_delivery_attempts', false),
    ('resend_webhook_events_pending_review_idx', 'resend_webhook_events', false),
    ('resend_webhook_events_unowned_retention_idx', 'resend_webhook_events', false),
    ('users_pending_access_request_idx', 'users', false),
    ('users_renewal_cancel_escalated_idx', 'users', false),
    ('users_renewal_cancel_pending_idx', 'users', false),
    ('users_stripe_email_sync_pending_idx', 'users', false),
    ('users_stripe_email_sync_dead_letter_idx', 'users', false),
    ('users_stripe_subscription_id_unique_idx', 'users', true),
    ('users_suppression_recovery_pending_idx', 'users', false),
    ('users_suppression_cleanup_pending_idx', 'users', false),
    ('users_suppression_cleanup_dead_letter_idx', 'users', false)
)
select
  e.name,
  i.indexrelid is not null as exists,
  coalesce(tn.nspname = 'public' and tbl.relname = e.table_name, false)
    as on_expected_table,
  coalesce(i.indisunique = e.expected_unique, false) as uniqueness_matches,
  coalesce(i.indisready, false) as ready,
  coalesce(i.indisvalid, false) as valid,
  coalesce(i.indislive, false) as live,
  pg_get_expr(i.indpred, i.indrelid) as predicate,
  pg_get_indexdef(i.indexrelid) as definition
from expected e
left join pg_namespace ni on ni.nspname = 'public'
left join pg_class ci
  on ci.relnamespace = ni.oid
 and ci.relname = e.name
left join pg_index i on i.indexrelid = ci.oid
left join pg_class tbl on tbl.oid = i.indrelid
left join pg_namespace tn on tn.oid = tbl.relnamespace
order by e.name;

-- PASS: every boolean is true. Pending requests remain indexed until an
-- explicit grant, even when an older billing entitlement is still present.
with installed_index as (
  select lower((
    select pg_get_expr(i.indpred, i.indrelid)
    from pg_index i
    where i.indexrelid = to_regclass('public.users_pending_access_request_idx')
  )) as predicate
)
select
  predicate is not null as predicate_present,
  position('access_requested_at is not null' in predicate) > 0
    as has_request_marker,
  position('access_granted_at is null' in predicate) > 0
    as has_ungranted_marker,
  position('subscribed_at' in predicate) = 0
    as ignores_legacy_entitlement_marker
from installed_index;

-- PASS: all 17 rows report exists, enabled_normally, and
-- calls_expected_function as true. The list includes all 16 new triggers and
-- the pre-existing protected-column trigger relied on by the final function.
with expected(trigger_name, table_name, function_name) as (
  values
    ('account_deletion_abort_legacy_checkout', 'account_deletion_sagas', 'abort_legacy_checkout_for_account_deletion'),
    ('account_deletion_active_delivery_guard', 'account_deletion_sagas', 'block_account_deletion_with_active_delivery'),
    ('users_suppression_recovery_identity_guard', 'users', 'block_identity_change_with_suppression_recovery'),
    ('auth_users_suppression_recovery_identity_guard', 'auth.users', 'block_auth_identity_change_with_suppression_recovery'),
    ('account_deletion_scrub_legacy_checkout', 'account_deletion_sagas', 'scrub_legacy_checkout_after_account_deletion'),
    ('checkout_profiles_block_billing_pair_conflict', 'checkout_profiles', 'block_checkout_billing_pair_conflict'),
    ('checkout_profiles_block_deleting_owner', 'checkout_profiles', 'block_checkout_for_deleting_owner'),
    ('issues_block_mutation_during_account_deletion', 'issues', 'block_issue_mutation_during_account_deletion'),
    ('legacy_checkout_billing_pair_conflict', 'legacy_checkout_fulfillments', 'block_legacy_checkout_billing_pair_conflict'),
    ('protect_user_privileged_columns_trg', 'users', 'protect_user_privileged_columns'),
    ('support_tickets_block_mutation_during_account_deletion', 'support_tickets', 'block_support_ticket_mutation_during_account_deletion'),
    ('users_active_delivery_state_guard', 'users', 'block_user_delivery_change_with_active_attempt'),
    ('users_block_billing_pair_conflict', 'users', 'block_user_billing_pair_conflict'),
    ('users_block_billing_rebind_during_account_deletion', 'users', 'block_billing_rebind_during_account_deletion'),
    ('users_block_legacy_duplicate_winner_mutation', 'users', 'block_user_legacy_duplicate_winner_mutation'),
    ('users_block_mutation_during_account_deletion', 'users', 'block_user_mutation_during_account_deletion'),
    ('users_normalize_delivery_retry_deadlines', 'users', 'normalize_delivery_retry_deadlines')
)
select
  e.trigger_name,
  e.table_name,
  t.oid is not null as exists,
  coalesce(t.tgenabled = 'O', false) as enabled_normally,
  coalesce(p.proname = e.function_name, false) as calls_expected_function,
  pg_get_triggerdef(t.oid) as definition
from expected e
left join pg_class rel
  on rel.oid = to_regclass(case when e.table_name = 'auth.users' then e.table_name else 'public.' || e.table_name end)
left join pg_trigger t
  on t.tgrelid = rel.oid
 and t.tgname = e.trigger_name
 and not t.tgisinternal
left join pg_proc p on p.oid = t.tgfoid
order by e.trigger_name;

-- PASS: every boolean is true. The user guard fires before delivery-critical
-- updates. The deletion guard fires before saga inserts and updates.
with selected as (
  select
    lower(pg_get_triggerdef(user_trigger.oid)) as user_definition,
    lower(pg_get_triggerdef(deletion_trigger.oid)) as deletion_definition
  from pg_trigger user_trigger
  cross join pg_trigger deletion_trigger
  where user_trigger.tgrelid = to_regclass('public.users')
    and user_trigger.tgname = 'users_active_delivery_state_guard'
    and not user_trigger.tgisinternal
    and deletion_trigger.tgrelid = to_regclass('public.account_deletion_sagas')
    and deletion_trigger.tgname = 'account_deletion_active_delivery_guard'
    and not deletion_trigger.tgisinternal
)
select
  position('before update of email' in user_definition) > 0
    as user_guard_is_before_critical_updates,
  position('unsubscribed_at' in user_definition) > 0
    and position('bounced_at' in user_definition) > 0
    and position('complained_at' in user_definition) > 0
    and position('suppression_cleanup_pending_at' in user_definition) > 0
    and position('delivery_suppression_cleared_at' in user_definition) > 0
    as user_guard_covers_delivery_state,
  position('before insert or update' in deletion_definition) > 0
    as deletion_guard_is_before_saga_start
from selected;

-- PASS: all 112 distinct Round 80 function names report overload_count = 1,
-- exactly_one_function = true, all_security_definer = true, and
-- all_pinned_search_path = true. The identity-signature output is release
-- evidence and makes an unexpected overload visible.
with expected(name) as (
  values
    ('abort_current_checkout_duplicate_fulfillment'),
    ('abort_legacy_checkout_for_account_deletion'),
    ('abort_legacy_checkout_fulfillment'),
    ('advance_weekly_send_cursor'),
    ('alpha_scheduled_maintenance_due'),
    ('apply_resend_suppression_to_user'),
    ('authorize_stripe_email_sync'),
    ('begin_account_deletion_auth_removal'),
    ('begin_checkout_session_creation'),
    ('bind_account_deletion_subscription'),
    ('bind_checkout_session'),
    ('bind_existing_alpha_subscription'),
    ('block_account_deletion_with_active_delivery'),
    ('block_identity_change_with_suppression_recovery'),
    ('block_auth_identity_change_with_suppression_recovery'),
    ('block_billing_rebind_during_account_deletion'),
    ('block_checkout_billing_pair_conflict'),
    ('block_checkout_for_deleting_owner'),
    ('block_issue_mutation_during_account_deletion'),
    ('block_legacy_checkout_billing_pair_conflict'),
    ('block_support_ticket_mutation_during_account_deletion'),
    ('block_user_billing_pair_conflict'),
    ('block_user_delivery_change_with_active_attempt'),
    ('block_user_legacy_duplicate_winner_mutation'),
    ('block_user_mutation_during_account_deletion'),
    ('claim_alpha_quantity_update'),
    ('claim_alpha_renewal_cancellation'),
    ('claim_alpha_renewal_cancellation_retirement'),
    ('claim_checkout_fulfillment'),
    ('claim_checkout_profile_recovery'),
    ('claim_checkout_session_creation_replay'),
    ('claim_legacy_checkout_fulfillment'),
    ('claim_resend_delivery_attempt'),
    ('claim_resend_suppression_recovery'),
    ('finalize_resend_suppression_recovery'),
    ('resend_suppression_recovery_snapshot'),
    ('claim_stripe_email_sync'),
    ('claim_stripe_webhook_event'),
    ('complete_account_deletion'),
    ('complete_checkout_creation_review_with_session'),
    ('complete_checkout_fulfillment'),
    ('complete_legacy_checkout_fulfillment'),
    ('complete_stripe_email_sync'),
    ('confirm_account_deletion_billing'),
    ('consume_alpha_rate_limit'),
    ('count_dead_lettered_account_deletions'),
    ('count_dead_lettered_checkout_profiles'),
    ('count_dead_lettered_legacy_checkout_fulfillments'),
    ('count_dead_lettered_stripe_email_sync'),
    ('count_dead_lettered_suppression_cleanups'),
    ('count_pending_alpha_renewal_cancellations'),
    ('count_pending_checkout_creation_reviews'),
    ('count_pending_refund_reviews'),
    ('count_prunable_resolved_refund_reviews'),
    ('count_unresolved_refund_reviews'),
    ('defer_account_deletion_reconciliation'),
    ('defer_checkout_profile_recovery_candidate'),
    ('defer_legacy_checkout_fulfillment'),
    ('fail_account_deletion_reconciliation'),
    ('fail_checkout_profile_recovery'),
    ('fail_legacy_checkout_fulfillment'),
    ('fail_stripe_email_sync'),
    ('fail_suppression_cleanup'),
    ('finalize_resend_delivery_attempt'),
    ('finalize_stale_checkout_fulfillments'),
    ('find_legacy_current_checkout_conflict'),
    ('handle_new_user'),
    ('hold_checkout_session_creation_for_invite_review'),
    ('list_legacy_fulfillments_awaiting_issue'),
    ('list_pending_legacy_duplicate_finalizations'),
    ('list_stale_checkout_session_creations'),
    ('list_stale_pending_legacy_fulfillments'),
    ('mark_account_deletion_support_deleted'),
    ('mark_account_deletion_delivery_policy_settled'),
    ('normalize_delivery_retry_deadlines'),
    ('prepare_account_deletion'),
    ('protect_user_privileged_columns'),
    ('prune_completed_account_deletion_sagas'),
    ('prune_unowned_resend_webhook_events'),
    ('prune_resolved_refund_reviews'),
    ('record_account_deletion_subscription'),
    ('record_current_checkout_duplicate_refund_review'),
    ('record_legacy_current_checkout_conflict_refund_review'),
    ('record_legacy_duplicate_refund_review'),
    ('record_refund_review'),
    ('record_resend_suppression_event'),
    ('record_webhook_duplicate_refund_review'),
    ('recover_checkout_profile_provisioning'),
    ('release_alpha_quantity_update'),
    ('release_alpha_renewal_cancellation_lease'),
    ('release_checkout_session_creation_replay'),
    ('release_stripe_email_sync'),
    ('requeue_checkout_profile_recovery'),
    ('requeue_legacy_checkout_fulfillment'),
    ('requeue_account_deletion_reconciliation'),
    ('requeue_stripe_email_sync'),
    ('requeue_suppression_cleanup'),
    ('reserve_alpha_paid_calls'),
    ('resolve_checkout_creation_review_no_create'),
    ('resolve_refund_review'),
    ('retire_alpha_renewal_cancellation_marker'),
    ('scrub_legacy_checkout_after_account_deletion'),
    ('scrub_terminal_checkout_tombstones'),
    ('settle_account_deletion_checkout_profile'),
    ('settle_alpha_renewal_cancellation'),
    ('settle_alpha_renewal_cancellation_no_access'),
    ('settle_checkout_profile_recovery'),
    ('settle_checkout_session_creation_replay'),
    ('settle_checkout_session_expiration'),
    ('settle_legacy_fulfillment_awaiting_issue'),
    ('stage_checkout_profile'),
    ('watchdog_delivery_check')
)
select
  e.name,
  count(p.oid) as overload_count,
  count(p.oid) = 1 and coalesce(bool_and(p.prokind = 'f'), false)
    as exactly_one_function,
  coalesce(bool_and(p.prosecdef), false) as all_security_definer,
  coalesce(bool_and(coalesce(
    exists (
      select 1
      from unnest(p.proconfig) setting
      where regexp_replace(setting, '\s', '', 'g') in (
        'search_path=public',
        'search_path=public,pg_temp'
      )
    ),
    false
  )), false) as all_pinned_search_path,
  string_agg(
    pg_get_function_identity_arguments(p.oid),
    ' | '
    order by p.oid
  ) as identity_signatures
from expected e
left join pg_namespace n on n.nspname = 'public'
left join pg_proc p
  on p.pronamespace = n.oid
 and p.proname = e.name
group by e.name
order by e.name;

-- PASS: all 91 exact service RPC signatures report exists,
-- security_definer, pinned_search_path, and service_execute as true. Both
-- anon_no_execute and authenticated_no_execute must be true. An EXECUTE grant
-- inherited from PUBLIC makes those negative checks fail.
with expected(signature) as (
  values
    ('public.abort_current_checkout_duplicate_fulfillment(text,uuid,uuid,uuid,text,text,text,text)'),
    ('public.abort_legacy_checkout_fulfillment(text,uuid,text,text,text,text)'),
    ('public.advance_weekly_send_cursor(date,uuid,uuid)'),
    ('public.alpha_scheduled_maintenance_due(timestamptz)'),
    ('public.authorize_stripe_email_sync(uuid,uuid,text,timestamptz,text)'),
    ('public.begin_account_deletion_auth_removal(uuid)'),
    ('public.begin_checkout_session_creation(uuid,text,text,integer,text)'),
    ('public.bind_account_deletion_subscription(uuid,text,text,text)'),
    ('public.bind_checkout_session(uuid,text)'),
    ('public.bind_existing_alpha_subscription(uuid,text,text,text,integer,timestamptz,timestamptz,timestamptz,integer)'),
    ('public.claim_alpha_quantity_update(uuid,uuid,integer)'),
    ('public.claim_alpha_renewal_cancellation_retirement(uuid,text,text,uuid,integer)'),
    ('public.claim_alpha_renewal_cancellation(uuid,text,text,uuid,integer)'),
    ('public.claim_checkout_fulfillment(text,uuid,text,uuid,date,uuid,integer)'),
    ('public.claim_checkout_profile_recovery(uuid,text,text,uuid,integer)'),
    ('public.claim_checkout_session_creation_replay(uuid,uuid,integer)'),
    ('public.claim_legacy_checkout_fulfillment(text,text,uuid,text,text,date,uuid,integer)'),
    ('public.claim_resend_delivery_attempt(uuid,date,text,text,text,uuid,timestamptz)'),
    ('public.claim_resend_suppression_recovery(uuid)'),
    ('public.finalize_resend_suppression_recovery(uuid,uuid)'),
    ('public.claim_stripe_email_sync(uuid,uuid)'),
    ('public.claim_stripe_webhook_event(text,text,uuid,integer)'),
    ('public.complete_account_deletion(uuid)'),
    ('public.complete_checkout_creation_review_with_session(uuid,text)'),
    ('public.complete_checkout_fulfillment(text,uuid,uuid,uuid,text,text,timestamptz,text,text,boolean)'),
    ('public.complete_legacy_checkout_fulfillment(text,uuid,uuid)'),
    ('public.complete_stripe_email_sync(uuid,uuid,text,timestamptz,text)'),
    ('public.confirm_account_deletion_billing(uuid)'),
    ('public.consume_alpha_rate_limit(text,text,integer,integer)'),
    ('public.count_dead_lettered_account_deletions()'),
    ('public.count_dead_lettered_checkout_profiles()'),
    ('public.count_dead_lettered_legacy_checkout_fulfillments()'),
    ('public.count_dead_lettered_stripe_email_sync()'),
    ('public.count_dead_lettered_suppression_cleanups()'),
    ('public.count_pending_alpha_renewal_cancellations()'),
    ('public.count_pending_checkout_creation_reviews()'),
    ('public.count_pending_refund_reviews()'),
    ('public.count_prunable_resolved_refund_reviews(timestamptz)'),
    ('public.count_unresolved_refund_reviews()'),
    ('public.defer_account_deletion_reconciliation(uuid,timestamptz)'),
    ('public.defer_checkout_profile_recovery_candidate(uuid,uuid,text,text,text,timestamptz,uuid,text,timestamptz)'),
    ('public.defer_legacy_checkout_fulfillment(text,uuid,uuid)'),
    ('public.fail_account_deletion_reconciliation(uuid,text,timestamptz)'),
    ('public.fail_checkout_profile_recovery(uuid,uuid,text,timestamptz)'),
    ('public.fail_legacy_checkout_fulfillment(text,uuid,text,timestamptz)'),
    ('public.fail_stripe_email_sync(uuid,uuid,text,timestamptz)'),
    ('public.fail_suppression_cleanup(uuid,timestamptz,text,timestamptz,timestamptz,timestamptz,text,text,timestamptz,timestamptz,timestamptz,text,timestamptz)'),
    ('public.finalize_resend_delivery_attempt(uuid,date,text,uuid,text,text)'),
    ('public.finalize_stale_checkout_fulfillments(timestamptz,integer)'),
    ('public.find_legacy_current_checkout_conflict(text,uuid,uuid)'),
    ('public.hold_checkout_session_creation_for_invite_review(uuid,timestamptz)'),
    ('public.list_legacy_fulfillments_awaiting_issue(timestamptz,integer)'),
    ('public.list_pending_legacy_duplicate_finalizations(integer)'),
    ('public.list_stale_checkout_session_creations(timestamptz,integer)'),
    ('public.list_stale_pending_legacy_fulfillments(timestamptz,integer)'),
    ('public.mark_account_deletion_support_deleted(uuid)'),
    ('public.mark_account_deletion_delivery_policy_settled(uuid)'),
    ('public.prepare_account_deletion(uuid)'),
    ('public.prune_completed_account_deletion_sagas(integer)'),
    ('public.prune_unowned_resend_webhook_events(integer)'),
    ('public.prune_resolved_refund_reviews(timestamptz,integer)'),
    ('public.record_account_deletion_subscription(uuid,text,text,text)'),
    ('public.record_current_checkout_duplicate_refund_review(text,uuid,uuid,uuid,text,text,text,text)'),
    ('public.record_legacy_current_checkout_conflict_refund_review(text,uuid,uuid,text,text)'),
    ('public.record_legacy_duplicate_refund_review(text,uuid,uuid,text,text)'),
    ('public.record_refund_review(text,text,text,text)'),
    ('public.record_resend_suppression_event(text,text,timestamptz,text[])'),
    ('public.record_webhook_duplicate_refund_review(text,uuid,text,date,text,text,text,text)'),
    ('public.recover_checkout_profile_provisioning(uuid,text,text,uuid,boolean,text,text,boolean)'),
    ('public.release_alpha_quantity_update(uuid,uuid)'),
    ('public.release_alpha_renewal_cancellation_lease(uuid,text,text,uuid,integer,text)'),
    ('public.release_checkout_session_creation_replay(uuid,uuid)'),
    ('public.release_stripe_email_sync(uuid,uuid)'),
    ('public.requeue_checkout_profile_recovery(uuid)'),
    ('public.requeue_legacy_checkout_fulfillment(text)'),
    ('public.requeue_account_deletion_reconciliation(uuid)'),
    ('public.requeue_stripe_email_sync(uuid)'),
    ('public.requeue_suppression_cleanup(uuid)'),
    ('public.reserve_alpha_paid_calls(date,integer)'),
    ('public.resolve_checkout_creation_review_no_create(uuid,text)'),
    ('public.resolve_refund_review(text,text,text)'),
    ('public.retire_alpha_renewal_cancellation_marker(uuid,text,text,uuid)'),
    ('public.scrub_terminal_checkout_tombstones(timestamptz,integer)'),
    ('public.settle_account_deletion_checkout_profile(uuid,uuid,text,text,text,text)'),
    ('public.settle_alpha_renewal_cancellation_no_access(uuid,text,text,uuid)'),
    ('public.settle_alpha_renewal_cancellation(uuid,text,text,uuid,timestamptz)'),
    ('public.settle_checkout_profile_recovery(uuid,uuid,text,text,text)'),
    ('public.settle_checkout_session_creation_replay(uuid,uuid,timestamptz,text,text)'),
    ('public.settle_checkout_session_expiration(uuid,text)'),
    ('public.settle_legacy_fulfillment_awaiting_issue(text,timestamptz)'),
    ('public.stage_checkout_profile(uuid,text,text,text,text,text,text,text,date,text,text[],text,text,uuid)')
)
select
  e.signature,
  p.oid is not null and p.prokind = 'f' as exists,
  coalesce(p.prosecdef, false) as security_definer,
  coalesce(exists (
    select 1
    from unnest(p.proconfig) setting
    where regexp_replace(setting, '\s', '', 'g') in (
      'search_path=public',
      'search_path=public,pg_temp'
    )
  ), false) as pinned_search_path,
  coalesce(has_function_privilege('service_role', p.oid, 'EXECUTE'), false)
    as service_execute,
  not coalesce(has_function_privilege('anon', p.oid, 'EXECUTE'), false)
    as anon_no_execute,
  not coalesce(has_function_privilege('authenticated', p.oid, 'EXECUTE'), false)
    as authenticated_no_execute,
  pg_get_function_result(p.oid) as result_type
from expected e
left join pg_proc p on p.oid = to_regprocedure(e.signature)
order by e.signature;

-- BEGIN INVITE CHECKOUT REVIEW PROOF
-- PASS: every boolean is true. Invite-mode holds must preserve uncertain
-- provider requests, honor live leases, and stop later automatic paid replay.
with bodies as (
  select
    lower(pg_get_functiondef(to_regprocedure(
      'public.hold_checkout_session_creation_for_invite_review(uuid,timestamptz)'
    ))) as hold_definition,
    lower(pg_get_functiondef(to_regprocedure(
      'public.claim_checkout_session_creation_replay(uuid,uuid,integer)'
    ))) as replay_definition,
    lower(pg_get_functiondef(to_regprocedure(
      'public.list_stale_checkout_session_creations(timestamptz,integer)'
    ))) as list_definition
)
select
  position('pg_advisory_xact_lock' in hold_definition) > 0
    and position('for update' in hold_definition) > 0
    and position('profile_owner_conflict' in hold_definition) > 0
    as invite_hold_serializes_and_rechecks_owner,
  position('session_creation_lease_expires_at > p_now' in hold_definition) > 0
    and position('session_creation_replay_lease_expires_at > p_now' in hold_definition) > 0
    and position('return ''in_progress''' in hold_definition)
      < position('insert into public.checkout_creation_reviews' in hold_definition)
    as invite_hold_honors_provider_leases,
  position('update public.checkout_profiles' in hold_definition) = 0
    and position('delete from public.checkout_profiles' in hold_definition) = 0
    and position('invite_mode_transition' in hold_definition) > 0
    as invite_hold_preserves_exact_request_and_binding,
  position('review.status = ''pending''' in replay_definition) > 0
    and position('select ''manual_review''::text' in replay_definition) > 0
    and position('select ''manual_review''::text' in replay_definition)
      < position('update public.checkout_profiles' in replay_definition)
    as pending_review_blocks_paid_replay_claim,
  position('not exists' in list_definition) > 0
    and position('review.status = ''pending''' in list_definition) > 0
    and position('p_limit between 1 and 10' in list_definition) > 0
    as pending_reviews_leave_bounded_replay_queue,
  exists (
    select 1 from pg_constraint constraint_row
     where constraint_row.conrelid = 'public.checkout_creation_reviews'::regclass
       and constraint_row.contype = 'c'
       and constraint_row.convalidated
       and position('invite_mode_transition' in pg_get_constraintdef(constraint_row.oid)) > 0
       and position('replay_window_missed' in pg_get_constraintdef(constraint_row.oid)) > 0
  ) as invite_review_reason_is_validated
from bodies;
-- END INVITE CHECKOUT REVIEW PROOF

-- PASS: every boolean is true. These exact installed bodies are the staged
-- delivery, causal suppression, fast-webhook replay, and race-guard contract.
with bodies as (
  select
    lower(pg_get_functiondef(to_regprocedure(
      'public.claim_resend_delivery_attempt(uuid,date,text,text,text,uuid,timestamptz)'
    ))) as claim_definition,
    lower(pg_get_functiondef(to_regprocedure(
      'public.finalize_resend_delivery_attempt(uuid,date,text,uuid,text,text)'
    ))) as finalize_definition,
    lower(pg_get_functiondef(to_regprocedure(
      'public.record_resend_suppression_event(text,text,timestamptz,text[])'
    ))) as record_definition,
    lower(pg_get_functiondef(to_regprocedure(
      'public.apply_resend_suppression_to_user(uuid,text[],text,timestamptz)'
    ))) as apply_definition,
    lower(pg_get_functiondef(to_regprocedure(
      'public.block_user_delivery_change_with_active_attempt()'
    ))) as user_guard_definition,
    lower(pg_get_functiondef(to_regprocedure(
      'public.block_account_deletion_with_active_delivery()'
    ))) as deletion_guard_definition
)
select
  position('from public.users' in claim_definition) > 0
    and position('for update' in claim_definition) > 0
    as claim_locks_and_rechecks_user,
  position('lower(btrim(v_user.email)) <> p_recipient' in claim_definition) > 0
    and position('v_user.created_at is null' in claim_definition) > 0
    and position('v_user.unsubscribed_at is not null' in claim_definition) > 0
    and position('v_user.bounced_at is not null' in claim_definition) > 0
    and position('v_user.complained_at is not null' in claim_definition) > 0
    and position('v_user.suppression_cleanup_pending_at is not null' in claim_definition) > 0
    as claim_rechecks_exact_delivery_eligibility,
  position('from public.account_deletion_sagas' in claim_definition) > 0
    and position('where s.user_id = p_user_id' in claim_definition) > 0
    as claim_rejects_any_deletion_saga,
  position('a.delivery_lane <> p_delivery_lane' in claim_definition) > 0
    and position('a.resend_message_id is null' in claim_definition) > 0
    and position('other_lane_pending' in claim_definition) > 0
    as cross_lane_pending_guard_present,
  position('v_now + interval ''23 hours''' in claim_definition) > 0
    and position('v_now >= v_attempt.retry_deadline_at' in claim_definition) > 0
    and position('manual_review_required_at = coalesce' in claim_definition) > 0
    as exact_23_hour_auto_retry_ceiling,
  position('v_now + interval ''5 minutes''' in claim_definition) > 0
    and position('lease_expires_at > clock_timestamp()' in claim_definition) > 0
    as bounded_provider_lease_present,
  position('v_attempt.request_fingerprint <> p_request_fingerprint' in claim_definition) > 0
    and position('payload_changed' in claim_definition) > 0
    as claim_rejects_payload_drift,
  position('alpha-resend-message:' in finalize_definition) > 0
    as finalize_uses_shared_message_lock,
  position('v_attempt.lease_token is distinct from p_lease_token' in finalize_definition) > 0
    and position('v_attempt.request_fingerprint <> p_request_fingerprint' in finalize_definition) > 0
    as finalize_requires_exact_lease_and_fingerprint,
  position('set resend_message_id = p_message_id' in finalize_definition) > 0
    and position('accepted_at = v_now' in finalize_definition) > 0
    and position('lease_token = null' in finalize_definition) > 0
    as finalization_is_one_way_and_database_stamped,
  position('from public.resend_webhook_events' in finalize_definition) > 0
    and position('public.apply_resend_suppression_to_user' in finalize_definition) > 0
    and position('for update' in finalize_definition) > 0
    as fast_webhook_replayed_during_finalize,
  position('v_current_message_id is null' in finalize_definition) > 0
    and position('v_current_message_id = v_attempt.resend_message_id' in finalize_definition) > 0
    and position('v_current_delivered_at <= v_attempt.accepted_at' in finalize_definition) > 0
    as issue_proof_repair_is_pointer_aware,
  position('insert into public.resend_webhook_events' in record_definition) > 0
    and position('on conflict (email_id, type) do nothing' in record_definition) > 0
    as writes_audit_row_before_resolution,
  position('alpha-resend-message:' in record_definition) > 0
    as webhook_uses_shared_message_lock,
  position('from public.resend_delivery_attempts' in record_definition) > 0
    and position('where resend_message_id = p_email_id' in record_definition) > 0
    and position('from public.issues' in record_definition) > 0
    as attempt_owner_precedes_legacy_issue_fallback,
  position('sha256(convert_to' in record_definition) > 0
    and position('v_effective_hashes := array[v_attempt_recipient_hash]' in record_definition) > 0
    as missing_recipients_derive_from_finalized_attempt,
  position('p_event_at is null' in record_definition) > 0
    and position('p_event_at > clock_timestamp() + interval ''10 minutes''' in record_definition) > 0
    as signed_event_clock_is_validated,
  position('legacy_review' in record_definition) > 0
    and position('pending_owner' in record_definition) > 0
    and position('manual_review' in record_definition) > 0
    as unresolved_suppression_states_are_durable,
  position('v_current_hash = any(p_recipient_hashes)' in apply_definition) > 0
    and position('v_user.created_at > p_event_at' in apply_definition) > 0
    as suppression_owner_and_creation_clock_are_bound,
  position('v_user.delivery_suppression_cleared_at > p_event_at' in apply_definition) > 0
    as newer_clear_wins_by_signed_event_clock,
  position('v_user.bounced_at >= p_event_at' in apply_definition) > 0
    and position('v_user.complained_at >= p_event_at' in apply_definition) > 0
    as suppression_evidence_is_monotonic,
  position('new.email is distinct from old.email' in user_guard_definition) > 0
    and position('new.unsubscribed_at is distinct from old.unsubscribed_at' in user_guard_definition) > 0
    and position('new.bounced_at is distinct from old.bounced_at' in user_guard_definition) > 0
    and position('new.delivery_suppression_cleared_at is distinct from old.delivery_suppression_cleared_at' in user_guard_definition) > 0
    and position('a.lease_expires_at > clock_timestamp()' in user_guard_definition) > 0
    as active_user_delivery_mutation_guard_present,
  position('new.state <> ''complete''' in deletion_guard_definition) > 0
    and position('pg_advisory_xact_lock' in deletion_guard_definition) > 0
    and position('a.lease_expires_at > clock_timestamp()' in deletion_guard_definition) > 0
    as active_delivery_deletion_guard_present
from bodies;

-- PASS: every boolean is true. The apply helper is private to the SQL
-- transaction. Only claim, finalize, and record are service-role entrypoints.
select
  not has_function_privilege(
    'service_role',
    to_regprocedure('public.apply_resend_suppression_to_user(uuid,text[],text,timestamptz)'),
    'EXECUTE'
  ) as apply_helper_service_no_execute,
  not has_function_privilege(
    'anon',
    to_regprocedure('public.apply_resend_suppression_to_user(uuid,text[],text,timestamptz)'),
    'EXECUTE'
  ) as apply_helper_anon_no_execute,
  not has_function_privilege(
    'authenticated',
    to_regprocedure('public.apply_resend_suppression_to_user(uuid,text[],text,timestamptz)'),
    'EXECUTE'
  ) as apply_helper_authenticated_no_execute,
  has_function_privilege(
    'service_role',
    to_regprocedure('public.claim_resend_delivery_attempt(uuid,date,text,text,text,uuid,timestamptz)'),
    ('public.claim_resend_suppression_recovery(uuid)'),
    ('public.finalize_resend_suppression_recovery(uuid,uuid)'),
    'EXECUTE'
  ) as claim_service_execute,
  has_function_privilege(
    'service_role',
    to_regprocedure('public.finalize_resend_delivery_attempt(uuid,date,text,uuid,text,text)'),
    'EXECUTE'
  ) as finalize_service_execute,
  has_function_privilege(
    'service_role',
    to_regprocedure('public.record_resend_suppression_event(text,text,timestamptz,text[])'),
    'EXECUTE'
  ) as record_service_execute;

-- PASS: all 17 trigger/protection function signatures exist, return trigger,
-- use SECURITY DEFINER with the pinned search path, and deny direct execution
-- to anon and authenticated. These functions execute through their triggers.
with expected(signature) as (
  values
    ('public.abort_legacy_checkout_for_account_deletion()'),
    ('public.block_account_deletion_with_active_delivery()'),
    ('public.block_identity_change_with_suppression_recovery()'),
    ('public.block_auth_identity_change_with_suppression_recovery()'),
    ('public.block_billing_rebind_during_account_deletion()'),
    ('public.block_checkout_billing_pair_conflict()'),
    ('public.block_checkout_for_deleting_owner()'),
    ('public.block_issue_mutation_during_account_deletion()'),
    ('public.block_legacy_checkout_billing_pair_conflict()'),
    ('public.block_support_ticket_mutation_during_account_deletion()'),
    ('public.block_user_billing_pair_conflict()'),
    ('public.block_user_delivery_change_with_active_attempt()'),
    ('public.block_user_legacy_duplicate_winner_mutation()'),
    ('public.block_user_mutation_during_account_deletion()'),
    ('public.normalize_delivery_retry_deadlines()'),
    ('public.protect_user_privileged_columns()'),
    ('public.scrub_legacy_checkout_after_account_deletion()')
)
select
  e.signature,
  p.oid is not null and p.prokind = 'f' as exists,
  coalesce(p.prorettype = 'trigger'::regtype, false) as returns_trigger,
  coalesce(p.prosecdef, false) as security_definer,
  coalesce('search_path=public' = any(p.proconfig), false) as pinned_search_path,
  not coalesce(has_function_privilege('anon', p.oid, 'EXECUTE'), false)
    as anon_no_execute,
  not coalesce(has_function_privilege('authenticated', p.oid, 'EXECUTE'), false)
    as authenticated_no_execute
from expected e
left join pg_proc p on p.oid = to_regprocedure(e.signature)
order by e.signature;

-- PASS: every boolean is true. The invite-aware watchdog remains one exact
-- anon-only SECURITY DEFINER function. Its two population branches use the
-- same invite, paid-window, suppression, and deliverability filters. The
-- uncovered branch retains per-user proof of send.
with f as (
  select
    p.oid,
    p.prokind,
    p.prosecdef,
    p.proconfig,
    p.proacl,
    p.proowner,
    lower(p.prosrc) as definition
  from pg_proc p
  where p.oid = to_regprocedure(
    'public.watchdog_delivery_check(timestamptz)'
  )
), proof as (
  select
    *,
    (length(definition) - length(replace(definition, 'u.subscribed_at is not null', '')))
      / length('u.subscribed_at is not null') as access_stamp_occurrences,
    (length(definition) - length(replace(definition, 'u.access_granted_at is not null', '')))
      / length('u.access_granted_at is not null') as access_grant_occurrences,
    (length(definition) - length(replace(definition, 'u.cancelled_at is null', '')))
      / length('u.cancelled_at is null') as open_paid_window_occurrences,
    (length(definition) - length(replace(definition, 'u.cancelled_at > now()', '')))
      / length('u.cancelled_at > now()') as future_paid_window_occurrences,
    (length(definition) - length(replace(definition, 'u.unsubscribed_at is null', '')))
      / length('u.unsubscribed_at is null') as subscribed_delivery_occurrences,
    (length(definition) - length(replace(definition, 'u.bounced_at is null', '')))
      / length('u.bounced_at is null') as bounce_exclusion_occurrences,
    (length(definition) - length(replace(definition, 'u.complained_at is null', '')))
      / length('u.complained_at is null') as complaint_exclusion_occurrences,
    (length(definition) - length(replace(definition, 'u.suppression_cleanup_pending_at is null', '')))
      / length('u.suppression_cleanup_pending_at is null') as suppression_exclusion_occurrences
  from f
)
select
  count(*) = 1 as exact_one_watchdog,
  coalesce(bool_and(prokind = 'f'), false) as regular_function,
  coalesce(bool_and(prosecdef), false) as security_definer,
  coalesce(bool_and('search_path=public' = any(proconfig)), false)
    as pinned_search_path,
  coalesce(bool_and(has_function_privilege('anon', oid, 'EXECUTE')), false)
    as anon_execute,
  coalesce(bool_and(not has_function_privilege('authenticated', oid, 'EXECUTE')), false)
    as authenticated_no_execute,
  coalesce(bool_and(not exists (
    select 1
    from aclexplode(coalesce(proacl, acldefault('f', proowner))) privilege
    where privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  )), false) as public_no_execute,
  coalesce(bool_and(position('--' in definition) = 0), false)
    and coalesce(bool_and(position('/*' in definition) = 0), false)
    as body_has_no_comments,
  coalesce(bool_and(access_stamp_occurrences = 2), false)
    as access_stamp_in_both_population_branches,
  coalesce(bool_and(access_grant_occurrences = 2), false)
    as access_grant_in_both_population_branches,
  coalesce(bool_and(open_paid_window_occurrences = 2), false)
    and coalesce(bool_and(future_paid_window_occurrences = 2), false)
    as paid_window_in_both_population_branches,
  coalesce(bool_and(subscribed_delivery_occurrences = 2), false)
    and coalesce(bool_and(bounce_exclusion_occurrences = 2), false)
    and coalesce(bool_and(complaint_exclusion_occurrences = 2), false)
    as deliverability_filters_in_both_population_branches,
  coalesce(bool_and(suppression_exclusion_occurrences = 2), false)
    as suppression_filter_in_both_population_branches,
  coalesce(bool_and(position('i.user_id = u.id' in definition) > 0), false)
    and coalesce(bool_and(position('i.delivered_at >= date_trunc(''hour'', cutoff)' in definition) > 0), false)
    and coalesce(bool_and(position('i.resend_message_id is not null' in definition) > 0), false)
    and coalesce(bool_and(position('i.delivered_at < ''2026-08-05t19:10:00z''::timestamptz' in definition) > 0), false)
    as uncovered_branch_has_proof_of_send
from proof;

-- PASS: every boolean is true. The installed function bodies must contain no
-- comments that could spoof a marker. Existing bindings must reach every named
-- conflict return before already_bound, and already_bound must precede UPDATE.
-- The checkout trigger must reject a row naming two different users.
with definitions as (
  select
    lower(checkout_proc.prosrc) as checkout_definition,
    lower(binding_proc.prosrc) as binding_definition
  from pg_proc checkout_proc
  cross join pg_proc binding_proc
  where checkout_proc.oid =
    to_regprocedure('public.block_checkout_for_deleting_owner()')
    and binding_proc.oid = to_regprocedure(
      'public.bind_existing_alpha_subscription(uuid,text,text,text,integer,timestamptz,timestamptz,timestamptz,integer)'
    )
)
select
  position('--' in checkout_definition) = 0
    and position('/*' in checkout_definition) = 0
    as checkout_body_has_no_comments,
  position('new.owner_user_id <> new.provisioned_user_id' in checkout_definition) > 0
    as checkout_owner_pair_guard_present,
  position('--' in binding_definition) = 0
    and position('/*' in binding_definition) = 0
    as binding_body_has_no_comments,
  position('v_already_bound :=' in binding_definition) > 0
    and position('v_already_bound :=' in binding_definition)
      < position('return ''deletion_pending''' in binding_definition)
    as binding_assignment_before_conflicts,
  position('if v_already_bound then' in binding_definition)
      > 0
    and position('return ''deletion_pending''' in binding_definition) > 0
    and position('return ''renewal_pending''' in binding_definition) > 0
    and position('return ''checkout_pending''' in binding_definition) > 0
    and position('return ''legacy_fulfillment_pending''' in binding_definition) > 0
    and position('return ''refund_review_pending''' in binding_definition) > 0
    and position('return ''reservation_conflict''' in binding_definition) > 0
    and position('return ''already_bound''' in binding_definition) > 0
    and position('update public.users' in binding_definition) > 0
    and position('if v_already_bound then' in binding_definition)
      > position('return ''deletion_pending''' in binding_definition)
    and position('if v_already_bound then' in binding_definition)
      > position('return ''renewal_pending''' in binding_definition)
    and position('if v_already_bound then' in binding_definition)
      > position('return ''checkout_pending''' in binding_definition)
    and position('if v_already_bound then' in binding_definition)
      > position('return ''legacy_fulfillment_pending''' in binding_definition)
    and position('if v_already_bound then' in binding_definition)
      > position('return ''refund_review_pending''' in binding_definition)
    and position('if v_already_bound then' in binding_definition)
      > position('return ''reservation_conflict''' in binding_definition)
    and position('return ''already_bound''' in binding_definition)
      > position('if v_already_bound then' in binding_definition)
    and position('return ''already_bound''' in binding_definition)
      < position('update public.users' in binding_definition)
    as already_bound_after_all_conflicts_before_update,
  position('p.owner_user_id <> p_user_id' in binding_definition) > 0
    and position('p.provisioned_user_id <> p_user_id' in binding_definition) > 0
    as strict_checkout_owner_conflicts_present
from definitions;

-- PASS: every protected-column assignment reports present = true. This proves
-- the final Round 80 replacement retained the old protected fields and added
-- invite, subscription, delivery, retry, and renewal state.
with expected(marker) as (
  values
    ('new.id := old.id'),
    ('new.email := old.email'),
    ('new.stripe_customer_id := old.stripe_customer_id'),
    ('new.stripe_subscription_id := old.stripe_subscription_id'),
    ('new.subscribed_at := old.subscribed_at'),
    ('new.cancelled_at := old.cancelled_at'),
    ('new.unsubscribed_at := old.unsubscribed_at'),
    ('new.topic_quota := old.topic_quota'),
    ('new.created_at := old.created_at'),
    ('new.access_requested_at := old.access_requested_at'),
    ('new.access_granted_at := old.access_granted_at'),
    ('new.bounced_at := old.bounced_at'),
    ('new.complained_at := old.complained_at'),
    ('new.delivery_suppression_cleared_at := old.delivery_suppression_cleared_at'),
    ('new.suppression_recovery_token := old.suppression_recovery_token'),
    ('new.suppression_recovery_started_at := old.suppression_recovery_started_at'),
    ('new.suppression_recovery_snapshot := old.suppression_recovery_snapshot'),
    ('new.suppression_cleanup_pending_at := old.suppression_cleanup_pending_at'),
    ('new.suppression_cleanup_next_attempt_at := old.suppression_cleanup_next_attempt_at'),
    ('new.stripe_email_sync_pending_at := old.stripe_email_sync_pending_at'),
    ('new.stripe_email_sync_next_attempt_at := old.stripe_email_sync_next_attempt_at'),
    ('new.stripe_email_sync_lease_token := old.stripe_email_sync_lease_token'),
    ('new.stripe_email_sync_lease_expires_at := old.stripe_email_sync_lease_expires_at'),
    ('new.stripe_email_sync_attempt_count := old.stripe_email_sync_attempt_count'),
    ('new.stripe_email_sync_last_error_code := old.stripe_email_sync_last_error_code'),
    ('new.stripe_email_sync_dead_lettered_at := old.stripe_email_sync_dead_lettered_at'),
    ('new.suppression_cleanup_attempt_count := old.suppression_cleanup_attempt_count'),
    ('new.suppression_cleanup_last_error_code := old.suppression_cleanup_last_error_code'),
    ('new.suppression_cleanup_dead_lettered_at := old.suppression_cleanup_dead_lettered_at'),
    ('new.renewal_cancel_pending_at := old.renewal_cancel_pending_at'),
    ('new.renewal_cancel_customer_id := old.renewal_cancel_customer_id'),
    ('new.renewal_cancel_subscription_id := old.renewal_cancel_subscription_id'),
    ('new.renewal_cancel_next_attempt_at := old.renewal_cancel_next_attempt_at'),
    ('new.renewal_cancel_lease_token := old.renewal_cancel_lease_token'),
    ('new.renewal_cancel_lease_expires_at := old.renewal_cancel_lease_expires_at'),
    ('new.renewal_cancel_attempt_count := old.renewal_cancel_attempt_count'),
    ('new.renewal_cancel_last_error_code := old.renewal_cancel_last_error_code'),
    ('new.renewal_cancel_escalated_at := old.renewal_cancel_escalated_at')
), function_definition as (
  select pg_get_functiondef(
    to_regprocedure('public.protect_user_privileged_columns()')
  ) as definition
)
select
  e.marker,
  coalesce(position(e.marker in f.definition) > 0, false) as present
from expected e
cross join function_definition f
order by e.marker;

-- PASS: every reset assignment reports present = true and body_has_no_comments
-- is true. Starting a new provider obligation must clear all previous bounded
-- retry and dead-letter state before the row can be claimed again.
with expected(marker) as (
  values
    ('new.suppression_cleanup_attempt_count := 0'),
    ('new.suppression_cleanup_last_error_code := null'),
    ('new.suppression_cleanup_dead_lettered_at := null'),
    ('new.stripe_email_sync_attempt_count := 0'),
    ('new.stripe_email_sync_last_error_code := null'),
    ('new.stripe_email_sync_dead_lettered_at := null')
), function_definition as (
  select lower(p.prosrc) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'normalize_delivery_retry_deadlines'
    and pg_get_function_identity_arguments(p.oid) = ''
)
select
  e.marker,
  coalesce(position(e.marker in f.definition) > 0, false) as present,
  coalesce(
    position('--' in f.definition) = 0
      and position('/*' in f.definition) = 0,
    false
  ) as body_has_no_comments
from expected e
cross join function_definition f
order by e.marker;

-- PASS: every final maintenance marker reports present = true. This guards
-- against shipping an earlier intra-Round 80 definition that hides a later
-- obligation.
with expected(marker) as (
  values
    ('p_now is null'),
    ('checkout_profiles'),
    ('checkout_fulfillments'),
    ('checkout_creation_reviews'),
    ('account_deletion_sagas'),
    ('refund_reviews'),
    ('legacy_checkout_fulfillments'),
    ('suppression_cleanup_pending_at'),
    ('suppression_cleanup_dead_lettered_at is null'),
    ('stripe_email_sync_pending_at'),
    ('stripe_email_sync_dead_lettered_at is null'),
    ('reconcile_dead_lettered_at is null'),
    ('renewal_cancel_pending_at'),
    ('renewal_cancel_escalated_at'),
    ('renewal_cancel_next_attempt_at')
), function_definition as (
  select lower(pg_get_functiondef(
    to_regprocedure('public.alpha_scheduled_maintenance_due(timestamptz)')
  )) as definition
)
select
  e.marker,
  coalesce(position(e.marker in f.definition) > 0, false) as present
from expected e
cross join function_definition f
order by e.marker;

-- PASS: the final issue policy exists exactly once, is permissive SELECT for
-- PUBLIC, and every access marker is true. Review the full qualifier too.
select
  count(*) = 1 as exact_one_policy,
  coalesce(bool_and(permissive = 'PERMISSIVE'), false) as permissive,
  coalesce(bool_and(cmd = 'SELECT'), false) as select_only,
  coalesce(bool_and('public' = any(roles)), false) as applies_to_public,
  coalesce(bool_and(position('auth.uid()' in lower(qual)) > 0), false)
    as has_self_marker,
  coalesce(bool_and(position('subscribed_at' in lower(qual)) > 0), false)
    as has_access_stamp_marker,
  coalesce(bool_and(position('access_granted_at' in lower(qual)) > 0), false)
    as has_access_grant_marker,
  coalesce(bool_and(position('cancelled_at' in lower(qual)) > 0), false)
    as has_cancellation_marker,
  string_agg(qual, ' | ' order by policyname) as qualifier
from pg_policies
where schemaname = 'public'
  and tablename = 'issues'
  and policyname = 'issues self read';

-- PASS immediately after migration: malformed_customer_ids,
-- malformed_subscription_ids, and subscription_without_customer are zero.
-- PASS before checkout reopens: every count except active_access_rows,
-- active_free_access_rows, and active_paid_rows_with_exact_local_shape is zero.
-- Those three are evidence counts. Free access means both billing IDs are null
-- and needs operator classification, not automatic repair. A nonzero
-- active_paid_rows_missing_exact_subscription is the bounded repair population
-- and blocks reopen until the separately approved exact Stripe evidence flow
-- finishes.
select
  count(*) filter (
    where stripe_customer_id is not null
      and stripe_customer_id !~ '^cus_[A-Za-z0-9]+$'
  ) as malformed_customer_ids,
  count(*) filter (
    where stripe_subscription_id is not null
      and stripe_subscription_id !~ '^sub_[A-Za-z0-9]+$'
  ) as malformed_subscription_ids,
  count(*) filter (
    where stripe_subscription_id is not null
      and stripe_customer_id is null
  ) as subscription_without_customer,
  count(*) filter (
    where stripe_customer_id is not null
      and subscribed_at is null
      and (cancelled_at is null or cancelled_at > now())
  ) as billed_rows_missing_access_stamp,
  count(*) filter (
    where stripe_customer_id is not null
      and subscribed_at is not null
      and (cancelled_at is null or cancelled_at > now())
      and stripe_subscription_id is null
  ) as active_paid_rows_missing_exact_subscription,
  count(*) filter (
    where stripe_customer_id is not null
      and subscribed_at is not null
      and (cancelled_at is null or cancelled_at > now())
      and stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'
  ) as active_paid_rows_with_exact_local_shape,
  count(*) filter (
    where stripe_customer_id is null
      and stripe_subscription_id is null
      and subscribed_at is not null
      and (
        access_granted_at is not null
        or cancelled_at is null
        or cancelled_at > now()
      )
  ) as active_free_access_rows,
  count(*) filter (
    where subscribed_at is not null
      and (
        access_granted_at is not null
        or cancelled_at is null
        or cancelled_at > now()
      )
  ) as active_access_rows
from public.users;

-- PASS before checkout reopens: both duplicate counts and the checkout identity
-- mismatch count are zero. Repeat this after the binding repair even though
-- PRE-APPLY also checked customer IDs.
select
  (
    select count(*)
    from (
      select stripe_customer_id
      from public.users
      where stripe_customer_id is not null
      group by stripe_customer_id
      having count(*) > 1
    ) duplicate_customers
  ) as duplicate_customer_groups,
  (
    select count(*)
    from (
      select stripe_subscription_id
      from public.users
      where stripe_subscription_id is not null
      group by stripe_subscription_id
      having count(*) > 1
    ) duplicate_subscriptions
  ) as duplicate_subscription_groups,
  (
    select count(*)
    from public.checkout_profiles
    where owner_user_id is not null
      and provisioned_user_id is not null
      and owner_user_id <> provisioned_user_id
  ) as checkout_profile_identity_mismatches;

-- These local checks cannot prove a non-null binding points to the correct live
-- Stripe account, Alpha product, price, status, quantity, or cancellation
-- state. Provider-side exactness remains a separate approved release gate.

-- PASS immediately after migration and before any Round 80 traffic: all 12
-- rows report row_count = 0.
select 'checkout_profiles' as relation_name, count(*) as row_count
from public.checkout_profiles
union all
select 'checkout_fulfillments', count(*)
from public.checkout_fulfillments
union all
select 'checkout_creation_reviews', count(*)
from public.checkout_creation_reviews
union all
select 'account_deletion_sagas', count(*)
from public.account_deletion_sagas
union all
select 'account_deletion_alpha_subscriptions', count(*)
from public.account_deletion_alpha_subscriptions
union all
select 'refund_reviews', count(*)
from public.refund_reviews
union all
select 'legacy_checkout_fulfillments', count(*)
from public.legacy_checkout_fulfillments
union all
select 'alpha_paid_call_budgets', count(*)
from public.alpha_paid_call_budgets
union all
select 'weekly_send_delivery_cursors', count(*)
from public.weekly_send_delivery_cursors
union all
select 'alpha_rate_limit_buckets', count(*)
from public.alpha_rate_limit_buckets
union all
select 'alpha_quantity_update_leases', count(*)
from public.alpha_quantity_update_leases
union all
select 'resend_delivery_attempts', count(*)
from public.resend_delivery_attempts
order by relation_name;

-- PASS immediately after migration: both counts are zero. Existing webhook
-- dedup markers must inherit succeeded with no lease.
select
  count(*) filter (where status <> 'succeeded') as non_succeeded,
  count(*) filter (
    where lease_token is not null
       or lease_expires_at is not null
  ) as unexpected_live_leases
from public.stripe_webhook_events;

-- PASS before schedules and checkout are enabled: every count is zero and
-- maintenance_due is false. This is intentionally repeated after the exact
-- binding repair and after the paused Worker deploy.
-- The predicate is intentionally inlined with direct table reads. This proof
-- never invokes an application-defined function, even if its catalog metadata
-- or body has drifted.
with verification_clock as (
  select now() as observed_at
)
select
  (
    select count(*)
    from public.checkout_creation_reviews
    where status = 'pending'
  ) as pending_checkout_creation_reviews,
  (
    select count(*)
    from public.checkout_profiles
    where recovery_dead_lettered_at is not null
  ) as dead_lettered_checkout_profiles,
  (
    select count(*)
    from public.checkout_fulfillments
    where status = 'pending'
  ) as pending_checkout_fulfillments,
  (
    select count(*)
    from public.account_deletion_sagas
    where state <> 'complete'
  ) as incomplete_account_deletions,
  (
    select count(*)
    from public.account_deletion_sagas
    where reconcile_dead_lettered_at is not null
  ) as dead_lettered_account_deletions,
  (
    select count(*)
    from public.refund_reviews
    where status in ('pending', 'reviewed')
  ) as unresolved_refund_reviews,
  (
    select count(*)
    from public.legacy_checkout_fulfillments
    where reconcile_dead_lettered_at is not null
  ) as dead_lettered_legacy_fulfillments,
  (
    select count(*)
    from public.legacy_checkout_fulfillments
    where status in ('pending', 'awaiting_issue', 'deleting')
  ) as nonterminal_legacy_fulfillments,
  (
    select count(*)
    from public.users
    where renewal_cancel_pending_at is not null
  ) as pending_renewal_cancellations,
  (
    select count(*)
    from public.users
    where suppression_cleanup_pending_at is not null
  ) as pending_suppression_cleanup,
  (
    select count(*)
    from public.users
    where suppression_cleanup_dead_lettered_at is not null
  ) as dead_lettered_suppression_cleanups,
  (
    select count(*)
    from public.users
    where stripe_email_sync_pending_at is not null
  ) as pending_stripe_email_sync,
  (
    select count(*)
    from public.users
    where stripe_email_sync_dead_lettered_at is not null
  ) as dead_lettered_stripe_email_sync,
  (
    exists (
      select 1
      from public.checkout_profiles p
      where p.recovery_dead_lettered_at is not null
         or (
           p.billing_state in ('creating', 'deleting')
           and p.stripe_session_id is null
           and p.session_creation_lease_expires_at <= verification_clock.observed_at
         )
         or (
           p.billing_state = 'recovering'
           and p.recovery_dead_lettered_at is null
           and p.recovery_lease_expires_at <= verification_clock.observed_at
         )
         or (
           p.billing_state in ('open', 'paid')
           and p.recovery_dead_lettered_at is null
           and p.provisioned_user_id is null
           and p.expires_at <= verification_clock.observed_at
           and (
             p.recovery_lease_expires_at is null
             or p.recovery_lease_expires_at <= verification_clock.observed_at
           )
         )
         or (
           p.billing_state in ('ended', 'expired')
           and p.identity_scrubbed_at is null
           and p.updated_at <= verification_clock.observed_at - interval '180 days'
         )
         or (
           p.raw_profile_scrubbed_at is null
           and p.expires_at <= verification_clock.observed_at
           and (
             p.provisioned_user_id is not null
             or p.billing_state in ('ended', 'expired')
           )
         )
    )
    or exists (
      select 1
      from public.checkout_fulfillments f
      where f.status = 'completed'
        and f.identity_scrubbed_at is null
        and f.completed_at <= verification_clock.observed_at - interval '180 days'
    )
    or exists (
      select 1
      from public.checkout_fulfillments f
      join public.checkout_profiles p on p.id = f.profile_id
      where f.status = 'pending'
        and (
          f.lease_token is null
          or f.lease_expires_at is null
          or f.lease_expires_at <= verification_clock.observed_at
        )
        and (
          p.billing_state in ('ended', 'expired')
          or (
            p.provisioned_user_id is not null
            and p.raw_profile_scrubbed_at is not null
            and (
              f.created_at <= verification_clock.observed_at - interval '24 hours'
              or exists (
                select 1
                from public.issues i
                where i.user_id = p.provisioned_user_id
                  and i.week_of = f.week_of
              )
            )
          )
        )
    )
    or exists (
      select 1
      from public.checkout_creation_reviews r
      where r.status = 'pending'
    )
    or exists (
      select 1
      from public.account_deletion_sagas s
      where (
        s.state <> 'complete'
        and s.reconcile_dead_lettered_at is null
        and s.updated_at <= verification_clock.observed_at - interval '15 minutes'
        and s.reconcile_next_attempt_at <= verification_clock.observed_at
      ) or (
        s.state = 'complete'
        and s.purge_after <= verification_clock.observed_at
      )
    )
    or exists (
      select 1
      from public.refund_reviews r
      where r.status in ('pending', 'reviewed')
    )
    or exists (
      select 1
      from public.refund_reviews r
      where r.status in ('refunded', 'not_required')
        and r.resolved_at <= verification_clock.observed_at - interval '180 days'
        and not exists (
          select 1
          from public.legacy_checkout_fulfillments l
          where l.session_id = r.session_id
            and l.stripe_subscription_id = r.subscription_id
            and l.stripe_customer_id = r.customer_id
            and l.status in ('pending', 'deleting')
        )
        and not exists (
          select 1
          from public.checkout_profiles p
          where p.stripe_session_id = r.session_id
            and p.stripe_customer_id = r.customer_id
            and p.stripe_subscription_id = r.subscription_id
            and p.billing_state in (
              'open', 'creating', 'paid', 'recovering', 'deleting'
            )
        )
        and not exists (
          select 1
          from public.checkout_fulfillments f
          join public.checkout_profiles p
            on p.id = f.profile_id
           and p.stripe_session_id = f.session_id
          where f.session_id = r.session_id
            and f.status = 'pending'
            and p.stripe_customer_id = r.customer_id
            and p.stripe_subscription_id = r.subscription_id
        )
    )
    or exists (
      select 1
      from public.legacy_checkout_fulfillments l
      where l.reconcile_dead_lettered_at is not null
    )
    or exists (
      select 1
      from public.legacy_checkout_fulfillments l
      where (
        l.status = 'awaiting_issue'
        and coalesce(l.lease_expires_at, l.created_at)
          <= verification_clock.observed_at
      ) or (
        l.status = 'pending'
        and coalesce(
          l.lease_expires_at,
          l.created_at + interval '5 minutes'
        ) <= verification_clock.observed_at
      )
    )
    or exists (
      select 1
      from public.legacy_checkout_fulfillments l
      join public.refund_reviews r
        on r.session_id = l.session_id
       and r.subscription_id = l.stripe_subscription_id
       and r.customer_id = l.stripe_customer_id
       and r.winner_customer_id is not null
       and r.winner_subscription_id is not null
      where l.status = 'pending'
    )
    or exists (
      select 1
      from public.users u
      where u.suppression_recovery_token is not null or (
        u.suppression_cleanup_pending_at is not null
        and u.suppression_cleanup_dead_lettered_at is null
        and (
          u.suppression_cleanup_next_attempt_at is null
          or u.suppression_cleanup_next_attempt_at <= verification_clock.observed_at
        )
      ) or (
        u.stripe_email_sync_pending_at is not null
        and u.stripe_email_sync_dead_lettered_at is null
        and (
          u.stripe_email_sync_next_attempt_at is null
          or u.stripe_email_sync_next_attempt_at <= verification_clock.observed_at
        )
        and (
          u.stripe_email_sync_lease_expires_at is null
          or u.stripe_email_sync_lease_expires_at <= verification_clock.observed_at
        )
      ) or (
        u.renewal_cancel_pending_at is not null
        and (
          u.renewal_cancel_escalated_at is not null
          or u.renewal_cancel_next_attempt_at <= verification_clock.observed_at
        )
      )
    )
    or exists (
      select 1 from public.resend_webhook_events e
       where e.owner_user_id is null
         and least(e.event_at, e.received_at)
           <= verification_clock.observed_at - interval '7 days'
    )
  ) as maintenance_due
from verification_clock;

-- Approved local policy: deletion preserves provider do-not-email protection.
-- Exact owned events keep their causal path. Unowned evidence expires by its
-- original clock and cannot acquire a new lifetime from a provider replay.
-- PASS: all local policy predicates true. This is a catalog proof, not proof
-- that the scheduled job has run or that the live provider team is Alpha-only.
with definitions as (
  select
    coalesce(lower(pg_get_functiondef(to_regprocedure('public.record_resend_suppression_event(text,text,timestamptz,text[])'))), '') as ingress,
    coalesce(lower(pg_get_functiondef(to_regprocedure('public.prune_unowned_resend_webhook_events(integer)'))), '') as pruning,
    coalesce(lower(pg_get_functiondef(to_regprocedure('public.finalize_resend_delivery_attempt(uuid,date,text,uuid,text,text)'))), '') as finalization,
    coalesce(lower(pg_get_functiondef(to_regprocedure('public.begin_account_deletion_auth_removal(uuid)'))), '') as deletion
)
select
  position('expired_unowned' in ingress) > 0
    and position('v_target_user_id is null' in ingress) > 0
    and position('v_now - interval ''7 days''' in ingress) > 0
    and position('owner_user_id is null' in pruning) > 0
    and position('p_limit > 1000' in pruning) > 0
    and position('for update skip locked' in pruning) > 0
    and position('v_now >= v_attempt.retry_deadline_at' in finalization) > 0
    and position('delivery_policy_settled_at is not null' in deletion) > 0
    and exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'resend_webhook_events'
         and column_name = 'received_at' and is_nullable = 'NO'
    ) as late_post_deletion_provider_event_path_closed,
  not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'account_deletion_sagas'
       and column_name = 'suppression_cleared_at'
  ) as no_false_provider_deletion_marker,
  (select count(*) from public.resend_webhook_events
    where owner_user_id is null
      and least(event_at, received_at) <= current_timestamp - interval '7 days')
    as expired_unowned_events_due
from definitions;

-- PASS: every recovery boolean is true. These catalog checks complement the
-- isolated concurrency drill. No provider request or recovery RPC runs here.
with definitions as (
  select
    coalesce(lower(pg_get_functiondef(to_regprocedure('public.claim_resend_suppression_recovery(uuid)'))), '') as claim,
    coalesce(lower(pg_get_functiondef(to_regprocedure('public.finalize_resend_suppression_recovery(uuid,uuid)'))), '') as finish,
    coalesce(lower(pg_get_functiondef(to_regprocedure('public.block_account_deletion_with_active_delivery()'))), '') as deletion,
    coalesce(lower(pg_get_functiondef(to_regprocedure('public.block_identity_change_with_suppression_recovery()'))), '') as identity_guard,
    coalesce(lower(pg_get_functiondef(to_regprocedure('public.block_auth_identity_change_with_suppression_recovery()'))), '') as auth_guard,
    coalesce(lower(pg_get_functiondef(to_regprocedure('public.claim_resend_delivery_attempt(uuid,date,text,text,text,uuid,timestamptz)'))), '') as delivery,
    coalesce(lower(pg_get_functiondef(to_regprocedure('public.alpha_scheduled_maintenance_due(timestamptz)'))), '') as maintenance
)
select
  position('pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080))' in claim) > 0
    and position('for update' in claim) > 0
    and position('review_required' in claim) > 0
    and position('deletion_pending' in claim) > 0
    and position('identity_conflict' in claim) > 0
    and position('already_clear' in claim) > 0
    as recovery_claim_checks_owner_and_conflicts,
  position('v_user.suppression_recovery_token is distinct from p_recovery_token' in finish) > 0
    and position('= v_user.suppression_recovery_snapshot' in finish) > 0
    and position('delivery_suppression_cleared_at = v_user.suppression_recovery_started_at' in finish) > 0
    and position('return ''state_changed''' in finish) > position('return ''cleared''' in finish)
    and position('update public.users' in substring(finish from position('return ''cleared''' in finish))) = 0
    as recovery_finish_preserves_changed_state_and_original_clock,
  position('suppression_recovery_token is not null' in deletion) > 0
    and position('suppression_recovery_token is not null' in identity_guard) > 0
    and position('unresolved suppression recovery' in deletion) > 0
    as unresolved_recovery_blocks_deletion,
  position('for update' in auth_guard) > 0
    and position('v_token is not null' in auth_guard) > 0
    as auth_identity_change_checks_locked_owner,
  position('suppression_recovery_token is not null' in delivery) > 0
    as unresolved_recovery_blocks_delivery,
  position('suppression_recovery_token is not null' in maintenance) > 0
    as unresolved_recovery_keeps_review_due,
  not coalesce(has_function_privilege('service_role', to_regprocedure('public.resend_suppression_recovery_snapshot(jsonb)'), 'EXECUTE'), true)
    and not coalesce(has_function_privilege('anon', to_regprocedure('public.resend_suppression_recovery_snapshot(jsonb)'), 'EXECUTE'), true)
    and not coalesce(has_function_privilege('authenticated', to_regprocedure('public.resend_suppression_recovery_snapshot(jsonb)'), 'EXECUTE'), true)
    as recovery_snapshot_has_no_direct_api_access,
  (select count(*) = 2 and bool_and('TimeZone=UTC' = any(p.proconfig))
     from pg_proc p where p.oid in (
       to_regprocedure('public.claim_resend_suppression_recovery(uuid)'),
       to_regprocedure('public.finalize_resend_suppression_recovery(uuid,uuid)')
     )) as recovery_snapshot_timezone_is_fixed
from definitions;

-- PASS: both identity guards exist and fire for the exact intended events.
with expected(relation_name, trigger_name, expected_type) as (
  values
    ('public.users', 'users_suppression_recovery_identity_guard', 27),
    ('auth.users', 'auth_users_suppression_recovery_identity_guard', 19)
)
select
  e.trigger_name,
  coalesce(t.tgenabled = 'O' and t.tgtype = e.expected_type, false)
    as recovery_identity_guard_events_match,
  coalesce((select array_agg(a.attname::text order by a.attname)
    from unnest(t.tgattr::smallint[]) n(attnum)
    join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = n.attnum
  ) = array['created_at', 'email', 'id']::text[], false)
    as recovery_identity_guard_columns_match
from expected e
left join pg_trigger t on t.tgrelid = to_regclass(e.relation_name)
  and t.tgname = e.trigger_name and not t.tgisinternal
order by e.trigger_name;

-- PASS: zero unresolved rows before release. Nonzero is an operator hold.
-- This aggregate reveals no recipient, token, or saved comparison fields.
select count(*) as unresolved_suppression_recoveries,
  min(suppression_recovery_started_at) as oldest_suppression_recovery_started_at
from public.users where suppression_recovery_token is not null;

-- MANUAL RELEASE GATE: the local policy is approved. External cutover evidence
-- still needs an exact approval and review before migration or deployment.
select
  false as production_privacy_cutover_verified,
  true as provider_team_isolation_must_be_verified,
  true as scheduled_retention_run_must_be_verified,
  'MANUAL HOLD: do not apply without approved production preflight and cutover evidence'
    as release_gate;

-- End of canonical read-only verification template.
