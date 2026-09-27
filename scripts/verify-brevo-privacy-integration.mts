import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAdminAccountState, type AdminAccountStateInput } from "../lib/admin-account-state";

const repo = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(path.join(repo, relative), "utf8");
let checks = 0;
function same(actual: unknown, expected: unknown): void { assert.deepEqual(actual, expected); checks++; }
function contains(source: string, fragment: string): void { assert.ok(source.includes(fragment), fragment); checks++; }

const reader: AdminAccountStateInput = {
  first_name: "Reader", topics: ["mental-health"], birthday: "1990-01-01",
  stripe_customer_id: null, stripe_subscription_id: null,
  subscribed_at: "2026-09-25T12:00:00.000Z", cancelled_at: null,
  access_requested_at: null, access_granted_at: "2026-09-25T12:00:00.000Z",
  delivery_enrolled: false, unsubscribed_at: null, brevo_unsubscribed_at: null,
  bounced_at: null, complained_at: null, suppression_cleanup_pending_at: null,
  suppression_recovery_started_at: null,
};
same(getAdminAccountState(reader).canEnableDelivery, true);
same(getAdminAccountState({ ...reader, brevo_unsubscribed_at: "2026-09-26T12:00:00.000Z" }).canEnableDelivery, false);
same(getAdminAccountState({ ...reader, brevo_unsubscribed_at: "2026-09-26T12:00:00.000Z" }).suppressed, true);
same(getAdminAccountState({ ...reader, brevo_unsubscribed_at: "2026-09-26T12:00:00.000Z" }).deliveryBlockReason,
  "This reader has a provider unsubscribe block. Reviewed recovery is required before letters can resume.");
same(getAdminAccountState({ ...reader, delivery_enrolled: true,
  brevo_unsubscribed_at: "2026-09-26T12:00:00.000Z" }).deliveryLabel, "Letters blocked");
same(getAdminAccountState({ ...reader, delivery_enrolled: true }).deliveryLabel, "Letters enabled");
same(getAdminAccountState({ ...reader, brevo_unsubscribed_at: undefined }).canEnableDelivery, true);

const policy = read("lib/brevo-delivery-policy.ts");
const rolloutPolicy = read("lib/brevo-rollout-policy.mjs");
const router = read("lib/subscriber-email-router.ts");
const delivery = read("lib/subscriber-email-delivery.ts");
const resume = read("app/api/resume/route.ts");
const accountExport = read("app/api/account/export/route.ts");
const admin = read("app/api/admin/users/route.ts");
contains(policy, 'from "./brevo-rollout-policy.mjs"');
contains(policy, "BREVO_DELIVERY_SCHEMA_ENABLED");
contains(policy, "BREVO_SUBSCRIBER_DELIVERY_ENABLED");
contains(rolloutPolicy, "export const BREVO_DELIVERY_SCHEMA_ENABLED = false");
contains(rolloutPolicy, "export const BREVO_SUBSCRIBER_DELIVERY_ENABLED = false");
contains(delivery, "schemaEnabled: BREVO_DELIVERY_SCHEMA_ENABLED");
contains(delivery, "brevoEnabled: BREVO_SUBSCRIBER_DELIVERY_ENABLED");
contains(delivery, "brevoWebhookReady: /^[A-Za-z0-9_-]{32,256}$/.test(process.env.BREVO_WEBHOOK_TOKEN || \"\")");
contains(router, "if (!config.schemaEnabled) return config.resendReady");
contains(router, "if (!brevoDeliveryConfigured(config) || params.deliveryLane !== \"live\" || !params.expectedClaimedAt)");
contains(router, "prepared.payload.headers[\"List-Unsubscribe\"]");
contains(router, "!prepared.payload.html.includes(unsubscribeLink) || !prepared.payload.text.includes(unsubscribeLink)");
contains(router, "const result = prepareBrevoCandidateEmail({");
contains(router, "const sent = await sendWithBrevoDeliveryAttempt({");
same(router.indexOf("!prepared.payload.html.includes(unsubscribeLink)") < router.indexOf("const sent = await sendWithBrevoDeliveryAttempt({"), true);
same(router.indexOf("!prepared.payload.html.includes(unsubscribeLink)") <
  router.indexOf('params.sb.rpc("resolve_subscriber_delivery_provider"'), true);
same(router.indexOf("!prepared.payload.html.includes(unsubscribeLink)") <
  router.indexOf("const result = await sendWithResendDeliveryAttempt({"), true);

contains(resume, "if (BREVO_DELIVERY_SCHEMA_ENABLED) {");
contains(resume, '.is("brevo_unsubscribed_at", null)');
contains(resume, "if (!resumed || resumed.length !== 1)");
contains(resume, "provider has an unsubscribe block");
contains(resume, ".update({ unsubscribed_at: null })");
same(resume.indexOf("if (BREVO_DELIVERY_SCHEMA_ENABLED) {") <
  resume.indexOf("const { error } = await svc"), true);

contains(accountExport, "if (BREVO_DELIVERY_SCHEMA_ENABLED) {");
contains(accountExport, '.from("brevo_suppression_events")');
contains(accountExport, '.eq("owner_user_id", user.id)');
contains(accountExport, "...(BREVO_DELIVERY_SCHEMA_ENABLED ? { brevo_suppression_events: brevoSuppressionEvents } : {})");
contains(admin, 'BREVO_DELIVERY_SCHEMA_ENABLED ? ", brevo_unsubscribed_at" : ""');
contains(admin, "(BREVO_DELIVERY_SCHEMA_ENABLED && existing.brevo_unsubscribed_at)");
contains(admin, "...(BREVO_DELIVERY_SCHEMA_ENABLED ? { brevo_unsubscribed_at: existing.brevo_unsubscribed_at } : {})");

console.log(`Brevo privacy integration offline checks passed (${checks} assertions).`);
