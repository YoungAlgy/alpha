#!/usr/bin/env node
// Test-only PostgREST stand-in for the unmodified critical-table exporter.
// This process has no HTTP server and never calls the original fetch.

import { lstatSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { criticalTablesForFormatVersion } from "../critical-table-backup-format.mjs";

const PG_BIN = "/home/algy/alpha-pg17-test-20260909/pgsql-17.11/bin/psql";
const ALPHA_ORIGIN = "https://xpqxhdciaoicsnyyfshy.supabase.co";
const PAGE_SIZE = 1000;
const EXPECTED_TABLES = Object.freeze([
  ["users", "id.asc"],
  ["issues", "id.asc"],
  ["resend_delivery_attempts", "attempt_id.asc"],
  ["brevo_suppression_events", "message_id.asc,event_type.asc,event_at.asc"],
  ["resend_webhook_events", "email_id.asc,type.asc"],
  ["support_tickets", "id.asc"],
  ["checkout_profiles", "id.asc"],
  ["checkout_fulfillments", "session_id.asc"],
  ["checkout_creation_reviews", "profile_id.asc"],
  ["account_deletion_sagas", "user_id.asc"],
  ["account_deletion_alpha_subscriptions", "user_id.asc,subscription_id.asc"],
  ["refund_reviews", "session_id.asc,subscription_id.asc"],
  ["legacy_checkout_fulfillments", "session_id.asc"],
]);

function fail(message) {
  throw new Error(`local export adapter: ${message}`);
}

if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() === 0) {
  fail("requires a nonroot Linux process");
}
if (process.argv.length !== 4 || !/^[0-9]+$/.test(process.argv[2])) {
  fail("expected PORT OUTDIR with a decimal port");
}
const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  fail("port must be between 1 and 65535");
}
const outDir = path.resolve(process.argv[3]);
if (!/^\/tmp\/alpha-brevo-restore-[A-Za-z0-9]+\/backup(?:\/|$)/.test(outDir)) {
  fail("OUTDIR must be within /tmp/alpha-brevo-restore-<alnum>/backup");
}
for (let current = outDir; current !== "/"; current = path.dirname(current)) {
  try {
    if (lstatSync(current).isSymbolicLink()) fail("OUTDIR contains a symlink");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const actualTables = criticalTablesForFormatVersion(5);
if (JSON.stringify(actualTables.map(({ name, order }) => [name, order])) !== JSON.stringify(EXPECTED_TABLES)) {
  fail("format 5 table inventory or order changed");
}
const tableOrders = new Map(EXPECTED_TABLES);
const pgEnv = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  PGPASSFILE: "/dev/null",
  PGHOST: "127.0.0.1",
  PGPORT: String(port),
  PGUSER: "postgres",
  PGDATABASE: "alpha_source",
  PGCONNECT_TIMEOUT: "2",
  PGOPTIONS: "-c default_transaction_read_only=on",
};
let requestCount = 0;

function queryPage(table, order, from) {
  const columns = order.split(",").map((part) => part.slice(0, -4));
  const orderSql = columns.map((column) => `"${column}" ASC`).join(", ");
  const tableSql = `public."${table}"`;
  const sql = `SELECT json_build_object('rows', COALESCE((SELECT json_agg(page_row) FROM (SELECT * FROM ${tableSql} ORDER BY ${orderSql} LIMIT ${PAGE_SIZE} OFFSET ${from}) AS page_row), '[]'::json), 'total', (SELECT count(*) FROM ${tableSql}));`;
  const result = spawnSync(PG_BIN, [
    "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "--no-password",
    "-c", "BEGIN READ ONLY", "-c", sql, "-c", "COMMIT",
  ], {
    env: pgEnv,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.signal) {
    fail(`local PostgreSQL page query failed for ${table}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(result.stdout.trim());
  } catch {
    fail(`local PostgreSQL returned invalid JSON for ${table}`);
  }
  if (!Array.isArray(envelope.rows) || !Number.isSafeInteger(envelope.total) ||
      envelope.total < 0 || envelope.total > 100_000 || envelope.rows.length > PAGE_SIZE) {
    fail(`local PostgreSQL returned an invalid page for ${table}`);
  }
  return envelope;
}

globalThis.fetch = async (input, init) => {
  if (!(input instanceof URL) || input.origin !== ALPHA_ORIGIN ||
      input.username || input.password || input.hash) {
    fail("unexpected fetch URL");
  }
  const match = /^\/rest\/v1\/([a-z][a-z0-9_]*)$/.exec(input.pathname);
  const table = match?.[1];
  const order = tableOrders.get(table);
  if (!order || [...input.searchParams].length !== 2 ||
      input.searchParams.get("select") !== "*" || input.searchParams.get("order") !== order) {
    fail("unexpected fetch table or query");
  }
  const headers = init?.headers;
  if (!headers || Object.keys(headers).sort().join(",") !==
      "Authorization,Prefer,Range,Range-Unit,apikey" ||
      headers.apikey !== "offline-fixture-only" ||
      headers.Authorization !== "Bearer offline-fixture-only" ||
      headers["Range-Unit"] !== "items" || headers.Prefer !== "count=exact" ||
      !(init.signal instanceof AbortSignal) || init.signal.aborted) {
    fail("unexpected fetch headers or signal");
  }
  const range = /^(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/.exec(headers.Range);
  if (!range) fail("invalid fetch range");
  const from = Number(range[1]);
  const to = Number(range[2]);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) ||
      from % PAGE_SIZE !== 0 || to !== from + PAGE_SIZE - 1 || from > 100_000) {
    fail("fetch range exceeds the local fixture boundary");
  }
  requestCount += 1;
  const { rows, total } = queryPage(table, order, from);
  const body = JSON.stringify(rows);
  const last = rows.length ? from + rows.length - 1 : from;
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      "Content-Range": `${from}-${last}/${total}`,
    },
  });
};

process.env = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  SUPABASE_URL: ALPHA_ORIGIN,
  SUPABASE_SECRET_KEY: "offline-fixture-only",
  ALPHA_BACKUP_FORMAT_VERSION: "5",
  BACKUP_TIMESTAMP: "2026-09-26T00:00:00.000Z",
};

const exporter = new URL("../backup-critical-tables.mjs", import.meta.url);
process.argv = [process.execPath, fileURLToPath(exporter), outDir];
const originalLog = console.log;
console.log = () => {};
try {
  await import(exporter.href);
} finally {
  console.log = originalLog;
}
if (requestCount <= EXPECTED_TABLES.length) {
  fail("fixture did not exercise pagination");
}
console.log(`Local exporter requests: ${requestCount}`);
