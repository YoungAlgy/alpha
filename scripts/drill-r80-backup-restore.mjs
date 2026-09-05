#!/usr/bin/env node
// Offline Round 80 recovery drill. It creates an isolated loopback PostgreSQL
// cluster, applies the repository migrations, exports a synthetic snapshot,
// restores it through the public local-only CLI, and destroys the cluster.
// Child-process output and fixture rows are never printed.
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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
const FIXTURE_ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const GUARD_ISSUE_ID = "66666666-6666-4666-8666-666666666666";
const GUARD_ATTEMPT_ID = "77777777-7777-4777-8777-777777777777";
const GUARD_LEASE_TOKEN = "88888888-8888-4888-8888-888888888888";
const CLOCK_BACKFILL_USER_ID = "99999999-9999-4999-8999-999999999999";
const CLOCK_UNRECOVERABLE_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOCK_BACKFILL_AT = "2026-01-02T03:04:05.678Z";
const CLOCK_TRIGGER_AT = "2026-02-03T04:05:06.789Z";
const CLOCK_BACKFILL_MIGRATION =
  "20260830050000_resend_suppression_causality.sql";
const RESEND_RECEIPT_BACKFILL_EVENT_ID = "r80-receipt-backfill";

function fail(message) {
  throw new Error(message);
}

function command(executable, args, options = {}) {
  const {
    diagnostic = "none",
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
    const combinedOutput = `${result.stderr || ""}\n${result.stdout || ""}`;
    const errorLine =
      diagnostic === "migration"
        ? combinedOutput
            .split(/\r?\n/)
            .map((line) => line.slice(line.search(/(?:ERROR|FATAL):/)))
            .find((line) => /^(?:ERROR|FATAL):/.test(line))
        : undefined;
    const safeErrorLine = errorLine
      ?.replace(/(?:postgres(?:ql)?):\/\/\S+/gi, "[redacted database URL]")
      .slice(0, 300);
    fail(safeErrorLine ? `${stage} (${safeErrorLine})` : stage);
  }
  return result;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
  {
    diagnostic,
    file,
    files,
    input,
    stage = "local PostgreSQL drill step failed",
    timeout = 180_000,
    tuplesOnly = false,
  }
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
    diagnostic,
    timeout,
  }).stdout.trim();
}

function psqlAsync(psqlBin, port, database, input, applicationName = "alpha-r80-concurrency") {
  return new Promise((resolve) => {
    const child = spawn(
      psqlBin,
      ["-X", "-w", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-c", "set request.jwt.claims = '{\"role\":\"service_role\"}';\n" + input],
      {
        env: {
          ...postgresEnvironment(port, database),
          PGAPPNAME: applicationName,
        },
        windowsHide: true,
      }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(null, "timeout");
    }, 20_000);
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status, signal, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (status, signal) => finish(status, signal));
  });
}

