// Offline unit verifier for the Round 80 backup format and local restore guard.
// It writes synthetic JSON only under the operating-system temp directory.
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BACKUP_FORMAT_VERSION,
  buildBackupManifest,
  CRITICAL_TABLES,
  serializeTableRows,
  tableFileMetadata,
} from "./critical-table-backup-format.mjs";
import {
  buildRestoreSql,
  parseLocalPostgresUrl,
  psqlEnvironment,
  RestoreValidationError,
  validateBackupDirectory,
} from "./critical-table-restore.mjs";

let assertions = 0;
function check(value: unknown, message: string): asserts value {
  assertions += 1;
  assert.ok(value, message);
}

function rejectsRestore(action: () => unknown, pattern: RegExp): void {
  assertions += 1;
  assert.throws(action, (error: unknown) => {
    return error instanceof RestoreValidationError && pattern.test(error.message);
  });
}

function fixtureRow(tableName: string): Record<string, unknown> {
  switch (tableName) {
    case "users":
      return {
        email: "restore-unit@fixture.invalid",
        id: "11111111-1111-4111-8111-111111111111",
      };
    case "issues":
      return { id: "44444444-4444-4444-8444-444444444444" };
    case "resend_delivery_attempts":
      return {
        attempt_id: "55555555-5555-4555-8555-555555555555",
        user_id: "11111111-1111-4111-8111-111111111111",
        issue_id: "44444444-4444-4444-8444-444444444444",
        recipient: "restore-unit@fixture.invalid",
        delivery_lane: "live",
        request_fingerprint: "a".repeat(64),
        started_at: "2026-08-30T12:00:00.000Z",
        retry_deadline_at: "2026-08-31T11:00:00.000Z",
        resend_message_id: "resend-unit-message",
        accepted_at: "2026-08-30T12:00:01.000Z",
      };
    case "resend_webhook_events":
      return {
        email_id: "resend-unit-message",
        type: "email.bounced",
        received_at: "2026-08-30T12:05:02.000Z",
        event_at: "2026-08-30T12:05:00.000Z",
        recipient_hashes: [
          "e1424f359149365651d639f175c5a49eedb202b59e2bc72488583fdfa17daa82",
        ],
        owner_user_id: "11111111-1111-4111-8111-111111111111",
        resolution_status: "applied",
        review_required_at: null,
        resolved_at: "2026-08-30T12:05:03.000Z",
      };
    case "support_tickets":
      return { id: 42 };
    case "checkout_profiles":
      return { id: "33333333-3333-4333-8333-333333333333" };
    case "checkout_fulfillments":
      return { session_id: "cs_test_unit" };
    case "checkout_creation_reviews":
      return { profile_id: "33333333-3333-4333-8333-333333333333" };
    case "account_deletion_sagas":
      return { user_id: "11111111-1111-4111-8111-111111111111" };
    case "account_deletion_alpha_subscriptions":
      return {
        subscription_id: "sub_test_unit",
        user_id: "11111111-1111-4111-8111-111111111111",
      };
    case "refund_reviews":
      return {
        session_id: "cs_test_refund_unit",
        subscription_id: "sub_test_refund_unit",
      };
    case "legacy_checkout_fulfillments":
      return { session_id: "cs_test_legacy_unit" };
    default:
      throw new Error("unexpected critical table");
  }
}

