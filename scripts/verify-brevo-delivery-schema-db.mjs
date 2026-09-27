#!/usr/bin/env node
// Disposable, offline PostgreSQL 17 fixture. Run only after reviewing this file.
// No app environment, hosted database, provider, or subscriber data is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = "/home/algy/alpha-pg17-test-20260909/pgsql-17.11/bin";
const repo = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = path.join(repo, "supabase", "migrations");
const names = readdirSync(migrationsDir)
  .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
assert.equal(names.length, 43, "expected the exact 43-file chain");
assert.equal(names.at(-1), "20260927000000_brevo_delivery_foundation.sql");
assert.equal(process.platform, "linux", "run only in the isolated Linux runtime");
assert.notEqual(process.getuid?.(), 0, "PostgreSQL must not run as root");

const base = mkdtempSync(path.join(os.tmpdir(), "alpha-brevo-db-"));
assert.match(base, /^\/tmp\/alpha-brevo-db-[A-Za-z0-9]+$/);
const data = path.join(base, "data");
const log = path.join(base, "postgres.log");
const env = {
  PATH: "/usr/bin:/bin", LC_ALL: "C", PGHOST: base, PGPORT: "5432",
  PGUSER: "postgres", PGDATABASE: "postgres",
};
let initialized = false;
let started = false;
let passed = false;
let checks = 0;

