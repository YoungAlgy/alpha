#!/usr/bin/env node
// Offline Round 80 recovery drill. It creates an isolated loopback PostgreSQL
// cluster, applies the repository migrations, exports a synthetic snapshot,
// restores it through the public local-only CLI, and destroys the cluster.
// Child-process output and fixture rows are never printed.
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBackupManifest,
  CRITICAL_TABLES,
  serializeTableRows,
  tableFileMetadata,
} from "./critical-table-backup-format.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RESTORE_CLI = fileURLToPath(
  new URL("./restore-critical-tables-local.mjs", import.meta.url)
);
const FIXTURE_USER_ID = "11111111-1111-4111-8111-111111111111";
const FIXTURE_PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const FIXTURE_ISSUE_ID = "44444444-4444-4444-8444-444444444444";

function fail(message) {
  throw new Error(message);
}

function command(executable, args, options = {}) {
  const {
    stage = "local recovery drill command failed",
    timeout = 180_000,
    ...spawnOptions
  } = options;
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    windowsHide: true,
    ...spawnOptions,
  });
  if (result.error || result.signal || result.status !== 0) {
    fail(stage);
  }
  return result;
}

function nativeSibling(psqlBin, baseName) {
  if (!path.isAbsolute(psqlBin)) return baseName;
  const extension = path.extname(psqlBin);
  return path.join(path.dirname(psqlBin), `${baseName}${extension}`);
}

function postgresEnvironment(port, database = "postgres") {
  const environment = {
    ...process.env,
    PGAPPNAME: "alpha-r80-recovery-drill",
    PGCONNECT_TIMEOUT: "5",
    PGDATABASE: database,
    PGHOST: "127.0.0.1",
    PGPASSWORD: "",
    PGPORT: String(port),
    PGSSLMODE: "disable",
    PGUSER: "postgres",
  };
  delete environment.PGHOSTADDR;
  delete environment.PGSERVICE;
  delete environment.PGSERVICEFILE;
  return environment;
}

function psql(
  psqlBin,
  port,
  database,
  { file, files, input, stage = "local PostgreSQL drill step failed", tuplesOnly = false }
) {
  const args = ["-X", "-w", "-q", "-v", "ON_ERROR_STOP=1"];
  if (tuplesOnly) args.push("-A", "-t");
  for (const selectedFile of files || [file || "-"]) {
    args.push("-f", selectedFile);
  }
  return command(psqlBin, args, {
    env: postgresEnvironment(port, database),
    input,
    stage,
  }).stdout.trim();
}

function getFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function migrationFiles() {
  const migrationDirectory = path.join(REPOSITORY_ROOT, "supabase", "migrations");
  return readdirSync(migrationDirectory)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()
    .map((name) => path.join(migrationDirectory, name));
}

function bootstrapDatabase(psqlBin, port, database) {
  psql(psqlBin, port, database, {
    stage: "local database bootstrap failed",
    input: `
create extension if not exists pg_trgm;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text not null unique
);
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
`,
  });
  for (const migration of migrationFiles()) {
    if (!realpathSync(migration).startsWith(realpathSync(REPOSITORY_ROOT))) {
      fail("migration resolves outside the repository");
    }
  }
  psql(psqlBin, port, database, {
    files: migrationFiles(),
    stage: "repository migration application failed",
  });
}

function quotedTable(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) fail("invalid fixture table name");
  return `public."${name}"`;
}

function triggerStatements(action) {
  return ["auth.users", ...CRITICAL_TABLES.map(({ name }) => quotedTable(name))]
    .map((name) => `alter table ${name} ${action} trigger user;`)
    .join("\n");
}

