#!/usr/bin/env node
// Offline format and restore-generation checks. No network or database call.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BACKUP_FORMAT_VERSION,
  BREVO_CRITICAL_TABLES,
  CRITICAL_TABLES,
  buildBackupManifest,
  criticalTablesForFormatVersion,
  selectedBackupFormatVersion,
  serializeTableRows,
  tableFileMetadata,
} from "./critical-table-backup-format.mjs";
import { buildRestoreSql, validateBackupDirectory } from "./critical-table-restore.mjs";

assert.equal(BACKUP_FORMAT_VERSION, 4);
assert.equal(selectedBackupFormatVersion(undefined), 4);
assert.equal(selectedBackupFormatVersion("4"), 4);
assert.equal(selectedBackupFormatVersion("5"), 5);
for (const value of ["", "05", "6", 5, null]) {
  assert.throws(() => selectedBackupFormatVersion(value), /must be 4 or 5/);
}
assert.equal(criticalTablesForFormatVersion(4), CRITICAL_TABLES);
assert.equal(criticalTablesForFormatVersion(5), BREVO_CRITICAL_TABLES);
assert.equal(CRITICAL_TABLES.length, 12);
assert.equal(BREVO_CRITICAL_TABLES.length, 13);
assert.deepEqual(BREVO_CRITICAL_TABLES[3], {
  name: "brevo_suppression_events",
  order: "message_id.asc,event_type.asc,event_at.asc",
});

const fixtureRoot = realpathSync(os.tmpdir());
const temporaryDirectories = [];
function makeFixture(formatVersion) {
  const directory = mkdtempSync(path.join(fixtureRoot, "alpha-brevo-backup-format-"));
  temporaryDirectories.push(directory);
  const files = {};
  for (const { name } of criticalTablesForFormatVersion(formatVersion)) {
    const rows = name === "users"
      ? [{ id: "11111111-1111-4111-8111-111111111111", email: "backup-fixture@example.invalid" }]
      : name === "brevo_suppression_events"
        ? [{
            message_id: "brevo-fixture-id",
            event_type: "unsubscribed",
            event_at: "2026-09-26T12:00:00.000Z",
            recipient_hash: "a".repeat(64),
            owner_user_id: null,
            resolution_status: "pending_owner",
            review_required_at: "2026-09-26T12:00:01.000Z",
            resolved_at: null,
          }]
        : [];
    const bytes = serializeTableRows(rows);
    const metadata = tableFileMetadata(name, bytes, rows.length);
    writeFileSync(path.join(directory, metadata.file), bytes);
    files[name] = metadata;
  }
  const manifest = buildBackupManifest({
    backedUpAt: "2026-09-26T13:00:00.000Z",
    files,
    failed: false,
    formatVersion,
  });
  writeFileSync(path.join(directory, "MANIFEST.json"), JSON.stringify(manifest));
  return { directory, manifest };
}

try {
  const oldPackage = makeFixture(4);
  assert.equal(oldPackage.manifest.formatVersion, 4);
  assert.equal(oldPackage.manifest.tables.length, 12);
  const oldSnapshot = validateBackupDirectory(oldPackage.directory);
  const oldSql = buildRestoreSql(oldSnapshot);
  assert.doesNotMatch(oldSql, /brevo_suppression_events/);
  assert.match(oldSql, /restore destination table is not empty: resend_webhook_events/);

  const newPackage = makeFixture(5);
  assert.equal(newPackage.manifest.formatVersion, 5);
  assert.equal(newPackage.manifest.tables.length, 13);
  const newSnapshot = validateBackupDirectory(newPackage.directory);
  const newSql = buildRestoreSql(newSnapshot);
  assert.match(newSql, /restore destination table is not empty: brevo_suppression_events/);
  assert.match(newSql, /insert into public\."brevo_suppression_events"/);
  assert.ok(newSql.indexOf('public."resend_delivery_attempts"') <
    newSql.indexOf('public."brevo_suppression_events"'));
  const incompleteFiles = { ...newPackage.manifest.files };
  delete incompleteFiles.brevo_suppression_events;
  assert.throws(() => buildBackupManifest({
    backedUpAt: "2026-09-26T13:00:00.000Z",
    files: incompleteFiles,
    failed: false,
    formatVersion: 5,
  }), /exact Brevo table inventory/);

  const missingBrevo = {
    ...newPackage.manifest,
    tables: newPackage.manifest.tables.filter((name) => name !== "brevo_suppression_events"),
  };
  writeFileSync(path.join(newPackage.directory, "MANIFEST.json"), JSON.stringify(missingBrevo));
  assert.throws(() => validateBackupDirectory(newPackage.directory), /table order is not the recovery order/);

  const invalidVersion = { ...oldPackage.manifest, formatVersion: 6 };
  writeFileSync(path.join(oldPackage.directory, "MANIFEST.json"), JSON.stringify(invalidVersion));
  assert.throws(() => validateBackupDirectory(oldPackage.directory), /format must be 4 or 5/);
  console.log("PASS Brevo backup format: v4 compatible, v5 complete, unsupported versions rejected");
} finally {
  for (const directory of temporaryDirectories) {
    const resolved = realpathSync(directory);
    if (path.dirname(resolved) !== fixtureRoot ||
        !path.basename(resolved).startsWith("alpha-brevo-backup-format-")) {
      throw new Error("fixture cleanup path escaped the local temporary directory");
    }
    rmSync(resolved, { recursive: true, force: true });
  }
}
