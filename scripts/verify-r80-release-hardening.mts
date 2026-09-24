// Focused Round 80 release-gate checks. Fully local: pure helpers plus source
// assertions. No environment files, provider clients, network, or app data.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARD_PRODUCT_CHECK_NAMES,
  hardProductFailures,
  type HardProductChecks,
} from "../lib/health-status.ts";
import { requireResendMessageId } from "../lib/resend-response.ts";

const allHealthy = Object.fromEntries(
  HARD_PRODUCT_CHECK_NAMES.map((name) => [name, true])
) as HardProductChecks;
assert.deepEqual(hardProductFailures(allHealthy), []);
for (const name of HARD_PRODUCT_CHECK_NAMES) {
  assert.deepEqual(
    hardProductFailures({ ...allHealthy, [name]: false }),
    [name],
    `${name} must make hard product health fail`
  );
}
assert.ok(!HARD_PRODUCT_CHECK_NAMES.includes("anthropic" as never));
assert.ok(!HARD_PRODUCT_CHECK_NAMES.includes("gemini" as never));

assert.equal(requireResendMessageId({ id: " re_local_proof " }), "re_local_proof");
assert.throws(() => requireResendMessageId(null), /missing provider message id/);
assert.throws(() => requireResendMessageId({}), /missing provider message id/);
assert.throws(() => requireResendMessageId({ id: "   " }), /missing provider message id/);

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const health = source("../app/api/health/route.ts");
const smoke = source("./smoke-test-deploy.mjs");
const accessMode = source("../lib/access-mode.ts");
const checkoutRoute = source("../app/api/stripe/checkout/route.ts");
const quantityRoute = source("../app/api/stripe/update-quantity/route.ts");
const portalRoute = source("../app/api/stripe/portal/route.ts");
const workerEntry = source("../src/worker-entry.ts");
const email = source("../lib/email.ts");
const deployRelease = source("./verify-deploy-release.mjs");
const deployWrapper = source("./deploy-from-wsl.sh");
const rollbackCapture = source("./capture-cloudflare-rollback.mjs");
const unsubscribeCanary = source("./verify-unsubscribe-secret-match.mjs");
const packageJson = source("../package.json");
const deployCommand = (
  JSON.parse(packageJson) as { scripts: Record<string, string> }
).scripts["cf:deploy"];
const deliveryMigration = source(
  "../supabase/migrations/20260827020000_delivery_suppression_pending.sql"
);
const renewalMigration = source(
  "../supabase/migrations/20260828000000_alpha_renewal_cancellation.sql"
);
const keepaliveWorkflow = source("../.github/workflows/repo-keepalive.yml");
const watchdogWorkflow = source("../.github/workflows/letter-watchdog.yml");
const dailyWorkflow = source("../.github/workflows/daily-send.yml");
const weeklySend = source("../app/api/cron/weekly-send/route.ts");
const migrationBundler = source("./build-r80-migration-bundle.mjs");
const liveVerification = source("./r80-live-verification.sql");
const liveVerificationVerifier = source("./verify-r80-live-verification.mts");
const backfillVerifier = source("./verify-subscription-binding-backfill.mts");
const expectedRound80Migrations = [
  "20260827000000_checkout_fulfillment_claims.sql",
  "20260827010000_stripe_webhook_event_leases.sql",
  "20260827020000_delivery_suppression_pending.sql",
  "20260827030000_legacy_checkout_fulfillments.sql",
  "20260827040000_refund_review_resolution.sql",
  "20260827050000_daily_paid_call_budget.sql",
  "20260827200000_issues_rls_subscribed_access.sql",
  "20260828000000_alpha_renewal_cancellation.sql",
  "20260830000000_invite_access.sql",
  "20260830010000_weekly_send_delivery_cursors.sql",
  "20260830020000_account_privacy_retry_bounds.sql",
  "20260830030000_distributed_rate_limits.sql",
  "20260830040000_quantity_update_leases.sql",
  "20260830050000_resend_suppression_causality.sql",
] as const;
const checkoutMaintenance = source("../lib/checkout-maintenance.ts");
const checkoutMaintenanceRunbook = source(
  "../docs/CHECKOUT_MAINTENANCE.md"
);
const creationReviewOperator = source(
  "./resolve-checkout-creation-review.mts"
);
const creationReviewRunbook = source("../docs/CHECKOUT_CREATION_REVIEW.md");

