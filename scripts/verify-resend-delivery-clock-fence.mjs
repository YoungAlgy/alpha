import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const normalized = (value) => value.replace(/\r\n/g, "\n");
const frozen = normalized(read("../supabase/migrations/20260830050000_resend_suppression_causality.sql"));
const candidate = normalized(read("../supabase/migrations/20260905000000_resend_delivery_clock_fence.sql"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(sha256(frozen), "52a6cf03d032508c9fd4bd2fd46cdfa52b6cad2f5f3bcecd5cad8d37dd816766", "frozen migration changed");

function functionWithAcl(text, name, signature) {
  const start = text.indexOf(`create or replace function public.${name}(`);
  const grant = `grant execute on function public.${signature}\n  to service_role;`;
  const grantAt = text.indexOf(grant, start);
  assert.ok(start >= 0 && grantAt >= start, `missing ${name}`);
  const end = grantAt + grant.length;
  return text.slice(start, end);
}

const claimSignature = "claim_resend_delivery_attempt(uuid, date, text, text, text, uuid, timestamptz)";
const finalizeSignature = "finalize_resend_delivery_attempt(uuid, date, text, uuid, text, text)";
const claim = functionWithAcl(candidate, "claim_resend_delivery_attempt", claimSignature);
const finalize = functionWithAcl(candidate, "finalize_resend_delivery_attempt", finalizeSignature);
assert.equal((candidate.match(/create or replace function public\./g) ?? []).length, 2, "candidate changed an unexpected function");
for (const signature of [claimSignature, finalizeSignature]) {
  assert.match(candidate, new RegExp(`revoke all on function public\\.${signature.replace(/[()]/g, "\\$&")}\\n  from public, anon, authenticated;`));
  assert.match(candidate, new RegExp(`grant execute on function public\\.${signature.replace(/[()]/g, "\\$&")}\\n  to service_role;`));
}
let expectedClaim = functionWithAcl(frozen, "claim_resend_delivery_attempt", claimSignature);
expectedClaim = expectedClaim.replace("v_now timestamptz := clock_timestamp();", "v_now timestamptz;");
const oldEligibility = expectedClaim.match(/  if lower\(btrim\(v_user\.email\)\) <> p_recipient[\s\S]*?    return;\r?\n  end if;\r?\n/);
assert.ok(oldEligibility, "frozen claim eligibility block changed");
expectedClaim = expectedClaim.replace(oldEligibility[0], "");
expectedClaim = expectedClaim.replace("\n\n  v_lease_expires_at := v_now + interval '5 minutes';", `\n\n  v_now := clock_timestamp();\n${oldEligibility[0]}\n  v_lease_expires_at := v_now + interval '5 minutes';`);
expectedClaim = expectedClaim.replace("  if not found or v_attempt.user_id <> p_user_id then\n    raise exception 'Resend delivery attempt ownership conflict';\n  end if;\n", "  if not found or v_attempt.user_id <> p_user_id then\n    raise exception 'Resend delivery attempt ownership conflict';\n  end if;\n\n  v_now := clock_timestamp();\n  v_lease_expires_at := v_now + interval '5 minutes';\n\n  -- An existing attempt can make this row lock wait while its paid period\n  -- ends. Do not renew or return that attempt as claimable after the cutoff.\n  -- New rows did not wait on an existing attempt, so this narrow fence cannot\n  -- leave behind a newly-created ineligible attempt.\n  if v_inserted = 0\n     and v_user.access_granted_at is null\n     and v_user.cancelled_at is not null\n     and v_user.cancelled_at <= v_now then\n    return query select 'ineligible'::text, null::text, null::text,\n      null::timestamptz, null::timestamptz, null::timestamptz;\n    return;\n  end if;\n");
let expectedFinalize = functionWithAcl(frozen, "finalize_resend_delivery_attempt", finalizeSignature);
expectedFinalize = expectedFinalize.replace("v_now timestamptz := clock_timestamp();", "v_now timestamptz;");
expectedFinalize = expectedFinalize.replace("  if v_attempt.request_fingerprint <> p_request_fingerprint then\n    return query select 'payload_changed'::text, null::timestamptz, true;\n    return;\n  end if;\n", "  if v_attempt.request_fingerprint <> p_request_fingerprint then\n    return query select 'payload_changed'::text, null::timestamptz, true;\n    return;\n  end if;\n\n  v_now := clock_timestamp();\n");
const header = "-- Follow-up only. The frozen Round 80 migration remains byte-for-byte unchanged.\n-- Refresh clocks only after lock points that can wait. Contracts and ACLs are retained.\n\n";
assert.equal(candidate, `${header}${expectedClaim}\n\n${expectedFinalize}\n`, "candidate contains unrelated SQL or body drift");
assert.match(claim, /v_now timestamptz;/);
assert.doesNotMatch(claim, /v_now timestamptz :=/);
const userLock = claim.indexOf("from public.users");
const issueLock = claim.indexOf("for update;", claim.indexOf("from public.issues"));
const eligibility = claim.indexOf("if lower(btrim(v_user.email)) <> p_recipient");
const eligibilityClock = claim.indexOf("v_now := clock_timestamp();", issueLock);
const attemptLock = claim.indexOf("where issue_id = v_issue_id\n     and delivery_lane = p_delivery_lane\n   for update;");
const attemptClock = claim.indexOf("v_now := clock_timestamp();", attemptLock);
assert.ok(userLock >= 0 && issueLock > userLock, "claim issue lock is not after the user lock");
assert.ok(eligibilityClock > issueLock && eligibility > eligibilityClock, "claim eligibility is stale");
assert.ok(attemptClock > attemptLock, "claim retry/lease clock is stale");
assert.ok(claim.indexOf("v_lease_expires_at := v_now + interval '5 minutes';", attemptClock) > attemptClock, "claim return lease is stale");
assert.ok(claim.indexOf("if v_inserted = 0", attemptClock) > attemptClock, "existing-attempt paid cutoff is stale");
assert.match(finalize, /v_now timestamptz;/);
assert.doesNotMatch(finalize, /v_now timestamptz :=/);
const finalAttemptLock = finalize.indexOf("where issue_id = v_issue_id\n     and delivery_lane = p_delivery_lane\n   for update;");
const finalClock = finalize.indexOf("v_now := clock_timestamp();", finalAttemptLock);
assert.ok(finalClock > finalAttemptLock, "finalize clock is stale");
assert.ok(finalize.indexOf("if v_now >= v_attempt.retry_deadline_at", finalClock) > finalClock, "finalize deadline is stale");
assert.ok(finalize.indexOf("accepted_at = v_now", finalClock) > finalClock, "finalize acceptance is stale");
console.log("resend delivery clock fence source checks passed");
