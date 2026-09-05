// Fully local release check. Reads source and migration text only.
// No environment loading, network calls, provider clients, or file writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

let assertions = 0;
function matches(text: string, pattern: RegExp, message?: string): void {
  assertions += 1;
  assert.match(text, pattern, message);
}
function excludes(text: string, pattern: RegExp, message?: string): void {
  assertions += 1;
  assert.doesNotMatch(text, pattern, message);
}
function check(value: unknown, message: string): void {
  assertions += 1;
  assert.ok(value, message);
}
function equal(actual: unknown, expectedValue: unknown): void {
  assertions += 1;
  assert.deepEqual(actual, expectedValue);
}

const backup = source("./backup-critical-tables.mjs");
const supabaseGuard = source("./alpha-supabase-url.mjs");
const backupFormat = source("./critical-table-backup-format.mjs");
const restore = source("./critical-table-restore.mjs");
const restoreCli = source("./restore-critical-tables-local.mjs");
const drill = source("./drill-r80-backup-restore.mjs");
const workflow = source("../.github/workflows/db-backup.yml");
const recovery = source("../docs/DATABASE_RECOVERY.md");
const gitignore = source("../.gitignore");
const migrationFiles = [
  "../supabase/migrations/20260806030000_resend_webhook_deliverability.sql",
  "../supabase/migrations/20260827000000_checkout_fulfillment_claims.sql",
  "../supabase/migrations/20260827010000_stripe_webhook_event_leases.sql",
  "../supabase/migrations/20260827020000_delivery_suppression_pending.sql",
  "../supabase/migrations/20260827030000_legacy_checkout_fulfillments.sql",
  "../supabase/migrations/20260827040000_refund_review_resolution.sql",
  "../supabase/migrations/20260827050000_daily_paid_call_budget.sql",
  "../supabase/migrations/20260827200000_issues_rls_subscribed_access.sql",
  "../supabase/migrations/20260828000000_alpha_renewal_cancellation.sql",
  "../supabase/migrations/20260830050000_resend_suppression_causality.sql",
];

const expected = new Map([
  ["users", "id.asc"],
  ["issues", "id.asc"],
  ["resend_delivery_attempts", "attempt_id.asc"],
  ["resend_webhook_events", "email_id.asc,type.asc"],
  ["support_tickets", "id.asc"],
  ["checkout_profiles", "id.asc"],
  ["checkout_fulfillments", "session_id.asc"],
  ["checkout_creation_reviews", "profile_id.asc"],
  ["account_deletion_sagas", "user_id.asc"],
  [
    "account_deletion_alpha_subscriptions",
    "user_id.asc,subscription_id.asc",
  ],
  ["refund_reviews", "session_id.asc,subscription_id.asc"],
  ["legacy_checkout_fulfillments", "session_id.asc"],
]);

let previousTable = -1;
for (const [name, order] of expected) {
  const marker = `name: "${name}"`;
  const tablePosition = backupFormat.indexOf(marker);
  check(tablePosition > previousTable, `${name} must keep the recovery order`);
  previousTable = tablePosition;
  check(
    backupFormat.includes(`order: "${order}"`),
    `${name} must have a stable unique backup order`
  );
  matches(recovery, new RegExp(`\\b${name}\\b`));
}

const createdRound80Tables = new Set(
  migrationFiles.flatMap((path) =>
    [...source(path).matchAll(/create table public\.(\w+)/gi)].map(
      (match) => match[1]
    )
  )
);
const intentionalTransientTables = new Set(["alpha_paid_call_budgets"]);
for (const table of createdRound80Tables) {
  check(
    expected.has(table) || intentionalTransientTables.has(table),
    `Round 80 table ${table} needs backup coverage or an explicit transient classification`
  );
}
equal(
  [...createdRound80Tables].filter((table) => !expected.has(table)),
  ["alpha_paid_call_budgets"]
);

matches(backupFormat, /BACKUP_FORMAT_VERSION = 4/);
check(expected.size === 12, "format 4 must cover all twelve durable tables");
matches(backupFormat, /createHash\("sha256"\)/);
matches(backupFormat, /rowCount,/);
matches(backupFormat, /bytes: bytes\.byteLength/);
matches(backupFormat, /sha256: sha256Hex\(bytes\)/);
matches(backupFormat, /files,/);
matches(backupFormat, /totalRows,/);
matches(backupFormat, /failed,/);