function expectPsqlFailure(
  psqlBin,
  port,
  database,
  file,
  expectedMessage
) {
  const result = spawnSync(
    psqlBin,
    [
      "-X",
      "-w",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "begin;",
      "-f",
      file,
      "-c",
      "rollback;",
    ],
    {
      encoding: "utf8",
      env: postgresEnvironment(port, database),
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
      windowsHide: true,
    }
  );
  if (result.error || result.signal) {
    fail("expected migration preflight could not run");
  }
  const combinedOutput = `${result.stderr || ""}\n${result.stdout || ""}`;
  if (result.status === 0 || !combinedOutput.includes(expectedMessage)) {
    fail("unrecoverable creation clock did not stop the migration preflight");
  }
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

function bootstrapDatabase(psqlBin, port, database, beforeMigration = null) {
  psql(psqlBin, port, database, {
    stage: "local database bootstrap failed",
    input: `
create extension if not exists pg_trgm;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text not null unique,
  created_at timestamptz default now()
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
  const migrations = migrationFiles().filter(
    (migration) =>
      beforeMigration === null || path.basename(migration).slice(0, 14) < beforeMigration
  );
  for (const migration of migrations) {
    if (!realpathSync(migration).startsWith(realpathSync(REPOSITORY_ROOT))) {
      fail("migration resolves outside the repository");
    }
    const migrationName = path.basename(migration);
    if (migrationName === CLOCK_BACKFILL_MIGRATION) {
      psql(psqlBin, port, database, {
        diagnostic: "migration",
        stage: "creation-clock backfill fixture setup failed",
        input: `
begin;
insert into auth.users (id, email, created_at)
values (
  '${CLOCK_BACKFILL_USER_ID}',
  'clock-backfill@fixture.invalid',
  '${CLOCK_BACKFILL_AT}'::timestamptz
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.users
   set created_at = null
 where id = '${CLOCK_BACKFILL_USER_ID}'::uuid;
insert into public.resend_webhook_events (email_id, type, received_at)
values ('${RESEND_RECEIPT_BACKFILL_EVENT_ID}', 'email.bounced', null);
insert into auth.users (id, email, created_at)
values (
  '${CLOCK_UNRECOVERABLE_USER_ID}',
  'clock-unrecoverable@fixture.invalid',
  null
);
update public.users
   set created_at = null
 where id = '${CLOCK_UNRECOVERABLE_USER_ID}'::uuid;
do $$
begin
  if not exists (
    select 1
      from public.users
     where id = '${CLOCK_BACKFILL_USER_ID}'::uuid
       and created_at is null
  ) then
    raise exception 'could not stage nullable public user creation clock';
  end if;
  if not exists (
    select 1
      from public.users public_user
      join auth.users auth_user on auth_user.id = public_user.id
     where public_user.id = '${CLOCK_UNRECOVERABLE_USER_ID}'::uuid
       and public_user.created_at is null
       and auth_user.created_at is null
  ) then
    raise exception 'could not stage unrecoverable public user creation clock';
  end if;
end;
$$;
commit;
`,
      });
      expectPsqlFailure(
        psqlBin,
        port,
        database,
        migration,
        "Cannot recover public.users.created_at from auth.users.created_at"
      );
      psql(psqlBin, port, database, {
        stage: "unrecoverable creation-clock fixture cleanup failed",
        input: `
delete from auth.users
 where id = '${CLOCK_UNRECOVERABLE_USER_ID}'::uuid;
`,
      });
    }
    psql(psqlBin, port, database, {
      diagnostic: "migration",
      file: migration,
      stage: `repository migration application failed: ${path.basename(migration)}`,
    });
    if (migrationName === CLOCK_BACKFILL_MIGRATION) {
      psql(psqlBin, port, database, {
        diagnostic: "migration",
        stage: "creation-clock backfill verification failed",
        input: `
do $$
begin
  if (
    select created_at
      from public.users
     where id = '${CLOCK_BACKFILL_USER_ID}'::uuid
  ) is distinct from '${CLOCK_BACKFILL_AT}'::timestamptz then
    raise exception 'public user creation clock was not recovered exactly';
  end if;
  if not exists (
    select 1
      from public.resend_webhook_events
     where email_id = '${RESEND_RECEIPT_BACKFILL_EVENT_ID}'
       and type = 'email.bounced'
       and received_at is not null
       and event_at is null
       and resolution_status = 'legacy_review'
  ) then
    raise exception 'nullable Resend receipt clock was not backfilled safely';
  end if;
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'users'
       and column_name = 'created_at'
       and is_nullable = 'NO'
  ) then
    raise exception 'public user creation clock is still nullable';
  end if;
end;
$$;
delete from public.users
 where id = '${CLOCK_BACKFILL_USER_ID}'::uuid;
delete from auth.users
 where id = '${CLOCK_BACKFILL_USER_ID}'::uuid;
insert into auth.users (id, email, created_at)
values (
  '${CLOCK_BACKFILL_USER_ID}',
  'clock-trigger@fixture.invalid',
  '${CLOCK_TRIGGER_AT}'::timestamptz
);
do $$
begin
  if (
    select created_at
      from public.users
     where id = '${CLOCK_BACKFILL_USER_ID}'::uuid
  ) is distinct from '${CLOCK_TRIGGER_AT}'::timestamptz then
    raise exception 'new public user did not inherit the exact Auth creation clock';
  end if;
end;
$$;
delete from auth.users
 where id = '${CLOCK_BACKFILL_USER_ID}'::uuid;
delete from public.resend_webhook_events
 where email_id = '${RESEND_RECEIPT_BACKFILL_EVENT_ID}'
   and type = 'email.bounced';
`,
      });
    }
  }
}

function verifyInviteCheckoutReview(psqlBin, port, database) {
  // These fixture-only mutations run in an isolated database and roll back.
  // No Stripe client or real account is involved.
  psql(psqlBin, port, database, {
    diagnostic: "migration",
    stage: "invite checkout review runtime guards failed",
    input: `
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into auth.users (id, email)
values ('${FIXTURE_USER_ID}', 'invite-review@fixture.invalid');
insert into public.checkout_profiles (
  id, email_hash, browser_nonce_hash, owner_user_id, billing_state,
  raw_profile_scrubbed_at, session_creation_started_at,
  stripe_session_expires_at, stripe_session_business_expires_at,
  stripe_session_origin, stripe_session_price_id, stripe_session_params_version,
  stripe_session_customer_email_ciphertext, session_creation_lease_expires_at
) values (
  '${FIXTURE_PROFILE_ID}', repeat('a', 64), repeat('b', 64),
  '${FIXTURE_USER_ID}', 'creating', now(), now() - interval '1 hour',
  now() + interval '23 hours', now() + interval '23 hours',
  'https://alpha.everyday.report', 'price_local_drill', 1,
  'v1.local_fixture_not_encrypted', now() + interval '1 minute'
);
do $invite$
declare
  v_before jsonb;
  v_after jsonb;
  v_decision text;
begin
  if public.hold_checkout_session_creation_for_invite_review(null, now())
       is distinct from 'invalid' then
    raise exception 'invite hold accepted missing profile';
  end if;
  if public.hold_checkout_session_creation_for_invite_review('${FIXTURE_PROFILE_ID}', now())
       is distinct from 'not_due' then
    raise exception 'invite hold did not respect active original lease';
  end if;
  if exists (select 1 from public.checkout_creation_reviews) then
    raise exception 'active original lease created review';
  end if;
  update public.checkout_profiles
     set session_creation_lease_expires_at = now() - interval '1 minute',
         session_creation_replay_token = '${GUARD_LEASE_TOKEN}',
         session_creation_replay_lease_expires_at = now() + interval '1 minute'
   where id = '${FIXTURE_PROFILE_ID}';
  if public.hold_checkout_session_creation_for_invite_review('${FIXTURE_PROFILE_ID}', now())
       is distinct from 'in_progress' then
    raise exception 'invite hold did not respect active replay lease';
  end if;
  if exists (select 1 from public.checkout_creation_reviews) then
    raise exception 'active replay lease created review';
  end if;
  update public.checkout_profiles
     set session_creation_replay_lease_expires_at = now() - interval '1 second'
   where id = '${FIXTURE_PROFILE_ID}';
  select to_jsonb(p) into v_before from public.checkout_profiles p
   where p.id = '${FIXTURE_PROFILE_ID}';
  if public.hold_checkout_session_creation_for_invite_review('${FIXTURE_PROFILE_ID}', now())
       is distinct from 'review_required' then
    raise exception 'due invite hold did not create review';
  end if;
  if not exists (select 1 from public.checkout_creation_reviews
                  where profile_id = '${FIXTURE_PROFILE_ID}'
                    and reason = 'invite_mode_transition' and status = 'pending') then
    raise exception 'invite hold lost review reason';
  end if;
  if public.hold_checkout_session_creation_for_invite_review('${FIXTURE_PROFILE_ID}', now())
       is distinct from 'review_required' then
    raise exception 'repeated invite hold is not idempotent';
  end if;
  select decision into v_decision
    from public.claim_checkout_session_creation_replay(
      '${FIXTURE_PROFILE_ID}', '${GUARD_ATTEMPT_ID}', 180
    );
  if v_decision is distinct from 'manual_review' then
    raise exception 'pending invite review allowed paid replay';
  end if;
  if exists (select 1 from public.list_stale_checkout_session_creations(now(), 5)
              where profile_id = '${FIXTURE_PROFILE_ID}') then
    raise exception 'pending invite review remains in automatic queue';
  end if;
  if public.count_pending_checkout_creation_reviews() <> 1 then
    raise exception 'invite review missing from operator count';
  end if;
  select to_jsonb(p) into v_after from public.checkout_profiles p
   where p.id = '${FIXTURE_PROFILE_ID}';
  if v_before is distinct from v_after then
    raise exception 'invite hold changed exact request or binding';
  end if;
end
$invite$;
rollback;
`,
  });
  const verification = readFileSync(
    path.join(REPOSITORY_ROOT, "scripts", "r80-live-verification.sql"), "utf8"
  );
  const proof = verification.split("-- BEGIN INVITE CHECKOUT REVIEW PROOF")[1]
    ?.split("-- END INVITE CHECKOUT REVIEW PROOF")[0];
  if (!proof) fail("invite review catalog proof is missing");
  const catalogProof = psql(psqlBin, port, database, {
    input: proof,
    tuplesOnly: true,
    stage: "invite checkout review catalog proof failed",
  });
  if (catalogProof !== "t|t|t|t|t|t") {
    fail("invite checkout review installed catalog contract changed");
  }
}

function verifyResendPrivacyDrill(psqlBin, port, database) {
  const privacyDrill = path.join(
    REPOSITORY_ROOT,
    "scripts",
    "r80-resend-privacy-drill.sql"
  );
  if (!realpathSync(privacyDrill).startsWith(realpathSync(REPOSITORY_ROOT))) {
    fail("Resend privacy drill resolves outside the repository");
  }
  const result = psql(psqlBin, port, database, {
    diagnostic: "migration",
    file: privacyDrill,
    tuplesOnly: true,
    stage: "Resend deletion/privacy SQL drill failed",
  });
  if (result !== "R80 RESEND PRIVACY DRILL PASS: 29 assertions") {
    fail("Resend deletion/privacy SQL drill returned an unexpected result");
  }
}

function verifySuppressionRecoveryDrill(psqlBin, port, database) {
  const recoveryDrill = path.join(
    REPOSITORY_ROOT,
    "scripts",
    "r80-suppression-recovery-drill.sql"
  );
  if (!realpathSync(recoveryDrill).startsWith(realpathSync(REPOSITORY_ROOT))) {
    fail("suppression recovery drill resolves outside the repository");
  }
  const result = psql(psqlBin, port, database, {
    diagnostic: "migration",
    file: recoveryDrill,
    tuplesOnly: true,
    stage: "suppression recovery SQL drill failed",
  });
  if (result !== "R80 SUPPRESSION RECOVERY DRILL PASS: 23 assertions") {
    fail("suppression recovery SQL drill returned an unexpected result");
  }
}

function verifySuppressionRecoveryCatalog(psqlBin, port, database) {
  const verification = readFileSync(
    path.join(REPOSITORY_ROOT, "scripts", "r80-live-verification.sql"), "utf8"
  );
  const start = verification.indexOf("-- PASS: every recovery boolean is true.");
  const end = verification.indexOf("-- MANUAL RELEASE GATE:", start);
  if (start < 0 || end < start) fail("canonical recovery proof boundaries missing");
  const result = psql(psqlBin, port, database, {
    input: verification.slice(start, end),
    diagnostic: "migration",
    tuplesOnly: true,
    stage: "canonical suppression recovery catalog proof failed",
  });
  const rows = result.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  const expected = [
    "t|t|t|t|t|t|t|t",
    "auth_users_suppression_recovery_identity_guard|t|t",
    "users_suppression_recovery_identity_guard|t|t",
    "0|",
  ];
  if (JSON.stringify(rows) !== JSON.stringify(expected)) {
    fail("canonical suppression recovery catalog proof did not pass every predicate");
  }
}

async function verifySuppressionRecoveryConcurrency(psqlBin, port, database) {
  const fixtures = [
    ["e5000000-0000-4000-8000-000000000001", "recovery-delete-first@fixture.invalid"],
    ["e5000000-0000-4000-8000-000000000002", "recovery-delete-wins@fixture.invalid"],
    ["e5000000-0000-4000-8000-000000000003", "recovery-auth-update@fixture.invalid"],
    ["e5000000-0000-4000-8000-000000000004", "recovery-prepare-first@fixture.invalid"],
    ["e5000000-0000-4000-8000-000000000005", "recovery-prepare-wins@fixture.invalid"],
  ];
  const setup = `
set request.jwt.claims = '{"role":"service_role"}';
insert into auth.users (id, email, created_at) values
  ('${fixtures[0][0]}', '${fixtures[0][1]}', clock_timestamp()),
  ('${fixtures[1][0]}', '${fixtures[1][1]}', clock_timestamp()),
  ('${fixtures[2][0]}', '${fixtures[2][1]}', clock_timestamp()),
  ('${fixtures[3][0]}', '${fixtures[3][1]}', clock_timestamp()),
  ('${fixtures[4][0]}', '${fixtures[4][1]}', clock_timestamp());
update public.users
   set subscribed_at = clock_timestamp(),
       access_granted_at = clock_timestamp(),
       bounced_at = clock_timestamp() - interval '1 hour'
 where id in ('${fixtures[0][0]}'::uuid, '${fixtures[1][0]}'::uuid,
              '${fixtures[2][0]}'::uuid, '${fixtures[3][0]}'::uuid,
              '${fixtures[4][0]}'::uuid);
`;
  psql(psqlBin, port, database, {
    stage: "suppression recovery concurrency fixture setup failed",
    input: setup,
  });
  const waitForActivity = async (applicationName) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const active = psql(psqlBin, port, database, {
        input: `select count(*)::text from pg_stat_activity where application_name = '${applicationName}' and state = 'active' and wait_event = 'PgSleep';`,
        tuplesOnly: true,
        stage: "suppression recovery concurrency activity check failed",
      });
      if (active === "1") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    fail(`suppression recovery concurrency session ${applicationName} did not reach its lock barrier`);
  };
  const waitForLockWait = async (applicationName) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = psql(psqlBin, port, database, {
        input: `select count(*)::text from pg_stat_activity where application_name = '${applicationName}' and state = 'active' and wait_event_type = 'Lock';`,
        tuplesOnly: true,
        stage: "suppression recovery lock-wait check failed",
      });
      if (waiting === "1") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    fail(`suppression recovery session ${applicationName} did not wait on its expected lock`);
  };
  try {
    const claimFirstPromise = psqlAsync(
      psqlBin,
      port,
      database,
      `begin;
select recovery_status from public.claim_resend_suppression_recovery('e5000000-0000-4000-8000-000000000001'::uuid);
select pg_sleep(2);
commit;`,
      "r80-claim-first-delete"
    );
    await waitForActivity("r80-claim-first-delete");
    const claimFirstDeletePromise = psqlAsync(
      psqlBin,
      port,
      database,
      `begin;
delete from auth.users where id = 'e5000000-0000-4000-8000-000000000001'::uuid;
commit;`,
      "r80-delete-after-claim"
    );
    await waitForLockWait("r80-delete-after-claim");
    const claimFirst = await Promise.all([claimFirstPromise, claimFirstDeletePromise]);
    if (
      claimFirst[0].status !== 0 ||
      !claimFirst[0].stdout.includes("claimed") ||
      claimFirst[1].status === 0 ||
      !claimFirst[1].stderr.includes(
        "account deletion blocked by unresolved suppression recovery"
      )
    ) {
      fail("claim-first versus direct Auth deletion race did not fail closed");
    }
    const claimFirstFence = psql(psqlBin, port, database, {
      input: `select count(*)::text from public.users where id = 'e5000000-0000-4000-8000-000000000001'::uuid and suppression_recovery_token is not null;`,
      tuplesOnly: true,
      stage: "claim-first recovery fence verification failed",
    });
    if (claimFirstFence !== "1") fail("claim-first recovery fence was lost");

    const deleteFirstPromise = psqlAsync(
      psqlBin,
      port,
      database,
      `begin;
delete from auth.users where id = 'e5000000-0000-4000-8000-000000000002'::uuid;
select pg_sleep(2);
commit;`,
      "r80-delete-first-claim"
    );
    await waitForActivity("r80-delete-first-claim");
    const deleteFirstClaimPromise = psqlAsync(
      psqlBin,
      port,
      database,
      `begin;
select recovery_status from public.claim_resend_suppression_recovery('e5000000-0000-4000-8000-000000000002'::uuid);
commit;`,
      "r80-claim-after-delete"
    );
    await waitForLockWait("r80-claim-after-delete");
    const deleteFirst = await Promise.all([deleteFirstClaimPromise, deleteFirstPromise]);
    if (
      deleteFirst[0].status !== 0 ||
      !deleteFirst[0].stdout.includes("missing") ||
      deleteFirst[1].status !== 0
    ) {
      fail("direct Auth deletion-first versus claim race did not serialize");
    }
    const deleteFirstGone = psql(psqlBin, port, database, {
      input: `select count(*)::text from public.users where id = 'e5000000-0000-4000-8000-000000000002'::uuid;`,
      tuplesOnly: true,
      stage: "deletion-first cascade verification failed",
    });
    if (deleteFirstGone !== "0") fail("direct Auth deletion did not cascade the public user");

    const authUpdatePromise = psqlAsync(
      psqlBin,
      port,
      database,
      `set timezone = 'America/New_York';
begin;
select recovery_status || '|' || recovery_token::text from public.claim_resend_suppression_recovery('e5000000-0000-4000-8000-000000000003'::uuid);
select pg_sleep(2);
commit;`,
      "r80-claim-auth-update"
    );
    await waitForActivity("r80-claim-auth-update");
    const authUpdateOperationPromise = psqlAsync(
      psqlBin,
      port,
      database,
      `begin;
update auth.users
   set email = 'recovery-auth-update-changed@fixture.invalid'
 where id = 'e5000000-0000-4000-8000-000000000003'::uuid;
commit;`,
      "r80-auth-update-after-claim"
    );
    await waitForLockWait("r80-auth-update-after-claim");
    const authUpdate = await Promise.all([
      authUpdatePromise,
      authUpdateOperationPromise,
    ]);
    if (
      authUpdate[0].status !== 0 ||
      !authUpdate[0].stdout.includes("claimed") ||
      authUpdate[1].status === 0 ||
      !authUpdate[1].stderr.includes("Auth identity change blocked by unresolved suppression recovery")
    ) {
      fail("claim versus Auth email update race did not fail closed");
    }
    const recoveryToken = authUpdate[0].stdout.match(
      /claimed\|([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i
    )?.[1];
    if (!recoveryToken) fail("cross-timezone claim did not return its recovery token");
    const crossTimezoneFinalize = await psqlAsync(
      psqlBin,
      port,
      database,
      `set timezone = 'UTC';
select public.finalize_resend_suppression_recovery(
  'e5000000-0000-4000-8000-000000000003'::uuid,
  '${recoveryToken}'::uuid
);`
    );
    if (
      crossTimezoneFinalize.status !== 0 ||
      !crossTimezoneFinalize.stdout.includes("cleared")
    ) {
      fail("cross-session-timezone recovery finalization did not clear safely");
    }
    const authEmail = psql(psqlBin, port, database, {
      input: `select email from auth.users where id = 'e5000000-0000-4000-8000-000000000003'::uuid;`,
      tuplesOnly: true,
      stage: "Auth email recovery fence verification failed",
    });
    if (authEmail !== fixtures[2][1]) fail("Auth email changed during recovery fence");

    const authFirstPromise = psqlAsync(psqlBin, port, database, `begin;
update auth.users set email = 'confirmed-first@fixture.invalid'
 where id = 'e5000000-0000-4000-8000-000000000003'::uuid;
select pg_sleep(2);
commit;`, "r80-auth-change-first");
    await waitForActivity("r80-auth-change-first");
    const claimAfterAuthPromise = psqlAsync(psqlBin, port, database, `begin;
select recovery_status from public.claim_resend_suppression_recovery(
  'e5000000-0000-4000-8000-000000000003'::uuid
);
commit;`, "r80-claim-after-auth-change");
    await waitForLockWait("r80-claim-after-auth-change");
    const authFirst = await Promise.all([authFirstPromise, claimAfterAuthPromise]);
    if (authFirst[0].status !== 0 || authFirst[1].status !== 0 ||
        !authFirst[1].stdout.includes("identity_conflict")) {
      fail("Auth identity change first did not block recovery on the old mirror");
    }

    const claimPrepareFirstPromise = psqlAsync(
      psqlBin,
      port,
      database,
      `begin;
select recovery_status from public.claim_resend_suppression_recovery('e5000000-0000-4000-8000-000000000004'::uuid);
select pg_sleep(2);
commit;`,
      "r80-claim-first-prepare"
    );
    await waitForActivity("r80-claim-first-prepare");
    const prepareAfterClaimPromise = psqlAsync(
      psqlBin,
      port,
      database,
      `begin;
select public.prepare_account_deletion('e5000000-0000-4000-8000-000000000004'::uuid);
commit;`,
      "r80-prepare-after-claim"
    );
    await waitForLockWait("r80-prepare-after-claim");
    const claimPrepareFirst = await Promise.all([
      claimPrepareFirstPromise,
      prepareAfterClaimPromise,
    ]);
    if (
      claimPrepareFirst[0].status !== 0 ||
      !claimPrepareFirst[0].stdout.includes("claimed") ||
      claimPrepareFirst[1].status === 0 ||
      !claimPrepareFirst[1].stderr.includes(
        "account deletion blocked by unresolved suppression recovery"
      )
    ) {
      fail("claim-first versus prepare-account-deletion race did not fail closed");
    }

    const prepareFirstPromise = psqlAsync(
      psqlBin,
      port,
      database,
      `begin;
select public.prepare_account_deletion('e5000000-0000-4000-8000-000000000005'::uuid);
select pg_sleep(2);
commit;`,
      "r80-prepare-first-claim"
    );
    await waitForActivity("r80-prepare-first-claim");
    const claimAfterPreparePromise = psqlAsync(
      psqlBin,
      port,
      database,
      `begin;
select recovery_status from public.claim_resend_suppression_recovery('e5000000-0000-4000-8000-000000000005'::uuid);
commit;`,
      "r80-claim-after-prepare"
    );
    await waitForLockWait("r80-claim-after-prepare");
    const prepareFirst = await Promise.all([
      claimAfterPreparePromise,
      prepareFirstPromise,
    ]);
    if (
      prepareFirst[0].status !== 0 ||
      !prepareFirst[0].stdout.includes("deletion_pending") ||
      prepareFirst[1].status !== 0
    ) {
      fail("prepare-first versus claim race did not serialize");
    }
  } finally {
    psql(psqlBin, port, database, {
      stage: "suppression recovery concurrency fixture cleanup failed",
      input: `
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
delete from public.account_deletion_sagas
 where user_id in ('${fixtures[0][0]}'::uuid, '${fixtures[1][0]}'::uuid, '${fixtures[2][0]}'::uuid, '${fixtures[3][0]}'::uuid, '${fixtures[4][0]}'::uuid);
update public.users
   set suppression_recovery_token = null,
       suppression_recovery_started_at = null,
       suppression_recovery_snapshot = null,
       suppression_cleanup_pending_at = null,
       bounced_at = null,
       complained_at = null
 where id in ('${fixtures[0][0]}'::uuid, '${fixtures[1][0]}'::uuid,
              '${fixtures[2][0]}'::uuid, '${fixtures[3][0]}'::uuid,
              '${fixtures[4][0]}'::uuid);
delete from auth.users
 where id in ('${fixtures[0][0]}'::uuid, '${fixtures[1][0]}'::uuid, '${fixtures[2][0]}'::uuid, '${fixtures[3][0]}'::uuid, '${fixtures[4][0]}'::uuid);
`,
    });
  }
}

function verifyFrozenBundleArtifact(bundlePath) {
  const resolvedBundle = path.resolve(bundlePath);
  const manifestPath = path.join(
    path.dirname(resolvedBundle),
    `${path.basename(resolvedBundle, path.extname(resolvedBundle))}.manifest.json`
  );
  if (!lstatSync(resolvedBundle).isFile() || !lstatSync(manifestPath).isFile()) {
    fail("frozen migration bundle or companion manifest is missing");
  }
  const bundleBytes = readFileSync(resolvedBundle);
  const bundleText = bundleBytes.toString("utf8");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expectedVersions = [
    "20260827000000",
    "20260827010000",
    "20260827020000",
    "20260827030000",
    "20260827040000",
    "20260827050000",
    "20260827200000",
    "20260828000000",
    "20260830000000",
    "20260830010000",
    "20260830020000",
    "20260830030000",
    "20260830040000",
    "20260830050000",
  ];
  const expectedNames = expectedVersions.map(
    (version) => migrationFiles().find((file) => path.basename(file).startsWith(version))
  );
  if (
    manifest.bundle?.name !== path.basename(resolvedBundle) ||
    manifest.bundle?.sha256 !== sha256(bundleBytes) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 14 ||
    JSON.stringify(manifest.ledgerVersions) !== JSON.stringify(expectedVersions) ||
    expectedNames.some((file) => !file)
  ) {
    fail("frozen migration bundle manifest identity or 14-file order changed");
  }
  let previousMarker = -1;
  for (const [index, entry] of manifest.files.entries()) {
    const expectedPath = expectedNames[index];
    const expectedName = path.basename(expectedPath);
    const sourceText = readFileSync(expectedPath, "utf8").trimEnd();
    const marker = `-- BEGIN ${entry.name}`;
    const markerAt = bundleText.indexOf(marker);
    if (
      entry.name !== expectedName ||
      entry.sha256 !== sha256(sourceText) ||
      entry.name.slice(0, 14) !== expectedVersions[index] ||
      markerAt <= previousMarker ||
      !bundleText.startsWith(
        `${marker}\n-- SHA256 ${entry.sha256}\n${sourceText}\n-- END ${entry.name}`,
        markerAt
      )
    ) {
      fail(`frozen migration bundle source hash/order mismatch at ${entry.name}`);
    }
    previousMarker = markerAt;
  }
  return resolvedBundle;
}

function applyFrozenBundle(psqlBin, port, database, bundlePath) {
  const verifiedBundle = verifyFrozenBundleArtifact(bundlePath);
  psql(psqlBin, port, database, {
    diagnostic: "migration",
    file: verifiedBundle,
    stage: "verified frozen migration bundle application failed",
  });
  const ledger = psql(psqlBin, port, database, {
    input: `
select count(*)::text || '|' ||
       bool_and(version = any(array[
         '20260827000000','20260827010000','20260827020000',
         '20260827030000','20260827040000','20260827050000',
         '20260827200000','20260828000000','20260830000000',
         '20260830010000','20260830020000','20260830030000',
         '20260830040000','20260830050000'
       ]::text[]))::text
  from supabase_migrations.schema_migrations
 where version = any(array[
         '20260827000000','20260827010000','20260827020000',
         '20260827030000','20260827040000','20260827050000',
         '20260827200000','20260828000000','20260830000000',
         '20260830010000','20260830020000','20260830030000',
         '20260830040000','20260830050000'
       ]::text[]);`,
    stage: "frozen bundle migration ledger verification failed",
    tuplesOnly: true,
  });
  if (ledger !== "14|true") {
    fail("frozen bundle did not leave the expected representative 14-row ledger");
  }
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
  const recipientHash =
    "e1424f359149365651d639f175c5a49eedb202b59e2bc72488583fdfa17daa82";
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

insert into public.resend_delivery_attempts (
  attempt_id, user_id, issue_id, recipient, delivery_lane,
  request_fingerprint, started_at, retry_deadline_at,
  resend_message_id, accepted_at
) values (
  '${FIXTURE_ATTEMPT_ID}',
  '${FIXTURE_USER_ID}',
  '${FIXTURE_ISSUE_ID}',
  'recovery-drill@fixture.invalid',
  'live',
  '${hashA}',
  '2026-08-30T12:00:00Z',
  '2026-08-31T11:00:00Z',
  'resend-recovery-drill',
  '2026-08-30T12:00:01Z'
);

insert into public.resend_webhook_events (
  email_id, type, received_at, event_at, recipient_hashes,
  owner_user_id, resolution_status, review_required_at, resolved_at
) values (
  'resend-recovery-drill',
  'email.bounced',
  '2026-08-30T12:05:02Z',
  '2026-08-30T12:05:00Z',
  array['${recipientHash}']::text[],
  '${FIXTURE_USER_ID}',
  'applied',
  null,
  '2026-08-30T12:05:03Z'
);

-- Exercise the active-delivery user-state guard while the fixture has no
-- deletion saga. The temporary issue and attempt are removed before export.
insert into public.issues (id, user_id, week_of, editor_intro, sections)
values (
  '${GUARD_ISSUE_ID}',
  '${FIXTURE_USER_ID}',
  '2026-08-17',
  'Synthetic active-lease guard drill.',
  '[]'::jsonb
);

with guard_clock as (
  select clock_timestamp() as started_at
)
insert into public.resend_delivery_attempts (
  attempt_id, user_id, issue_id, recipient, delivery_lane,
  request_fingerprint, started_at, retry_deadline_at,
  lease_token, lease_expires_at
)
select
  '${GUARD_ATTEMPT_ID}',
  '${FIXTURE_USER_ID}',
  '${GUARD_ISSUE_ID}',
  'recovery-drill@fixture.invalid',
  'live',
  '${hashB}',
  started_at,
  started_at + interval '23 hours',
  '${GUARD_LEASE_TOKEN}',
  started_at + interval '6 minutes'
from guard_clock;

alter table public.users enable trigger user;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $guard$
declare
  v_status text;
begin
  begin
    update public.users
       set email = 'blocked-email-change@fixture.invalid'
     where id = '${FIXTURE_USER_ID}';
    raise exception 'active lease allowed email mutation';
  exception
    when others then
      if sqlerrm <> 'delivery state change blocked by active provider lease' then
        raise;
      end if;
  end;

  begin
    update public.users
       set unsubscribed_at = clock_timestamp()
     where id = '${FIXTURE_USER_ID}';
    raise exception 'active lease allowed unsubscribe mutation';
  exception
    when others then
      if sqlerrm <> 'delivery state change blocked by active provider lease' then
        raise;
      end if;
  end;

  if not exists (
    select 1
      from public.users
     where id = '${FIXTURE_USER_ID}'
       and email = 'recovery-drill@fixture.invalid'
       and unsubscribed_at is null
  ) then
    raise exception 'blocked delivery-state mutation changed the user row';
  end if;

  select finalized.delivery_status
    into v_status
    from public.finalize_resend_delivery_attempt(
      '${FIXTURE_USER_ID}',
      '2026-08-17'::date,
      'live',
      '${GUARD_LEASE_TOKEN}',
      '${hashB}',
      'resend-recovery-guard'
    ) finalized;
  if v_status <> 'recorded' then
    raise exception 'active lease fixture did not finalize';
  end if;

  update public.users
     set email = 'allowed-after-finalize@fixture.invalid',
         unsubscribed_at = clock_timestamp()
   where id = '${FIXTURE_USER_ID}';
  if not exists (
    select 1
      from public.users
     where id = '${FIXTURE_USER_ID}'
       and email = 'allowed-after-finalize@fixture.invalid'
       and unsubscribed_at is not null
  ) then
    raise exception 'finalized lease did not release delivery-state mutation';
  end if;

  update public.users
     set email = 'recovery-drill@fixture.invalid',
         unsubscribed_at = null
   where id = '${FIXTURE_USER_ID}';
end
$guard$;

delete from public.issues where id = '${GUARD_ISSUE_ID}';
alter table public.users disable trigger user;

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
        select 1 from public.resend_delivery_attempts child
        left join public.issues parent
          on parent.id = child.issue_id and parent.user_id = child.user_id
        where parent.id is null
      )
      and not exists (
        select 1 from public.resend_webhook_events child
        left join public.users parent on parent.id = child.owner_user_id
        where child.owner_user_id is not null and parent.id is null
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

function parseOptionalBundlePath() {
  const args = process.argv.slice(2);
  const bundleIndex = args.indexOf("--bundle");
  if (bundleIndex === -1) {
    if (args.length !== 0) fail("unknown recovery drill argument");
    return null;
  }
  if (args.length !== 2 || !args[bundleIndex + 1]) {
    fail("--bundle requires one manifest-backed SQL path");
  }
  return path.resolve(args[bundleIndex + 1]);
}

async function drill() {
  const psqlBin = process.env.PSQL_BIN?.trim() || "psql";
  const frozenBundlePath = parseOptionalBundlePath();
  if (frozenBundlePath) verifyFrozenBundleArtifact(frozenBundlePath);
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
    if (frozenBundlePath) {
      psql(psqlBin, port, "postgres", {
        stage: "frozen bundle representative database could not be created",
        input: "create database alpha_r80_bundle;",
      });
    }
    bootstrapDatabase(psqlBin, port, "alpha_r80_source");
    bootstrapDatabase(psqlBin, port, "alpha_r80_destination");
    verifySuppressionRecoveryDrill(psqlBin, port, "alpha_r80_source");
    verifySuppressionRecoveryCatalog(psqlBin, port, "alpha_r80_source");
    await verifySuppressionRecoveryConcurrency(psqlBin, port, "alpha_r80_source");
    verifyResendPrivacyDrill(psqlBin, port, "alpha_r80_source");
    verifyInviteCheckoutReview(psqlBin, port, "alpha_r80_source");
    loadSyntheticFixture(psqlBin, port, "alpha_r80_source");
    if (frozenBundlePath) {
      bootstrapDatabase(
        psqlBin,
        port,
        "alpha_r80_bundle",
        "20260827000000"
      );
      psql(psqlBin, port, "alpha_r80_bundle", {
        stage: "representative migration ledger setup failed",
        input: `
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (
  version text primary key
);
`,
      });
      applyFrozenBundle(
        psqlBin,
        port,
        "alpha_r80_bundle",
        frozenBundlePath
      );
      verifySuppressionRecoveryDrill(psqlBin, port, "alpha_r80_bundle");
      verifySuppressionRecoveryCatalog(psqlBin, port, "alpha_r80_bundle");
      await verifySuppressionRecoveryConcurrency(psqlBin, port, "alpha_r80_bundle");
      verifyResendPrivacyDrill(psqlBin, port, "alpha_r80_bundle");
      verifyInviteCheckoutReview(psqlBin, port, "alpha_r80_bundle");
    }

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
  return frozenBundlePath;
}

try {
  const frozenBundlePath = await drill();
  const bundleSummary = frozenBundlePath
    ? "Representative frozen-bundle ledger verified when --bundle was supplied. Production migration ledger remains unknown."
    : "Repository-source migration recovery path verified. No production migration ledger claim was made.";
  console.log(
    `DRILL PASS: ${CRITICAL_TABLES.length} tables restored with manifest counts/hashes, exact auth anchors, foreign keys, and serial sequences verified. Invite checkout review runtime and catalog guards passed. Resend deletion/privacy SQL drill passed with 29 assertions. Suppression recovery SQL drill passed with 23 assertions, exact canonical catalog guards passed, and six two-session fence races. ${bundleSummary}`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "local recovery drill failed";
  console.error(`DRILL FAIL: ${message}`);
  process.exitCode = 1;
}