const temporaryDirectory = mkdtempSync(
  path.join(os.tmpdir(), "alpha-r80-restore-unit-")
);
try {
  const files: Record<string, ReturnType<typeof tableFileMetadata>> = {};
  for (const { name } of CRITICAL_TABLES) {
    const rows = [fixtureRow(name)];
    const bytes = serializeTableRows(rows);
    const metadata = tableFileMetadata(name, bytes, rows.length);
    files[name] = metadata;
    writeFileSync(path.join(temporaryDirectory, metadata.file), bytes);
  }
  const manifest = buildBackupManifest({
    backedUpAt: "2026-08-30T12:00:00.000Z",
    failed: false,
    files,
  });
  const manifestPath = path.join(temporaryDirectory, "MANIFEST.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const snapshot = validateBackupDirectory(temporaryDirectory);
  check(manifest.formatVersion === BACKUP_FORMAT_VERSION, "format version must match");
  check(snapshot.totalRows === CRITICAL_TABLES.length, "all fixture rows must validate");
  check(snapshot.anchors.length === 1, "one exact auth anchor must be prepared");
  check(
    snapshot.anchors[0].id === "11111111-1111-4111-8111-111111111111" &&
      snapshot.anchors[0].email === "restore-unit@fixture.invalid",
    "the auth anchor must preserve the users JSON ID and email"
  );

  const usersPath = path.join(temporaryDirectory, "users.json");
  const usersBytes = readFileSync(usersPath);
  writeFileSync(usersPath, Buffer.concat([usersBytes, Buffer.from("\n")]));
  rejectsRestore(
    () => validateBackupDirectory(temporaryDirectory),
    /byte count|SHA-256/
  );
  writeFileSync(usersPath, usersBytes);

  const mismatchedManifest = structuredClone(manifest);
  mismatchedManifest.files.issues.rowCount += 1;
  writeFileSync(manifestPath, JSON.stringify(mismatchedManifest, null, 2));
  rejectsRestore(
    () => validateBackupDirectory(temporaryDirectory),
    /row count does not match/
  );
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const local = parseLocalPostgresUrl(
    "postgresql://postgres@127.0.0.1:55432/alpha_restore"
  );
  check(local.host === "127.0.0.1", "IPv4 loopback must be accepted");
  check(local.port === "55432", "the explicit local port must be preserved");
  check(
    parseLocalPostgresUrl("postgresql://postgres@[::1]/alpha_restore").host ===
      "::1",
    "IPv6 loopback must be accepted"
  );
  rejectsRestore(
    () => parseLocalPostgresUrl("postgresql://postgres@198.51.100.10/alpha"),
    /loopback/
  );
  rejectsRestore(
    () => parseLocalPostgresUrl("postgresql://postgres@localhost/alpha?sslmode=require"),
    /query or fragment/
  );

  const childEnvironment = psqlEnvironment(local, {
    Path: "C:\\Windows\\System32",
    SYSTEMROOT: "C:\\Windows",
    TEMP: "C:\\Temp",
    HOME: "C:\\ambient-home-must-not-pass",
    NODE_OPTIONS: "--require=ambient-must-not-pass",
    PGOPTIONS: "-c default_transaction_read_only=on",
    PGPASSFILE: "C:\\ambient-pgpass-must-not-pass",
    PGSSLROOTCERT: "C:\\ambient-root-cert-must-not-pass",
    PGSERVICE: "ambient-service-must-not-pass",
  });
  check(childEnvironment.PATH === "C:\\Windows\\System32", "mixed-case PATH must pass through once under its canonical key");
  check(childEnvironment.SYSTEMROOT === "C:\\Windows", "SystemRoot must pass through");
  check(childEnvironment.TEMP === "C:\\Temp", "temporary-directory configuration must pass through");
  check(childEnvironment.PGHOST === local.host, "explicit loopback host must be set");
  check(childEnvironment.PGPORT === local.port, "explicit loopback port must be set");
  check(childEnvironment.PGDATABASE === local.database, "explicit database must be set");
  check(childEnvironment.PGUSER === local.user, "explicit database user must be set");
  check(childEnvironment.PGPASSWORD === local.password, "explicit URL password must be set");
  check(childEnvironment.PGPASSFILE === os.devNull, "saved password-file fallback must use the null device");
  check(childEnvironment.PGSSLMODE === "disable", "local transport must disable TLS");
  check(!("HOME" in childEnvironment), "unrelated ambient HOME must not reach the psql child");
  check(!("NODE_OPTIONS" in childEnvironment), "NODE_OPTIONS must not affect the psql child");
  for (const key of ["PGOPTIONS", "PGSSLROOTCERT", "PGSERVICE"]) {
    check(!(key in childEnvironment), `${key} must not reach the psql child`);
  }
  check(
    Object.keys(childEnvironment).every((key) =>
      !key.toUpperCase().startsWith("PG") ||
      ["PGAPPNAME", "PGCONNECT_TIMEOUT", "PGDATABASE", "PGHOST", "PGPASSWORD", "PGPASSFILE", "PGPORT", "PGSSLMODE", "PGUSER"].includes(key)
    ),
    "no unexpected PostgreSQL setting may reach the psql child"
  );

  const sql = buildRestoreSql(snapshot);
  check(sql.startsWith("\\set ON_ERROR_STOP on\n"), "psql must stop on the first error");
  check((sql.match(/\bbegin;/g) || []).length === 1, "restore must open one transaction");
  check((sql.match(/\bcommit;/g) || []).length === 1, "restore must commit one transaction");
  check(sql.includes("inet_server_addr()"), "the server must verify its loopback address");
  check(sql.includes("in access exclusive mode"), "restore tables must be locked");
  check(sql.includes("restore destination auth table is not empty"), "Auth must be empty");
  for (const { name } of CRITICAL_TABLES) {
    check(
      sql.includes(`restore destination table is not empty: ${name}`),
      `${name} must be checked for destination emptiness`
    );
  }
  check(sql.includes("alter table auth.users disable trigger user"), "Auth trigger side effects must pause");
  check(sql.includes("alter table auth.users enable trigger user"), "Auth trigger state must be restored");
  check(sql.includes("insert into auth.users (id, email)"), "exact Auth anchors must be inserted first");
  check(sql.includes("jsonb_to_recordset"), "Auth anchors must be prepared from validated JSON");
  check(sql.includes("constraint_row.convalidated"), "validated foreign keys must be checked");
  check(sql.includes("restored foreign key has an orphan"), "foreign key orphans must fail the transaction");
  check(sql.includes("alter sequence %s restart with %s"), "serial sequences must restart transactionally");
  check(sql.includes("set constraints all immediate"), "constraints must be forced before commit");

  let previousInsert = -1;
  for (const { name } of CRITICAL_TABLES) {
    const nextInsert = sql.indexOf(`insert into public.\"${name}\"`);
    check(nextInsert > previousInsert, `${name} must appear in documented restore order`);
    previousInsert = nextInsert;
  }
} finally {
  const resolved = path.resolve(temporaryDirectory);
  const temporaryRoot = path.resolve(os.tmpdir());
  if (
    path.dirname(resolved).toLowerCase() !== temporaryRoot.toLowerCase() ||
    !path.basename(resolved).startsWith("alpha-r80-restore-unit-") ||
    lstatSync(resolved).isSymbolicLink()
  ) {
    throw new Error("unsafe unit verifier cleanup target");
  }
  rmSync(resolved, { force: true, recursive: true });
}

console.log(`PASS verify-r80-backup-restore-tool (offline, ${assertions} assertions)`);
