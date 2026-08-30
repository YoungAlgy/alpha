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
const backupFormat = source("./critical-table-backup-format.mjs");
const restore = source("./critical-table-restore.mjs");
const restoreCli = source("./restore-critical-tables-local.mjs");
const drill = source("./drill-r80-backup-restore.mjs");
const workflow = source("../.github/workflows/db-backup.yml");
const recovery = source("../docs/DATABASE_RECOVERY.md");
const migrationFiles = [
  "../supabase/migrations/20260827000000_checkout_fulfillment_claims.sql",
  "../supabase/migrations/20260827010000_stripe_webhook_event_leases.sql",
  "../supabase/migrations/20260827020000_delivery_suppression_pending.sql",
  "../supabase/migrations/20260827030000_legacy_checkout_fulfillments.sql",
  "../supabase/migrations/20260827040000_refund_review_resolution.sql",
  "../supabase/migrations/20260827050000_daily_paid_call_budget.sql",
  "../supabase/migrations/20260827200000_issues_rls_subscribed_access.sql",
  "../supabase/migrations/20260828000000_alpha_renewal_cancellation.sql",
];

const expected = new Map([
  ["users", "id.asc"],
  ["issues", "id.asc"],
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

matches(backupFormat, /BACKUP_FORMAT_VERSION = 3/);
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
matches(backup, /writeFileSync\(path\.join\(outDir, metadata\.file\), bytes\)/);
matches(backup, /buildBackupManifest\(/);
matches(backup, /process\.env\.BACKUP_PRE_R80_MODE === "1"/);
matches(backup, /PRE_ROUND80_TABLES = new Set/);
matches(backup, /failure\?\.code === "PGRST205"/);
matches(workflow, /BACKUP_PRE_R80_MODE: "1"/);

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
matches(restore, /delete environment\.PGHOSTADDR/);
matches(restore, /delete environment\.PGSERVICE/);
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
matches(drill, /argumentValue\("--real-backup-dir"\)/);
matches(drill, /REAL BACKUP DRILL/);
matches(drill, /nativeSibling\(psqlBin, "pg_ctl"\)/);
matches(drill, /-h 127\.0\.0\.1/);
matches(drill, /create role anon nologin/);
matches(drill, /create or replace function auth\.uid\(\)/);
matches(drill, /supabase", "migrations/);
matches(drill, /198\.51\.100\.10/);
matches(drill, /Buffer\.concat\(\[originalUsers, Buffer\.from\("\\n"\)\]\)/);
matches(drill, /nonempty restore target was accepted/);
matches(drill, /support_tickets_id_seq/);
matches(drill, /DRILL PASS:/);
excludes(
  drill,
  /\.env\.local|process\.env\.(?:SUPABASE|STRIPE|RESEND)|fetch\(/i
);

matches(workflow, /permissions:\s*\n\s*contents: read/);
matches(workflow, /openssl enc -aes-256-cbc -pbkdf2 -salt/);
matches(workflow, /rm -rf backup backup\.tar\.gz/);
matches(workflow, /path: backup\.tar\.gz\.enc/);
excludes(workflow, /path:\s*backup\s*$/m);

matches(recovery, /partial recovery snapshot/i);
matches(recovery, /does not export\s+`auth\.users`/i);
matches(recovery, /formatVersion: 3/);
matches(recovery, /rowCount`, `bytes`, and `sha256`/);
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
