#!/usr/bin/env node
// Isolated PostgreSQL fixture for the enrollment migration. This never reads
// application env files, connects to a hosted database, or calls a provider.
// Run on Linux as a non-root user with the pinned local PostgreSQL 17.11 build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = "/home/algy/alpha-pg17-test-20260909/pgsql-17.11/bin";
const repo = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = path.join(repo, "supabase", "migrations");
const migrationNames = readdirSync(migrationsDir)
  .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
assert.equal(migrationNames.length, 42, "expected the exact 42-file migration chain");
assert.equal(migrationNames.at(-1), "20260924000000_delivery_enrollment.sql");
assert.equal(process.platform, "linux", "run this fixture in Linux, never against Windows PostgreSQL");
assert.notEqual(process.getuid?.(), 0, "PostgreSQL fixture must not run as root");

const base = mkdtempSync(path.join(os.tmpdir(), "alpha-enrollment-"));
assert.match(base, /^\/tmp\/alpha-enrollment-[A-Za-z0-9]+$/);
const data = path.join(base, "data");
const log = path.join(base, "postgres.log");
const env = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  PGHOST: base,
  PGPORT: "5432",
  PGUSER: "postgres",
  PGDATABASE: "postgres",
};
let started = false;
let initialized = false;
let passed = false;

