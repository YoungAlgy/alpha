import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { parseResendEventCreatedAt } from "../lib/resend-suppression-causality";

let assertions = 0;
function check(label: string, value: unknown): void {
  assertions += 1;
  assert.ok(value, label);
}

const now = Date.parse("2026-08-31T18:00:00.000Z");
assert.equal(
  parseResendEventCreatedAt("2026-08-31T12:34:56Z", now),
  "2026-08-31T12:34:56.000Z"
);
assertions += 1;
assert.equal(
  parseResendEventCreatedAt("2026-08-31T08:34:56.123456789-04:00", now),
  "2026-08-31T12:34:56.123Z"
);
assertions += 1;
assert.equal(
  parseResendEventCreatedAt("2024-02-29T00:00:00+00:00", now),
  "2024-02-29T00:00:00.000Z"
);
assertions += 1;

for (const invalid of [
  undefined,
  "",
  "2026-02-29T00:00:00Z",
  "2026-04-31T00:00:00Z",
  "2026-08-31T24:00:00Z",
  "2026-08-31T12:60:00Z",
  "2026-08-31T12:00:60Z",
  "2026-08-31T12:00:00+14:01",
  "1999-12-31T23:59:59Z",
  "2026-08-31",
]) {
  assert.equal(parseResendEventCreatedAt(invalid, now), null);
  assertions += 1;
}
assert.equal(
  parseResendEventCreatedAt("2026-08-31T18:09:59Z", now),
  "2026-08-31T18:09:59.000Z"
);
assertions += 1;
assert.equal(
  parseResendEventCreatedAt("2026-08-31T18:10:01Z", now),
  null
);
assertions += 1;

const route = readFileSync(
  new URL("../app/api/webhooks/resend/route.ts", import.meta.url),
  "utf8"
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260830050000_resend_suppression_causality.sql",
    import.meta.url
  ),
  "utf8"
);
const admin = readFileSync(
  new URL("../app/api/admin/users/route.ts", import.meta.url),
  "utf8"
);
const reconciler = readFileSync(
  new URL("../lib/suppression-reconciliation.ts", import.meta.url),
  "utf8"
);
const accounts = readFileSync(
  new URL("../app/settings/accounts/page.tsx", import.meta.url),
  "utf8"
);
const stripeWebhook = readFileSync(
  new URL("../app/api/stripe/webhook/route.ts", import.meta.url),
  "utf8"
);
const generate = readFileSync(
  new URL("../app/api/generate/route.ts", import.meta.url),
  "utf8"
);
const emailReconcile = readFileSync(
  new URL("../app/api/account/email/reconcile/route.ts", import.meta.url),
  "utf8"
);
const email = readFileSync(new URL("../lib/email.ts", import.meta.url), "utf8");
const recoveryHelper = readFileSync(
  new URL("../lib/suppression-recovery.ts", import.meta.url),
  "utf8"
);
const recoveryPolicy = readFileSync(
  new URL("../lib/suppression-recovery-policy.ts", import.meta.url),
  "utf8"
);

check(
  "webhook requires the signed event clock",
  route.includes("parseResendEventCreatedAt(event.created_at)") &&
    route.includes('error: "event timestamp invalid"')
);
check(
  "webhook never stamps suppression with handler receipt time",
  !route.includes(".update({ [column]: new Date().toISOString() })")
);
check(
  "soft bounces stop before the suppression RPC",
  route.indexOf("!isHardBounce") <
    route.indexOf('"record_resend_suppression_event"')
);
check(
  "webhook delegates audit and suppression to one RPC",
  route.includes('"record_resend_suppression_event"') &&
    !route.includes('.from("resend_webhook_events")')
);
check(
  "webhook validates the RPC result and returns a retriable failure",
  route.includes('"legacy_review"') &&
    route.includes('"pending_owner"') &&
    route.includes('"manual_review"') &&
    route.includes('{ status: 500 }')
);
check(
  "ambiguous events use the independent ops channel without retry loops",
  route.includes("reviewRequired: true") &&
    route.includes("resend suppression needs review") &&
    route.includes("sendOpsWebhookAlert(") &&
    !route.includes("sendOpsAlert(") &&
    email.includes("export async function sendOpsWebhookAlert(")
);
check(
  "missing recipients still reach the durable database audit",
  !route.includes("has no recipient addresses -- nothing to suppress") &&
    route.indexOf("normalizeRecipients(event.data.to)") <
      route.indexOf('"record_resend_suppression_event"')
);