function loadSyntheticFixture(psqlBin, port, database) {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  psql(psqlBin, port, database, {
    stage: "synthetic fixture load failed",
    input: `
begin;
${triggerStatements("disable")}

insert into auth.users (id, email)
values ('${FIXTURE_USER_ID}', 'recovery-drill@fixture.invalid');

insert into public.users (id, email, first_name, topics, theme, subscribed_at)
values (
  '${FIXTURE_USER_ID}',
  'recovery-drill@fixture.invalid',
  'Recovery',
  array['healthcare-recruiting','sales-persuasion','founder-operator','marketing-growth','personal-finance'],
  'forest',
  '2026-08-30T12:00:00Z'
);

insert into public.issues (id, user_id, week_of, editor_intro, sections)
values (
  '${FIXTURE_ISSUE_ID}',
  '${FIXTURE_USER_ID}',
  '2026-08-24',
  'Synthetic local recovery drill.',
  '[]'::jsonb
);

insert into public.support_tickets (id, name, email, message, user_id, status)
values (
  42,
  'Recovery Drill',
  'recovery-drill@fixture.invalid',
  'Synthetic local recovery fixture.',
  '${FIXTURE_USER_ID}',
  'open'
);

insert into public.checkout_profiles (
  id, email_hash, email, first_name, topics, theme, browser_nonce_hash,
  owner_user_id, billing_state
) values (
  '${FIXTURE_PROFILE_ID}',
  '${hashA}',
  'checkout-recovery@fixture.invalid',
  'Checkout',
  array['healthcare-recruiting','sales-persuasion','founder-operator','marketing-growth','personal-finance'],
  'forest',
  '${hashB}',
  '${FIXTURE_USER_ID}',
  'open'
);

insert into public.checkout_fulfillments (
  session_id, profile_id, email_hash, week_of, status, user_id
) values (
  'cs_test_recovery_drill',
  '${FIXTURE_PROFILE_ID}',
  '${hashA}',
  '2026-08-24',
  'pending',
  '${FIXTURE_USER_ID}'
);

insert into public.checkout_creation_reviews (profile_id, reason, status)
values ('${FIXTURE_PROFILE_ID}', 'replay_window_missed', 'pending');

insert into public.account_deletion_sagas (
  user_id, stripe_customer_id, stripe_subscription_id, state
) values (
  '${FIXTURE_USER_ID}',
  'cus_test_recovery_saga',
  'sub_test_recovery_saga',
  'prepared'
);

insert into public.account_deletion_alpha_subscriptions (
  user_id, subscription_id, customer_id, terminal_status
) values (
  '${FIXTURE_USER_ID}',
  'sub_test_recovery_saga',
  'cus_test_recovery_saga',
  'active'
);

insert into public.refund_reviews (
  session_id, subscription_id, customer_id, reason, status
) values (
  'cs_test_recovery_refund',
  'sub_test_recovery_refund',
  'cus_test_recovery_refund',
  'duplicate_checkout',
  'pending'
);

insert into public.legacy_checkout_fulfillments (
  session_id, email_hash, user_id, stripe_customer_id,
  stripe_subscription_id, week_of, status
) values (
  'cs_test_recovery_legacy',
  '${hashA}',
  '${FIXTURE_USER_ID}',
  'cus_test_recovery_legacy',
  'sub_test_recovery_legacy',
  '2026-08-24',
  'pending'
);

${triggerStatements("enable")}
commit;
`,
  });
}

function orderSql(postgrestOrder) {
  return postgrestOrder
    .split(",")
    .map((part) => {
      const match = part.match(/^([a-z_][a-z0-9_]*)\.(asc|desc)$/);
      if (!match) fail("invalid fixture export ordering");
      return `"${match[1]}" ${match[2]}`;
    })
    .join(", ");
}

function exportSyntheticSnapshot(psqlBin, port, database, backupDirectory) {
  const files = {};
  for (const table of CRITICAL_TABLES) {
    const raw = psql(psqlBin, port, database, {
      input: `select coalesce(jsonb_agg(to_jsonb(row_data) order by ${orderSql(
        table.order
      )}), '[]'::jsonb)::text from public."${table.name}" row_data;`,
      tuplesOnly: true,
    });
    const rows = JSON.parse(raw);
    const bytes = serializeTableRows(rows);
    const metadata = tableFileMetadata(table.name, bytes, rows.length);
    writeFileSync(path.join(backupDirectory, metadata.file), bytes);
    files[table.name] = metadata;
  }
  const manifest = buildBackupManifest({
    backedUpAt: "2026-08-30T12:00:00.000Z",
    failed: false,
    files,
  });
  writeFileSync(
    path.join(backupDirectory, "MANIFEST.json"),
    JSON.stringify(manifest, null, 2)
  );
  return manifest;
}

function runRestoreCli({ backupDirectory, databaseUrl, psqlBin }) {
  return spawnSync(
    process.execPath,
    [
      RESTORE_CLI,
      "--backup-dir",
      backupDirectory,
      "--database-url",
      databaseUrl,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PSQL_BIN: psqlBin },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
      windowsHide: true,
    }
  );
}

