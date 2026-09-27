import { createHash } from "node:crypto";

export const BACKUP_FORMAT_VERSION = 4;

// This order is part of the recovery format. Parents precede children, and
// each ordering key is unique so a paginated export cannot reorder rows.
export const CRITICAL_TABLES = Object.freeze([
  Object.freeze({ name: "users", order: "id.asc" }),
  Object.freeze({ name: "issues", order: "id.asc" }),
  Object.freeze({
    name: "resend_delivery_attempts",
    order: "attempt_id.asc",
  }),
  Object.freeze({
    name: "resend_webhook_events",
    order: "email_id.asc,type.asc",
  }),
  Object.freeze({ name: "support_tickets", order: "id.asc" }),
  Object.freeze({ name: "checkout_profiles", order: "id.asc" }),
  Object.freeze({ name: "checkout_fulfillments", order: "session_id.asc" }),
  Object.freeze({ name: "checkout_creation_reviews", order: "profile_id.asc" }),
  Object.freeze({ name: "account_deletion_sagas", order: "user_id.asc" }),
  Object.freeze({
    name: "account_deletion_alpha_subscriptions",
    order: "user_id.asc,subscription_id.asc",
  }),
  Object.freeze({
    name: "refund_reviews",
    order: "session_id.asc,subscription_id.asc",
  }),
  Object.freeze({ name: "legacy_checkout_fulfillments", order: "session_id.asc" }),
]);

// Format 4 remains the default and keeps its original inventory byte-for-byte.
// Format 5 adds the Brevo suppression ledger after the delivery attempt ledger.
export const BREVO_CRITICAL_TABLES = Object.freeze([
  ...CRITICAL_TABLES.slice(0, 3),
  Object.freeze({
    name: "brevo_suppression_events",
    order: "message_id.asc,event_type.asc,event_at.asc",
  }),
  ...CRITICAL_TABLES.slice(3),
]);

export function criticalTablesForFormatVersion(formatVersion) {
  if (formatVersion === BACKUP_FORMAT_VERSION) return CRITICAL_TABLES;
  if (formatVersion === 5) return BREVO_CRITICAL_TABLES;
  throw new TypeError("backup format version must be 4 or 5");
}

export function selectedBackupFormatVersion(raw) {
  if (raw === undefined) return BACKUP_FORMAT_VERSION;
  if (raw === "4") return BACKUP_FORMAT_VERSION;
  if (raw === "5") return 5;
  throw new TypeError("ALPHA_BACKUP_FORMAT_VERSION must be 4 or 5");
}

export function serializeTableRows(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError("backup rows must be an array");
  }
  return Buffer.from(JSON.stringify(rows, null, 2), "utf8");
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function tableFileMetadata(tableName, bytes, rowCount) {
  if (!/^[_a-z][_a-z0-9]*$/.test(tableName)) {
    throw new TypeError("invalid backup table name");
  }
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError("backup file bytes must be a Buffer");
  }
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new TypeError("backup row count must be a non-negative safe integer");
  }
  return {
    file: `${tableName}.json`,
    rowCount,
    bytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

export function buildBackupManifest({ backedUpAt, files, failed, formatVersion = BACKUP_FORMAT_VERSION }) {
  const criticalTables = criticalTablesForFormatVersion(formatVersion);
  const tableNames = criticalTables.map(({ name }) => name);
  if (formatVersion === 5 && failed === false && (
    files === null || typeof files !== "object" || Array.isArray(files) ||
    Object.keys(files).sort().join(",") !== [...tableNames].sort().join(",")
  )) {
    throw new TypeError("format 5 backup requires the exact Brevo table inventory");
  }
  const totalRows = tableNames.reduce((sum, name) => {
    const count = files[name]?.rowCount;
    return Number.isSafeInteger(count) && count >= 0 ? sum + count : sum;
  }, 0);

  return {
    formatVersion,
    backedUpAt,
    tables: tableNames,
    orderBy: Object.fromEntries(
      criticalTables.map(({ name, order }) => [name, order])
    ),
    files,
    totalRows,
    failed,
  };
}