function run(binary, args, { input, allowFailure = false } = {}) {
  const result = spawnSync(path.join(BIN, binary), args, {
    env, input, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${binary} failed (${result.status}): ${(result.stderr || result.stdout || "").slice(-3000)}`);
  }
  return result;
}
function sql(source, { allowFailure = false } = {}) {
  return run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-c", source], { allowFailure });
}
function expect(source, expected) {
  assert.equal(sql(source).stdout.trim(), expected);
  checks++;
}
function denied(source, message) {
  const result = sql(source, { allowFailure: true });
  assert.notEqual(result.status, 0, "protected SQL unexpectedly succeeded");
  assert.match(result.stderr, message);
  checks++;
}
function service(source) {
  return `set request.jwt.claims = '{"role":"service_role"}';\n${source}`;
}
function migration(name) {
  return readFileSync(path.join(migrationsDir, name), "utf8").replace(/\r\n/g, "\n");
}
const finalMigration = names.at(-1);
const guardedBody = migration(finalMigration)
  .replace(/^([\s\S]*?)\bbegin;\s*/i, "")
  .replace(/\bcommit;\s*$/i, "");
const claimSignature = "public.claim_resend_delivery_attempt(uuid,date,text,text,text,uuid,timestamptz)";
const finalizerSignature = "public.finalize_resend_delivery_attempt(uuid,date,text,uuid,text,text)";
const watchdogSignature = "public.watchdog_delivery_check(timestamptz)";
const expectedHashes = {
  [claimSignature]: ["a76d4d87de294392d6fd561b9b425140", "c6a37e212ce0b5c8a9dc7e1b0ab7c26b"],
  [finalizerSignature]: ["8f5d0927021c0549d56a6b4fa2cab753"],
  [watchdogSignature]: ["c4140fc12e1be0a950d9b3f08e4b9380", "956f463881fd5b192be8e0f71491d356"],
};
function replaceFunctionBody(signature, expression) {
  return `do $fixture$ declare v_sql text; v_body text; begin
    select pg_get_functiondef(oid), prosrc into strict v_sql, v_body
      from pg_proc where oid='${signature}'::regprocedure;
    if position(v_body in v_sql)=0 then raise exception 'fixture body not found'; end if;
    execute replace(v_sql, v_body, ${expression});
  end $fixture$;`;
}
const crlfBody = (signature) => replaceFunctionBody(signature, "replace(v_body, E'\\n', E'\\r\\n')");
const absentSchema = `select
  (select count(*) from information_schema.columns where table_schema='public' and
    (table_name,column_name) in (('issues','brevo_message_id'),
      ('resend_delivery_attempts','brevo_message_id'),('resend_delivery_attempts','provider'),
      ('users','brevo_unsubscribed_at')))
  + (select count(*) from pg_class where oid=to_regclass('public.brevo_suppression_events'))
  + (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname=any(array[
      'apply_brevo_suppression_to_user','claim_brevo_delivery_attempt',
      'finalize_brevo_delivery_attempt','guard_brevo_attempt_ownership',
      'guard_brevo_unsubscribe_delivery_lease','guard_brevo_unsubscribe_hold',
      'mark_brevo_delivery_unconfirmed','prior_provider_issue_counts',
      'prune_unowned_brevo_suppression_events','record_brevo_suppression_event',
      'resolve_subscriber_delivery_provider']))`;
function assertNoBrevoSchema() { expect(absentSchema, "0"); }
function guardProbe(label, setup, error) {
  const result = sql(`begin;\n${setup}\n${guardedBody}\nselect 'guard_accepted';\nrollback;`,
    { allowFailure: true });
  if (error) {
    assert.notEqual(result.status, 0, `${label}: guard unexpectedly accepted drift`);
    assert.match(result.stderr, error, `${label}: wrong rejection`);
  } else {
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.match(result.stdout, /guard_accepted/, `${label}: did not finish`);
  }
  checks++;
  assertNoBrevoSchema();
}

const ids = {
  brevo: "11111111-1111-4111-8111-111111111111",
  resend: "22222222-2222-4222-8222-222222222222",
  pending: "33333333-3333-4333-8333-333333333333",
  late: "44444444-4444-4444-8444-444444444444",
  hold: "12121212-1212-4121-8121-121212121212",
  issueBrevo: "55555555-5555-4555-8555-555555555555",
  issueResend: "66666666-6666-4666-8666-666666666666",
  issuePending: "77777777-7777-4777-8777-777777777777",
  issueLate: "88888888-8888-4888-8888-888888888888",
  issueHold: "13131313-1313-4131-8131-131313131313",
  issueLegacy: "14141414-1414-4141-8141-141414141414",
  issueUnproven: "15151515-1515-4151-8151-151515151515",
  attemptBrevo: "99999999-9999-4999-8999-999999999999",
  attemptPending: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  attemptLate: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  leaseBrevo: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  leaseResend: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  leasePending: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  leaseLate: "ffffffff-ffff-4fff-8fff-ffffffffffff",
};
const fingerprint = "a".repeat(64);
const week = "current_date";
const address = (name) => `${name}@example.com`;
const claimBrevo = (user, attempt, lease, recipient, issue) => service(`
  select delivery_status from public.claim_brevo_delivery_attempt(
    '${user}', ${week}, '${recipient}', '${fingerprint}', '${attempt}', '${lease}',
    (select delivered_at from public.issues where id='${issue}')
  );`);
const claimResend = (user, lease, recipient, issue) => service(`
  select delivery_status from public.claim_resend_delivery_attempt(
    '${user}', ${week}, '${recipient}', 'live', '${fingerprint}', '${lease}',
    (select delivered_at from public.issues where id='${issue}')
  );`);
const finalizeBrevo = (user, attempt, lease, message) => service(`
  select delivery_status from public.finalize_brevo_delivery_attempt(
    '${user}', ${week}, '${attempt}', '${lease}', '${fingerprint}', '${message}'
  );`);
const event = (message, type, recipient, eventAt = "clock_timestamp()") => service(`
  select delivery_status || ':' || updated_count from public.record_brevo_suppression_event(
    '${message}', '${type}', ${eventAt}, '${recipient}'
  );`);
const resolved = (user, lane = "live") => service(`select public.resolve_subscriber_delivery_provider(
  '${user}', ${week}, '${lane}');`);

try {
  run("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"]);
  initialized = true;
  run("pg_ctl", ["-D", data, "-l", log, "-o",
    `-F -p 5432 -c listen_addresses='' -c unix_socket_directories='${base}'`, "-w", "start"]);
  started = true;
  expect("show listen_addresses", "");
  expect("show unix_socket_directories", base);
  expect("select current_setting('server_version_num')::int between 170011 and 170099", "t");

  sql(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create extension if not exists pg_trgm;
    create schema auth;
    create table auth.users (id uuid primary key, email text not null,
      created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
  `);
  for (const name of names.slice(0, -1)) {
    run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"], { input: migration(name) });
  }
  // Model the exact hosted ACL readback. The frozen watchdog migration grants
  // anon explicitly; production also has an explicit service_role grant.
  sql(`grant execute on function ${watchdogSignature} to service_role`);
  for (const [signature, hashes] of Object.entries(expectedHashes)) {
    expect(`select md5(prosrc) from pg_proc where oid='${signature}'::regprocedure`, hashes[0]);
  }
  expect(`select string_agg(grantee::regrole::text, ',' order by grantee::regrole::text)
    from aclexplode((select proacl from pg_proc where oid='${watchdogSignature}'::regprocedure))
    where privilege_type='EXECUTE'`, "anon,postgres,service_role");
  assertNoBrevoSchema();

  guardProbe("frozen LF prerequisite bodies", "", null);
  guardProbe("mixed line endings within claim body",
    replaceFunctionBody(claimSignature, "regexp_replace(v_body, E'\\n', E'\\r\\n')"),
    /Brevo prerequisite function changed/);
  guardProbe("changed finalizer body",
    replaceFunctionBody(finalizerSignature, "v_body || E'\\n-- fixture body drift'"),
    /Brevo prerequisite function changed/);
  guardProbe("changed watchdog SQL body",
    replaceFunctionBody(watchdogSignature, "v_body || E'\\n-- fixture SQL drift'"),
    /Brevo prerequisite function changed/);
  guardProbe("changed claim owner", `alter function ${claimSignature} owner to service_role;`,
    /Brevo prerequisite function changed/);
  guardProbe("changed claim search path", `alter function ${claimSignature} set search_path=public,pg_temp;`,
    /Brevo prerequisite function changed/);
  guardProbe("claim security invoker", `alter function ${claimSignature} security invoker;`,
    /Brevo prerequisite function changed/);
  guardProbe("public claim execute", `grant execute on function ${claimSignature} to public;`,
    /Brevo prerequisite function grants changed/);
  guardProbe("authenticated watchdog execute", `grant execute on function ${watchdogSignature} to authenticated;`,
    /Brevo prerequisite function grants changed/);
  guardProbe("missing watchdog anon execute", `revoke execute on function ${watchdogSignature} from anon;`,
    /Brevo prerequisite function grants changed/);
  guardProbe("missing watchdog service execute", `revoke execute on function ${watchdogSignature} from service_role;`,
    /Brevo prerequisite function grants changed/);
  guardProbe("service grant option", `grant execute on function ${claimSignature} to service_role with grant option;`,
    /Brevo prerequisite function grants changed/);
  guardProbe("wrong unique index column order", `drop index public.resend_delivery_attempts_issue_lane_uidx;
    create unique index resend_delivery_attempts_issue_lane_uidx
      on public.resend_delivery_attempts(delivery_lane,issue_id);`,
    /Brevo attempt ledger contract changed/);
  guardProbe("partial unique index", `drop index public.resend_delivery_attempts_issue_lane_uidx;
    create unique index resend_delivery_attempts_issue_lane_uidx
      on public.resend_delivery_attempts(issue_id,delivery_lane) where issue_id is not null;`,
    /Brevo attempt ledger contract changed/);
  guardProbe("weakened retry constraint", `alter table public.resend_delivery_attempts
    drop constraint resend_delivery_attempts_retry_window_check,
    add constraint resend_delivery_attempts_retry_window_check check (retry_deadline_at > started_at);`,
    /Brevo attempt ledger constraint changed/);
  guardProbe("unvalidated retry constraint", `alter table public.resend_delivery_attempts
    drop constraint resend_delivery_attempts_retry_window_check,
    add constraint resend_delivery_attempts_retry_window_check check (
      retry_deadline_at = started_at + interval '23 hours' and retry_deadline_at > started_at
    ) not valid;`,
    /Brevo attempt ledger constraint changed/);

  // Convert only the two live-observed bodies, then exercise the complete
  // candidate against their exact raw CRLF fingerprints.
  guardProbe("verified CRLF prerequisite bodies",
    `${crlfBody(claimSignature)}\n${crlfBody(watchdogSignature)}\n` +
    `do $fixture_hashes$ begin
      if (select md5(prosrc) from pg_proc where oid='${claimSignature}'::regprocedure)
           is distinct from '${expectedHashes[claimSignature][1]}'
         or (select md5(prosrc) from pg_proc where oid='${watchdogSignature}'::regprocedure)
           is distinct from '${expectedHashes[watchdogSignature][1]}' then
        raise exception 'fixture CRLF fingerprints changed';
      end if;
    end $fixture_hashes$;`, null);
  sql(`${crlfBody(claimSignature)}\n${crlfBody(watchdogSignature)}`);
  expect(`select md5(prosrc) from pg_proc where oid='${claimSignature}'::regprocedure`,
    expectedHashes[claimSignature][1]);
  expect(`select md5(prosrc) from pg_proc where oid='${watchdogSignature}'::regprocedure`,
    expectedHashes[watchdogSignature][1]);
  run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"],
    { input: migration(finalMigration) });

  // All identities and mailboxes below are disposable test fixtures.
  for (const [label, user, issue] of [
    ["brevo", ids.brevo, ids.issueBrevo], ["resend", ids.resend, ids.issueResend],
    ["pending", ids.pending, ids.issuePending], ["late", ids.late, ids.issueLate],
    ["hold", ids.hold, ids.issueHold],
  ]) {
    sql(service(`
      insert into auth.users(id,email,created_at)
        values ('${user}','${address(label)}',clock_timestamp()-interval '2 hours');
      update public.users set subscribed_at=clock_timestamp(), access_granted_at=clock_timestamp(),
        delivery_enrolled=true where id='${user}';
      insert into public.issues(id,user_id,week_of,editor_intro,sections,delivered_at)
        values ('${issue}','${user}',${week},'fixture','[]'::jsonb,clock_timestamp());
    `));
  }
  expect("select count(*) from public.resend_delivery_attempts", "0");
  expect(resolved(ids.brevo), "none");
  expect(claimBrevo(ids.brevo, ids.attemptBrevo, ids.leaseBrevo, address("brevo"), ids.issueBrevo), "claimed");
  expect(resolved(ids.brevo), "brevo");
  expect(claimBrevo(ids.brevo, ids.attemptBrevo, ids.leaseBrevo, address("brevo"), ids.issueBrevo), "manual_review");
  expect(claimBrevo(ids.brevo, ids.attemptPending, ids.leasePending, address("brevo"), ids.issueBrevo), "manual_review");
  expect(`select count(*) from public.resend_delivery_attempts where issue_id='${ids.issueBrevo}'`, "1");
  expect(`select provider || ':' || (retry_deadline_at is null)::text || ':' ||
    (manual_review_required_at is not null)::text from public.resend_delivery_attempts
    where attempt_id='${ids.attemptBrevo}'`, "brevo:true:true");

  // A previous Resend retry cannot convert or replay the Brevo reservation.
  expect(claimResend(ids.brevo, ids.leaseResend, address("brevo"), ids.issueBrevo), "busy");
  expect(claimBrevo(ids.brevo, ids.attemptBrevo, ids.leaseBrevo, address("brevo"), ids.issueBrevo), "manual_review");

  // The original Resend path still claims and finalizes an independent issue.
  expect(claimResend(ids.resend, ids.leaseResend, address("resend"), ids.issueResend), "claimed");
  expect(resolved(ids.resend), "resend");
  expect(service(`select delivery_status from public.finalize_resend_delivery_attempt(
    '${ids.resend}',${week},'live','${ids.leaseResend}','${fingerprint}','re_fixture_resend')`), "recorded");
  expect(`select provider || ':' || resend_message_id from public.resend_delivery_attempts
    where issue_id='${ids.issueResend}'`, "resend:re_fixture_resend");

  expect(service(`select delivery_status from public.mark_brevo_delivery_unconfirmed(
    '${ids.brevo}',${week},'${ids.attemptBrevo}','${ids.leaseBrevo}','${fingerprint}')`), "manual_review");
  expect(`select (lease_token='${ids.leaseBrevo}')::text from public.resend_delivery_attempts
    where attempt_id='${ids.attemptBrevo}'`, "true");
  expect(finalizeBrevo(ids.brevo, ids.attemptBrevo, ids.leaseBrevo, "brevo-fixture-1@example.com"), "recorded");
  expect(finalizeBrevo(ids.brevo, ids.attemptBrevo, ids.leaseBrevo, "brevo-fixture-1@example.com"), "replayed");
  expect(claimBrevo(ids.brevo, ids.attemptBrevo, ids.leaseBrevo, address("brevo"), ids.issueBrevo), "accepted");
  expect(`select (i.brevo_message_id=a.brevo_message_id and i.delivered_at=a.accepted_at)::text
    from public.issues i join public.resend_delivery_attempts a on a.issue_id=i.id
    where i.id='${ids.issueBrevo}'`, "true");
  expect("select active_subscriber_count || ':' || uncovered_count from public.watchdog_delivery_check(now()-interval '1 hour')", "5:3");

  // Provider-aware issue counts preserve old proof while excluding newer
  // delivered_at claims with no accepted provider ID.
  sql(service(`insert into public.issues(id,user_id,week_of,editor_intro,sections,delivered_at)
    values ('${ids.issueLegacy}','${ids.resend}','2026-08-01','fixture','[]'::jsonb,
      '2026-08-01T12:00:00Z'::timestamptz),
      ('${ids.issueUnproven}','${ids.late}',current_date-7,'fixture','[]'::jsonb,
      clock_timestamp());`));
  expect(service(`select string_agg(user_id::text || ':' || prior_count::text, ',' order by user_id)
    from public.prior_provider_issue_counts(current_date+1,
      array['${ids.brevo}'::uuid,'${ids.resend}'::uuid,'${ids.late}'::uuid])`),
    `${ids.brevo}:1,${ids.resend}:2`);
  expect(service(`select count(*) from public.prior_provider_issue_counts(current_date+1,
    array['${ids.late}'::uuid])`), "0");

  // Event before the API finalizer is retained, matched by ID and recipient,
  // then replayed exactly once. A wrong recipient remains for manual review.
  expect(event("brevo-early@example.com", "unsubscribed", address("pending")), "pending_owner:0");
  expect(event("brevo-early@example.com", "unsubscribed", address("pending"),
    `(select event_at from public.brevo_suppression_events where message_id='brevo-early@example.com')`), "pending_owner:0");
  expect(claimBrevo(ids.pending, ids.attemptPending, ids.leasePending, address("pending"), ids.issuePending), "claimed");
  expect(finalizeBrevo(ids.pending, ids.attemptPending, ids.leasePending, "brevo-early@example.com"), "recorded");
  expect(`select (brevo_unsubscribed_at is not null and unsubscribed_at is not null)::text
    from public.users where id='${ids.pending}'`, "true");
  expect(`select resolution_status || ':' || (owner_user_id='${ids.pending}')::text
    from public.brevo_suppression_events where message_id='brevo-early@example.com'`, "applied:true");
  expect(event("brevo-early@example.com", "unsubscribed", address("wrong"),
    `(select event_at from public.brevo_suppression_events where message_id='brevo-early@example.com')`), "manual_review:0");
  expect(`select (recipient_conflict and resolution_status='manual_review')::text
    from public.brevo_suppression_events where message_id='brevo-early@example.com'`, "true");
  expect(finalizeBrevo(ids.pending, ids.attemptPending, ids.leasePending, "brevo-early@example.com"), "replayed");
  expect(`select (recipient_conflict and resolution_status='manual_review')::text
    from public.brevo_suppression_events where message_id='brevo-early@example.com'`, "true");
  expect(event("brevo-early@example.com", "spam", address("pending"),
    `(select started_at-interval '11 minutes' from public.resend_delivery_attempts where attempt_id='${ids.attemptPending}')`), "manual_review:0");
  expect(`select count(*) from public.users where email='${address("wrong")}' and brevo_unsubscribed_at is not null`, "0");

  // A later generic suppression clearance must not erase a real late-arriving
  // provider opt-out. Bounce and spam still have their normal causal fence.
  sql(service(`update public.users set delivery_suppression_cleared_at=clock_timestamp()-interval '30 seconds'
    where id='${ids.brevo}'`));
  expect(event("brevo-fixture-1@example.com", "unsubscribed", address("brevo"),
    "clock_timestamp()-interval '1 minute'"), "applied:1");
  expect(`select (brevo_unsubscribed_at is not null and unsubscribed_at is not null)::text
    from public.users where id='${ids.brevo}'`, "true");
  denied(service(`update public.users set brevo_unsubscribed_at=null where id='${ids.brevo}'`),
    /Brevo unsubscribe marker requires reviewed recovery/);
  // The self-serve Resume route only clears unsubscribed_at. The provider
  // marker must remain after that exact database write.
  sql(service(`update public.users set unsubscribed_at=null where id='${ids.brevo}'`));
  expect(`select (unsubscribed_at is null and brevo_unsubscribed_at is not null)::text
    from public.users where id='${ids.brevo}'`, "true");
  // Resend cleanup is allowed to settle its own state without clearing Brevo.
  sql(service(`update public.users set suppression_cleanup_pending_at=clock_timestamp()
    where id='${ids.brevo}'`));
  expect(service(`select recovery_status from public.claim_resend_suppression_recovery('${ids.brevo}')`), "claimed");
  expect(service(`select public.finalize_resend_suppression_recovery(
    '${ids.brevo}',(select suppression_recovery_token from public.users where id='${ids.brevo}'))`), "cleared");
  expect(`select (brevo_unsubscribed_at is not null)::text from public.users where id='${ids.brevo}'`, "true");

  // A pending Resend attempt with an expired lease still cannot be renewed
  // after a Brevo opt-out, even if self-serve Resume cleared the shared field.
  sql(service(`with initial as (select clock_timestamp()-interval '1 hour' as started)
    insert into public.resend_delivery_attempts(
    user_id,issue_id,recipient,delivery_lane,request_fingerprint,
    started_at,retry_deadline_at,lease_token,lease_expires_at)
    select '${ids.hold}','${ids.issueHold}','${address("hold")}',
      'live','${fingerprint}',started,started+interval '23 hours',
      '${ids.leasePending}',started+interval '5 minutes' from initial;`));
  sql(`update public.users set brevo_unsubscribed_at=clock_timestamp()
    where id='${ids.hold}'`);
  expect(`select (brevo_unsubscribed_at is null)::text from public.users where id='${ids.hold}'`, "true");
  sql(service(`update public.users set brevo_unsubscribed_at=clock_timestamp()
    where id='${ids.hold}'`));
  denied(claimResend(ids.hold, ids.leaseResend, address("hold"), ids.issueHold),
    /Brevo unsubscribe blocks delivery lease/);
  expect(`select (brevo_unsubscribed_at is not null)::text from public.users where id='${ids.hold}'`, "true");

  // Privacy deletion may enter its saga after a Brevo unsubscribe. It keeps
  // the opt-out marker until the separate deletion privacy step removes user.
  sql(service(`select public.prepare_account_deletion('${ids.brevo}')`));
  expect(`select count(*) from public.account_deletion_sagas where user_id='${ids.brevo}'`, "1");
  expect(`select (brevo_unsubscribed_at is not null)::text from public.users where id='${ids.brevo}'`, "true");
  expect(finalizeBrevo(ids.brevo, ids.attemptBrevo, ids.leaseBrevo, "brevo-fixture-1@example.com"), "deletion_pending");

  // An old unknown API result cannot be attached after its 23-hour fence.
  sql(service(`insert into public.resend_delivery_attempts(
    attempt_id,user_id,issue_id,recipient,delivery_lane,provider,request_fingerprint,
    started_at,manual_review_required_at,lease_token,lease_expires_at)
    values ('${ids.attemptLate}','${ids.late}','${ids.issueLate}','${address("late")}',
      'live','brevo','${fingerprint}',clock_timestamp()-interval '24 hours',
      clock_timestamp()-interval '24 hours','${ids.leaseLate}',clock_timestamp()-interval '23 hours');`));
  expect(finalizeBrevo(ids.late, ids.attemptLate, ids.leaseLate, "brevo-old@example.com"), "ambiguous_expired");
  expect(claimBrevo(ids.late, ids.attemptLate, ids.leaseLate, address("late"), ids.issueLate), "manual_review");
  denied(claimResend(ids.late, ids.leaseResend, address("late"), ids.issueLate),
    /Brevo delivery ownership is immutable|delivery attempt provider cannot change/);
  expect(`select count(*) from public.resend_delivery_attempts where attempt_id='${ids.attemptLate}'
    and brevo_message_id is null`, "1");

  // Only service_role may invoke the Brevo writers. Audit rows have no reader policy.
  for (const role of ["anon", "authenticated"]) {
    for (const signature of [
      "claim_brevo_delivery_attempt(uuid,date,text,text,uuid,uuid,timestamptz)",
      "finalize_brevo_delivery_attempt(uuid,date,uuid,uuid,text,text)",
      "mark_brevo_delivery_unconfirmed(uuid,date,uuid,uuid,text)",
      "record_brevo_suppression_event(text,text,timestamptz,text)",
    ]) expect(`select has_function_privilege('${role}','public.${signature}','EXECUTE')`, "f");
    expect(`select has_table_privilege('${role}','public.brevo_suppression_events','SELECT')`, "f");
  }
  expect("select has_function_privilege('service_role','public.record_brevo_suppression_event(text,text,timestamptz,text)','EXECUTE')", "t");
  expect("select relrowsecurity::text from pg_class where oid='public.brevo_suppression_events'::regclass", "true");
  passed = true;
} finally {
  const running = started || (initialized && run("pg_ctl", ["-D", data, "status"], { allowFailure: true }).status === 0);
  if (running) {
    assert.equal(run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], { allowFailure: true }).status,
      0, "isolated PostgreSQL failed to stop");
  }
  if (initialized) {
    assert.equal(run("pg_ctl", ["-D", data, "status"], { allowFailure: true }).status,
      3, "isolated PostgreSQL status is not stopped");
    assert.equal(existsSync(path.join(data, "postmaster.pid")), false);
    assert.equal(existsSync(path.join(base, ".s.PGSQL.5432")), false);
  }
  console.log(`Fixture preserved at ${base}; PostgreSQL log at ${log}; passed=${passed}; checks=${checks}`);
}
