#!/usr/bin/env node
// alpha-drift-r14-09 (review 2026-08-06): the repo had zero backup/point-in-
// time-recovery story for the Supabase Postgres database -- a bad SQL editor
// action, a botched migration, or the project itself disappearing (already
// happened to a sibling project this session, went NXDOMAIN with no warning)
// meant total, unrecoverable data loss for a paying-customer product. Free-
// tier Supabase has no automatic PITR.
//
// Exports subscriber source data plus every durable Round 80 obligation that
// cannot be reconstructed safely from a provider after a database loss.
// Deliberately skips topic_blurbs (a per-(topic,week_of)
// AI-generation CACHE, own comment says "Generate once... serve to all
// subscribers" -- losing it just means the next read regenerates it, at
// AI cost, not data loss). The staged resend_delivery_attempts table is kept
// because its immutable recipient and provider lane make retries privacy-safe.
// Resend suppression audit rows are also kept because unresolved ownership and
// manual-review markers cannot be reconstructed safely after a database loss.
// Skips stripe_webhook_events (pure idempotency bookkeeping -- losing it is a
// negligible dedup-window risk on the very next natural webhook delivery, not
// user data). Also skips alpha_paid_call_budgets: it is a one-day cost counter,
// not restorable user or billing state. See docs/DATABASE_RECOVERY.md for the
// exact boundary.
//
// Plain REST + fetch, no @supabase/supabase-js dependency -- keeps this
// script runnable without `npm ci`, so the backup workflow stays fast and
// has nothing to install. Paginated the same way every other full-table
// read in this codebase already is (weekly-send's subscriber fetch,
// admin's gatherStats): PostgREST silently caps an unbounded select at its
// default db.max_rows, so an unpaginated request would start silently
// under-backing-up a table past 1,000 rows with no error anywhere.
//
// Run: SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/backup-critical-tables.mjs [outDir]

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBackupManifest,
  CRITICAL_TABLES,
  serializeTableRows,
  tableFileMetadata,
} from "./critical-table-backup-format.mjs";
import { requireExactAlphaSupabaseUrl } from "./alpha-supabase-url.mjs";

const rawUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!rawUrl || !key) {
  console.error("::error:: SUPABASE_URL and SUPABASE_SECRET_KEY (or their NEXT_PUBLIC_/SERVICE_ROLE_ equivalents) must both be set.");
  process.exit(1);
}
let url;
try {
  url = requireExactAlphaSupabaseUrl(rawUrl);
} catch {
  console.error("::error:: SUPABASE_URL must be the dedicated Alpha Supabase HTTPS host (value withheld).");
  process.exit(1);
}

const PAGE_SIZE = 1000;
const MAX_PAGES_PER_TABLE = 1000;
const MAX_ROWS_PER_TABLE = 100_000;
const MAX_TOTAL_ROWS = 500_000;
const MAX_TABLE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const requestedOutDir = process.argv[2]?.trim() || "";
const outDir = path.resolve(
  requestedOutDir || path.join(os.tmpdir(), `alpha-backup-${process.pid}`)
);

function isWithinDirectory(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

if (isWithinDirectory(REPOSITORY_ROOT, outDir)) {
  console.error(
    "::error:: Backup output must be outside the repository because it contains raw subscriber data."
  );
  process.exit(1);
}

let outputPreviouslyExisted = false;
let outputPrepared = false;
const writtenPaths = [];
function cleanupOutput() {
  for (const filePath of writtenPaths) {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // Best effort only. Never replace the original backup error with cleanup noise.
    }
  }
  if (outputPrepared && !outputPreviouslyExisted) {
    try {
      // Remove only the now-empty directory we created. Never recursively
      // delete an explicitly supplied path that another process populated.
      rmSync(outDir, { force: true });
    } catch {
      // Leave a non-empty directory in place rather than risk deleting data
      // that was not written by this invocation.
    }
  }
}

function prepareOutputDirectory() {
  outputPreviouslyExisted = existsSync(outDir);
  if (outputPreviouslyExisted) {
    const status = lstatSync(outDir);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("backup output must be a regular directory");
    }
    if (readdirSync(outDir).length > 0) {
      throw new Error("backup output directory must be empty");
    }
  } else {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
  }
  chmodSync(outDir, 0o700);
  outputPrepared = true;
}

let downloadedBytes = 0;
let writtenBytes = 0;

