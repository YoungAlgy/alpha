// Static guard for the canonical Round 80 live verification SQL. Fully local:
// reads reviewed source files only. No env files, database, providers, or network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { maskSqlNonCode } from "./sql-read-only-mask.mjs";

const migrationNames = [
  "20260827000000_checkout_fulfillment_claims.sql",
  "20260827010000_stripe_webhook_event_leases.sql",
  "20260827020000_delivery_suppression_pending.sql",
  "20260827030000_legacy_checkout_fulfillments.sql",
  "20260827040000_refund_review_resolution.sql",
  "20260827050000_daily_paid_call_budget.sql",
  "20260827200000_issues_rls_subscribed_access.sql",
  "20260828000000_alpha_renewal_cancellation.sql",
  "20260830000000_invite_access.sql",
  "20260830010000_weekly_send_delivery_cursors.sql",
  "20260830020000_account_privacy_retry_bounds.sql",
  "20260830030000_distributed_rate_limits.sql",
  "20260830040000_quantity_update_leases.sql",
  "20260830050000_resend_suppression_causality.sql",
] as const;

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

let assertionCount = 0;
function check(value: unknown, message: string): asserts value {
  assert.ok(value, message);
  assertionCount += 1;
}
function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message);
  assertionCount += 1;
}

const verification = source("./r80-live-verification.sql");
const migrations = migrationNames.map((name) => ({
  name,
  sql: source(`../supabase/migrations/${name}`),
}));
const combined = migrations.map(({ sql }) => sql).join("\n");

equal(migrationNames.length, 14, "Round 80 migration count changed");
equal(
  [...migrationNames].sort().join("\n"),
  migrationNames.join("\n"),
  "Round 80 migrations must remain in timestamp order"
);

check(
  verification.includes("-- READ ONLY") &&
    verification.includes("-- PRE-APPLY") &&
    verification.includes("-- POST-APPLY") &&
    verification.includes("-- End of canonical read-only verification template."),
  "canonical verification must retain its read-only and phase markers"
);

