#!/usr/bin/env node
// Offline format-5 rehearsal. All rows are disposable local fixtures.
// Uses the real exporter with a local SQL-backed fetch adapter, encryption,
// and the unmodified local restore CLI. Never loads an app environment.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { criticalTablesForFormatVersion, tableFileMetadata } from "./critical-table-backup-format.mjs";
import { validateBackupDirectory } from "./critical-table-restore.mjs";

const BIN = "/home/algy/alpha-pg17-test-20260909/pgsql-17.11/bin";
const repo = fileURLToPath(new URL("..", import.meta.url));
const tables = criticalTablesForFormatVersion(5);
const minimalEnv = { PATH: "/usr/bin:/bin", LC_ALL: "C", PGPASSFILE: "/dev/null" };
assert.equal(process.platform, "linux");
assert.notEqual(process.getuid?.(), 0);
const base = mkdtempSync("/tmp/alpha-brevo-restore-");
assert.match(base, /^\/tmp\/alpha-brevo-restore-[A-Za-z0-9]+$/);
const data = path.join(base, "data");
const backup = path.join(base, "backup");
const recovered = path.join(base, "recovered");
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const allocated = server.address().port;
    server.close((error) => error ? reject(error) : resolve(allocated));
  });
});
let initialized = false;
let started = false;
let passed = false;
let checks = 0;
let rowCounts = null;
let archiveProof = null;
let shutdownVerified = false;
const completed = [];

function run(executable, args, { input, env = minimalEnv, allowFailure = false } = {}) {
  const result = spawnSync(executable, args, {
    input, env, encoding: "utf8", timeout: 150_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.signal) throw new Error(`local command did not finish: ${path.basename(executable)}`);
  if (!allowFailure && result.status !== 0) {
    throw new Error(`local ${path.basename(executable)} failed: ${(result.stderr || result.stdout).slice(-1800)}`);
  }
  return result;
}
const pg = (binary, args, options) => run(path.join(BIN, binary), args, options);
function sql(database, source, allowFailure = false) {
  assert.match(database, /^alpha_(schema|source|restored|failed)$/);
  return pg("psql", ["-X", "-w", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-f", "-"], {
    input: source, allowFailure,
    env: { ...minimalEnv, PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "postgres",
      PGDATABASE: database, PGSSLMODE: "disable", PGCONNECT_TIMEOUT: "5", PGPASSFILE: "/dev/null" },
  });
}
function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks++;
}
function checkSql(database, query, expected, label) {
  equal(sql(database, query).stdout.trim(), expected, label);
}
function orderSql(order) {
  return order.split(",").map((part) => {
    const match = part.match(/^([a-z_][a-z0-9_]*)\.asc$/);
    assert.ok(match);
    return `"${match[1]}" asc`;
  }).join(",");
}
function rows(database, table) {
  return JSON.parse(sql(database, `select coalesce(jsonb_agg(to_jsonb(r) order by ${orderSql(table.order)}),
    '[]'::jsonb) from public."${table.name}" r;`).stdout.trim());
}
const triggerCatalog = `select coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname,t.tgname,t.tgenabled)
  order by n.nspname,c.relname,t.tgname),'[]'::jsonb) from pg_trigger t
  join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('auth','public');`;