async function readBoundedBody(response, table, tableBytes) {
  const remainingTableBytes = MAX_TABLE_BYTES - tableBytes;
  const remainingTotalBytes = MAX_TOTAL_BYTES - downloadedBytes;
  const maxBytes = Math.min(remainingTableBytes, remainingTotalBytes);
  if (maxBytes < 0) {
    throw new Error(`${table}: backup byte cap exceeded`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
    throw new Error(`${table}: response exceeds the backup byte cap`);
  }
  if (!response.body) {
    throw new Error(`${table}: response body is empty`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${table}: response exceeds the backup byte cap`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  downloadedBytes += bytes;
  return Buffer.concat(chunks, bytes);
}

function exactTotal(response, table) {
  const contentRange = response.headers.get("content-range") || "";
  const match = contentRange.match(/\/(\d+)$/);
  if (!match) {
    throw new Error(
      `${table}: missing exact Content-Range total (${contentRange || "none"})`
    );
  }
  return Number(match[1]);
}

async function fetchAllRows({ name, order }) {
  const rows = [];
  let from = 0;
  let expectedTotal = null;
  let pageCount = 0;
  let tableBytes = 0;
  for (;;) {
    if (pageCount >= MAX_PAGES_PER_TABLE) {
      throw new Error(`${name}: backup page cap exceeded`);
    }
    const to = from + PAGE_SIZE - 1;
    const endpoint = new URL(`/rest/v1/${name}`, url);
    endpoint.searchParams.set("select", "*");
    endpoint.searchParams.set("order", order);
    const res = await fetch(endpoint, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Range-Unit": "items",
        Range: `${from}-${to}`,
        Prefer: "count=exact",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 206) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${name}: fetch failed, HTTP ${res.status}`);
    }
    const pageTotal = exactTotal(res, name);
    if (
      !Number.isSafeInteger(pageTotal) ||
      pageTotal < 0 ||
      pageTotal > MAX_ROWS_PER_TABLE
    ) {
      throw new Error(`${name}: exact row count exceeds the backup cap`);
    }
    if (expectedTotal === null) expectedTotal = pageTotal;
    if (pageTotal !== expectedTotal) {
      throw new Error(
        `${name}: row count changed during pagination (${expectedTotal} -> ${pageTotal}); refusing an inconsistent snapshot`
      );
    }
    const pageBytes = await readBoundedBody(res, name, tableBytes);
    tableBytes += pageBytes.byteLength;
    let page;
    try {
      page = JSON.parse(pageBytes.toString("utf8"));
    } catch {
      throw new Error(`${name}: response was not valid JSON`);
    }
    if (!Array.isArray(page)) {
      throw new Error(`${name}: expected a JSON row array`);
    }
    rows.push(...page);
    pageCount += 1;
    if (rows.length > MAX_ROWS_PER_TABLE || rows.length > MAX_TOTAL_ROWS) {
      throw new Error(`${name}: backup row cap exceeded`);
    }
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  if (rows.length !== expectedTotal) {
    throw new Error(
      `${name}: fetched ${rows.length} row(s), exact count reported ${expectedTotal}`
    );
  }
  return rows;
}

try {
  prepareOutputDirectory();

  let failed = false;
  const summary = [];
  const files = {};
  let totalRows = 0;
  for (const table of CRITICAL_TABLES) {
    try {
      const rows = await fetchAllRows(table);
      totalRows += rows.length;
      if (totalRows > MAX_TOTAL_ROWS) {
        throw new Error("backup aggregate row cap exceeded");
      }
      const bytes = serializeTableRows(rows);
      writtenBytes += bytes.byteLength;
      if (
        bytes.byteLength > MAX_TABLE_BYTES ||
        writtenBytes > MAX_TOTAL_BYTES
      ) {
        throw new Error(`${table.name}: serialized backup byte cap exceeded`);
      }
      const metadata = tableFileMetadata(table.name, bytes, rows.length);
      const filePath = path.join(outDir, metadata.file);
      writtenPaths.push(filePath);
      writeFileSync(filePath, bytes, { mode: 0o600 });
      files[table.name] = metadata;
      summary.push(`${table.name}: ${rows.length} row(s)`);
    } catch (e) {
      failed = true;
      console.error(`::error:: backup of ${table.name} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  try {
    const manifest = buildBackupManifest({
      backedUpAt: process.env.BACKUP_TIMESTAMP || new Date().toISOString(),
      files,
      failed,
    });
    const manifestPath = path.join(outDir, "MANIFEST.json");
    writtenPaths.push(manifestPath);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
  } catch (e) {
    failed = true;
    console.error(
      `::error:: backup manifest could not be written: ${e instanceof Error ? e.message : e}`
    );
  }

  if (failed) {
    cleanupOutput();
    console.error("::error:: Backup failed. Partial plaintext output was removed.");
    process.exit(1);
  }

  console.log("Backup completed:");
  for (const line of summary) console.log(`  ${line}`);
} catch (e) {
  cleanupOutput();
  console.error(
    `::error:: Backup failed before completion: ${e instanceof Error ? e.message : e}`
  );
  process.exit(1);
}
