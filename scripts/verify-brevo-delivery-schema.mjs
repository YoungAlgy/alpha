#!/usr/bin/env node
// Read-only source gate for the candidate migration. Database behavior is
// checked separately in the isolated PostgreSQL fixture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/20260927000000_brevo_delivery_foundation.sql");

function sourceBody(file, name) {
  const source = read(`supabase/migrations/${file}`);
  const match = source.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\bas \\$\\$([\\s\\S]*?)\\$\\$;`,
    "i"
  ));
  assert.ok(match, `missing frozen ${name} definition`);
  return match[1].replaceAll("\r\n", "\n");
}

for (const [file, name, expected] of [
  ["20260924000000_delivery_enrollment.sql", "claim_resend_delivery_attempt", ["a76d4d87de294392d6fd561b9b425140", "c6a37e212ce0b5c8a9dc7e1b0ab7c26b"]],
  ["20260905000000_resend_delivery_clock_fence.sql", "finalize_resend_delivery_attempt", ["8f5d0927021c0549d56a6b4fa2cab753"]],
  ["20260924000000_delivery_enrollment.sql", "watchdog_delivery_check", ["c4140fc12e1be0a950d9b3f08e4b9380", "956f463881fd5b192be8e0f71491d356"]],
]) {
  const body = sourceBody(file, name);
  assert.equal(createHash("md5").update(body).digest("hex"), expected[0],
    `${name} source changed`);
  if (expected.length === 2) {
    assert.equal(createHash("md5").update(body.replaceAll("\n", "\r\n")).digest("hex"), expected[1],
      `${name} verified CRLF fingerprint changed`);
  }
  for (const hash of expected) {
    assert.ok(migration.includes(`'${hash}'`), `${name} SQL preflight hash missing: ${hash}`);
  }
}

assert.match(migration, /pg_get_indexdef\(i\.indexrelid\)\s*=\s*'CREATE UNIQUE INDEX resend_delivery_attempts_issue_lane_uidx ON public\.resend_delivery_attempts USING btree \(issue_id, delivery_lane\)'/);
assert.match(migration, /i\.indisunique and i\.indisvalid and i\.indisready and i\.indislive/);
assert.match(migration, /i\.indpred is null and i\.indexprs is null/);
assert.match(migration, /c\.contype = 'c' and c\.convalidated/);
assert.match(migration, /has_function_privilege\('anon', installed\.oid, 'EXECUTE'\) is distinct from expected\.allow_anon/);
assert.match(migration, /has_function_privilege\('authenticated', installed\.oid, 'EXECUTE'\)/);
assert.match(migration, /acl\.is_grantable and acl\.grantee <> installed\.proowner/);
assert.match(migration, /provider text not null default 'resend'/);
assert.match(migration, /provider = 'resend' and retry_deadline_at is not null/);
assert.match(migration, /provider = 'brevo' and resend_message_id is null/);
assert.match(migration, /provider = 'resend' and brevo_message_id is null/);
assert.match(migration, /new\.lease_token is not null and \([\s\S]*?new\.lease_expires_at is distinct from old\.lease_expires_at/);
assert.match(migration, /if v_inserted = 0 then[\s\S]*?return query select 'manual_review'/);
assert.doesNotMatch(migration, /retry_deadline_at\s*=\s*v_now\s*\+\s*interval '23 hours'/i);
assert.match(migration, /v_now >= v_attempt\.started_at \+ interval '23 hours'/);
assert.match(migration, /brevo_unsubscribed_at = coalesce\(brevo_unsubscribed_at, p_event_at\)/);
assert.match(migration, /request\.jwt\.claims'[\s\S]*?is distinct from 'service_role' then/);
assert.match(migration, /create function public\.guard_brevo_unsubscribe_delivery_lease\(/);
assert.match(migration, /create function public\.resolve_subscriber_delivery_provider\(/);
assert.match(migration, /new\.lease_expires_at is distinct from old\.lease_expires_at/);
assert.match(migration, /p_event_type <> 'unsubscribed'\s+and v_user\.delivery_suppression_cleared_at/);
assert.match(migration, /recipient_conflict boolean not null default false/);
assert.match(migration, /i\.resend_message_id is not null\s+or i\.brevo_message_id is not null/);
assert.match(migration, /create function public\.prior_provider_issue_counts\([\s\S]*?returns table\(user_id uuid, prior_count bigint\)/);
assert.match(migration, /i\.week_of < week_of_cutoff[\s\S]*?i\.delivered_at is not null[\s\S]*?i\.resend_message_id is not null\s+or i\.brevo_message_id is not null\s+or i\.delivered_at < '2026-08-05T19:10:00Z'::timestamptz/);
assert.match(migration, /revoke all on function public\.prior_provider_issue_counts\(date, uuid\[\]\)\s+from public, anon, authenticated/);
assert.match(migration, /grant execute on function public\.prior_provider_issue_counts\(date, uuid\[\]\)\s+to service_role/);
assert.match(migration, /revoke all on table public\.brevo_suppression_events\s+from public, anon, authenticated, service_role/);
assert.match(migration, /commit;\s*$/);

console.log("PASS Brevo schema source gate: frozen prerequisites, ownership, proof, review, suppression, ACL");
