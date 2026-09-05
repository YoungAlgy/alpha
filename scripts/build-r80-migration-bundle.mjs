#!/usr/bin/env node
// Local artifact builder. It reads the reviewed Round 80 SQL, verifies the
// exact order, wraps all files in one transaction, and writes checksums beside
// the bundle. It never loads env files or contacts a database.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { maskSqlNonCode } from "./sql-read-only-mask.mjs";

const migrations = [
  "20260827000000_checkout_fulfillment_claims.sql",
  "20260827010000_stripe_webhook_event_leases.sql",
  "20260827020000_delivery_suppression_pending.sql",
  "20260827030000_legacy_checkout_fulfillments.sql",
  "20260827040000_refund_review_resolution.sql",
  "20260827050000_daily_paid_call_budget.sql",
  "20260827200000_issues_rls_subscribed_access.sql",
  "20260828000000_alpha_renewal_cancellation.sql",
  "20260830000000_invite_access.sql",
  "20260830010000_weekly_send_delivery_cursors.sql",
  "20260830020000_account_privacy_retry_bounds.sql",
  "20260830030000_distributed_rate_limits.sql",
  "20260830040000_quantity_update_leases.sql",
  "20260830050000_resend_suppression_causality.sql",
];
const expectedMigrationSha256 = new Map([
  [
    "20260827000000_checkout_fulfillment_claims.sql",
    "f346d9ac2eebee475373c41c1a15aec603686a3ad8536ba0858ca9e03d6bcee2",
  ],
  [
    "20260827010000_stripe_webhook_event_leases.sql",
    "bb59fca2872ed3be0ec6961a18e31349a2838444a9677d830b9bd19fd455aedc",
  ],
  [
    "20260827020000_delivery_suppression_pending.sql",
    "564f61ac032810ea03dca35233641b2d56eef932e22fc693eee3caad157f70d8",
  ],
  [
    "20260827030000_legacy_checkout_fulfillments.sql",
    "bc51bb2692170e28ed1dae713b28afa885a5f8602ca4f095be43d404a3362d09",
  ],
  [
    "20260827040000_refund_review_resolution.sql",
    "b323f4f5d99b9412524f99b659e80fee0b8171228010195bf6cbeadce17843fa",
  ],
  [
    "20260827050000_daily_paid_call_budget.sql",
    "9ee5acb47bc9609d49e476dfd4ed2050be98f8d29d79515a7a01c54822f90a72",
  ],
  [
    "20260827200000_issues_rls_subscribed_access.sql",
    "7e7ab705a99153de6194abb15b27e993dca3c0e7376465001ed757e5cee1206c",
  ],
  [
    "20260828000000_alpha_renewal_cancellation.sql",
    "5d8fe1553ea022a16793f80b34616d50a6fb6ef7f329862cc39cc252eeb2183e",
  ],
  [
    "20260830000000_invite_access.sql",
    "3dc3107f7a867848c50a3607f61b53c9a9c13c33dd2dc792d49d1676d7bffe64",
  ],
  [
    "20260830010000_weekly_send_delivery_cursors.sql",
    "2c0618cb391876eb461b6a18adba44ab90d101c55c558e80a72c43eb90af535d",
  ],
  [
    "20260830020000_account_privacy_retry_bounds.sql",
    "7a15e7a532273503af760985f38aeecbf951c2797c08fbc3683db6c5b1a832e5",
  ],
  [
    "20260830030000_distributed_rate_limits.sql",
    "ce883004cdeadf566ed3a2f92b62857c56e4e22aec7c769b9ab4e2e2c370ca57",
  ],
  [
    "20260830040000_quantity_update_leases.sql",
    "ac6a67cba64374b5f9b08585c297fd32fbc5dd5d183c889500b878392a14b61d",
  ],
  [
    "20260830050000_resend_suppression_causality.sql",
    "20c263f7afc7f265c899b680d4f08db8478acaf2bcae7e49debf2cb758ec16ad",
  ],
]);
if (
  JSON.stringify([...expectedMigrationSha256.keys()]) !==
  JSON.stringify(migrations)
) {
  throw new Error("Round 80 reviewed checksum inventory is out of order");
}
const migrationDir = path.resolve("supabase/migrations");
const verificationSourcePath = path.resolve(
  "scripts/r80-live-verification.sql"
);
const outputDir = path.resolve(
  process.argv[2] || "backup/migration-bundles"
);
const artifactDate = process.argv[3] || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(artifactDate)) {
  throw new Error("artifact date must use YYYY-MM-DD");
}

