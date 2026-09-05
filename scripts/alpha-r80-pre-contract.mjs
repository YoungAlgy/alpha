// Explicit PRE-APPLY contract for statements 0..26 of the frozen Round 80 SQL.
// A caller must hash-pin and split the SQL before applying these indices.
// manualEvidence means record and review the result. It can never become a local pass.
const frozen = (check) => Object.freeze({ trueFields: [], falseFields: [], zeroFields: [], manualEvidence: [], ...check });

export const alphaR80PreChecks = Object.freeze([
  frozen({ index: 0, exactRows: 1, manualEvidence: ['database_name', 'migration_execution_role', 'session_role', 'observed_at'] }),
  frozen({ index: 1, exactRows: 1, trueFields: ['migration_role_can_guard_auth_identity'] }),
  frozen({ index: 2, exactRows: 7, trueFields: ['present'], expectedNames: ['auth.users', 'public.users', 'public.issues', 'public.support_tickets', 'public.resend_webhook_events', 'public.stripe_webhook_events', 'supabase_migrations.schema_migrations'] }),
  frozen({ index: 3, exactRows: 3, trueFields: ['present'], expectedNames: ['anon', 'authenticated', 'service_role'], nameField: 'role_name' }),
  frozen({ index: 4, exactRows: 1, trueFields: ['has_uuid_generator', 'has_lock_hash'] }),
  frozen({ index: 5, exactRows: 12, trueFields: ['absent'] }),
  frozen({ index: 6, exactRows: 40, trueFields: ['absent'] }),
  frozen({ index: 7, exactRows: 21, trueFields: ['absent'] }),
  frozen({ index: 8, exactRows: 37, trueFields: ['absent'] }),
  frozen({ index: 9, exactRows: 16, trueFields: ['absent'] }),
  frozen({ index: 10, exactRows: 109, trueFields: ['absent'], zeroFields: ['existing_overloads'] }),
  frozen({ index: 11, exactRows: 1, trueFields: ['exact_one_trigger', 'enabled_normally', 'calls_expected_function'] }),
  frozen({ index: 12, exactRows: 1, trueFields: ['exact_one_baseline_function'], falseFields: ['search_path_already_pinned', 'round80_subscription_marker_present', 'round80_access_request_marker_present', 'round80_access_grant_marker_present', 'round80_delivery_causality_marker_present', 'round80_suppression_marker_present', 'round80_email_sync_marker_present', 'round80_email_sync_retry_marker_present', 'round80_suppression_retry_marker_present', 'round80_renewal_marker_present'] }),
  frozen({ index: 13, exactRows: 1, trueFields: ['exact_one_baseline_handle_new_user', 'security_definer', 'pinned_search_path', 'inserts_public_user'], falseFields: ['deterministic_auth_clock_marker_already_present'] }),
  frozen({ index: 14, exactRows: 1, trueFields: ['exact_one_baseline_watchdog', 'regular_function', 'security_definer', 'pinned_search_path', 'anon_execute', 'authenticated_no_execute', 'public_no_execute', 'body_has_no_comments', 'has_access_stamp_marker', 'has_paid_window_markers', 'has_delivery_exclusion_markers', 'has_proof_of_send_markers'], falseFields: ['round80_access_grant_marker_present', 'round80_suppression_marker_present'] }),
  frozen({ index: 15, exactRows: 1, trueFields: ['exact_one_policy', 'select_only', 'has_self_marker', 'has_cancellation_marker'], falseFields: ['final_subscribed_marker_present', 'final_access_grant_marker_present'] }),
  frozen({ index: 16, exactRows: 1, zeroFields: ['malformed_customer_ids', 'billed_rows_missing_access_stamp'], manualEvidence: ['active_access_rows'] }),
  frozen({ index: 17, exactRows: 1, zeroFields: ['duplicate_customer_groups'] }),
  frozen({ index: 18, exactRows: 1, zeroFields: ['users_missing_deterministic_auth_clock', 'public_users_without_auth_owner'], manualEvidence: ['public_users_missing_created_at'] }),
  frozen({ index: 19, exactRows: 1, zeroFields: ['canonical_email_collision_groups'] }),
  frozen({ index: 20, exactRows: 1, zeroFields: ['duplicate_legacy_resend_message_groups'] }),
  frozen({ index: 21, exactRows: 1, manualEvidence: ['historical_resend_events_requiring_legacy_review'] }),
  frozen({ index: 22, manualEvidence: ['ordinal_position', 'column_name', 'data_type', 'udt_name', 'is_nullable', 'column_default', 'is_identity', 'is_generated'] }),
  frozen({ index: 23, exactRows: 1, trueFields: ['ledger_exists', 'version_column_compatible', 'other_required_columns_compatible', 'exact_nonpartial_unique_version_index', 'execution_role_has_schema_usage', 'execution_role_can_select_ledger', 'execution_role_can_insert_ledger'] }),
  frozen({ index: 24, manualEvidence: ['index_name', 'indisunique', 'indisvalid', 'indisready', 'indislive', 'indnkeyatts', 'indnatts', 'predicate', 'definition'] }),
  frozen({ index: 25, exactRows: 14, trueFields: ['absent'], expectedNames: ['20260827000000', '20260827010000', '20260827020000', '20260827030000', '20260827040000', '20260827050000', '20260827200000', '20260828000000', '20260830000000', '20260830010000', '20260830020000', '20260830030000', '20260830040000', '20260830050000'], nameField: 'version' }),
  frozen({ index: 26, manualEvidence: ['version'] }),
]);

export default alphaR80PreChecks;
