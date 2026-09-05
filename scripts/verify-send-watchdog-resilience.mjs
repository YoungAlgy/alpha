#!/usr/bin/env node

import { readFileSync } from "node:fs";

const preflight = readFileSync(new URL("./verify-send-preflight.mjs", import.meta.url), "utf8");
const daily = readFileSync(new URL("../.github/workflows/daily-send.yml", import.meta.url), "utf8");
const watchdog = readFileSync(new URL("../.github/workflows/letter-watchdog.yml", import.meta.url), "utf8");
const reconciliation = readFileSync(
  new URL("../.github/workflows/stripe-reconcile.yml", import.meta.url),
  "utf8"
);
const maintenanceRoute = readFileSync(
  new URL("../app/api/cron/maintenance/route.ts", import.meta.url),
  "utf8"
);
const deletionMaintenanceRoute = readFileSync(
  new URL(
    "../app/api/cron/account-deletion-maintenance/route.ts",
    import.meta.url
  ),
  "utf8"
);
const providerMirrorRoute = readFileSync(
  new URL(
    "../app/api/cron/provider-mirror-maintenance/route.ts",
    import.meta.url
  ),
  "utf8"
);
const healthRoute = readFileSync(
  new URL("../app/api/health/route.ts", import.meta.url),
  "utf8"
);
const finalMaintenanceMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260828000000_alpha_renewal_cancellation.sql",
    import.meta.url
  ),
  "utf8"
);

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`PASS: ${label}`);
  } else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