matches(backup, /Prefer: "count=exact"/);
matches(backup, /row count changed during pagination/);
matches(backup, /rows\.length !== expectedTotal/);
matches(backup, /serializeTableRows\(rows\)/);
matches(backup, /tableFileMetadata\(table\.name, bytes, rows\.length\)/);
matches(backup, /writeFileSync\(filePath, bytes/);
matches(backup, /buildBackupManifest\(/);
matches(supabaseGuard, /ALPHA_SUPABASE_HOST = "xpqxhdciaoicsnyyfshy\.supabase\.co"/);
matches(backup, /requireExactAlphaSupabaseUrl\(rawUrl\)/);
matches(backup, /AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/);
matches(backup, /MAX_PAGES_PER_TABLE/);
matches(backup, /MAX_ROWS_PER_TABLE/);
matches(backup, /MAX_TOTAL_ROWS/);
matches(backup, /MAX_TABLE_BYTES/);
matches(backup, /MAX_TOTAL_BYTES/);
matches(backup, /cleanupOutput\(\)/);
matches(backup, /mode: 0o700/);
matches(backup, /mode: 0o600/);
excludes(backup, /response\.text\(\)/);

matches(restore, /manifest\.formatVersion !== BACKUP_FORMAT_VERSION/);
matches(restore, /backup manifest file inventory is incomplete or has extras/);
matches(restore, /bytes\.byteLength !== metadata\.bytes/);
matches(restore, /sha256Hex\(bytes\) !== metadata\.sha256/);
matches(restore, /rows\.length !== metadata\.rowCount/);
matches(restore, /manifest\.totalRows !== totalRows/);
matches(restore, /users: every row needs an exact UUID auth anchor/);
matches(restore, /users: every row needs an exact email auth anchor/);
matches(restore, /auth anchors must have unique IDs and emails/);
matches(restore, /LOCAL_HOSTS = new Set\(\["localhost", "127\.0\.0\.1", "::1"\]\)/);
matches(restore, /restore target must be an explicit loopback host/);
matches(restore, /inet_server_addr\(\)/);
matches(restore, /export function psqlEnvironment\(connection, ambient = process\.env\)/);
matches(restore, /const normalizedKey = key\.toUpperCase\(\)/);
matches(restore, /systemKeys\.has\(normalizedKey\)/);
excludes(restore, /\.\.\.process\.env/);
matches(restore, /begin;[\s\S]*commit;/);
matches(restore, /pg_advisory_xact_lock/);
matches(restore, /in access exclusive mode/);
matches(restore, /restore destination auth table is not empty/);
matches(restore, /restore destination table is not empty/);
matches(restore, /disable trigger user/);
matches(restore, /enable trigger user/);
matches(restore, /insert into auth\.users \(id, email\)/);
matches(restore, /jsonb_populate_recordset/);
matches(restore, /restored row count mismatch/);
matches(restore, /constraint_row\.convalidated/);
matches(restore, /restored foreign key has an orphan/);
matches(restore, /alter sequence %s restart with %s/);
matches(restore, /set constraints all immediate/);
matches(restore, /process\.env\.PSQL_BIN/);
matches(restore, /spawnSync\(/);
excludes(restore, /shell:\s*true/);
excludes(restore, /console\.(?:log|error)/);

matches(restoreCli, /RESTORE PASS:/);
matches(restoreCli, /RESTORE FAIL:/);
matches(restoreCli, /psqlBin: process\.env\.PSQL_BIN/);
excludes(restoreCli, /result\.(?:stdout|stderr)/);

matches(drill, /nativeSibling\(psqlBin, "initdb"\)/);
matches(drill, /nativeSibling\(psqlBin, "pg_ctl"\)/);
matches(drill, /-h 127\.0\.0\.1/);
matches(drill, /create role anon nologin/);
matches(drill, /create or replace function auth\.uid\(\)/);
matches(drill, /supabase", "migrations/);
matches(drill, /198\.51\.100\.10/);
matches(drill, /Buffer\.concat\(\[originalUsers, Buffer\.from\("\\n"\)\]\)/);
matches(drill, /nonempty restore target was accepted/);
matches(drill, /support_tickets_id_seq/);
matches(drill, /insert into public\.resend_delivery_attempts/);
matches(drill, /request_fingerprint, started_at, retry_deadline_at/);
matches(drill, /insert into public\.resend_webhook_events/);
matches(drill, /recipient_hashes,[\s\S]*owner_user_id, resolution_status/);
matches(drill, /public\.resend_delivery_attempts child/);
matches(drill, /active lease allowed email mutation/);
matches(drill, /active lease allowed unsubscribe mutation/);
matches(drill, /delivery state change blocked by active provider lease/);
matches(drill, /public\.finalize_resend_delivery_attempt\(/);
matches(drill, /finalized lease did not release delivery-state mutation/);
matches(drill, /DRILL PASS:/);
excludes(
  drill,
  /\.env\.local|process\.env\.(?:SUPABASE|STRIPE|RESEND)|fetch\(/i
);

matches(workflow, /permissions:\s*\n\s*contents: read/);
matches(workflow, /openssl enc -aes-256-cbc -pbkdf2 -salt/);
matches(workflow, /\$\{RUNNER_TEMP\}\/alpha-db-backup/);
matches(workflow, /trap 'rm -rf -- "\$\{BACKUP_DIR\}" backup\.tar\.gz' EXIT/);
matches(workflow, /rm -rf -- "\$\{BACKUP_DIR\}" backup\.tar\.gz/);
matches(workflow, /path: backup\.tar\.gz\.enc/);
excludes(workflow, /path:\s*backup\s*$/m);
matches(gitignore, /^\/backup\/$/m);

matches(recovery, /partial recovery snapshot/i);
matches(recovery, /does not export\s+`auth\.users`/i);
matches(recovery, /formatVersion: 4/);
matches(recovery, /all twelve tables/i);
matches(recovery, /resend_webhook_events/);
matches(recovery, /rowCount`, `bytes`, and `sha256`/);
matches(recovery, /current `BACKUP_ENCRYPTION_KEY_V2` outside the artifact/i);
matches(
  recovery,
  /older `BACKUP_ENCRYPTION_KEY` only for decrypting\s+historical artifacts/i
);
excludes(recovery, /Keep `BACKUP_ENCRYPTION_KEY` outside the artifact/i);
matches(recovery, /explicit loopback PostgreSQL database/);
matches(recovery, /one PostgreSQL transaction/);
matches(recovery, /exact local Auth anchors/);
matches(recovery, /foreign-key orphans/);
matches(recovery, /ALTER SEQUENCE \.\.\. RESTART/);
matches(recovery, /PSQL_BIN/);
matches(recovery, /synthetic fixture data only/);
matches(recovery, /requires Alex's approval/);
matches(recovery, /Stop conditions/);

console.log(
  `PASS verify-r80-backup-recovery (offline, ${assertions} assertions)`
);
