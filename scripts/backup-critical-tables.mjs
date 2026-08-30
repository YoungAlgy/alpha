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
// AI cost, not data loss) and stripe_webhook_events/resend_webhook_events
// (pure idempotency bookkeeping -- losing them is a negligible dedup-window
// risk on the very next natural webhook delivery, not user data). Also skips
// alpha_paid_call_budgets: it is a one-day cost counter, not restorable user
// or billing state. See docs/DATABASE_RECOVERY.md for the exact boundary.
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

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildBackupManifest,
  CRITICAL_TABLES,
  serializeTableRows,
  tableFileMetadata,
} from "./critical-table-backup-format.mjs";

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("::error:: SUPABASE_URL and SUPABASE_SECRET_KEY (or their NEXT_PUBLIC_/SERVICE_ROLE_ equivalents) must both be set.");
  process.exit(1);
}

const outDir = process.argv[2] || "backup";
const PAGE_SIZE = 1000;
const allowPreRound80Absence = process.env.BACKUP_PRE_R80_MODE === "1";
const PRE_ROUND80_TABLES = new Set([
  "checkout_profiles",
  "checkout_fulfillments",
  "checkout_creation_reviews",
  "account_deletion_sagas",
  "account_deletion_alpha_subscriptions",
  "refund_reviews",
  "legacy_checkout_fulfillments",
]);

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
  for (;;) {
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
    });
    if (!res.ok && res.status !== 206) {
      if (
        allowPreRound80Absence &&
        from === 0 &&
        res.status === 404 &&
        PRE_ROUND80_TABLES.has(name)
      ) {
        const failure = await res.json().catch(() => null);
        if (failure?.code === "PGRST205") {
          return [];
        }
      }
      throw new Error(`${name}: fetch failed, HTTP ${res.status}`);
    }
    const pageTotal = exactTotal(res, name);
    if (expectedTotal === null) expectedTotal = pageTotal;
    if (pageTotal !== expectedTotal) {
      throw new Error(
        `${name}: row count changed during pagination (${expectedTotal} -> ${pageTotal}); refusing an inconsistent snapshot`
      );
    }
    const page = await res.json();
    if (!Array.isArray(page)) {
      throw new Error(`${name}: expected a JSON row array`);
    }
    rows.push(...page);
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

mkdirSync(outDir, { recursive: true });

let failed = false;
const summary = [];
const files = {};
for (const table of CRITICAL_TABLES) {
  try {
    const rows = await fetchAllRows(table);
    const bytes = serializeTableRows(rows);
    const metadata = tableFileMetadata(table.name, bytes, rows.length);
    writeFileSync(path.join(outDir, metadata.file), bytes);
    files[table.name] = metadata;
    summary.push(`${table.name}: ${rows.length} row(s)`);
  } catch (e) {
    failed = true;
    console.error(`::error:: backup of ${table.name} failed: ${e instanceof Error ? e.message : e}`);
  }
}

const manifest = buildBackupManifest({
  backedUpAt: process.env.BACKUP_TIMESTAMP || new Date().toISOString(),
  files,
  failed,
});
writeFileSync(
  path.join(outDir, "MANIFEST.json"),
  JSON.stringify(manifest, null, 2)
);

console.log(failed ? "Backup completed with errors:" : "Backup completed:");
for (const line of summary) console.log(`  ${line}`);
process.exit(failed ? 1 : 0);