function run(binary, args, { allowFailure = false, input } = {}) {
  const result = spawnSync(path.join(BIN, binary), args, {
    env,
    input,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${binary} failed (${result.status}): ${(result.stderr || result.stdout || "").slice(-3000)}`);
  }
  return result;
}

function sql(source, options = {}) {
  return run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-c", source], options);
}

function expectSql(source, expected) {
  const got = sql(source).stdout.trim();
  assert.equal(got, expected);
}

function expectDenied(source, reason) {
  const result = sql(source, { allowFailure: true });
  assert.notEqual(result.status, 0, "the database unexpectedly allowed a protected operation");
  assert.match(result.stderr, reason);
}

const oldId = "11111111-1111-4111-8111-111111111111";
const newId = "22222222-2222-4222-8222-222222222222";
const issueId = "33333333-3333-4333-8333-333333333333";
const leaseId = "44444444-4444-4444-8444-444444444444";
const fingerprint = "a".repeat(64);
const claims = (role, sub = oldId) =>
  `set request.jwt.claims = '{"role":"${role}"}';
   set request.jwt.claim.sub = '${sub}';`;
const migrationInput = (name) =>
  readFileSync(path.join(migrationsDir, name), "utf8").replace(/\r\n/g, "\n");

try {
  run("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"]);
  initialized = true;
  // A unique socket directory and empty listen_addresses rule out TCP and
  // accidental reuse of any other cluster. The directory and logs survive.
  run("pg_ctl", [
    "-D", data, "-l", log,
    "-o", `-F -p 5432 -c listen_addresses='' -c unix_socket_directories='${base}'`,
    "-w", "start",
  ]);
  started = true;
  expectSql("show listen_addresses", "");
  expectSql("show unix_socket_directories", base);
  expectSql("select current_setting('server_version_num')::int between 170011 and 170099", "t");

  // These are explicitly modeled Supabase fixtures, not hosted-Supabase proof.
  sql(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (
      id uuid primary key, email text not null, created_at timestamptz default now()
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
  `);

  for (const name of migrationNames.slice(0, -1)) {
    run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"],
      { input: migrationInput(name) });
  }
  // The existing profile predates the additive enrollment column.
  sql(`insert into auth.users(id,email) values ('${oldId}','existing@example.invalid');`);
  run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"],
    { input: migrationInput(migrationNames.at(-1)) });
  expectSql(`select delivery_enrolled from public.users where id='${oldId}'`, "f");

  sql(`
    insert into auth.users(id,email) values ('${newId}','new@example.invalid');
    grant select, insert, update on public.users to authenticated;
    grant select on public.issues to authenticated;
    grant select on auth.users to authenticated;
    grant select, insert, update on public.users to service_role;
    grant select, insert, update on public.issues to service_role;
    grant select on public.resend_delivery_attempts to service_role;
    -- Supabase grants this pure catalog validator to its service runtime.
    -- Model that platform permission explicitly in this isolated fixture.
    grant execute on function public.topics_all_valid(text[]) to service_role;
  `);
  expectSql(`select delivery_enrolled from public.users where id='${newId}'`, "f");

  // A forged true insert is rejected by the current RLS policy. As an
  // additional trigger test, superuser fixture with authenticated JWT claims
  // cannot force true even when RLS is bypassed.
  sql(`insert into auth.users(id,email) values ('55555555-5555-4555-8555-555555555555','forged@example.invalid');
    delete from public.users where id='55555555-5555-4555-8555-555555555555';`);
  expectDenied(`begin; set local role authenticated; ${claims("authenticated", "55555555-5555-4555-8555-555555555555")}
    insert into public.users(id,email,delivery_enrolled)
    values ('55555555-5555-4555-8555-555555555555','forged@example.invalid',true);
    commit;`, /row-level security|permission denied/i);
  sql(`insert into auth.users(id,email) values ('66666666-6666-4666-8666-666666666666','trigger@example.invalid');
    delete from public.users where id='66666666-6666-4666-8666-666666666666';`);
  sql(`set role authenticated; ${claims("authenticated", oldId)}
    update public.users set delivery_enrolled=true where id='${oldId}';`);
  expectSql(`select delivery_enrolled from public.users where id='${oldId}'`, "f");
  // Insert under a privileged SQL role while retaining non-service JWT claims.
  sql(`${claims("authenticated", oldId)}
    insert into public.users(id,email,delivery_enrolled)
      values ('66666666-6666-4666-8666-666666666666','trigger@example.invalid',true);`);
  expectSql("select delivery_enrolled from public.users where email='trigger@example.invalid'", "f");
  sql(`insert into auth.users(id,email) values ('77777777-7777-4777-8777-777777777777','no-jwt@example.invalid');
    delete from public.users where id='77777777-7777-4777-8777-777777777777';`);
  sql(`insert into public.users(id,email,delivery_enrolled)
    values ('77777777-7777-4777-8777-777777777777','no-jwt@example.invalid',true);`);
  expectSql("select delivery_enrolled from public.users where email='no-jwt@example.invalid'", "f");

  sql(`set role service_role; ${claims("service_role")}
    update public.users set subscribed_at=now(), access_granted_at=now()
      where id='${oldId}';
    insert into public.issues(id,user_id,week_of,editor_intro,sections,delivered_at)
      values ('${issueId}','${oldId}',current_date,'fixture','[]'::jsonb,now());`);
  expectSql(`select delivery_status from public.claim_resend_delivery_attempt(
    '${oldId}',current_date,'existing@example.invalid','live','${fingerprint}',
    '${leaseId}',(select delivered_at from public.issues where id='${issueId}'))`, "ineligible");
  expectSql("select count(*) from public.resend_delivery_attempts", "0");
  expectSql("select active_subscriber_count || ':' || uncovered_count from public.watchdog_delivery_check(now()-interval '1 hour')", "0:0");

  // Saved-issue RLS uses account access, independently of delivery enrollment.
  expectSql(`begin; set local role authenticated; ${claims("authenticated")}
    select count(*) from public.issues where id='${issueId}'; commit;`, "1");

  sql(`set role service_role; ${claims("service_role")}
    update public.users set delivery_enrolled=true where id='${oldId}';`);
  expectSql(`select delivery_enrolled from public.users where id='${oldId}'`, "t");
  // delivered_at without a provider message ID is deliberately uncovered.
  expectSql("select active_subscriber_count || ':' || uncovered_count from public.watchdog_delivery_check(now()-interval '1 hour')", "1:1");
  expectSql("select active_subscriber_count || ':' || uncovered_count from public.watchdog_delivery_check(now()+interval '2 hours')", "1:1");
  expectSql(`set role service_role; ${claims("service_role")}
    select delivery_status from public.claim_resend_delivery_attempt(
    '${oldId}',current_date,'existing@example.invalid','live','${fingerprint}',
    '${leaseId}',(select delivered_at from public.issues where id='${issueId}'))`, "claimed");
  expectSql("select count(*) from public.resend_delivery_attempts", "1");
  expectDenied(`set role service_role; ${claims("service_role")}
    update public.users set delivery_enrolled=false where id='${oldId}';`,
    /delivery state change blocked by active provider lease/);
  expectSql(`select delivery_enrolled from public.users where id='${oldId}'`, "t");
  expectSql(`set role service_role; ${claims("service_role")}
    select delivery_status from public.finalize_resend_delivery_attempt(
      '${oldId}',current_date,'live','${leaseId}','${fingerprint}','re_fixture_delivery')`, "recorded");
  expectSql("select active_subscriber_count || ':' || uncovered_count from public.watchdog_delivery_check(now()-interval '1 hour')", "1:0");
  sql(`set role service_role; ${claims("service_role")}
    update public.users set delivery_enrolled=false where id='${oldId}';`);
  expectSql(`select delivery_enrolled from public.users where id='${oldId}'`, "f");
  expectSql(`begin; set local role authenticated; ${claims("authenticated")}
    select count(*) from public.issues where id='${issueId}'; commit;`, "1");

  expectSql(`select has_function_privilege('service_role',
    'public.claim_resend_delivery_attempt(uuid,date,text,text,text,uuid,timestamptz)','EXECUTE')`, "t");
  for (const role of ["anon", "authenticated"]) {
    expectSql(`select has_function_privilege('${role}',
      'public.claim_resend_delivery_attempt(uuid,date,text,text,text,uuid,timestamptz)','EXECUTE')`, "f");
  }
  passed = true;
} finally {
  const running = started || (initialized && run("pg_ctl", ["-D", data, "status"], { allowFailure: true }).status === 0);
  if (running) {
    const stopped = run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], { allowFailure: true });
    assert.equal(stopped.status, 0, "isolated PostgreSQL failed to stop");
  }
  if (initialized) {
    assert.equal(run("pg_ctl", ["-D", data, "status"], { allowFailure: true }).status, 3,
      "isolated PostgreSQL status is not stopped");
    assert.equal(existsSync(path.join(data, "postmaster.pid")), false, "postmaster PID file remains");
    assert.equal(existsSync(path.join(base, ".s.PGSQL.5432")), false, "Unix socket remains");
  }
  console.log(`Fixture preserved at ${base}; PostgreSQL log at ${log}; passed=${passed}`);
  if (passed) console.log("PASS enrollment DB fixture: 42 migrations, protected writes, claim/lease, watchdog, saved-issue RLS, ACL");
}