const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const repositoryHead = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
}).trim();
const builderSha256 = digest(readFileSync(fileURLToPath(import.meta.url)));
const files = migrations.map((name) => {
  const sql = readFileSync(path.join(migrationDir, name), "utf8").trimEnd();
  if (/^\s*(begin|commit|rollback)\s*;/im.test(sql)) {
    throw new Error(`${name}: contains transaction control`);
  }
  if (/create\s+(unique\s+)?index\s+concurrently/i.test(sql)) {
    throw new Error(`${name}: contains CREATE INDEX CONCURRENTLY`);
  }
  const sha256 = digest(sql);
  if (sha256 !== expectedMigrationSha256.get(name)) {
    throw new Error(`${name}: reviewed SHA256 changed`);
  }
  return { name, sql, sha256 };
});
const verificationSql = `${readFileSync(verificationSourcePath, "utf8").trimEnd()}\n`;
const verificationSurface = maskSqlNonCode(verificationSql);
const verificationStatements = verificationSurface
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
if (
  !verificationSql.includes("-- READ ONLY") ||
  verificationStatements.length === 0 ||
  verificationStatements.some((statement) => !/^(select|with)\b/i.test(statement)) ||
  /\b(insert|update|delete|truncate|alter|create|drop|grant|revoke|copy|call|do|merge|vacuum|analyze|refresh|reindex|cluster|set|reset)\b/i.test(
    verificationSurface
  ) ||
  /\b(nextval|setval|pg_advisory_lock|pg_advisory_xact_lock|dblink|lo_import|lo_export)\s*\(/i.test(
    verificationSurface
  ) ||
  /\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i.test(
    verificationSurface
  )
) {
  throw new Error("Round 80 live verification SQL must remain read-only");
}
const combinedMigrationSql = files.map(({ sql }) => sql).join("\n");
const uniqueMatches = (pattern) =>
  [
    ...new Set(
      [...combinedMigrationSql.matchAll(pattern)].map((match) => match[1])
    ),
  ].sort();
const verificationInventories = [
  [
    "tables",
    uniqueMatches(/create table(?: if not exists)? public\.([a-z0-9_]+)/gi),
    12,
  ],
  [
    "added columns",
    uniqueMatches(/add column(?: if not exists)?\s+([a-z0-9_]+)/gi),
    40,
  ],
  ["named constraints", uniqueMatches(/add constraint\s+([a-z0-9_]+)/gi), 21],
  [
    "indexes",
    uniqueMatches(
      /create(?: unique)? index(?: if not exists)?\s+([a-z0-9_]+)/gi
    ),
    37,
  ],
  ["triggers", uniqueMatches(/create trigger\s+([a-z0-9_]+)/gi), 16],
  [
    "functions",
    uniqueMatches(/create or replace function public\.([a-z0-9_]+)/gi),
    112,
  ],
];
for (const [label, names, expectedCount] of verificationInventories) {
  if (names.length !== expectedCount) {
    throw new Error(
      `Round 80 ${label} inventory changed: expected ${expectedCount}, found ${names.length}`
    );
  }
  const missing = names.filter((name) => !verificationSql.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `Round 80 live verification SQL omits ${label}: ${missing.join(", ")}`
    );
  }
}
const functionDefinitionCount = [
  ...combinedMigrationSql.matchAll(/create or replace function public\.[a-z0-9_]+/gi),
].length;
if (functionDefinitionCount !== 126) {
  throw new Error(
    `Round 80 function definition count changed: expected 126, found ${functionDefinitionCount}`
  );
}
const normalizeSignature = (value) =>
  value.toLowerCase().replace(/\s+/g, "");
const serviceRoleGrantSignatures = [
  ...combinedMigrationSql.matchAll(
    /grant\s+execute\s+on\s+function\s+(public\.[a-z0-9_]+\s*\([^;]*?\))\s+to\s+service_role\s*;/gi
  ),
].map((match) => normalizeSignature(match[1]));
if (
  serviceRoleGrantSignatures.length !== 97 ||
  new Set(serviceRoleGrantSignatures).size !== 91
) {
  throw new Error(
    "Round 80 service-role grant inventory changed: expected 97 statements and 91 signatures"
  );
}
const expectedSuppressionFailureSignature =
  "public.fail_suppression_cleanup(uuid,timestamptz,text,timestamptz,timestamptz,timestamptz,text,text,timestamptz,timestamptz,timestamptz,text,timestamptz)";
if (!serviceRoleGrantSignatures.includes(expectedSuppressionFailureSignature)) {
  throw new Error("Round 80 suppression failure RPC signature changed");
}

