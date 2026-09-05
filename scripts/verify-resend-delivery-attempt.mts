import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ResendDeliveryAttemptError,
  sendWithResendDeliveryAttempt,
} from "../lib/resend-delivery-attempt";
import { prepareLetterNotification } from "../lib/email";
import type { Issue } from "../lib/types";

let assertions = 0;
function check(value: unknown, label: string): void {
  assertions += 1;
  assert.ok(value, label);
}

type RpcResult = { data: unknown; error: { message: string } | null };
function fakeClient(results: RpcResult[]) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        const next = results.shift();
        if (!next) throw new Error("unexpected RPC call");
        return next;
      },
    },
  };
}

const base = {
  userId: "11111111-1111-4111-8111-111111111111",
  weekOf: "2026-08-31",
  recipient: "reader@example.com",
  deliveryLane: "live",
  payloadFingerprint: "a".repeat(64),
  expectedClaimedAt: "2026-08-31T17:00:00.000Z",
};
const liveLease = () => new Date(Date.now() + 5 * 60_000).toISOString();
const liveRetryDeadline = () => new Date(Date.now() + 5 * 60_000).toISOString();

{
  // Known local-only value. The verifier never loads an environment file or
  // reads an existing credential, but the pure renderer still signs its URL.
  process.env.UNSUBSCRIBE_SECRET =
    "offline-resend-delivery-attempt-verifier-secret-2026";
  const canonical: Issue = {
    id: "22222222-2222-4222-8222-222222222222",
    volume: 1,
    number: 9,
    weekOf: "2026-08-31",
    recipientFirstName: "Reader",
    recipientCity: "Tampa, FL",
    editorIntro: "A grounded note.",
    sections: [
      {
        topicId: "ai-news",
        topicLabel: "AI news",
        intro: "Today",
        items: [
          {
            kind: "read",
            headline: "A sourced headline",
            body: "A sourced summary.",
            primaryRef: { label: "Source", url: "https://example.com/source" },
          },
        ],
      },
    ],
  };
  const rebuilt: Issue = {
    ...canonical,
    id: "reader-2026-08-31",
    weekOf: "Monday, August 31, 2026",
  };
  const params = {
    to: base.recipient,
    firstName: "Reader",
    inboxUrl: "https://alpha.everyday.report/inbox",
    letterUrl: "https://alpha.everyday.report/letter?token=stable",
    issueNumber: 9,
    userId: base.userId,
    idempotencyKind: "live",
    deliveryDate: base.weekOf,
  };
  const fromGenerate = prepareLetterNotification({ ...params, issue: canonical });
  const fromCron = prepareLetterNotification({ ...params, issue: rebuilt });
  assert.deepEqual(fromCron.payload, fromGenerate.payload);
  assertions += 1;
  assert.equal(fromCron.idempotencyKey, fromGenerate.idempotencyKey);
  assertions += 1;
  assert.equal(fromCron.requestFingerprint, fromGenerate.requestFingerprint);
  assertions += 1;
  assert.equal(
    fromCron.payload.headers["X-Alpha-Issue-Id"],
    `${base.userId}:${base.weekOf}`
  );
  assertions += 1;
  const changed = prepareLetterNotification({
    ...params,
    issue: { ...canonical, editorIntro: "A changed payload." },
  });
  assert.notEqual(changed.requestFingerprint, fromGenerate.requestFingerprint);
  assertions += 1;
}

{
  const fake = fakeClient([]);
  await assert.rejects(
    sendWithResendDeliveryAttempt({
      ...base,
      sb: fake.client as never,
      recipient: "Reader@example.com",
      send: async () => ({ id: "unused" }),
    }),
    (error: unknown) =>
      error instanceof ResendDeliveryAttemptError &&
      error.stage === "claim" &&
      error.code === "recipient_not_canonical"
  );
  assertions += 1;
  assert.equal(fake.calls.length, 0);
  assertions += 1;
}