check(
  "dormant SQL protocol adds the protected watermark and durable recovery fence",
  migration.includes(
    "add column if not exists delivery_suppression_cleared_at timestamptz"
  ) &&
    migration.includes(
      "new.delivery_suppression_cleared_at := old.delivery_suppression_cleared_at"
    ) &&
    migration.includes("add column if not exists suppression_recovery_token uuid") &&
    migration.includes("add column if not exists suppression_recovery_started_at timestamptz") &&
    migration.includes("add column if not exists suppression_recovery_snapshot jsonb")
);
check(
  "dormant SQL protocol claim takes the owner lock, rejects deletion/duplicates, and stores a fixed snapshot",
  migration.includes("claim_resend_suppression_recovery(uuid)") &&
    migration.includes("pg_advisory_xact_lock(hashtextextended(p_user_id::text, 80425080))") &&
    migration.includes("recovery_status text") &&
    migration.includes("return query select 'review_required'::text") &&
    migration.includes("return query select 'deletion_pending'::text") &&
    migration.includes("suppression_recovery_snapshot = public.resend_suppression_recovery_snapshot(to_jsonb(v_user))")
);
check(
  "dormant SQL protocol settlement is token-bound and has no automatic fence expiry",
  migration.includes("finalize_resend_suppression_recovery(uuid, uuid)") &&
    migration.includes("v_user.suppression_recovery_token is distinct from p_recovery_token") &&
    migration.includes("= v_user.suppression_recovery_snapshot") &&
    migration.includes("This fence has no automatic expiry")
);
check(
  "dormant SQL protocol keeps the recovery fence unresolved after a changed delivery or Auth identity state",
  /-- A new complaint[\s\S]*?return 'state_changed';/.test(migration) &&
    !/-- A new complaint[\s\S]*?suppression_recovery_token = null/.test(migration)
);
check(
  "message-id lookup has a bounded partial index",
  migration.includes("create index if not exists issues_resend_message_id_idx") &&
    migration.includes("where resend_message_id is not null")
);
check(
  "RPC owns durable audit insert and shared monotonic suppression mutation",
  migration.includes("record_resend_suppression_event(") &&
    migration.includes("insert into public.resend_webhook_events (") &&
    migration.includes("on conflict (email_id, type) do nothing") &&
    migration.includes("apply_resend_suppression_to_user(") &&
    migration.includes("v_user.bounced_at >= p_event_at") &&
    migration.includes("v_user.complained_at >= p_event_at")
);
check(
  "attempt-backed and legacy events bind to one proven owner",
  migration.includes("from public.resend_delivery_attempts") &&
    migration.includes("v_target_user_id := v_attempt_user_id") &&
    migration.includes("v_target_user_id := v_issue_user_id") &&
    migration.includes("p_user_id,") &&
    migration.includes("p_recipient_hashes")
);
check(
  "signed event time orders suppression after a clear",
  migration.includes("v_user.created_at is null") &&
    migration.includes("v_user.created_at > p_event_at") &&
    migration.includes("v_user.delivery_suppression_cleared_at > p_event_at")
);
check(
  "legacy ambiguity and messages awaiting ownership remain durable review rows",
  migration.includes("'legacy_review'::text") &&
    migration.includes("'pending_owner'::text") &&
    migration.includes("if v_target_user_id is null then")
);
check(
  "legacy issue ownership is resolved from one database snapshot",
  migration.includes("(array_agg(user_id))[1]") &&
    migration.includes("(array_agg(delivered_at))[1]")
);
check(
  "provider finalization and webhook recording serialize on one message lock",
  (migration.match(/alpha-resend-message:/g) ?? []).length >= 2 &&
    migration.includes("80425083")
);
check(
  "a fast webhook is attached and applied during provider finalization",
  /finalize_resend_delivery_attempt\([\s\S]*?from public\.resend_webhook_events[\s\S]*?apply_resend_suppression_to_user\(/.test(
    migration
  )
);
check(
  "webhook evidence stores recipient hashes, owner, and resolution markers",
  migration.includes("recipient_hashes text[] not null") &&
    migration.includes("owner_user_id uuid references public.users(id) on delete cascade") &&
    migration.includes("resolution_status text not null") &&
    migration.includes("resend_webhook_events_pending_review_idx")
);
check(
  "RPC is callable only by the service role",
  migration.includes(
    "revoke all on function public.record_resend_suppression_event(text, text, timestamptz, text[])"
  ) &&
    migration.includes(
      "grant execute on function public.record_resend_suppression_event(text, text, timestamptz, text[])"
    )
);

const grantStart = admin.indexOf('body.action === "grant_free"');
const grantEnd = admin.indexOf('body.action === "revoke_free"', grantStart);
const grant = admin.slice(grantStart, grantEnd);
check(
  "free approval extraction is nonempty and ends at revoke_free rather than the held clear guard",
  grantStart > -1 &&
    grantEnd > grantStart &&
    grant.length > 500 &&
    !grant.includes('if (body.action === "revoke_free")')
);
check(
  "free approval grants access without provider suppression removal",
  !grant.includes("removeResendSuppression(")
);
check(
  "free approval preserves unsubscribe, suppression evidence, pending cleanup, and its causal watermark",
  !/\.update\(\{[\s\S]*?unsubscribed_at:\s*null/.test(grant) &&
    !/\.update\(\{[\s\S]*?bounced_at:\s*null/.test(grant) &&
    !/\.update\(\{[\s\S]*?complained_at:\s*null/.test(grant) &&
    !/\.update\(\{[\s\S]*?suppression_cleanup_pending_at:\s*(?:null|grantedAt)/.test(
      grant
    ) &&
    !/\.update\(\{[\s\S]*?delivery_suppression_cleared_at:/.test(grant)
);
check(
  "free approval still uses the preexistence, billing-pair, and delivery-state compare-and-swap guards",
  grant.includes("if (!existing)") &&
    grant.includes("isFreeGrantEligible(existing.stripe_customer_id)") &&
    grant.includes("existing.stripe_subscription_id") &&
    grant.includes('grant = existing.unsubscribed_at') &&
    grant.includes('grant = existing.bounced_at') &&
    grant.includes('grant = existing.complained_at') &&
    grant.includes('grant = existing.suppression_cleanup_pending_at') &&
    grant.includes('grant = existing.delivery_suppression_cleared_at')
);

check(
  "reconciler reports pending delivery review without provider suppression removal",
  !reconciler.includes("removeResendSuppression") &&
    !reconciler.includes("fail_suppression_cleanup") &&
    reconciler.includes("result.deferred = reviewRequired")
);
check(
  "reconciler preserves local delivery evidence and pending markers",
  !reconciler.includes(".update(") &&
    !reconciler.includes("suppression_cleanup_pending_at: null")
);
check(
  "manual provider removal is a checked-in hard hold before service access",
  recoveryPolicy.includes(
    "export const MANUAL_PROVIDER_SUPPRESSION_REMOVAL_ENABLED = false"
  ) &&
    admin.includes('"clear_suppression",') &&
    admin.includes('code: "manual_recovery_disabled"') &&
    admin.indexOf('if (body.action === "clear_suppression")') >
      admin.indexOf("body = ActionBodySchema.parse(raw);") &&
    admin.indexOf('if (body.action === "clear_suppression")') <
      admin.indexOf(
        "const sb = await supabaseServiceClient();",
        admin.indexOf('if (body.action === "clear_suppression")')
      ) &&
    !admin.includes("recoverResendSuppression({")
);
check(
  "dormant helper returns manual_recovery_disabled before configuration, claim, or provider removal",
  recoveryHelper.indexOf('return { status: "manual_recovery_disabled" }') > -1 &&
    recoveryHelper.indexOf('return { status: "manual_recovery_disabled" }') <
      recoveryHelper.indexOf("if (!params.providerConfigured)") &&
    recoveryHelper.indexOf('return { status: "manual_recovery_disabled" }') <
      recoveryHelper.indexOf('"claim_resend_suppression_recovery"') &&
    recoveryHelper.indexOf('return { status: "manual_recovery_disabled" }') <
      recoveryHelper.indexOf("removeSuppression(claimed.recipient_email)")
);
check(
  "admin list keeps delivery review visible while recovery is held without a retry action",
  accounts.includes("suppression_cleanup_pending_at: string | null") &&
    accounts.includes('"DELIVERY REVIEW"') &&
    accounts.includes("MANUAL_PROVIDER_SUPPRESSION_REMOVAL_HOLD_MESSAGE") &&
    !accounts.includes('"clear_suppression"')
);
check(
  "Stripe checkout preserves provider suppression and does not stamp a cleanup cutoff",
  !stripeWebhook.includes("removeResendSuppression(") &&
    stripeWebhook.includes("preserveSuppressionState: true") &&
    !stripeWebhook.includes("delivery_suppression_cleared_at: checkoutMutationAt")
);
check(
  "legacy checkout does not call provider suppression removal or create a clean-account marker",
  !generate.includes("removeResendSuppression") &&
    generate.includes("suppressionCleared: false") &&
    generate.includes("preserveSuppressionState: true")
);
check(
  "confirmed email changes leave delivery pending for review without provider suppression removal",
  emailReconcile.includes("suppression_cleanup_pending_at: suppressionPendingAt") &&
    !emailReconcile.includes("removeResendSuppression") &&
    emailReconcile.includes("deliveryReviewRequired")
);

console.log(`Resend suppression causality verification passed: ${assertions}/${assertions}`);