const header = `-- Alpha Round 80 atomic production migration bundle
-- Generated ${artifactDate} from the exact repository files listed below.
-- Do not edit this bundle. Compare its companion manifest before use.
-- Requires an approved Alpha-only checkout maintenance window and live preflight.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';`;
const body = files
  .map(
    ({ name, sql, sha256 }) =>
      `\n\n-- BEGIN ${name}\n-- SHA256 ${sha256}\n${sql}\n-- END ${name}`
  )
  .join("");
const migrationVersions = migrations.map((name) => name.slice(0, 14));
const ledgerValues = migrationVersions
  .map((version) => `    ('${version}')`)
  .join(",\n");
const ledgerArray = migrationVersions.map((version) => `'${version}'`).join(", ");
const ledger = `

-- Register the exact fourteen source versions in the normal Supabase migration
-- ledger before the same transaction commits. This prevents a later migration
-- runner from replaying non-idempotent Round 80 DDL. The preflight rejects an
-- unknown ledger shape instead of guessing how to write it.
do $alpha_round_80_ledger$
declare
  v_existing_versions text;
  v_incompatible_columns text;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'Supabase migration ledger is missing';
  end if;

  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'supabase_migrations'
       and table_name = 'schema_migrations'
       and column_name = 'version'
       and data_type in ('text', 'character varying')
       and is_nullable = 'NO'
  ) then
    raise exception 'Supabase migration ledger version column is incompatible';
  end if;

  if not exists (
    select 1
      from pg_index i
      join pg_attribute a
        on a.attrelid = i.indrelid
       and a.attname = 'version'
     where i.indrelid = 'supabase_migrations.schema_migrations'::regclass
       and i.indisunique
       and i.indisvalid
       and i.indisready
       and i.indislive
       and i.indpred is null
       and i.indnkeyatts = 1
       and i.indnatts = 1
       and i.indexprs is null
       and a.attnum = any(i.indkey)
  ) then
    raise exception 'Supabase migration ledger version is not uniquely indexed';
  end if;

  select string_agg(column_name, ', ' order by ordinal_position)
    into v_incompatible_columns
    from information_schema.columns
   where table_schema = 'supabase_migrations'
     and table_name = 'schema_migrations'
     and column_name <> 'version'
     and is_nullable = 'NO'
     and column_default is null
     and is_identity = 'NO'
     and is_generated = 'NEVER';
  if v_incompatible_columns is not null then
    raise exception
      'Supabase migration ledger has required columns with no defaults: %',
      v_incompatible_columns;
  end if;

  select string_agg(version, ', ' order by version)
    into v_existing_versions
    from supabase_migrations.schema_migrations
   where version = any(array[${ledgerArray}]::text[]);
  if v_existing_versions is not null then
    raise exception 'Round 80 migration versions already recorded: %',
      v_existing_versions;
  end if;

  insert into supabase_migrations.schema_migrations (version)
  values
${ledgerValues};

  if (
    select count(*)
      from supabase_migrations.schema_migrations
     where version = any(array[${ledgerArray}]::text[])
  ) <> ${migrationVersions.length} then
    raise exception 'Round 80 migration ledger recording was incomplete';
  end if;
end;
$alpha_round_80_ledger$;`;
const bundle = `${header}${body}${ledger}\n\ncommit;\n`;
const bundleName = `Alpha-Round-80-Atomic-Migration-${artifactDate}.sql`;
const manifestName = `Alpha-Round-80-Atomic-Migration-${artifactDate}.manifest.json`;
const verificationName = `Alpha-Round-80-Live-Verification-SQL-${artifactDate}.sql`;

mkdirSync(outputDir, { recursive: true });
writeFileSync(path.join(outputDir, bundleName), bundle);
writeFileSync(path.join(outputDir, verificationName), verificationSql);
writeFileSync(
  path.join(outputDir, manifestName),
  JSON.stringify(
    {
      formatVersion: 2,
      generatedAt: new Date().toISOString(),
      transaction: "single explicit transaction",
      ledgerMode: "atomic-version-insert",
      ledgerVersions: migrationVersions,
      ledgerSchemaPreflightRequired: true,
      repositoryHead,
      builderSha256,
      lockTimeout: "5s",
      statementTimeout: "10min",
      files: files.map(({ name, sha256 }) => ({ name, sha256 })),
      bundle: { name: bundleName, sha256: digest(bundle) },
      verification: {
        source: "scripts/r80-live-verification.sql",
        sourceSha256: digest(verificationSql),
        name: verificationName,
        sha256: digest(verificationSql),
      },
    },
    null,
    2
  ) + "\n"
);

console.log(path.join(outputDir, bundleName));
console.log(path.join(outputDir, manifestName));
console.log(path.join(outputDir, verificationName));