function assertAggregateLine(result, stream, prefix) {
  const selected = result[stream].trim();
  const other = result[stream === "stdout" ? "stderr" : "stdout"].trim();
  if (!selected.startsWith(prefix) || selected.includes("\n") || other !== "") {
    fail("restore CLI did not emit one aggregate result line");
  }
}

function verifyRestoredDatabase(psqlBin, port, database, manifest) {
  const counts = JSON.parse(
    psql(psqlBin, port, database, {
      input: `select jsonb_object_agg(table_name, row_count)::text
from (
  ${CRITICAL_TABLES.map(
    ({ name }) =>
      `select '${name}'::text as table_name, count(*)::integer as row_count from public."${name}"`
  ).join("\n  union all\n  ")}
) counts;`,
      tuplesOnly: true,
    })
  );
  for (const { name } of CRITICAL_TABLES) {
    if (counts[name] !== manifest.files[name].rowCount) {
      fail("restored table count verification failed");
    }
  }

  const authExact = psql(psqlBin, port, database, {
    input: `select (
      count(*) = 1
      and bool_and(id = '${FIXTURE_USER_ID}'::uuid)
      and bool_and(email = 'recovery-drill@fixture.invalid')
    )::text from auth.users;`,
    tuplesOnly: true,
  });
  if (authExact !== "true") fail("restored auth anchor verification failed");

  const foreignKeysValid = psql(psqlBin, port, database, {
    input: `select (
      not exists (
        select 1 from public.issues child
        left join public.users parent on parent.id = child.user_id
        where parent.id is null
      )
      and not exists (
        select 1 from public.support_tickets child
        left join public.users parent on parent.id = child.user_id
        where child.user_id is not null and parent.id is null
      )
      and not exists (
        select 1 from public.checkout_fulfillments child
        left join public.checkout_profiles parent on parent.id = child.profile_id
        where parent.id is null
      )
      and not exists (
        select 1 from public.checkout_creation_reviews child
        left join public.checkout_profiles parent on parent.id = child.profile_id
        where parent.id is null
      )
      and not exists (
        select 1 from public.account_deletion_alpha_subscriptions child
        left join public.account_deletion_sagas parent on parent.user_id = child.user_id
        where parent.user_id is null
      )
    )::text;`,
    tuplesOnly: true,
  });
  if (foreignKeysValid !== "true") fail("restored foreign key verification failed");

  const sequenceState = psql(psqlBin, port, database, {
    input:
      "select last_value::text || ':' || is_called::text from public.support_tickets_id_seq;",
    tuplesOnly: true,
  });
  if (sequenceState !== "43:false") fail("restored sequence verification failed");
}

function safeTemporaryDirectory(candidate) {
  const resolved = path.resolve(candidate);
  const temporaryRoot = path.resolve(os.tmpdir());
  return (
    path.dirname(resolved).toLowerCase() === temporaryRoot.toLowerCase() &&
    path.basename(resolved).startsWith("alpha-r80-restore-") &&
    !lstatSync(resolved).isSymbolicLink()
  );
}