assert.match(health, /const hardFailures = hardProductFailures\(checks(?:, accessMode)?\)/);
assert.match(health, /const ok = hardFailures\.length === 0/);
assert.match(health, /status: ok \? 200 : 503/);
assert.match(
  health,
  /UNSUBSCRIBE_SECRET\?\.trim\(\)\.length[\s\S]*>= 32/
);
assert.match(
  health,
  /release: process\.env\.NEXT_PUBLIC_ALPHA_RELEASE_SHA\?\.trim\(\) \|\| null/
);
assert.match(
  health,
  /checkoutMode: checkoutMode\(process\.env\.ALPHA_CHECKOUT_MODE\)/
);
assert.match(accessMode, /export function alphaAccessMode\(_server = false\)[\s\S]*?return "invite"/);
assert.match(accessMode, /export function isInviteOnly\(_server = false\)[\s\S]*?return true/);
assert.doesNotMatch(accessMode, /process\.env/);
function assertInviteGuardPrecedes(
  route: string,
  routeName: string,
  barriers: string[]
) {
  const guard = route.indexOf("if (isInviteOnly(true))");
  assert.ok(guard >= 0, `${routeName} must have an invite guard`);
  const guardBlock = route.slice(guard, route.indexOf("const secret", guard));
  assert.match(guardBlock, /status: 410/);
  assert.match(guardBlock, /Cache-Control": "no-store"/);
  for (const barrier of barriers) {
    const position = route.indexOf(barrier, guard);
    assert.ok(position > guard, `${routeName} guard must precede ${barrier}`);
  }
}
assertInviteGuardPrecedes(checkoutRoute, "checkout", [
  "const secret = process.env.STRIPE_SECRET_KEY",
  "await supabaseServiceClient()",
  "stripe.checkout.sessions.create",
]);
assertInviteGuardPrecedes(quantityRoute, "quantity update", [
  "const secret = process.env.STRIPE_SECRET_KEY",
  "await supabaseServerClient()",
  "stripe.subscriptions.update",
]);
assertInviteGuardPrecedes(portalRoute, "billing portal", [
  "const secret = process.env.STRIPE_SECRET_KEY",
  "const sb = await supabaseServerClient()",
  "stripe.billingPortal.sessions.create",
]);
assert.match(checkoutMaintenance, /value === "open"/);
assert.ok(!checkoutMaintenance.includes("BYPASS"));

const coreBlock = smoke.match(/const CORE = \[[\s\S]*?\];/)?.[0] ?? "";
const softBlock = smoke.match(/const SOFT = \[[\s\S]*?\];/)?.[0] ?? "";
assert.ok(coreBlock && !coreBlock.includes('"anthropic"'));
assert.ok(softBlock.includes('"anthropic"'));
assert.ok(coreBlock.includes('"unsubscribe"'));
assert.match(smoke, /\^\[0-9a-f\]\{40\}\$/);
assert.match(smoke, /body\?\.release !== EXPECTED_RELEASE/);
assert.match(smoke, /ALPHA_EXPECTED_CHECKOUT_MODE/);
assert.match(smoke, /body\?\.checkoutMode !== EXPECTED_CHECKOUT_MODE/);
assert.match(smoke, /EXPECTED_CHECKOUT_MODE !== "paused"/);
assert.match(smoke, /manualDeliveryHealthMatches\(body\)/);
assert.match(smoke, /body\?\.accessMode === "invite"[\s\S]*?body\?\.subscriberDeliveryMode === "open"/);
assert.match(smoke, /noChargeResponseMatches\(status, body, cacheControl, expectedError\)/);
assert.match(smoke, /\/api\/stripe\/checkout[\s\S]*?"invite_only"/);
assert.match(smoke, /\/api\/stripe\/update-quantity[\s\S]*?Paid plan changes are closed/);
assert.match(smoke, /\/api\/stripe\/portal[\s\S]*?Billing changes are closed/);
assert.match(smoke, /CANONICAL_BASE_URL = "https:\/\/alpha\.everyday\.report"/);
assert.match(smoke, /parsedBaseUrl\.protocol !== "https:"/);
assert.match(smoke, /parsedBaseUrl\.hostname !== "alpha\.everyday\.report"/);
assert.doesNotMatch(smoke, /const BASE_URL = process\.env\.SMOKE_TEST_URL/);
assert.equal(
  email.split("requireResendMessageId(result.data)").length - 1,
  3,
  "letters, welcome mail, and ops alerts must reject missing provider proof"
);
assert.ok(
  deployRelease.includes('execFileSync("git", ["rev-parse", "HEAD"]') &&
    deployRelease.includes('execFileSync("git", ["status", "--porcelain"]') &&
    deployRelease.includes("publicRelease !== head") &&
    deployRelease.includes('worktree !== ""')
);
assert.ok(
  deployRelease.includes("configuredCheckoutMode !== expectedCheckoutMode") &&
    deployRelease.includes('"ALPHA_CHECKOUT_MODE"') &&
    deployRelease.includes("ACCESS_MODE_SHA256") &&
    deployRelease.includes('pinnedSourceMatches("lib/access-mode.ts", ACCESS_MODE_SHA256)') &&
    deployRelease.includes("Permanent invite-only access policy is missing or changed")
);
assert.ok(
  deployRelease.includes("SUPPRESSION_HOLD_SHA256") &&
    deployRelease.includes('readFileSync("lib/suppression-recovery-policy.ts", "utf8")') &&
    deployRelease.includes('if (!suppressionHoldVerified)') &&
    deployRelease.includes('createHash("sha256").update(policy).digest("hex")')
);
assert.ok(
  deployCommand.indexOf("node scripts/verify-deploy-release.mjs") <
    deployCommand.indexOf("opennextjs-cloudflare build")
);
assert.ok(
  deployWrapper.includes('export NEXT_PUBLIC_ALPHA_RELEASE_SHA="$after"') &&
    deployWrapper.includes('export ALPHA_EXPECTED_RELEASE_SHA="$after"') &&
    deployWrapper.includes('export ALPHA_EXPECTED_CHECKOUT_MODE="$checkout_mode"')
);
assert.ok(
  deployWrapper.includes('git symbolic-ref --quiet --short HEAD') &&
    deployWrapper.includes('git remote get-url origin') &&
    deployWrapper.includes('git status --porcelain --untracked-files=all') &&
    deployWrapper.indexOf('git status --porcelain --untracked-files=all') <
      deployWrapper.indexOf('git reset --hard origin/master')
);
assert.ok(
  deployWrapper.includes("capture-cloudflare-rollback.mjs") &&
    deployWrapper.includes("wrangler rollback $rollback_version --name alpha") &&
    deployWrapper.includes("Keep checkout paused")
);
assert.ok(
  rollbackCapture.includes('"deployments", "status"') &&
    rollbackCapture.includes("version?.percentage === 100") &&
    rollbackCapture.includes("process.env.ALPHA_RELEASE_RECORD_DIR?.trim()") &&
    rollbackCapture.includes('"backup/release-records"')
);
assert.ok(
  unsubscribeCanary.includes('method: "GET"') &&
    !unsubscribeCanary.includes('method: "POST"') &&
    unsubscribeCanary.includes("00000000-0000-4000-8000-000000000000")
);
assert.ok(
  unsubscribeCanary.includes('target.hostname !== "alpha.everyday.report"') &&
    !unsubscribeCanary.includes("console.log(token)")
);
assert.match(
  deliveryMigration,
  /protect_user_privileged_columns\(\)[\s\S]*?security definer\s+set search_path = public\s+as \$\$/
);
assert.match(
  deliveryMigration,
  /normalize_delivery_retry_deadlines\(\)[\s\S]*?security definer\s+set search_path = public\s+as \$\$/
);
assert.match(
  renewalMigration,
  /protect_user_privileged_columns\(\)[\s\S]*?security definer\s+set search_path = public\s+as \$\$/
);
assert.ok(
  keepaliveWorkflow.includes("contents: read") &&
    !keepaliveWorkflow.includes("contents: write") &&
    !keepaliveWorkflow.includes("git push") &&
    keepaliveWorkflow.includes("gh issue create")
);
assert.match(watchdogWorkflow, /check-delivery:\s*\n\s*runs-on: ubuntu-latest\s*\n\s*timeout-minutes: 10/);
assert.match(watchdogWorkflow, /check-resilience-secrets:\s*\n\s*runs-on: ubuntu-latest\s*\n\s*timeout-minutes: 10/);
assert.match(keepaliveWorkflow, /warn:\s*\n\s*runs-on: ubuntu-latest\s*\n\s*timeout-minutes: 10/);
assert.match(workerEntry, /cron route returned \$\{response\.status\}`/);
assert.doesNotMatch(workerEntry, /await response\.text\(\)/);
assert.ok(
  !weeklySend.includes("generateIssue(${row.id})") &&
    !weeklySend.includes("persist+send(${row.id})") &&
    !weeklySend.includes("fast-fallback(${row.id})") &&
    !weeklySend.includes("backup-send(${row.id})")
);
assert.ok(
  weeklySend.includes('"generateIssue(subscriber)"') &&
    weeklySend.includes('"persist+send(subscriber)"') &&
    weeklySend.includes('"fast-fallback(subscriber)"') &&
    weeklySend.includes('"backup-send(subscriber)"')
);
assert.match(dailyWorkflow, /RAW_SERVER_LOG="server\.log"/);
assert.match(
  dailyWorkflow,
  /PUBLIC_SERVER_LOG="server\.public\.log"/
);
assert.match(
  dailyWorkflow,
  /build_public_server_log\(\)[\s\S]*?format=alpha-public-server-diagnostics-v1[\s\S]*?content=fixed-labels-and-numeric-counts-only/
);
assert.ok(
  dailyWorkflow.includes("append_public_count()") &&
    dailyWorkflow.includes('grep -F -c -- "${needle}" "${RAW_SERVER_LOG}"') &&
    dailyWorkflow.includes("*[!0-9]*) count=0") &&
    dailyWorkflow.includes("*[!0-9]*) raw_line_count=0")
);
assert.ok(
  dailyWorkflow.includes("Every output key is fixed here") &&
    dailyWorkflow.includes("grep matches are counted but never emitted.") &&
    dailyWorkflow.includes("No source") &&
    dailyWorkflow.includes("log line is ever copied, printed, or uploaded.")
);
assert.equal(
  (dailyWorkflow.match(/build_public_server_log\s*\n\s*echo "::error::/g) ?? [])
    .length,
  2
);
assert.equal(
  (dailyWorkflow.match(/tail -n (?:100|200) "\$\{PUBLIC_SERVER_LOG\}"/g) ?? [])
    .length,
  2
);
assert.doesNotMatch(
  dailyWorkflow,
  /(?:cp|cat|sed|awk|head|tail)[^\n]*\$\{RAW_SERVER_LOG\}[^\n]*\$\{PUBLIC_SERVER_LOG/
);
assert.equal(
  (dailyWorkflow.match(/>> "\$\{PUBLIC_SERVER_LOG_TMP\}"/g) ?? []).length,
  6
);
assert.doesNotMatch(
  dailyWorkflow,
  /(?:cat|head|tail|tee)[^\n]*\$\{RAW_SERVER_LOG\}/
);
assert.doesNotMatch(
  dailyWorkflow,
  /(?:cp|mv)[^\n]*"\$\{RAW_SERVER_LOG\}"[^\n]*"\$\{PUBLIC_SERVER_LOG(?:_TMP)?\}"/
);
assert.ok(
  dailyWorkflow.includes("alpha_exit_cleanup() {") &&
    dailyWorkflow.includes("build_public_server_log") &&
    dailyWorkflow.includes("trap alpha_exit_cleanup EXIT") &&
    dailyWorkflow.includes("name: public-server-diagnostics") &&
    dailyWorkflow.includes("path: server.public.log")
);
assert.doesNotMatch(
  dailyWorkflow,
  /^\s*path:\s*(?:server\.log|server\.sanitized\.log)\s*$/m
);

const publicFunctionStart = dailyWorkflow.indexOf("append_public_count() {");
const publicFunctionEnd = dailyWorkflow.indexOf(
  "trap alpha_exit_cleanup EXIT",
  publicFunctionStart
);
assert.ok(publicFunctionStart >= 0 && publicFunctionEnd > publicFunctionStart);
const publicFunctions = dailyWorkflow.slice(
  publicFunctionStart,
  publicFunctionEnd
);
const windowsBash = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
const bash =
  process.platform === "win32" && existsSync(windowsBash)
    ? windowsBash
    : "bash";
const publicLogFixtureDir = mkdtempSync(
  path.join(tmpdir(), "alpha-public-log-")
);
try {
  writeFileSync(
    path.join(publicLogFixtureDir, "server.log"),
    [
      "[cron/weekly-send] FAILED: custom:private-topic subscriber-private@example.invalid",
      "[topic-blurb] raw model output: PRIVATE_MODEL_OUTPUT cus_private sub_private cs_private 11111111-1111-4111-8111-111111111111",
      "[cron/weekly-send] sent (4 section(s))",
    ].join("\n") + "\n",
    "utf8"
  );
  const publicLogRun = spawnSync(
    bash,
    ["-c", `${publicFunctions}\nbuild_public_server_log`],
    {
      cwd: publicLogFixtureDir,
      encoding: "utf8",
      env: {
        ...process.env,
        RAW_SERVER_LOG: "server.log",
        PUBLIC_SERVER_LOG: "server.public.log",
        PUBLIC_SERVER_LOG_TMP: "server.public.log.tmp",
      },
    }
  );
  assert.equal(
    publicLogRun.status,
    0,
    publicLogRun.stderr || publicLogRun.stdout || publicLogRun.error?.message
  );
  const publicLogFixture = readFileSync(
    path.join(publicLogFixtureDir, "server.public.log"),
    "utf8"
  );
  assert.ok(
    publicLogFixture.includes("format=alpha-public-server-diagnostics-v1") &&
      publicLogFixture.includes("content=fixed-labels-and-numeric-counts-only") &&
      publicLogFixture.includes("raw_line_count=3")
  );
  assert.ok(
    publicLogFixture.includes("events.subscriber_failed=1") &&
      publicLogFixture.includes("events.sent_live=1")
  );
  assert.ok(
    publicLogFixture
      .trim()
      .split(/\r?\n/)
      .every((line) =>
        /^(?:format=alpha-public-server-diagnostics-v1|content=fixed-labels-and-numeric-counts-only|raw_(?:log_present|line_count)=\d+|events\.[a-z_]+=\d+)$/.test(
          line
        )
      )
  );
  assert.doesNotMatch(
    publicLogFixture,
    /custom:|PRIVATE_MODEL_OUTPUT|subscriber-private|11111111|(?:cus|sub|cs)_private/
  );
} finally {
  const resolved = path.resolve(publicLogFixtureDir);
  if (
    path.dirname(resolved).toLowerCase() !== path.resolve(tmpdir()).toLowerCase() ||
    !path.basename(resolved).startsWith("alpha-public-log-") ||
    lstatSync(resolved).isSymbolicLink()
  ) {
    throw new Error("unsafe public log verifier cleanup target");
  }
  rmSync(resolved, { recursive: true, force: true });
}
const migrationBlock =
  migrationBundler.match(/const migrations = \[([\s\S]*?)\];/)?.[1] || "";
assert.deepEqual(
  [...migrationBlock.matchAll(/"(\d{14}_[a-z0-9_]+\.sql)"/g)].map(
    (match) => match[1]
  ),
  expectedRound80Migrations
);
assert.equal(expectedRound80Migrations.length, 14);
const expectedMigrationChecksums = expectedRound80Migrations.map((name) => ({
  name,
  sha256: crypto
    .createHash("sha256")
    .update(source(`../supabase/migrations/${name}`).replace(/\r\n/g, "\n").trimEnd())
    .digest("hex"),
}));
const bundlerChecksumBlock =
  migrationBundler.match(
    /const expectedMigrationSha256 = new Map\(\[([\s\S]*?)\]\);/
  )?.[1] || "";
assert.deepEqual(
  [...bundlerChecksumBlock.matchAll(/"(\d{14}_[a-z0-9_]+\.sql)",\s*"([0-9a-f]{64})"/g)].map(
    (match) => ({ name: match[1], sha256: match[2] })
  ),
  expectedMigrationChecksums
);
assert.match(
  migrationBundler,
  /"functions",\s*uniqueMatches\(\/create or replace function public\\\.\(\[a-z0-9_\]\+\)\/gi\),\s*112,/
);
assert.match(
  migrationBundler,
  /functionDefinitionCount !== 126/
);
assert.ok(
  migrationBundler.includes("serviceRoleGrantSignatures.length !== 97") &&
    migrationBundler.includes("new Set(serviceRoleGrantSignatures).size !== 91") &&
    migrationBundler.includes(
      "public.fail_suppression_cleanup(uuid,timestamptz,text,timestamptz,timestamptz,timestamptz,text,text,timestamptz,timestamptz,timestamptz,text,timestamptz)"
    )
);
assert.ok(
  liveVerificationVerifier.includes("expected: 112") &&
    liveVerificationVerifier.includes("equal(functionDefinitionCount, 126") &&
    liveVerificationVerifier.includes(
      '"public.fail_suppression_cleanup(uuid,timestamptz,text,timestamptz,timestamptz,timestamptz,text,text,timestamptz,timestamptz,timestamptz,text,timestamptz)"'
    )
);
assert.ok(
  liveVerification.includes("all 112 distinct Round 80 function names") &&
    liveVerification.includes("('watchdog_delivery_check')") &&
    liveVerification.includes(
      "('public.fail_suppression_cleanup(uuid,timestamptz,text,timestamptz,timestamptz,timestamptz,text,text,timestamptz,timestamptz,timestamptz,text,timestamptz)')"
    ) &&
    liveVerification.includes("access_grant_in_both_population_branches") &&
    liveVerification.includes("public_no_execute")
);
const accessMetricsStart = liveVerification.lastIndexOf(
  "-- PASS immediately after migration: malformed_customer_ids"
);
const accessMetricsEnd = liveVerification.indexOf(
  "-- PASS before checkout reopens: both duplicate counts",
  accessMetricsStart
);
const accessMetrics = liveVerification.slice(accessMetricsStart, accessMetricsEnd);
const accessMetricFilter = (metric: string) => {
  const endMarker = `) as ${metric}`;
  const end = accessMetrics.indexOf(endMarker);
  const start = accessMetrics.lastIndexOf("count(*) filter (", end);
  return accessMetrics.slice(start, end + endMarker.length);
};
const activePaidMissingMetric = accessMetricFilter(
  "active_paid_rows_missing_exact_subscription"
);
assert.doesNotMatch(activePaidMissingMetric, /access_granted_at/);
const activePaidShapeMetric = accessMetricFilter(
  "active_paid_rows_with_exact_local_shape"
);
assert.doesNotMatch(activePaidShapeMetric, /access_granted_at/);
assert.ok(
  accessMetricFilter("active_free_access_rows").includes(
    "access_granted_at is not null"
  ) &&
    accessMetricFilter("active_access_rows").includes(
      "access_granted_at is not null"
    )
);
assert.ok(
  backfillVerifier.includes("expectedRound80Migrations.length, 14") &&
    backfillVerifier.includes("expectedRound80MigrationFiles") &&
    backfillVerifier.includes(
      'PASS verify-subscription-binding-backfill (offline, 217 assertions)'
    )
);
assert.ok(
    /begin;\s+set local lock_timeout/.test(migrationBundler) &&
    migrationBundler.includes("\\n\\ncommit;\\n") &&
    migrationBundler.includes('ledgerMode: "atomic-version-insert"') &&
    migrationBundler.includes("i.indpred is null") &&
    migrationBundler.includes("i.indnatts = 1") &&
    migrationBundler.includes("i.indexprs is null") &&
    migrationBundler.includes("scripts/r80-live-verification.sql") &&
    migrationBundler.includes("sql-read-only-mask.mjs") &&
    migrationBundler.includes("maskSqlNonCode") &&
    migrationBundler.includes("verificationStatements.some") &&
    migrationBundler.includes("nextval|setval|pg_advisory_lock") &&
    migrationBundler.includes("no\\s+key\\s+update") &&
    migrationBundler.includes("verification: {") &&
    migrationBundler.includes("verificationInventories") &&
    migrationBundler.includes('"functions",') &&
    migrationBundler.includes(
      "insert into supabase_migrations.schema_migrations (version)"
    )
);
assert.ok(
  checkoutMaintenanceRunbook.includes("standalone release") &&
    checkoutMaintenanceRunbook.includes("at least 90 seconds") &&
    checkoutMaintenanceRunbook.includes("separate reopen commit")
);
assert.ok(
  creationReviewOperator.includes("--confirm-reviewed-evidence") &&
    creationReviewOperator.includes("resolveCheckoutCreationReviewWithSession") &&
    creationReviewOperator.includes("resolveCheckoutCreationReviewNoCreate") &&
    creationReviewOperator.includes("countPendingCheckoutCreationReviews")
);
assert.ok(
  creationReviewRunbook.includes(
    "scripts/resolve-checkout-creation-review.mts"
  ) &&
    creationReviewRunbook.includes("with-session PROFILE_UUID") &&
    creationReviewRunbook.includes("no-create PROFILE_UUID")
);

console.log("PASS verify-r80-release-hardening (offline, access-only release contract)");