function arrayBody(source, name) {
  return source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`))?.[1] ?? "";
}

function quotedNames(source) {
  return [...source.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]);
}

function loopNamesAfter(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return [];
  const match = source.slice(start).match(/for name in ([^;]+); do/);
  return match ? match[1].trim().split(/\s+/) : [];
}

function sameNames(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const generatorKeys = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
];
const maintenanceKeys = [
  "CRON_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "CHECKOUT_BINDING_SECRET",
];
const deliveryKeys = [
  "RESEND_API_KEY",
  "RESEND_FROM",
  "UNSUBSCRIBE_SECRET",
];
const softKeys = [
  ...generatorKeys,
  "BRAVE_SEARCH_API_KEY",
  "YOU_API_KEY",
  "ALPHA_OPS_ALERT_WEBHOOK_URL",
];

check(
  "preflight generator group contains every supported content generator",
  sameNames(quotedNames(arrayBody(preflight, "GENERATOR_KEYS")), generatorKeys)
);
check(
  "maintenance preflight has only the secrets required to run local repair",
  sameNames(quotedNames(arrayBody(preflight, "MAINTENANCE_REQUIRED")), maintenanceKeys)
);
check(
  "delivery requirements are tracked separately from maintenance",
  sameNames(quotedNames(arrayBody(preflight, "DELIVERY_REQUIRED")), deliveryKeys)
);
check(
  "preflight requires a cryptographic-length unsubscribe and limiter root",
  preflight.includes('process.env.UNSUBSCRIBE_SECRET.trim().length < 32')
);

const softBody = arrayBody(preflight, "SOFT_RESILIENCE_TIER");
check(
  "preflight soft tiers include each generator plus search and alert fallbacks",
  softBody.includes("...GENERATOR_KEYS") &&
    sameNames([...generatorKeys, ...quotedNames(softBody)], softKeys)
);
const zeroGeneratorBranch = preflight.match(
  /if \(!strictNoModel && configuredGenerators\.length === 0\) \{([\s\S]*?)\n\}/
)?.[1] ?? "";
check(
  "preflight keeps zero-generator backup-only mode soft",
  zeroGeneratorBranch.includes("console.warn(") &&
    zeroGeneratorBranch.includes("already usable persisted issue") &&
    zeroGeneratorBranch.includes("bounded prior-issue backup") &&
    !zeroGeneratorBranch.includes("hardFailures") &&
    !zeroGeneratorBranch.includes("process.exit")
);
check(
  "Resend domain lookup has a 15-second AbortSignal timeout",
  /fetch\("https:\/\/api\.resend\.com\/domains", \{[\s\S]*?signal: AbortSignal\.timeout\(15_000\),[\s\S]*?\}\)/.test(preflight)
);
check(
  "delivery failure is exported without blocking local maintenance",
  preflight.includes('setWorkflowOutput("delivery_ready", String(deliveryReady))') &&
    preflight.includes("maintenance will still run")
);
check(
  "preflight reports configured fresh-source readiness without blocking backups",
  preflight.includes('enabled("ALPHA_NO_MODEL_MODE")') &&
    preflight.includes('enabled("ALPHA_PUBLIC_FEED_FALLBACK")') &&
    preflight.includes('setWorkflowOutput("fresh_source_ready", String(freshSourceReady))') &&
    preflight.includes("Only an already persisted issue or the bounded prior-issue backup can be delivered")
);

const dailyPreflightStep = daily.match(
  /- name: Pre-flight[\s\S]*?run: node scripts\/verify-send-preflight\.mjs/
)?.[0] ?? "";
check("daily preflight exposes a stable step id", dailyPreflightStep.includes("id: preflight"));
const dailyEnv = new Map([
  ["CRON_SECRET", "SEND_CRON_SECRET"],
  ["RESEND_API_KEY", "SEND_RESEND_API_KEY"],
  ["RESEND_FROM", "SEND_RESEND_FROM"],
  ["UNSUBSCRIBE_SECRET", "SEND_UNSUBSCRIBE_SECRET"],
  ["NEXT_PUBLIC_SUPABASE_URL", "SEND_SUPABASE_URL"],
  ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SEND_SUPABASE_PUBLISHABLE_KEY"],
  ["SUPABASE_SECRET_KEY", "SEND_SUPABASE_SECRET_KEY"],
  ["CHECKOUT_BINDING_SECRET", "SEND_CHECKOUT_BINDING_SECRET"],
  ["ANTHROPIC_API_KEY", "SEND_ANTHROPIC_API_KEY"],
  ["GEMINI_API_KEY", "SEND_GEMINI_API_KEY"],
  ["GROQ_API_KEY", "SEND_GROQ_API_KEY"],
  ["DEEPSEEK_API_KEY", "SEND_DEEPSEEK_API_KEY"],
  ["BRAVE_SEARCH_API_KEY", "SEND_BRAVE_SEARCH_API_KEY"],
  ["YOU_API_KEY", "SEND_YOU_API_KEY"],
  ["ALPHA_OPS_ALERT_WEBHOOK_URL", "SEND_ALPHA_OPS_ALERT_WEBHOOK_URL"],
]);
for (const [envName, secretName] of dailyEnv) {
  check(
    `daily preflight maps ${envName}`,
    dailyPreflightStep.includes(`${envName}: \${{ secrets.${secretName} }}`)
  );
}
for (const [envName, variableName] of [
  ["ALPHA_NO_MODEL_MODE", "SEND_ALPHA_NO_MODEL_MODE"],
  ["ALPHA_PUBLIC_FEED_FALLBACK", "SEND_ALPHA_PUBLIC_FEED_FALLBACK"],
]) {
  check(
    `daily preflight maps ${envName}`,
    dailyPreflightStep.includes(`${envName}: \${{ vars.${variableName} }}`)
  );
}
check(
  "health exposes current-source configuration separately from hard product health",
  healthRoute.includes("freshSourceConfigured:") &&
    healthRoute.includes("publicFeedFallbackEnabled()") &&
    healthRoute.includes("!strictNoModel && !!process.env.GEMINI_API_KEY") &&
    healthRoute.includes("noModelMode: strictNoModel")
);
check(
  "Stripe reconciliation uses the Alpha-only alert secret",
  reconciliation.includes(
    "ALPHA_OPS_ALERT_WEBHOOK_URL: ${{ secrets.SEND_ALPHA_OPS_ALERT_WEBHOOK_URL }}"
  ) && !reconciliation.includes("SEND_OPS_ALERT_WEBHOOK_URL")
);

const sendHardKeys = [
  "SEND_CRON_SECRET",
  "SEND_RESEND_API_KEY",
  "SEND_RESEND_FROM",
  "SEND_UNSUBSCRIBE_SECRET",
  "SEND_SUPABASE_URL",
  "SEND_SUPABASE_PUBLISHABLE_KEY",
  "SEND_SUPABASE_SECRET_KEY",
  "SEND_CHECKOUT_BINDING_SECRET",
];
const sendGeneratorKeys = generatorKeys.map((name) => `SEND_${name}`);
const sendSoftKeys = softKeys.map((name) => `SEND_${name}`);

check(
  "watchdog fixed hard list matches daily preflight",
  sameNames(loopNamesAfter(watchdog, 'HARD_MISSING=""'), sendHardKeys)
);
const dailyRuntimeStep = daily.match(
  /- name: Start the server and run the real daily send[\s\S]*?run: \|/
)?.[0] ?? "";
const optionalRuntimeMappings = [
  ["JINA_API_KEY", "secrets.SEND_JINA_API_KEY"],
  ["ALPHA_DISABLE_DEEPREAD", "vars.SEND_ALPHA_DISABLE_DEEPREAD"],
  ["ALPHA_BLURB_MODEL", "vars.SEND_ALPHA_BLURB_MODEL"],
  ["ALPHA_BLURB_CHEAP_MODEL", "vars.SEND_ALPHA_BLURB_CHEAP_MODEL"],
  ["ALPHA_EDITOR_MODEL", "vars.SEND_ALPHA_EDITOR_MODEL"],
  ["ALPHA_GEMINI_TEXT_MODEL", "vars.SEND_ALPHA_GEMINI_TEXT_MODEL"],
  ["ALPHA_GEMINI_SEARCH_MODEL", "vars.SEND_ALPHA_GEMINI_SEARCH_MODEL"],
  ["ALPHA_ALLOW_PAID_AI", "vars.SEND_ALPHA_ALLOW_PAID_AI"],
  ["ALPHA_NO_MODEL_MODE", "vars.SEND_ALPHA_NO_MODEL_MODE"],
  ["ALPHA_PUBLIC_FEED_FALLBACK", "vars.SEND_ALPHA_PUBLIC_FEED_FALLBACK"],
];
for (const [envName, sourceName] of optionalRuntimeMappings) {
  check(
    `daily runtime maps optional control ${envName}`,
    dailyRuntimeStep.includes(`${envName}: \${{ ${sourceName} }}`)
  );
}
check(
  "daily build stamps its checked-out commit into health",
  daily.includes("NEXT_PUBLIC_ALPHA_RELEASE_SHA: ${{ github.sha }}")
);
check(
  "checkout binding secret reaches scheduled recovery and its drift watchdog",
  dailyRuntimeStep.includes(
    "CHECKOUT_BINDING_SECRET: ${{ secrets.SEND_CHECKOUT_BINDING_SECRET }}"
  ) &&
    watchdog.includes(
      "SEND_CHECKOUT_BINDING_SECRET: ${{ secrets.SEND_CHECKOUT_BINDING_SECRET }}"
    )
);
check(
  "daily send skips generation on delivery failure but still invokes every maintenance lane",
  daily.includes('DELIVERY_READY: ${{ steps.preflight.outputs.delivery_ready }}') &&
    daily.includes('SEND_SKIPPED_FOR_PREFLIGHT=1') &&
    daily.indexOf('DELETION_RAW=$(curl') < daily.indexOf('Delivery preflight failed, so no letter generation was attempted') &&
    daily.indexOf('MAINT_RAW=$(curl') < daily.indexOf('Delivery preflight failed, so no letter generation was attempted') &&
    daily.indexOf('MIRROR_RAW=$(curl') < daily.indexOf('Delivery preflight failed, so no letter generation was attempted')
);
check(
  "daily workflow budget covers send, three isolated maintenance lanes, and build headroom",
  daily.includes("timeout-minutes: 90") &&
    !daily.includes("two independent 5-minute maintenance lanes")
);
check(
  "daily workflow redacts subscriber arrays before printing the send response",
  daily.includes("'backupSharedSentEmails','backupFreshSentEmails','backupStaleSentEmails','skippedBlankSubscribers','deferred','failures'") &&
    daily.includes("[response body redacted: invalid JSON]") &&
    !daily.includes("catch(e){console.log(d)}")
);
check(
  "account deletion has an isolated lane and timed-out processes are replaced",
  deletionMaintenanceRoute.includes("export const maxDuration = 300") &&
    deletionMaintenanceRoute.includes("reconcileStaleAccountDeletions") &&
    deletionMaintenanceRoute.includes("limit: 1") &&
    deletionMaintenanceRoute.includes("pendingDeletionSagas") &&
    deletionMaintenanceRoute.includes("dueDeletionTombstones") &&
    !maintenanceRoute.includes("reconcileStaleAccountDeletions") &&
    daily.includes("stop_alpha_server 15") &&
    daily.indexOf("stop_alpha_server 15") <
      daily.indexOf('MAINT_RAW=$(curl')
);
check(
  "daily workflow fails red on malformed or unresolved deletion maintenance",
  daily.includes('DELETION_STATUS=$(echo "${DELETION_RESPONSE}"') &&
    daily.includes('DELETION_STATUS}" = "SHAPE_INVALID') &&
    daily.includes('DELETION_STATUS}" != "0') &&
    daily.includes("s.pendingDeletionSagas") &&
    daily.includes("s.dueDeletionTombstones")
);
check(
  "general maintenance attempts independent lifecycle queues together",
  maintenanceRoute.includes("await Promise.all([") &&
    maintenanceRoute.includes("reconcileStaleCheckoutSessionCreations") &&
    maintenanceRoute.includes("reconcileStaleLegacyCheckoutFulfillments") &&
    maintenanceRoute.includes("reconcilePendingAlphaRenewalCancellations") &&
    maintenanceRoute.includes("reconcileOverdueCheckoutProfiles") &&
    !maintenanceRoute.includes("reconcilePendingStripeEmails") &&
    !maintenanceRoute.includes("reconcilePendingSuppressions")
);
check(
  "general maintenance exposes dead letters and every count failure to the workflow and alert",
  maintenanceRoute.includes("deadLetteredLegacyCheckoutFulfillments") &&
    maintenanceRoute.includes("legacyDeadLetterCountErrors") &&
    maintenanceRoute.includes("checkoutCreationReviewErrors > 0") &&
    maintenanceRoute.includes("checkoutCreation.reviewRequired > 0") &&
    maintenanceRoute.includes("checkoutDeadLetterCountErrors > 0") &&
    maintenanceRoute.includes("renewalCancellationCountErrors > 0") &&
    maintenanceRoute.includes("refundReviewErrors > 0") &&
    maintenanceRoute.includes("checkoutRecovery.inProgress > 0") &&
    maintenanceRoute.includes("Count errors: ${legacyDeadLetterCountErrors}") &&
    daily.includes("c?.reviewRequired") &&
    daily.includes("c.inProgress + c.reviewRequired") &&
    daily.includes("s.deadLetteredLegacyCheckoutFulfillments") &&
    daily.includes("s.legacyDeadLetterCountErrors")
);
check(
  "provider mirrors run in canonical-email order and finish with the global due check",
  providerMirrorRoute.indexOf("reconcilePendingStripeEmails") <
    providerMirrorRoute.indexOf("reconcilePendingSuppressions") &&
    providerMirrorRoute.includes('"alpha_scheduled_maintenance_due"') &&
    providerMirrorRoute.includes("finalMaintenanceDue") &&
    providerMirrorRoute.includes("finalMaintenanceDueErrors") &&
    providerMirrorRoute.includes("unresolvedSuppressionRecoveries") &&
    providerMirrorRoute.includes("suppressionRecoveryCountErrors") &&
    providerMirrorRoute.includes("No automatic provider retry is performed") &&
    daily.includes("typeof s.finalMaintenanceDue !== 'boolean'") &&
    daily.includes("(s.finalMaintenanceDue ? 1 : 0)") &&
    daily.includes("s.unresolvedSuppressionRecoveries") &&
    daily.includes("s.suppressionRecoveryCountErrors") &&
    daily.includes("s.resolvedRefundReviewsPruned") &&
    daily.includes("s.resolvedRefundReviewsRemaining") &&
    daily.includes("s.refundReviewPruneErrors")
);
check(
  "send tails drain before fresh isolated maintenance processes",
  daily.indexOf("stop_alpha_server 120") <
    daily.indexOf('DELETION_RAW=$(curl') &&
    (daily.match(/stop_alpha_server 15/g) ?? []).length >= 3 &&
    (daily.match(/start_alpha_server/g) ?? []).length >= 4
);
check(
  "final due predicate covers retention and every retry-aware maintenance queue",
    finalMaintenanceMigration.includes("p.raw_profile_scrubbed_at is null") &&
    finalMaintenanceMigration.includes("p.expires_at <= p_now") &&
    finalMaintenanceMigration.includes("p.recovery_lease_expires_at is null") &&
    finalMaintenanceMigration.includes("p.recovery_lease_expires_at <= p_now") &&
    finalMaintenanceMigration.includes("r.status in ('refunded', 'not_required')") &&
    finalMaintenanceMigration.includes("r.resolved_at <= p_now - interval '180 days'") &&
    finalMaintenanceMigration.includes("l.status = 'pending'") &&
    /legacy_checkout_fulfillments l[\s\S]*l\.status = 'awaiting_issue'[\s\S]*l\.status = 'pending'[\s\S]*coalesce\([\s\S]*l\.lease_expires_at/.test(
      finalMaintenanceMigration
    ) &&
    /legacy_checkout_fulfillments l[\s\S]*join public\.refund_reviews r[\s\S]*r\.winner_customer_id is not null[\s\S]*r\.winner_subscription_id is not null[\s\S]*where l\.status = 'pending'/.test(
      finalMaintenanceMigration
    ) &&
    finalMaintenanceMigration.includes("s.reconcile_next_attempt_at <= p_now") &&
    finalMaintenanceMigration.includes("l.reconcile_dead_lettered_at is not null") &&
    finalMaintenanceMigration.includes("u.suppression_cleanup_next_attempt_at <= p_now") &&
    finalMaintenanceMigration.includes("u.stripe_email_sync_next_attempt_at <= p_now") &&
    finalMaintenanceMigration.includes("u.stripe_email_sync_lease_expires_at <= p_now") &&
    finalMaintenanceMigration.includes("u.renewal_cancel_next_attempt_at <= p_now")
);
check(
  "watchdog generator group matches daily preflight",
  sameNames(loopNamesAfter(watchdog, "GENERATOR_CONFIGURED=0"), sendGeneratorKeys)
);
check(
  "watchdog soft list matches daily preflight",
  sameNames(loopNamesAfter(watchdog, 'SOFT_MISSING=""'), sendSoftKeys)
);
const watchdogGeneratorSection = watchdog.slice(
  watchdog.indexOf("GENERATOR_CONFIGURED=0"),
  watchdog.indexOf('SOFT_MISSING=""')
);
check(
  "watchdog keeps an empty generator group out of hard failures",
  !watchdogGeneratorSection.includes("HARD_MISSING") &&
    !watchdogGeneratorSection.includes("exit 1") &&
    watchdog.includes("usable persisted issue or bounded prior-issue backup remains")
);
check(
  "watchdog documents the independent Codex monitor and keeps an optional external ping",
  watchdog.includes("Alpha daily delivery monitor") &&
    watchdog.includes("WATCHDOG_HEARTBEAT_PING_URL is not configured") &&
    watchdog.includes('if [ -z "${PING_URL}" ]; then') &&
    watchdog.includes('curl -fsS --max-time 10 --retry 3 "${PING_URL}"')
);

const deliveryLogic = watchdog.slice(
  watchdog.indexOf('SEARCH_PHRASE="Daily letter send may be broken"'),
  watchdog.indexOf("  check-resilience-secrets:")
);
const zeroUncoveredBranch = deliveryLogic.match(
  /if \[ "\$\{UNCOVERED_COUNT\}" -eq 0 \]; then([\s\S]*?)\n\s+fi/
)?.[1] ?? "";
const positiveUncoveredBranch = deliveryLogic.slice(
  deliveryLogic.indexOf('if [ "${UNCOVERED_COUNT}" -gt 0 ]; then'),
  deliveryLogic.indexOf('if [ "${UNCOVERED_COUNT}" -eq 0 ]; then')
);
const allDeliveryIssueCloses = [
  ...deliveryLogic.matchAll(/close_issue_if_open "\$\{(?:PARTIAL_)?SEARCH_PHRASE\}"/g),
];
const zeroBranchIssueCloses = [
  ...zeroUncoveredBranch.matchAll(/close_issue_if_open "\$\{(?:PARTIAL_)?SEARCH_PHRASE\}"/g),
];

check(
  "watchdog alerts on every positive uncovered count",
  /if \[ "\$\{UNCOVERED_COUNT\}" -gt 0 \]; then/.test(deliveryLogic) &&
    (positiveUncoveredBranch.match(/send_resend_alert/g) ?? []).length === 2 &&
    (positiveUncoveredBranch.match(/open_or_update_issue/g) ?? []).length === 2 &&
    positiveUncoveredBranch.includes("exit 1")
);
check(
  "delivery issues close only inside the zero-uncovered branch",
  allDeliveryIssueCloses.length === 2 && zeroBranchIssueCloses.length === 2
);
check(
  "old percentage threshold cannot let uncovered subscribers pass",
  !/DELIVERED_COUNT \* 2|ACTIVE_COUNT \/ 2/.test(deliveryLogic)
);

if (failures > 0) {
  console.error(`\n${failures} resilience verification check(s) failed.`);
  process.exit(1);
}

console.log("\nAll send preflight and watchdog resilience checks passed.");
