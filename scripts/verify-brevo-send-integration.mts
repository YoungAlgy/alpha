import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Read route source only. Never import a route, load an environment file, or
// invoke a provider, database, scheduler, or network transport.
const cron = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
const generate = readFileSync(new URL("../app/api/generate/route.ts", import.meta.url), "utf8");
const policy = readFileSync(new URL("../lib/brevo-delivery-policy.ts", import.meta.url), "utf8");
const rolloutPolicy = readFileSync(new URL("../lib/brevo-rollout-policy.mjs", import.meta.url), "utf8");

let checks = 0;
function includes(source: string, fragment: string, label: string): void {
  assert.ok(source.includes(fragment), label);
  checks++;
}
function excludes(source: string, fragment: string, label: string): void {
  assert.ok(!source.includes(fragment), label);
  checks++;
}

includes(rolloutPolicy, "export const BREVO_DELIVERY_SCHEMA_ENABLED = false", "shared schema gate stays off");
includes(rolloutPolicy, "export const BREVO_SUBSCRIBER_DELIVERY_ENABLED = false", "shared Brevo send gate stays off");
includes(policy, 'from "./brevo-rollout-policy.mjs"', "TypeScript policy uses the shared flag source");
includes(policy, "BREVO_DELIVERY_SCHEMA_ENABLED,", "TypeScript policy exposes the schema gate");
includes(policy, "BREVO_SUBSCRIBER_DELIVERY_ENABLED,", "TypeScript policy exposes the send gate");
for (const [label, route] of [["cron", cron], ["generate", generate]] as const) {
  includes(route, label === "cron"
    ? 'subscriberEmailConfigured(canaryUserId ? "brevo" : undefined)'
    : "subscriberEmailConfigured()", `${label} uses provider-aware readiness`);
  includes(route, "sendPreparedSubscriberLetter({", `${label} uses shared delivery router`);
  includes(route, "prepared: preparedEmail", `${label} sends its prepared object`);
  excludes(route, "sendWithResendDeliveryAttempt({", `${label} does not directly claim Resend`);
  excludes(route, "sendPreparedSubscriberEmail(preparedEmail)", `${label} does not directly dispatch Resend`);
  includes(route, "BREVO_DELIVERY_SCHEMA_ENABLED", `${label} gates new-schema behavior`);
  includes(route, "brevo_unsubscribed_at", `${label} checks provider unsubscribe`);
}

includes(cron, 'if (BREVO_DELIVERY_SCHEMA_ENABLED) query = query.is("brevo_unsubscribed_at", null)', "cron page excludes Brevo unsubscribes only with new schema");
includes(cron, 'BREVO_DELIVERY_SCHEMA_ENABLED\n          ? "email, delivery_enrolled', "cron fresh read preserves old schema");
includes(cron, 'BREVO_DELIVERY_SCHEMA_ENABLED && freshUser.brevo_unsubscribed_at', "cron rechecks Brevo suppression before send");
includes(cron, 'reclaimQuery = reclaimQuery.is("brevo_message_id", null)', "cron reclaim excludes Brevo-accepted issues");
includes(cron, 'resend_message_id.not.is.null,brevo_message_id.not.is.null,delivered_at.lt.${RECLAIM_GRANDFATHER_CUTOFF}', "cron prefetch recognizes provider proof and historical sends");
includes(cron, 'BREVO_DELIVERY_SCHEMA_ENABLED ? "prior_provider_issue_counts" : "prior_issue_counts"', "cron counts provider-proven letters under new schema");
includes(cron, 'expectedClaimedAt: force ? null : claimedAt', "cron forwards its exact claim stamp");

includes(generate, 'BREVO_DELIVERY_SCHEMA_ENABLED\n          ? "email, delivery_enrolled', "generate read preserves old schema");
includes(generate, 'BREVO_DELIVERY_SCHEMA_ENABLED && deliveryUser.brevo_unsubscribed_at', "generate checks Brevo suppression before claim");
includes(generate, 'resend_message_id.not.is.null,brevo_message_id.not.is.null,delivered_at.lt.${RECLAIM_GRANDFATHER_CUTOFF}', "generate counts provider proof and historical sends");
includes(generate, 'import { RECLAIM_GRANDFATHER_CUTOFF } from "@/lib/delivery-proof"', "generate uses the shared historical cutoff");
includes(generate, 'expectedClaimedAt: deliveryClaimedAt', "generate forwards its exact claim stamp");
includes(generate, 'deliveryLane: "live"', "generate uses live delivery lane");
includes(cron, '${delivery.provider} accepted the letter', "cron review log names provider without personal data");
includes(generate, '${delivery.provider} accepted the letter', "generate review log names provider without personal data");

console.log(`Brevo route source integration: ${checks} offline checks passed.`);