{
  const fake = fakeClient([
    {
      data: [
        {
          delivery_status: "finalized",
          stored_recipient: base.recipient,
          stored_message_id: "email-finalized",
          stored_accepted_at: "2026-08-31T17:01:00.000Z",
          stored_lease_expires_at: null,
        },
      ],
      error: null,
    },
  ]);
  let sendCalls = 0;
  const result = await sendWithResendDeliveryAttempt({
    ...base,
    sb: fake.client as never,
    send: async () => {
      sendCalls += 1;
      return { id: "should-not-send" };
    },
  });
  assert.deepEqual(result, {
    providerSent: false,
    messageId: "email-finalized",
    acceptedAt: "2026-08-31T17:01:00.000Z",
    suppressionReviewRequired: false,
  });
  assertions += 1;
  assert.equal(sendCalls, 0);
  assertions += 1;
  assert.equal(fake.calls.length, 1);
  assertions += 1;
}

{
  const fake = fakeClient([
    {
      data: [
        {
          delivery_status: "recipient_changed",
          stored_recipient: "old@example.com",
          stored_message_id: null,
          stored_accepted_at: null,
          stored_lease_expires_at: liveLease(),
          stored_retry_deadline_at: liveRetryDeadline(),
        },
      ],
      error: null,
    },
  ]);
  let sendCalls = 0;
  await assert.rejects(
    sendWithResendDeliveryAttempt({
      ...base,
      sb: fake.client as never,
      send: async () => {
        sendCalls += 1;
        return { id: "unused" };
      },
    }),
    (error: unknown) =>
      error instanceof ResendDeliveryAttemptError &&
      error.code === "recipient_changed"
  );
  assertions += 1;
  assert.equal(sendCalls, 0);
  assertions += 1;
}

{
  const fake = fakeClient([
    {
      data: [
        {
          delivery_status: "claimed",
          stored_recipient: base.recipient,
          stored_message_id: null,
          stored_accepted_at: null,
          stored_lease_expires_at: liveLease(),
          stored_retry_deadline_at: liveRetryDeadline(),
        },
      ],
      error: null,
    },
    {
      data: [
        {
          delivery_status: "recorded",
          stored_accepted_at: "2026-08-31T17:01:00.000Z",
          suppression_review_required: false,
        },
      ],
      error: null,
    },
  ]);
  let sentTo = "";
  const result = await sendWithResendDeliveryAttempt({
    ...base,
    sb: fake.client as never,
    send: async (recipient) => {
      sentTo = recipient;
      return { id: "email-new" };
    },
  });
  check(result.providerSent, "claimed attempt must call the provider");
  assert.equal(result.messageId, "email-new");
  assertions += 1;
  assert.equal(sentTo, base.recipient);
  assertions += 1;
  assert.equal(fake.calls.length, 2);
  assertions += 1;
  assert.equal(fake.calls[0].name, "claim_resend_delivery_attempt");
  assertions += 1;
  assert.equal(fake.calls[1].name, "finalize_resend_delivery_attempt");
  assertions += 1;
  assert.equal(fake.calls[0].args.p_delivery_lane, "live");
  assertions += 1;
  assert.equal(fake.calls[1].args.p_delivery_lane, "live");
  assertions += 1;
  assert.equal(
    fake.calls[1].args.p_lease_token,
    fake.calls[0].args.p_lease_token
  );
  assertions += 1;
  assert.equal(fake.calls[1].args.p_message_id, "email-new");
  assertions += 1;
  assert.equal(
    fake.calls[0].args.p_request_fingerprint,
    base.payloadFingerprint
  );
  assertions += 1;
  assert.equal(
    fake.calls[1].args.p_request_fingerprint,
    base.payloadFingerprint
  );
  assertions += 1;
}