async function drill() {
  const psqlBin = process.env.PSQL_BIN?.trim() || "psql";
  const initdbBin = nativeSibling(psqlBin, "initdb");
  const pgCtlBin = nativeSibling(psqlBin, "pg_ctl");
  command(psqlBin, ["--version"], {
    stage: "native psql is unavailable",
    stdio: "ignore",
  });
  command(initdbBin, ["--version"], {
    stage: "native initdb is unavailable",
    stdio: "ignore",
  });
  command(pgCtlBin, ["--version"], {
    stage: "native pg_ctl is unavailable",
    stdio: "ignore",
  });

  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "alpha-r80-restore-")
  );
  if (!safeTemporaryDirectory(temporaryDirectory)) {
    fail("unsafe local drill directory");
  }
  const dataDirectory = path.join(temporaryDirectory, "postgres");
  const backupDirectory = path.join(temporaryDirectory, "backup");
  const serverLog = path.join(temporaryDirectory, "postgres.log");
  const port = await getFreeLoopbackPort();
  let serverStarted = false;
  let completed = false;
  let failure;

  try {
    command(
      initdbBin,
      ["-D", dataDirectory, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"],
      { stage: "isolated PostgreSQL initialization failed", stdio: "ignore" }
    );
    try {
      command(
        pgCtlBin,
        [
          "-D",
          dataDirectory,
          "-l",
          serverLog,
          "-o",
          `-F -p ${port} -h 127.0.0.1`,
          "-w",
          "start",
        ],
        { stage: "isolated PostgreSQL startup failed", stdio: "ignore" }
      );
      serverStarted = true;
    } catch (error) {
      const status = spawnSync(pgCtlBin, ["-D", dataDirectory, "status"], {
        stdio: "ignore",
        windowsHide: true,
      });
      serverStarted = status.status === 0;
      throw error;
    }

    psql(psqlBin, port, "postgres", {
      stage: "isolated roles or databases could not be created",
      input: `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create database alpha_r80_source;
create database alpha_r80_destination;
`,
    });
    bootstrapDatabase(psqlBin, port, "alpha_r80_source");
    bootstrapDatabase(psqlBin, port, "alpha_r80_destination");
    loadSyntheticFixture(psqlBin, port, "alpha_r80_source");

    const { mkdirSync } = await import("node:fs");
    mkdirSync(backupDirectory);
    const manifest = exportSyntheticSnapshot(
      psqlBin,
      port,
      "alpha_r80_source",
      backupDirectory
    );

    const nonlocal = runRestoreCli({
      backupDirectory,
      databaseUrl: "postgresql://postgres@198.51.100.10/blocked",
      psqlBin,
    });
    if (nonlocal.status === 0) fail("nonlocal restore target was accepted");
    assertAggregateLine(nonlocal, "stderr", "RESTORE FAIL:");

    const usersPath = path.join(backupDirectory, "users.json");
    const originalUsers = readFileSync(usersPath);
    writeFileSync(usersPath, Buffer.concat([originalUsers, Buffer.from("\n")]));
    const tampered = runRestoreCli({
      backupDirectory,
      databaseUrl: `postgresql://postgres@127.0.0.1:${port}/alpha_r80_destination`,
      psqlBin,
    });
    if (tampered.status === 0) fail("tampered backup was accepted");
    assertAggregateLine(tampered, "stderr", "RESTORE FAIL:");
    writeFileSync(usersPath, originalUsers);

    const firstRestore = runRestoreCli({
      backupDirectory,
      databaseUrl: `postgresql://postgres@127.0.0.1:${port}/alpha_r80_destination`,
      psqlBin,
    });
    if (firstRestore.status !== 0) {
      const sqlState = firstRestore.stderr.match(/SQLSTATE ([0-9A-Z]{5})/)?.[1];
      fail(
        sqlState
          ? `valid local restore failed with SQLSTATE ${sqlState}`
          : `valid local restore failed (${firstRestore.stderr.trim() || "no diagnostic"})`
      );
    }
    assertAggregateLine(firstRestore, "stdout", "RESTORE PASS:");
    verifyRestoredDatabase(psqlBin, port, "alpha_r80_destination", manifest);

    const beforeSecondRestore = psql(psqlBin, port, "alpha_r80_destination", {
      input: "select count(*)::text from public.users;",
      tuplesOnly: true,
    });
    const secondRestore = runRestoreCli({
      backupDirectory,
      databaseUrl: `postgresql://postgres@127.0.0.1:${port}/alpha_r80_destination`,
      psqlBin,
    });
    if (secondRestore.status === 0) fail("nonempty restore target was accepted");
    assertAggregateLine(secondRestore, "stderr", "RESTORE FAIL:");
    const afterSecondRestore = psql(psqlBin, port, "alpha_r80_destination", {
      input: "select count(*)::text from public.users;",
      tuplesOnly: true,
    });
    if (beforeSecondRestore !== afterSecondRestore) {
      fail("failed restore changed the destination");
    }

    completed = true;
  } catch (error) {
    failure = error;
  } finally {
    if (serverStarted) {
      try {
        command(
          pgCtlBin,
          ["-D", dataDirectory, "-m", "fast", "-w", "stop"],
          { stage: "isolated PostgreSQL shutdown failed", stdio: "ignore" }
        );
        serverStarted = false;
      } catch (error) {
        failure ||= error;
      }
    }
    if (!serverStarted && safeTemporaryDirectory(temporaryDirectory)) {
      try {
        rmSync(temporaryDirectory, { force: true, recursive: true });
      } catch (error) {
        failure ||= error;
      }
    }
  }

  if (failure) throw failure;
  if (!completed) fail("local recovery drill did not complete");
}

try {
  await drill();
  console.log(
    `DRILL PASS: ${CRITICAL_TABLES.length} tables restored with manifest counts/hashes, exact auth anchors, foreign keys, and serial sequences verified.`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "local recovery drill failed";
  console.error(`DRILL FAIL: ${message}`);
  process.exitCode = 1;
}