// Remove comments and quoted literals before classifying top-level statements.
// This makes words such as CREATE in explanatory comments or catalog strings
// irrelevant while preserving the actual statement shape.
const statementSurface = maskSqlNonCode(verification);
const statements = statementSurface
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
check(statements.length > 0, "canonical verification must contain SQL statements");
for (const [index, statement] of statements.entries()) {
  check(
    /^(select|with)\b/i.test(statement),
    `statement ${index + 1} must begin with SELECT or WITH`
  );
}
check(
  !/\b(insert|update|delete|truncate|alter|create|drop|grant|revoke|copy|call|do|merge|vacuum|analyze|refresh|reindex|cluster|set|reset)\b/i.test(
    statementSurface
  ),
  "canonical verification must not contain a mutating SQL keyword"
);
check(
  !/\b(nextval|setval|pg_advisory_lock|pg_advisory_xact_lock|dblink|lo_import|lo_export)\s*\(/i.test(
    statementSurface
  ),
  "canonical verification must not invoke a known state-changing helper"
);
check(
  !/\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i.test(
    statementSurface
  ),
  "canonical verification must not take row locks"
);

const postMarker = verification.indexOf("-- POST-APPLY");
check(postMarker > 0, "POST-APPLY marker must follow PRE-APPLY");
const pre = verification.slice(0, postMarker).toLowerCase();
const post = verification.slice(postMarker).toLowerCase();

for (const marker of [
  "invite_hold_serializes_and_rechecks_owner",
  "invite_hold_honors_provider_leases",
  "invite_hold_preserves_exact_request_and_binding",
  "pending_review_blocks_paid_replay_claim",
  "pending_reviews_leave_bounded_replay_queue",
  "invite_review_reason_is_validated",
] as const) {
  check(post.includes(marker), `POST-APPLY omits invite replay proof: ${marker}`);
}

function uniqueMatches(pattern: RegExp): string[] {
  return [
    ...new Set(
      [...combined.matchAll(pattern)].map((match) => match[1].toLowerCase())
    ),
  ].sort();
}

const inventories = [
  {
    label: "tables",
    names: uniqueMatches(
      /create table(?: if not exists)? public\.([a-z0-9_]+)/gi
    ),
    expected: 12,
  },
  {
    label: "added columns",
    names: uniqueMatches(/add column(?: if not exists)?\s+([a-z0-9_]+)/gi),
    expected: 40,
  },
  {
    label: "named constraints",
    names: uniqueMatches(/add constraint\s+([a-z0-9_]+)/gi),
    expected: 21,
  },
  {
    label: "indexes",
    names: uniqueMatches(
      /create(?: unique)? index(?: if not exists)?\s+([a-z0-9_]+)/gi
    ),
    expected: 37,
  },
  {
    label: "triggers",
    names: uniqueMatches(/create trigger\s+([a-z0-9_]+)/gi),
    expected: 16,
  },
  {
    label: "functions",
    names: uniqueMatches(
      /create or replace function public\.([a-z0-9_]+)/gi
    ),
    expected: 112,
  },
] as const;

for (const inventory of inventories) {
  equal(
    inventory.names.length,
    inventory.expected,
    `Round 80 ${inventory.label} inventory changed`
  );
  for (const name of inventory.names) {
    check(pre.includes(name), `PRE-APPLY omits ${inventory.label}: ${name}`);
    check(post.includes(name), `POST-APPLY omits ${inventory.label}: ${name}`);
  }
}

const resendMigration =
  migrations.find(
    ({ name }) => name === "20260830050000_resend_suppression_causality.sql"
  )?.sql.toLowerCase() || "";
check(resendMigration.length > 0, "Resend causality migration must be present");
for (const marker of [
  "left join auth.users auth_user on auth_user.id = user_row.id",
  "user_row.created_at is null",
  "auth_user.created_at is null",
  "set created_at = auth_user.created_at",
  "alter column created_at set not null",
  "insert into public.users (id, email, created_at)",
  "values (new.id, new.email, new.created_at)",
] as const) {
  check(
    resendMigration.includes(marker),
    `deterministic users.created_at cutover omits ${marker}`
  );
}
check(
  !resendMigration.includes("set created_at = now()"),
  "users.created_at cutover must never invent migration-time causality"
);

function section(body: string, startMarker: string, endMarker: string): string {
  const start = body.indexOf(startMarker);
  const end = body.indexOf(endMarker, start + startMarker.length);
  check(start >= 0, `missing SQL proof section: ${startMarker}`);
  check(end > start, `missing SQL proof section boundary: ${endMarker}`);
  return body.slice(start, end);
}

const serviceTableProof = section(
  post,
  "-- pass: all 12 service-only tables",
  "-- pass: all 14 coordination-table columns"
);
for (const table of [
  "weekly_send_delivery_cursors",
  "alpha_rate_limit_buckets",
  "alpha_quantity_update_leases",
] as const) {
  check(
    serviceTableProof.includes(`('${table}')`),
    `service-table privilege proof omits ${table}`
  );
}

const coordinationColumnProof = section(
  post,
  "-- pass: all 14 coordination-table columns",
  "-- pass: all three rows report exists and columns_match"
);
for (const marker of [
  "weekly_send_delivery_cursors', 'week_of'",
  "weekly_send_delivery_cursors', 'cursor_user_id'",
  "alpha_rate_limit_buckets', 'scope'",
  "alpha_rate_limit_buckets', 'key_hash'",
  "alpha_rate_limit_buckets', 'window_seconds'",
  "alpha_rate_limit_buckets', 'request_count'",
  "alpha_quantity_update_leases', 'user_id'",
  "alpha_quantity_update_leases', 'lease_token'",
  "alpha_quantity_update_leases', 'lease_expires_at'",
] as const) {
  check(
    coordinationColumnProof.includes(marker),
    `coordination-table shape proof omits ${marker}`
  );
}

const coordinationKeyProof = section(
  post,
  "-- pass: all three rows report exists and columns_match",
  "-- pass: all six distributed-limiter bounds"
);
for (const table of [
  "weekly_send_delivery_cursors",
  "alpha_rate_limit_buckets",
  "alpha_quantity_update_leases",
] as const) {
  check(
    coordinationKeyProof.includes(table),
    `coordination-table primary-key proof omits ${table}`
  );
}
for (const marker of [
  "exact_table_column_count",
  "columns_match",
  "index_ready",
  "index_valid",
  "index_live",
] as const) {
  check(post.includes(marker), `coordination-table proof omits ${marker}`);
}
check(
  coordinationKeyProof.includes("array_agg(a.attname::text"),
  "coordination key proof must compare text[] with text[]"
);

const limiterBoundProof = section(
  post,
  "-- pass: all six distributed-limiter bounds",
  "-- pass: exact_four_checks = true"
);
for (const marker of [
  "^[a-z0-9][a-z0-9:_-]{0,63}$",
  "^[0-9a-f]{64}$",
  "window_seconds >= 1",
  "window_seconds <= 2592000",
  "request_count >= 1",
  "request_count <= 10001",
] as const) {
  check(limiterBoundProof.includes(marker), `rate-limit proof omits ${marker}`);
}

const addedColumnProof = section(
  post,
  "-- pass: all 40 rows report exists = true and shape_matches = true",
  "-- pass: all 21 named constraints"
);
for (const column of [
  "access_requested_at",
  "access_granted_at",
  "reconcile_last_error_code",
  "reconcile_dead_lettered_at",
  "stripe_email_sync_attempt_count",
  "stripe_email_sync_last_error_code",
  "stripe_email_sync_dead_lettered_at",
  "suppression_cleanup_attempt_count",
  "suppression_cleanup_last_error_code",
  "suppression_cleanup_dead_lettered_at",
  "delivery_suppression_cleared_at",
  "suppression_recovery_token",
  "suppression_recovery_started_at",
  "suppression_recovery_snapshot",
] as const) {
  check(addedColumnProof.includes(column), `added-column proof omits ${column}`);
}

const inviteIndexProof = section(
  post,
  "-- pass: every boolean is true. pending requests remain indexed",
  "-- pass: all 17 rows report exists, enabled_normally"
);
for (const marker of [
  "users_pending_access_request_idx",
  "access_requested_at is not null",
  "access_granted_at is null",
  "ignores_legacy_entitlement_marker",
] as const) {
  check(inviteIndexProof.includes(marker), `invite index proof omits ${marker}`);
}
check(
  combined
    .toLowerCase()
    .replace(/\s+/g, " ")
    .includes("access_requested_at is not null and access_granted_at is null"),
  "invite migration must keep pending requests indexed until explicit grant"
);

for (const marker of [
  "users_missing_deterministic_auth_clock",
  "public_users_without_auth_owner",
  "canonical_email_collision_groups",
  "duplicate_legacy_resend_message_groups",
  "historical_resend_events_requiring_legacy_review",
  "left join auth.users au on au.id = u.id",
] as const) {
  check(pre.includes(marker), `PRE-APPLY omits hard cutover gate: ${marker}`);
}

for (const marker of [
  "users_created_at_is_not_null",
  "zero_users_missing_created_at",
  "auth_creation_clock_required",
  "public_insert_includes_created_at",
  "exact_auth_creation_clock_copied",
  "all 14 staged-delivery columns",
  "exact_eight_checks",
  "exact_23_hour_retry_window",
  "issue_owner_fk_cascades",
  "message_id_is_unique",
  "exact_fingerprint_shape",
  "one_way_finalization_present",
  "manual_review_after_retry_deadline",
  "service_no_insert",
  "service_no_update",
  "service_no_delete",
  "all nine audit columns",
  "legacy_review",
  "pending_owner",
  "manual_review",
  "unresolved_suppression_reviews",
  "invalid_resolution_status",
  "invalid_resolution_markers",
  "invalid_event_clock_state",
  "invalid_recipient_hash_rows",
  "exact_one_audit_primary_key",
  "owner_foreign_key_cascades",
  "exact_three_validated_audit_checks",
  "exact_resolution_states_present",
  "review_resolution_marker_shape_present",
  "legacy_only_null_event_clock_present",
  "pending_review_index_ready",
  "pending_review_index_predicate_present",
  "pending_review_index_columns_present",
  "active_delivery_leases",
  "expired_attempts_awaiting_review_stamp",
  "delivery_attempts_in_manual_review",
  "issues_with_multiple_unresolved_lanes",
] as const) {
  check(post.includes(marker), `POST-APPLY omits delivery proof: ${marker}`);
}

for (const marker of [
  "account_deletion_active_delivery_guard",
  "users_active_delivery_state_guard",
  "block_account_deletion_with_active_delivery",
  "block_user_delivery_change_with_active_attempt",
] as const) {
  check(pre.includes(marker), `PRE-APPLY omits trigger drift gate: ${marker}`);
  check(post.includes(marker), `POST-APPLY omits trigger proof: ${marker}`);
}

for (const marker of [
  "user_guard_is_before_critical_updates",
  "user_guard_covers_delivery_state",
  "deletion_guard_is_before_saga_start",
] as const) {
  check(post.includes(marker), `POST-APPLY omits trigger event proof: ${marker}`);
}

for (const marker of [
  "manual release gate",
  "late_post_deletion_provider_event_path_closed",
  "production_privacy_cutover_verified",
  "provider_team_isolation_must_be_verified",
  "scheduled_retention_run_must_be_verified",
  "no_false_provider_deletion_marker",
  "expired_unowned_events_due",
  "manual hold: do not apply",
] as const) {
  check(post.includes(marker), `POST-APPLY omits late-event manual gate: ${marker}`);
}
check(
  post.includes("false as production_privacy_cutover_verified"),
  "production cutover must stay held after local policy verification"
);

check(pre.includes("migration_role_can_guard_auth_identity"),
  "PRE-APPLY must verify permission for the exact Auth trigger installation");
for (const marker of [
  "recovery_claim_checks_owner_and_conflicts",
  "recovery_finish_preserves_changed_state_and_original_clock",
  "unresolved_recovery_blocks_deletion",
  "auth_identity_change_checks_locked_owner",
  "unresolved_recovery_blocks_delivery",
  "unresolved_recovery_keeps_review_due",
  "recovery_snapshot_has_no_direct_api_access",
  "recovery_snapshot_timezone_is_fixed",
  "recovery_identity_guard_events_match",
  "recovery_identity_guard_columns_match",
  "unresolved_suppression_recoveries",
]) {
  check(post.includes(marker), `POST-APPLY omits durable recovery proof: ${marker}`);
}

const functionDefinitionCount = [
  ...combined.matchAll(/create or replace function public\.[a-z0-9_]+/gi),
].length;
equal(functionDefinitionCount, 126, "Round 80 function definition count changed");
equal(
  [...combined.matchAll(/\bsecurity definer\b/gi)].length,
  functionDefinitionCount,
  "every Round 80 function definition must be SECURITY DEFINER"
);
equal(
  [...combined.matchAll(/\bset search_path\s*=\s*public\b/gi)].length,
  functionDefinitionCount,
  "every Round 80 function definition must pin search_path to public"
);

const normalizeSignature = (value: string) =>
  value.toLowerCase().replace(/\s+/g, "");
const grantSignatures = [
  ...combined.matchAll(
    /grant\s+execute\s+on\s+function\s+(public\.[a-z0-9_]+\s*\([^;]*?\))\s+to\s+service_role\s*;/gi
  ),
].map((match) => normalizeSignature(match[1]));
equal(grantSignatures.length, 97, "service-role grant statement count changed");
const uniqueGrantSignatures = [...new Set(grantSignatures)].sort();
equal(
  uniqueGrantSignatures.length,
  91,
  "distinct service-role grant signature count changed"
);
const normalizedPost = normalizeSignature(post);
for (const signature of uniqueGrantSignatures) {
  check(
    normalizedPost.includes(signature),
    `POST-APPLY omits service-role function signature: ${signature}`
  );
}
for (const signature of [
  "public.advance_weekly_send_cursor(date,uuid,uuid)",
  "public.claim_alpha_quantity_update(uuid,uuid,integer)",
  "public.release_alpha_quantity_update(uuid,uuid)",
  "public.consume_alpha_rate_limit(text,text,integer,integer)",
  "public.fail_stripe_email_sync(uuid,uuid,text,timestamptz)",
  "public.requeue_stripe_email_sync(uuid)",
  "public.count_dead_lettered_stripe_email_sync()",
  "public.fail_suppression_cleanup(uuid,timestamptz,text,timestamptz,timestamptz,timestamptz,text,text,timestamptz,timestamptz,timestamptz,text,timestamptz)",
  "public.requeue_suppression_cleanup(uuid)",
  "public.count_dead_lettered_suppression_cleanups()",
  "public.fail_account_deletion_reconciliation(uuid,text,timestamptz)",
  "public.requeue_account_deletion_reconciliation(uuid)",
  "public.count_dead_lettered_account_deletions()",
  "public.claim_resend_delivery_attempt(uuid,date,text,text,text,uuid,timestamptz)",
  "public.finalize_resend_delivery_attempt(uuid,date,text,uuid,text,text)",
  "public.record_resend_suppression_event(text,text,timestamptz,text[])",
] as const) {
  check(
    uniqueGrantSignatures.includes(signature),
    `Round 80 migrations omit service-only RPC grant: ${signature}`
  );
}
check(
  post.includes("'search_path=public,pg_temp'"),
  "POST-APPLY must accept the pinned public, pg_temp function search path"
);

const resendCausalityProof = section(
  post,
  "-- pass: every boolean is true. these exact installed bodies",
  "-- pass: all 17 trigger/protection function signatures"
);
for (const marker of [
  "claim_locks_and_rechecks_user",
  "claim_rechecks_exact_delivery_eligibility",
  "claim_rejects_any_deletion_saga",
  "cross_lane_pending_guard_present",
  "exact_23_hour_auto_retry_ceiling",
  "bounded_provider_lease_present",
  "claim_rejects_payload_drift",
  "finalize_uses_shared_message_lock",
  "finalize_requires_exact_lease_and_fingerprint",
  "finalization_is_one_way_and_database_stamped",
  "fast_webhook_replayed_during_finalize",
  "issue_proof_repair_is_pointer_aware",
  "writes_audit_row_before_resolution",
  "webhook_uses_shared_message_lock",
  "attempt_owner_precedes_legacy_issue_fallback",
  "missing_recipients_derive_from_finalized_attempt",
  "signed_event_clock_is_validated",
  "unresolved_suppression_states_are_durable",
  "suppression_owner_and_creation_clock_are_bound",
  "newer_clear_wins_by_signed_event_clock",
  "suppression_evidence_is_monotonic",
  "active_user_delivery_mutation_guard_present",
  "active_delivery_deletion_guard_present",
  "apply_helper_service_no_execute",
  "claim_service_execute",
  "finalize_service_execute",
  "record_service_execute",
] as const) {
  check(
    resendCausalityProof.includes(marker),
    `POST-APPLY Resend causality proof omits ${marker}`
  );
}
for (const marker of [
  "insert into public.resend_webhook_events",
  "on conflict (email_id, type) do nothing",
  "from public.resend_delivery_attempts",
  "a.delivery_lane <> p_delivery_lane",
  "return query select 'other_lane_pending'::text",
  "v_now + interval '23 hours'",
  "v_now >= v_attempt.retry_deadline_at",
  "manual_review_required_at = coalesce",
  "alpha-resend-message:",
  "from public.resend_webhook_events",
  "public.apply_resend_suppression_to_user",
  "v_user.created_at > p_event_at",
  "v_user.delivery_suppression_cleared_at > p_event_at",
  "v_user.bounced_at >= p_event_at",
  "v_user.complained_at >= p_event_at",
  "new.email is distinct from old.email",
  "new.state <> 'complete'",
] as const) {
  check(
    combined.toLowerCase().includes(marker),
    `Round 80 Resend suppression RPC omits ${marker}`
  );
}

const baselineWatchdogProof = section(
  pre,
  "-- pass: the baseline watchdog exists",
  "-- pass: the baseline issue policy exists"
);
for (const marker of [
  "exact_one_baseline_watchdog",
  "security_definer",
  "pinned_search_path",
  "anon_execute",
  "authenticated_no_execute",
  "public_no_execute",
  "body_has_no_comments",
  "has_access_stamp_marker",
  "has_paid_window_markers",
  "has_delivery_exclusion_markers",
  "has_proof_of_send_markers",
  "round80_access_grant_marker_present",
  "round80_suppression_marker_present",
  "aclexplode(coalesce(proacl, acldefault('f', proowner)))",
] as const) {
  check(
    baselineWatchdogProof.includes(marker),
    `PRE-APPLY baseline watchdog proof omits ${marker}`
  );
}
check(
  baselineWatchdogProof.includes("to_regprocedure(") &&
    baselineWatchdogProof.includes(
      "'public.watchdog_delivery_check(timestamptz)'"
    ),
  "PRE-APPLY must inspect the exact watchdog signature"
);

const installedWatchdogProof = section(
  post,
  "-- pass: every boolean is true. the invite-aware watchdog",
  "-- pass: every boolean is true. the installed function bodies"
);
for (const marker of [
  "exact_one_watchdog",
  "security_definer",
  "pinned_search_path",
  "anon_execute",
  "authenticated_no_execute",
  "public_no_execute",
  "body_has_no_comments",
  "access_stamp_in_both_population_branches",
  "access_grant_in_both_population_branches",
  "paid_window_in_both_population_branches",
  "deliverability_filters_in_both_population_branches",
  "suppression_filter_in_both_population_branches",
  "uncovered_branch_has_proof_of_send",
  "access_grant_occurrences = 2",
  "suppression_exclusion_occurrences = 2",
  "aclexplode(coalesce(proacl, acldefault('f', proowner)))",
] as const) {
  check(
    installedWatchdogProof.includes(marker),
    `POST-APPLY invite watchdog proof omits ${marker}`
  );
}
check(
  installedWatchdogProof.includes(
    "'public.watchdog_delivery_check(timestamptz)'"
  ),
  "POST-APPLY must inspect the exact watchdog signature"
);
const inviteWatchdogDefinition =
  migrations
    .find(({ name }) => name === "20260830000000_invite_access.sql")
    ?.sql.match(
      /create or replace function public\.watchdog_delivery_check\(cutoff timestamptz\)[\s\S]*?\n\$\$;/i
    )?.[0]
    .toLowerCase() || "";
check(inviteWatchdogDefinition.length > 0, "invite migration must define the watchdog");
for (const marker of [
  "u.subscribed_at is not null",
  "u.access_granted_at is not null",
  "u.cancelled_at is null",
  "u.cancelled_at > now()",
  "u.unsubscribed_at is null",
  "u.bounced_at is null",
  "u.complained_at is null",
  "u.suppression_cleanup_pending_at is null",
] as const) {
  equal(
    inviteWatchdogDefinition.split(marker).length - 1,
    2,
    `invite watchdog must use ${marker} in both population branches`
  );
}
for (const marker of [
  "i.user_id = u.id",
  "i.delivered_at >= date_trunc('hour', cutoff)",
  "i.resend_message_id is not null",
  "i.delivered_at < '2026-08-05t19:10:00z'::timestamptz",
] as const) {
  check(
    inviteWatchdogDefinition.includes(marker),
    `invite watchdog proof-of-send body omits ${marker}`
  );
}
check(
  combined
    .toLowerCase()
    .includes(
      "revoke all on function public.watchdog_delivery_check(timestamptz) from public;"
    ) &&
    combined
      .toLowerCase()
      .includes(
        "revoke all on function public.watchdog_delivery_check(timestamptz) from authenticated;"
      ) &&
    combined
      .toLowerCase()
      .includes(
        "grant execute on function public.watchdog_delivery_check(timestamptz) to anon;"
      ),
  "invite migration must retain watchdog privilege boundaries"
);

equal(
  [...verification.matchAll(/\bi\.indpred is null\b/gi)].length,
  2,
  "PRE and POST must both reject a partial migration-ledger index"
);
equal(
  [...verification.matchAll(/\bi\.indisready\b/gi)].length >= 4,
  true,
  "ledger and index checks must verify readiness"
);
equal(
  [...verification.matchAll(/\bi\.indislive\b/gi)].length >= 4,
  true,
  "ledger and index checks must verify live index state"
);
equal(
  [...verification.matchAll(/execution_role_can_select_ledger/gi)].length,
  2,
  "PRE and POST must verify ledger SELECT access"
);
equal(
  [...verification.matchAll(/execution_role_can_insert_ledger/gi)].length,
  2,
  "PRE and POST must verify ledger INSERT access"
);

for (const role of ["anon", "authenticated"] as const) {
  for (const privilege of [
    "select",
    "insert",
    "update",
    "delete",
    "truncate",
    "references",
    "trigger",
  ] as const) {
    check(
      post.includes(`${role}_no_${privilege}`),
      `POST-APPLY omits ${role} table privilege denial: ${privilege}`
    );
  }
  for (const privilege of ["select", "insert", "update", "references"] as const) {
    check(
      post.includes(`${role}_no_column_${privilege}`),
      `POST-APPLY omits ${role} column privilege denial: ${privilege}`
    );
  }
}

for (const marker of [
  "all_security_definer",
  "all_pinned_search_path",
  "service_execute",
  "anon_no_execute",
  "authenticated_no_execute",
  "enabled_normally",
  "validated",
  "exact_one_status_check",
  "has_self_marker",
  "has_access_stamp_marker",
  "has_access_grant_marker",
  "has_cancellation_marker",
  "malformed_customer_ids",
  "malformed_subscription_ids",
  "subscription_without_customer",
  "billed_rows_missing_access_stamp",
  "active_paid_rows_missing_exact_subscription",
  "active_paid_rows_with_exact_local_shape",
  "active_free_access_rows",
  "active_access_rows",
  "duplicate_customer_groups",
  "duplicate_subscription_groups",
  "checkout_profile_identity_mismatches",
  "non_succeeded",
  "unexpected_live_leases",
  "pending_checkout_creation_reviews",
  "dead_lettered_checkout_profiles",
  "pending_checkout_fulfillments",
  "incomplete_account_deletions",
  "dead_lettered_account_deletions",
  "unresolved_refund_reviews",
  "dead_lettered_legacy_fulfillments",
  "nonterminal_legacy_fulfillments",
  "pending_renewal_cancellations",
  "pending_suppression_cleanup",
  "dead_lettered_suppression_cleanups",
  "pending_stripe_email_sync",
  "dead_lettered_stripe_email_sync",
  "maintenance_due",
] as const) {
  check(post.includes(marker), `POST-APPLY omits required marker: ${marker}`);
}

const accessMetricProof = section(
  post,
  "-- pass immediately after migration: malformed_customer_ids",
  "-- pass before checkout reopens: both duplicate counts"
);
function metricFilter(metric: string): string {
  const endMarker = `) as ${metric}`;
  const end = accessMetricProof.indexOf(endMarker);
  check(end >= 0, `POST-APPLY access metrics omit ${metric}`);
  const start = accessMetricProof.lastIndexOf("count(*) filter (", end);
  check(start >= 0, `POST-APPLY access metric has no filter: ${metric}`);
  return accessMetricProof.slice(start, end + endMarker.length);
}
for (const metric of [
  "active_paid_rows_missing_exact_subscription",
  "active_paid_rows_with_exact_local_shape",
] as const) {
  const filter = metricFilter(metric);
  check(
    !filter.includes("access_granted_at"),
    `${metric} must classify paid binding rows only by the paid window`
  );
  check(
    filter.includes("cancelled_at is null or cancelled_at > now()"),
    `${metric} must retain the active paid cancellation window`
  );
}
for (const metric of ["active_free_access_rows", "active_access_rows"] as const) {
  check(
    metricFilter(metric).includes("access_granted_at is not null"),
    `${metric} must retain permanent invite access evidence`
  );
}

check(
  post.includes("with verification_clock as") &&
    post.includes("from verification_clock"),
  "POST-APPLY must calculate maintenance state through direct table reads"
);
check(
  !/public\.alpha_scheduled_maintenance_due\s*\(\s*now\(\)\s*\)/.test(post),
  "POST-APPLY must not invoke the application maintenance helper"
);
for (const marker of [
  "checkout_body_has_no_comments",
  "checkout_owner_pair_guard_present",
  "binding_body_has_no_comments",
  "binding_assignment_before_conflicts",
  "already_bound_after_all_conflicts_before_update",
  "strict_checkout_owner_conflicts_present",
] as const) {
  check(
    post.includes(marker),
    `POST-APPLY installed binding proof omits marker: ${marker}`
  );
}

const retryResetProof = section(
  post,
  "-- pass: every reset assignment reports present = true",
  "-- pass: every final maintenance marker reports present = true"
);
const protectedColumnProof = section(
  post,
  "-- pass: every protected-column assignment reports present = true",
  "-- pass: every reset assignment reports present = true"
);
for (const marker of [
  "new.access_requested_at := old.access_requested_at",
  "new.access_granted_at := old.access_granted_at",
  "new.stripe_email_sync_attempt_count := old.stripe_email_sync_attempt_count",
  "new.stripe_email_sync_last_error_code := old.stripe_email_sync_last_error_code",
  "new.stripe_email_sync_dead_lettered_at := old.stripe_email_sync_dead_lettered_at",
  "new.suppression_cleanup_attempt_count := old.suppression_cleanup_attempt_count",
  "new.suppression_cleanup_last_error_code := old.suppression_cleanup_last_error_code",
  "new.suppression_cleanup_dead_lettered_at := old.suppression_cleanup_dead_lettered_at",
  "new.delivery_suppression_cleared_at := old.delivery_suppression_cleared_at",
] as const) {
  check(
    combined.toLowerCase().includes(marker),
    `Round 80 privileged-column guard omits marker: ${marker}`
  );
  check(
    protectedColumnProof.includes(marker),
    `POST-APPLY privileged-column proof omits ${marker}`
  );
}
for (const marker of [
  "new.suppression_cleanup_attempt_count := 0",
  "new.suppression_cleanup_last_error_code := null",
  "new.suppression_cleanup_dead_lettered_at := null",
  "new.stripe_email_sync_attempt_count := 0",
  "new.stripe_email_sync_last_error_code := null",
  "new.stripe_email_sync_dead_lettered_at := null",
] as const) {
  check(
    combined.toLowerCase().includes(marker),
    `Round 80 retry normalizer omits reset marker: ${marker}`
  );
  check(retryResetProof.includes(marker), `POST-APPLY retry proof omits ${marker}`);
}
check(
  retryResetProof.includes("body_has_no_comments"),
  "POST-APPLY retry proof must reject comment-spoofed markers"
);
const compactPost = post.replace(/\s+/g, " ");
for (const marker of [
  "if v_already_bound then",
  "return ''deletion_pending''",
  "return ''renewal_pending''",
  "return ''checkout_pending''",
  "return ''legacy_fulfillment_pending''",
  "return ''refund_review_pending''",
  "return ''reservation_conflict''",
  "return ''already_bound''",
  "update public.users",
] as const) {
  check(
    compactPost.includes(`position('${marker}' in binding_definition) > 0`),
    `POST-APPLY installed binding proof does not require marker presence: ${marker}`
  );
}
check(
  post.indexOf("return ''reservation_conflict''") <
    post.indexOf("return ''already_bound''"),
  "POST-APPLY must prove reservation conflict precedes already_bound"
);
check(
  post.indexOf("return ''already_bound''") <
    post.indexOf("update public.users"),
  "POST-APPLY must prove already_bound precedes the binding update"
);
for (const marker of [
  "session_creation_lease_expires_at",
  "recovery_lease_expires_at",
  "identity_scrubbed_at",
  "raw_profile_scrubbed_at",
  "reconcile_next_attempt_at",
  "resolved_at",
  "reconcile_dead_lettered_at",
  "suppression_cleanup_next_attempt_at",
  "stripe_email_sync_next_attempt_at",
  "renewal_cancel_next_attempt_at",
] as const) {
  check(
    post.includes(marker),
    `POST-APPLY direct maintenance predicate omits marker: ${marker}`
  );
}
for (const marker of [
  "s.reconcile_dead_lettered_at is null",
  "u.suppression_cleanup_dead_lettered_at is null",
  "u.stripe_email_sync_dead_lettered_at is null",
] as const) {
  check(
    combined.toLowerCase().includes(marker),
    `Round 80 maintenance function omits dead-letter exclusion: ${marker}`
  );
  check(
    post.includes(marker),
    `POST-APPLY direct maintenance predicate omits dead-letter exclusion: ${marker}`
  );
}

for (const marker of [
  "new.owner_user_id <> new.provisioned_user_id",
  "v_already_bound :=",
  "if v_already_bound then",
  "p.owner_user_id <> p_user_id",
  "p.provisioned_user_id <> p_user_id",
] as const) {
  check(
    combined.toLowerCase().includes(marker),
    `Round 80 migrations omit binding or checkout identity marker: ${marker}`
  );
  check(
    post.includes(marker),
    `POST-APPLY omits binding or checkout identity marker: ${marker}`
  );
}

for (const version of migrationNames.map((name) => name.slice(0, 14))) {
  check(pre.includes(version), `PRE-APPLY omits ledger version ${version}`);
  check(post.includes(version), `POST-APPLY omits ledger version ${version}`);
}

console.log(
  `PASS verify-r80-live-verification (offline, ${assertionCount} assertions)`
);