for (const [label, retryDeadline] of [
  ["missing", undefined],
  ["malformed", "not-a-timestamp"],
  ["expired", new Date(Date.now() - 1).toISOString()],
  ["just-short", new Date(Date.now() + 4 * 60_000 - 1).toISOString()],
] as const) {
  const claim: Record<string, unknown> = {
    delivery_status: "claimed",
    stored_recipient: base.recipient,
    stored_message_id: null,
    stored_accepted_at: null,
    stored_lease_expires_at: liveLease(),
  };
  if (label !== "missing") claim.stored_retry_deadline_at = retryDeadline;
  const fake = fakeClient([
    {
      data: [claim],
      error: null,
    },
  ]);
  let sendCalls = 0;
  await assert.rejects(
    sendWithResendDeliveryAttempt({
      ...base,
      sb: fake.client as never,
      send: async () => {
        sendCalls += 1;
        return { id: "must-not-send" };
      },
    }),
    (error: unknown) =>
      error instanceof ResendDeliveryAttemptError &&
      error.stage === "claim" &&
      error.code === "retry_window_too_short"
  );
  assertions += 1;
  assert.equal(sendCalls, 0, `${label} retry deadline must block provider send`);
  assertions += 1;
  assert.equal(fake.calls.length, 1, `${label} retry deadline must block finalization`);
  assertions += 1;
}

{
  const fake = fakeClient([
    {
      data: [
        {
          delivery_status: "replayed",
          stored_recipient: base.recipient,
          stored_message_id: null,
          stored_accepted_at: null,
          stored_lease_expires_at: liveLease(),
          stored_retry_deadline_at: liveRetryDeadline(),
        },
      ],
      error: null,
    },
    {
      data: [
        {
          delivery_status: "lease_lost",
          stored_accepted_at: null,
          suppression_review_required: true,
        },
      ],
      error: null,
    },
  ]);
  await assert.rejects(
    sendWithResendDeliveryAttempt({
      ...base,
      sb: fake.client as never,
      send: async () => ({ id: "email-ambiguous" }),
    }),
    (error: unknown) =>
      error instanceof ResendDeliveryAttemptError &&
      error.stage === "finalize" &&
      error.code === "lease_lost"
  );
  assertions += 1;
}

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260830050000_resend_suppression_causality.sql",
    import.meta.url
  ),
  "utf8"
);
const weekly = readFileSync(
  new URL("../app/api/cron/weekly-send/route.ts", import.meta.url),
  "utf8"
);
const generate = readFileSync(
  new URL("../app/api/generate/route.ts", import.meta.url),
  "utf8"
);
const exportRoute = readFileSync(
  new URL("../app/api/account/export/route.ts", import.meta.url),
  "utf8"
);
const backupFormat = readFileSync(
  new URL("./critical-table-backup-format.mjs", import.meta.url),
  "utf8"
);

