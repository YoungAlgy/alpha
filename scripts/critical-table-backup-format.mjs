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

export function buildBackupManifest({ backedUpAt, files, failed }) {
  const tableNames = CRITICAL_TABLES.map(({ name }) => name);
  const totalRows = tableNames.reduce((sum, name) => {
    const count = files[name]?.rowCount;
    return Number.isSafeInteger(count) && count >= 0 ? sum + count : sum;
  }, 0);

  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    backedUpAt,
    tables: tableNames,
    orderBy: Object.fromEntries(
      CRITICAL_TABLES.map(({ name, order }) => [name, order])
    ),
    files,
    totalRows,
    failed,
  };
}
