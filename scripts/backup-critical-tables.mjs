#!/usr/bin/env node
// alpha-drift-r14-09 (review 2026-08-06): the repo had zero backup/point-in-
// time-recovery story for the Supabase Postgres database -- a bad SQL editor
// action, a botched migration, or the project itself disappearing (already
// happened to a sibling project this session, went NXDOMAIN with no warning)
// meant total, unrecoverable data loss for a paying-customer product. Free-
// tier Supabase has no automatic PITR.
//
// Exports the 3 tables that are actual source-of-truth data, not
// regenerable caches or pure dedup bookkeeping: users, issues,
// support_tickets. Deliberately skips topic_blurbs (a per-(topic,week_of)
// AI-generation CACHE, own comment says "Generate once... serve to all
// subscribers" -- losing it just means the next read regenerates it, at
// AI cost, not data loss) and stripe_webhook_events/resend_webhook_events
// (pure idempotency bookkeeping -- losing them is a negligible dedup-window
// risk on the very next natural webhook delivery, not user data).
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

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("::error:: SUPABASE_URL and SUPABASE_SECRET_KEY (or their NEXT_PUBLIC_/SERVICE_ROLE_ equivalents) must both be set.");
  process.exit(1);
}

const outDir = process.argv[2] || "backup";
const TABLES = ["users", "issues", "support_tickets"];
const PAGE_SIZE = 1000;

async function fetchAllRows(table) {
  const rows = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const res = await fetch(`${url}/rest/v1/${table}?select=*&order=id`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Range-Unit": "items",
        Range: `${from}-${to}`,
        Prefer: "count=exact",
      },
    });
    if (!res.ok && res.status !== 206) {
      const body = await res.text().catch(() => "");
      throw new Error(`${table}: fetch failed, HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(outDir, { recursive: true });

let failed = false;
const summary = [];
for (const table of TABLES) {
  try {
    const rows = await fetchAllRows(table);
    writeFileSync(`${outDir}/${table}.json`, JSON.stringify(rows, null, 2));
    summary.push(`${table}: ${rows.length} row(s)`);
  } catch (e) {
    failed = true;
    console.error(`::error:: backup of ${table} failed: ${e instanceof Error ? e.message : e}`);
  }
}

writeFileSync(
  `${outDir}/MANIFEST.json`,
  JSON.stringify(
    {
      backedUpAt: process.env.BACKUP_TIMESTAMP || new Date().toISOString(),
      tables: TABLES,
      failed,
    },
    null,
    2
  )
);

console.log(failed ? "Backup completed with errors:" : "Backup completed:");
for (const line of summary) console.log(`  ${line}`);
process.exit(failed ? 1 : 0);