for (const marker of [
  "create table public.resend_delivery_attempts",
  "unique (resend_message_id)",
  "resend_delivery_attempts_issue_lane_uidx",
  "claim_resend_delivery_attempt(",
  "finalize_resend_delivery_attempt(",
  "v_lease_expires_at := v_now + interval '5 minutes'",
  "request_fingerprint ~ '^[0-9a-f]{64}$'",
  "retry_deadline_at = started_at + interval '23 hours'",
  "v_now >= v_attempt.retry_deadline_at",
  "'ambiguous_expired'::text",
  "v_attempt.request_fingerprint <> p_request_fingerprint",
  "v_attempt.recipient <> p_recipient",
  "'other_lane_pending'::text",
  "v_attempt.resend_message_id is not null",
  "account_deletion_active_delivery_guard",
  "a.lease_expires_at > clock_timestamp()",
  "users_active_delivery_state_guard",
  "block_user_delivery_change_with_active_attempt()",
] as const) {
  check(migration.includes(marker), `migration omits staged-attempt marker: ${marker}`);
}
check(
  /left join auth\.users auth_user on auth_user\.id = user_row\.id[\s\S]*?user_row\.created_at is null[\s\S]*?auth_user\.created_at is null[\s\S]*?raise exception 'Cannot recover public\.users\.created_at from auth\.users\.created_at'/.test(
    migration
  ),
  "nullable public user creation clocks must fail unless the exact Auth clock can recover them"
);
check(
  /v_prior_claims text := current_setting\('request\.jwt\.claims', true\)[\s\S]*?set_config\('request\.jwt\.claims', '\{"role":"service_role"\}', true\)[\s\S]*?update public\.users user_row[\s\S]*?set created_at = auth_user\.created_at[\s\S]*?user_row\.created_at is null;[\s\S]*?coalesce\(nullif\(v_prior_claims, ''\), '\{\}'\)[\s\S]*?alter column created_at set not null/.test(
    migration
  ) &&
    !/set created_at\s*=\s*(?:now|clock_timestamp|current_timestamp)/i.test(
      migration
    ),
  "creation-clock repair must copy Auth exactly under restored transaction-local service claims and enforce NOT NULL without a synthetic clock"
);
check(
  /create or replace function public\.handle_new_user\(\)[\s\S]*?if new\.created_at is null then[\s\S]*?insert into public\.users \(id, email, created_at\)[\s\S]*?values \(new\.id, new\.email, new\.created_at\)/.test(
    migration
  ),
  "future public users must inherit the exact nonnull Auth identity clock"
);
check(
  migration.includes("perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080))") &&
    migration.includes("from public.account_deletion_sagas s") &&
    migration.includes("lower(btrim(v_user.email)) <> p_recipient") &&
    migration.includes("v_user.suppression_cleanup_pending_at is not null"),
  "claim must serialize with deletion and re-prove current recipient eligibility"
);
check(
  /where a\.issue_id = v_issue_id[\s\S]*?a\.delivery_lane <> p_delivery_lane[\s\S]*?a\.resend_message_id is null/.test(
    migration
  ),
  "a new force lane must not bypass another unresolved delivery lane"
);
check(
  /before update of[\s\S]*?email,[\s\S]*?unsubscribed_at,[\s\S]*?bounced_at,[\s\S]*?suppression_cleanup_pending_at,[\s\S]*?on public\.users[\s\S]*?block_user_delivery_change_with_active_attempt/.test(
    migration
  ),
  "delivery-critical user changes must stop while the provider lease is active"
);
check(
  migration.includes("set resend_message_id = v_attempt.resend_message_id") &&
    migration.includes("delivered_at = v_attempt.accepted_at"),
  "finalized attempt replay must repair the issue proof pair"
);
check(
  weekly.includes("sendWithResendDeliveryAttempt({") &&
    weekly.includes("deliveryLane: deliveryIdempotencyKind") &&
    weekly.includes("payloadFingerprint: preparedEmail.requestFingerprint") &&
    weekly.includes("deliveryDate: weekOf") &&
    weekly.includes("expectedClaimedAt: force ? null : claimedAt"),
  "scheduled and forced sends must use the exact provider lane"
);
check(
  generate.includes("sendWithResendDeliveryAttempt({") &&
    generate.includes('deliveryLane: "live"') &&
    generate.includes("payloadFingerprint: preparedEmail.requestFingerprint") &&
    generate.includes("deliveryDate: weekOf") &&
    generate.includes("expectedClaimedAt: deliveryClaimedAt"),
  "onboarding and scheduled first-letter delivery must share the live lane"
);
check(
  exportRoute.includes('.from("resend_delivery_attempts")') &&
    exportRoute.includes("resend_delivery_attempts: deliveryAttempts") &&
    exportRoute.includes('.from("resend_webhook_events")') &&
    exportRoute.includes("resend_suppression_events: suppressionEvents"),
  "privacy export must include staged delivery identity"
);
check(
  backupFormat.includes("BACKUP_FORMAT_VERSION = 4") &&
    backupFormat.includes('name: "resend_delivery_attempts"'),
  "critical backup format must retain staged delivery identity"
);

{
  const fake = fakeClient([
    { data: [{ delivery_status: "claimed", stored_recipient: base.recipient,
      stored_message_id: null, stored_accepted_at: null,
      stored_lease_expires_at: liveLease(),
      stored_retry_deadline_at: liveRetryDeadline() }], error: null },
    { data: [{ delivery_status: "ambiguous_expired", stored_accepted_at: null,
      suppression_review_required: true }], error: null },
  ]);
  await assert.rejects(
    sendWithResendDeliveryAttempt({
      ...base, sb: fake.client as never,
      send: async () => ({ id: "late-provider-proof" }),
    }),
    (error: unknown) => error instanceof ResendDeliveryAttemptError &&
      error.stage === "finalize" && error.code === "ambiguous_expired"
  );
  assertions += 1;
  check(fake.calls.length === 2, "expired finalization is never retried or reported successful");
}

console.log(
  `PASS verify-resend-delivery-attempt (offline, ${assertions} assertions)`
);