function assertEmpty(database) {
  const counts = ["select count(*) as n from auth.users",
    ...tables.map(({ name }) => `select count(*) as n from public."${name}"`)];
  checkSql(database, `select sum(n) from (${counts.join(" union all ")}) counts`, "0", "failed restore left no rows");
}
function restore(directory, database = "alpha_restored", host = "127.0.0.1") {
  return run(process.execPath, [path.join(repo, "scripts/restore-critical-tables-local.mjs"),
    "--backup-dir", directory, "--database-url", `postgresql://postgres@${host}:${port}/${database}`], {
    env: { ...minimalEnv, PSQL_BIN: path.join(BIN, "psql") }, allowFailure: true,
  });
}
function expectRejected(directory, database, pattern, host) {
  const result = restore(directory, database, host);
  equal(result.status, 1, "restore should reject");
  assert.match(result.stderr.trim(), pattern);
  equal(result.stdout.trim(), "", "failure must not print rows");
  equal(result.stderr.trim().split("\n").length, 1, "failure stays aggregate-only");
}
function alteredPackage(label, alter) {
  const directory = path.join(base, label);
  mkdirSync(directory, { mode: 0o700 });
  for (const name of readdirSync(recovered)) {
    writeFileSync(path.join(directory, name), readFileSync(path.join(recovered, name)), { mode: 0o600, flag: "wx" });
  }
  alter(directory);
  return directory;
}
function editRowsAndRehash(directory, name, alter) {
  const file = path.join(directory, `${name}.json`);
  const value = JSON.parse(readFileSync(file, "utf8"));
  alter(value);
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  writeFileSync(file, bytes);
  const manifestPath = path.join(directory, "MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files[name] = tableFileMetadata(name, bytes, value.length);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

try {
  pg("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"]);
  initialized = true;
  pg("pg_ctl", ["-D", data, "-l", path.join(base, "postgres.log"), "-o",
    `-F -p ${port} -c listen_addresses='127.0.0.1' -c unix_socket_directories='${base}'`, "-w", "start"]);
  started = true;
  pg("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "alpha_schema"]);
  checkSql("alpha_schema", "show listen_addresses", "127.0.0.1", "loopback listener only");
  checkSql("alpha_schema", "select host(inet_server_addr())", "127.0.0.1", "server confirms loopback");
  checkSql("alpha_schema", "show data_directory", data, "server owns only this disposable cluster");
  checkSql("alpha_schema", "select current_setting('server_version_num')::int between 170011 and 170099", "t", "pinned PostgreSQL 17.11+");
  sql("alpha_schema", `create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls;
    create extension if not exists pg_trgm; create schema auth;
    create table auth.users(id uuid primary key,email text not null unique,created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;`);
  const migrationDir = path.join(repo, "supabase/migrations");
  const migrationNames = readdirSync(migrationDir).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
  equal(migrationNames.length, 43, "exact migration chain");
  equal(migrationNames.at(-1), "20260927000000_brevo_delivery_foundation.sql", "candidate schema last");
  for (const name of migrationNames) {
    if (name === migrationNames.at(-1)) {
      // Match the service-role ACL from the September 26 hosted catalog.
      sql("alpha_schema", "grant execute on function public.watchdog_delivery_check(timestamptz) to service_role;");
    }
    sql("alpha_schema", readFileSync(path.join(migrationDir, name), "utf8").replaceAll("\r\n", "\n"));
  }
  for (const database of ["alpha_source", "alpha_restored", "alpha_failed"]) {
    pg("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-T", "alpha_schema", database]);
    assertEmpty(database);
  }
  completed.push("43 migrations and three isolated databases");

  const allTables = ["auth.users", ...tables.map(({ name }) => `public."${name}"`)];
  const userIds = [1, 2, 3, 4].map((n) => `${n}${"1".repeat(7)}-1111-4111-8111-111111111111`);
  const issueIds = [4, 6, 7, 8].map((n) => `${n}${"4".repeat(7)}-4444-4444-8444-444444444444`);
  const attemptIds = [5, 6, 7, 8].map((n) => `${n}${"5".repeat(7)}-5555-4555-8555-555555555555`);
  const lease = "88888888-8888-4888-8888-888888888888";
  const hash = "a".repeat(64);
  const sourceSql = ["begin; set local request.jwt.claims = '{\"role\":\"service_role\"}';",
    ...allTables.map((table) => `alter table ${table} disable trigger user;`)];
  for (let index = 0; index < 4; index++) {
    const provider = index === 0 || index === 3 ? "resend" : "brevo";
    const accepted = index < 2;
    const mailbox = index === 0 ? "recovery-drill@fixture.invalid" : `recovery-${index}@fixture.invalid`;
    const message = accepted ? `'${provider}-recovery-drill'` : "null";
    sourceSql.push(`insert into auth.users(id,email) values('${userIds[index]}','${mailbox}');
      insert into public.users(id,email,first_name,topics,subscribed_at,access_granted_at,delivery_enrolled,
        unsubscribed_at,brevo_unsubscribed_at)
      values('${userIds[index]}','${mailbox}','Local fixture',array['personal-finance'],
        '2026-09-26T10:00:00Z','2026-09-26T10:00:00Z',true,
        ${index === 1 ? "'2026-09-26T13:00:00Z','2026-09-26T13:00:00Z'" : "null,null"});
      insert into public.issues(id,user_id,week_of,editor_intro,sections,delivered_at,resend_message_id,brevo_message_id)
      values('${issueIds[index]}','${userIds[index]}','2026-09-26','Local recovery fixture only','[]',
        '${accepted ? "2026-09-26T12:00:01Z" : "2026-09-26T12:00:00Z"}',
        ${provider === "resend" ? message : "null"},${provider === "brevo" ? message : "null"});
      insert into public.resend_delivery_attempts(attempt_id,user_id,issue_id,recipient,delivery_lane,provider,
        request_fingerprint,started_at,retry_deadline_at,resend_message_id,brevo_message_id,accepted_at,
        manual_review_required_at,lease_token,lease_expires_at)
      values('${attemptIds[index]}','${userIds[index]}','${issueIds[index]}','${mailbox}','live','${provider}',
        '${hash}','2026-09-26T12:00:00Z',${provider === "resend" ? "'2026-09-27T11:00:00Z'" : "null"},
        ${provider === "resend" ? message : "null"},${provider === "brevo" ? message : "null"},
        ${accepted ? "'2026-09-26T12:00:01Z'" : "null"},
        ${index === 2 ? "'2026-09-26T12:00:00Z'" : "null"},
        ${accepted ? "null,null" : `'${lease}','2026-09-26T12:05:00Z'`});`);
  }
  sourceSql.push(`insert into public.brevo_suppression_events(message_id,event_type,event_at,recipient_hash,
      owner_user_id,resolution_status,resolved_at)
    values('brevo-recovery-drill','unsubscribed','2026-09-26T13:00:00Z','${hash}','${userIds[1]}','applied','2026-09-26T13:00:01Z'),
      ('brevo-recovery-drill','spam','2026-09-26T12:30:00Z','${hash}','${userIds[1]}','causally_ignored','2026-09-26T13:00:01Z');
    insert into public.brevo_suppression_events(message_id,event_type,event_at,recipient_hash,recipient_conflict,
      owner_user_id,resolution_status,review_required_at)
    values('brevo-conflict','spam','2026-09-26T13:00:00Z','${hash}',true,'${userIds[2]}','manual_review','2026-09-26T13:00:01Z');
    insert into public.brevo_suppression_events(message_id,event_type,event_at,recipient_hash,review_required_at)
    select 'brevo-pending-'||lpad(n::text,4,'0'),'hard_bounce','2026-09-26T13:00:00Z','${hash}',
      '2026-09-26T13:00:01Z' from generate_series(1,1001) n;`);
  sourceSql.push(...allTables.map((table) => `alter table ${table} enable trigger user;`), "commit;");
  sql("alpha_source", sourceSql.join("\n"));
  sql("alpha_source", readFileSync(path.join(repo, "scripts/fixtures/brevo-backup-legacy.sql"), "utf8"));
  checkSql("alpha_source", "select count(*) from public.brevo_suppression_events", "1004", "cross-page suppression fixture");
  checkSql("alpha_source", "select has_table_privilege('service_role','public.brevo_suppression_events','SELECT')", "t", "export grant");
  const before = new Map(tables.map((table) => [table.name, rows("alpha_source", table)]));
  for (const table of tables) assert.ok(before.get(table.name).length > 0, `${table.name} needs nonempty coverage`);
  const triggersBefore = sql("alpha_schema", triggerCatalog).stdout.trim();
  equal(sql("alpha_source", triggerCatalog).stdout.trim(), triggersBefore, "fixture leaves trigger modes unchanged");

  const exported = run(process.execPath, [path.join(repo, "scripts/fixtures/brevo-backup-export-local.mjs"), String(port), backup]);
  equal(exported.stdout.trim(), "Local exporter requests: 14", "all tables and second suppression page exported");
  const validated = validateBackupDirectory(backup);
  rowCounts = Object.fromEntries(Object.entries(validated.manifest.files).map(([name, metadata]) => [name, metadata.rowCount]));
  equal(validated.manifest.formatVersion, 5, "format 5 exported");
  equal(validated.tables.size, 13, "all 13 tables exported");
  for (const table of tables) equal(JSON.parse(validated.tables.get(table.name).json), before.get(table.name), `${table.name} export equality`);
  completed.push("real exporter via local SQL-backed transport, including pagination");

  // Same local archive/encryption commands as the scheduled workflow, using a
  // disposable random key kept only in child process memory. No real backup key.
  const archive = path.join(base, "backup.tar.gz");
  const encrypted = path.join(base, "backup.tar.gz.enc");
  const decrypted = path.join(base, "recovered.tar.gz");
  run("/usr/bin/tar", ["-czf", archive, "-C", backup, "."]);
  const encryptionEnv = { ...minimalEnv, ALPHA_DRILL_KEY: randomBytes(32).toString("hex") };
  run("/usr/bin/openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-in", archive, "-out", encrypted,
    "-pass", "env:ALPHA_DRILL_KEY"], { env: encryptionEnv });
  run("/usr/bin/openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-in", encrypted, "-out", decrypted,
    "-pass", "env:ALPHA_DRILL_KEY"], { env: encryptionEnv });
  delete encryptionEnv.ALPHA_DRILL_KEY;
  equal(readFileSync(decrypted), readFileSync(archive), "encrypted archive round trip");
  archiveProof = { encryptedBytes: readFileSync(encrypted).length, decryptedArchiveMatches: true };
  const expectedFiles = ["./", "./MANIFEST.json", ...tables.map(({ name }) => `./${name}.json`)].sort();
  equal(run("/usr/bin/tar", ["-tzf", decrypted]).stdout.trim().split("\n").sort(), expectedFiles, "archive contains only expected package");
  mkdirSync(recovered, { mode: 0o700 });
  run("/usr/bin/tar", ["-xzf", decrypted, "--no-same-owner", "-C", recovered]);
  equal(validateBackupDirectory(recovered).manifest, validated.manifest, "decrypted package evidence");
  completed.push("encrypted artifact round trip with disposable key");

  const restored = restore(recovered);
  equal(restored.status, 0, "real restore CLI succeeds");
  assert.match(restored.stdout.trim(), /^RESTORE PASS: 13 tables,/);
  equal(restored.stdout.trim().split("\n").length, 1, "restore prints only aggregate result");
  equal(restored.stderr.trim(), "", "no restore warnings");
  for (const table of tables) equal(rows("alpha_restored", table), before.get(table.name), `${table.name} restored exact rows`);
  equal(sql("alpha_restored", "select jsonb_agg(jsonb_build_array(id,email) order by id) from auth.users").stdout,
    sql("alpha_source", "select jsonb_agg(jsonb_build_array(id,email) order by id) from auth.users").stdout, "exact auth anchors");
  equal(sql("alpha_restored", triggerCatalog).stdout.trim(), triggersBefore, "triggers restored after commit");
  checkSql("alpha_restored", "select last_value::text || ':' || is_called::text from public.support_tickets_id_seq", "43:false", "serial sequence restored");
  completed.push("exact rows, Auth anchors, foreign keys and trigger/sequence state restored");

  expectRejected(recovered, "alpha_restored", /SQLSTATE P0001/);
  for (const table of tables) equal(rows("alpha_restored", table), before.get(table.name), "second restore preserves existing rows");
  expectRejected(recovered, "alpha_failed", /explicit loopback host/, "example.invalid");
  const damaged = alteredPackage("damaged", (directory) => {
    const file = path.join(directory, "brevo_suppression_events.json");
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from(" ")]));
  });
  expectRejected(damaged, "alpha_failed", /byte count does not match/);
  assertEmpty("alpha_failed");
  const missing = alteredPackage("missing", (directory) => {
    const file = path.join(directory, "MANIFEST.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    delete manifest.files.brevo_suppression_events;
    writeFileSync(file, JSON.stringify(manifest));
  });
  expectRejected(missing, "alpha_failed", /file inventory is incomplete/);
  assertEmpty("alpha_failed");
  const invalidMarker = alteredPackage("invalid-marker", (directory) => editRowsAndRehash(directory,
    "brevo_suppression_events", (value) => { value.find((row) => row.resolution_status === "pending_owner").review_required_at = null; }));
  expectRejected(invalidMarker, "alpha_failed", /SQLSTATE 23514/);
  assertEmpty("alpha_failed");
  equal(sql("alpha_failed", triggerCatalog).stdout.trim(), triggersBefore, "trigger changes roll back after check constraint failure");
  const orphan = alteredPackage("orphan", (directory) => editRowsAndRehash(directory,
    "brevo_suppression_events", (value) => { value[0].owner_user_id = "ffffffff-ffff-4fff-8fff-ffffffffffff"; }));
  expectRejected(orphan, "alpha_failed", /SQLSTATE 23503/);
  assertEmpty("alpha_failed");
  equal(sql("alpha_failed", triggerCatalog).stdout.trim(), triggersBefore, "trigger changes roll back after FK failure");
  completed.push("tamper, incomplete inventory, remote target, repeat restore and bad-row rollback rejection");

  const optOut = sql("alpha_restored", `begin; set local request.jwt.claims = '{"role":"service_role"}';
    update public.users set brevo_unsubscribed_at=null where id='${userIds[1]}'; rollback;`, true);
  equal(optOut.status, 3, "restored opt-out guard refuses clearing");
  assert.match(optOut.stderr, /Brevo unsubscribe marker requires reviewed recovery/);
  const ownership = sql("alpha_restored", `begin; set local request.jwt.claims = '{"role":"service_role"}';
    update public.resend_delivery_attempts set recipient='wrong@fixture.invalid' where attempt_id='${attemptIds[2]}'; rollback;`, true);
  equal(ownership.status, 3, "restored attempt owner guard refuses drift");
  assert.match(ownership.stderr, /Brevo delivery ownership is immutable/);
  for (const table of tables) equal(rows("alpha_restored", table), before.get(table.name), "guard probes leave recovered data unchanged");
  completed.push("post-restore opt-out and immutable delivery identity guards");
  passed = true;
} finally {
  const running = started || (initialized && pg("pg_ctl", ["-D", data, "status"], { allowFailure: true }).status === 0);
  if (running) equal(pg("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], { allowFailure: true }).status, 0, "database stops");
  if (initialized) {
    equal(pg("pg_ctl", ["-D", data, "status"], { allowFailure: true }).status, 3, "database is stopped");
    equal(existsSync(path.join(data, "postmaster.pid")), false, "no surviving PostgreSQL PID");
    equal(existsSync(path.join(base, `.s.PGSQL.${port}`)), false, "no surviving PostgreSQL socket");
    shutdownVerified = true;
  }
  const result = { passed, checks, completed, fixture: base, port, tables: tables.length,
    finishedAtUtc: new Date().toISOString(), rowCounts,
    totalRows: rowCounts ? Object.values(rowCounts).reduce((sum, count) => sum + count, 0) : null,
    archiveProof, shutdownVerified,
    productionAccess: false, actualHostedArtifactTested: false, realCredentialsUsed: false,
    limitation: "Quiescent local fixture with SQL-backed fetch adapter. Hosted PostgREST, live-write snapshot consistency, real backup key and Auth identity recovery are not proved." };
  writeFileSync(path.join(base, "RESULT.json"), JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(result));
}
