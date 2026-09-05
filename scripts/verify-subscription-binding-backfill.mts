// Fully local static checks for the one-time exact subscription binding path.
// No env files, provider clients, network, database, or app data.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260828000000_alpha_renewal_cancellation.sql",
    import.meta.url
  ),
  "utf8"
);
const checkoutMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260827000000_checkout_fulfillment_claims.sql",
    import.meta.url
  ),
  "utf8"
);
const script = readFileSync(
  new URL("./backfill-exact-alpha-subscriptions.mts", import.meta.url),
  "utf8"
);
const bundler = readFileSync(
  new URL("./build-r80-migration-bundle.mjs", import.meta.url),
  "utf8"
);
const stripeClientSource = readFileSync(
  new URL("../lib/stripe.ts", import.meta.url),
  "utf8"
);
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
const expectedRound80MigrationFiles = [
  {
    name: "20260827000000_checkout_fulfillment_claims.sql",
    sha256: "c24039bf787e3749db831d7698af1ff4612df91f30688b25a7dd612cb9405c5c",
  },
  {
    name: "20260827010000_stripe_webhook_event_leases.sql",
    sha256: "bb59fca2872ed3be0ec6961a18e31349a2838444a9677d830b9bd19fd455aedc",
  },
  {
    name: "20260827020000_delivery_suppression_pending.sql",
    sha256: "564f61ac032810ea03dca35233641b2d56eef932e22fc693eee3caad157f70d8",
  },
  {
    name: "20260827030000_legacy_checkout_fulfillments.sql",
    sha256: "bc51bb2692170e28ed1dae713b28afa885a5f8602ca4f095be43d404a3362d09",
  },
  {
    name: "20260827040000_refund_review_resolution.sql",
    sha256: "b323f4f5d99b9412524f99b659e80fee0b8171228010195bf6cbeadce17843fa",
  },
  {
    name: "20260827050000_daily_paid_call_budget.sql",
    sha256: "9ee5acb47bc9609d49e476dfd4ed2050be98f8d29d79515a7a01c54822f90a72",
  },
  {
    name: "20260827200000_issues_rls_subscribed_access.sql",
    sha256: "7e7ab705a99153de6194abb15b27e993dca3c0e7376465001ed757e5cee1206c",
  },
  {
    name: "20260828000000_alpha_renewal_cancellation.sql",
    sha256: "5d8fe1553ea022a16793f80b34616d50a6fb6ef7f329862cc39cc252eeb2183e",
  },
  {
    name: "20260830000000_invite_access.sql",
    sha256: "3dc3107f7a867848c50a3607f61b53c9a9c13c33dd2dc792d49d1676d7bffe64",
  },
  {
    name: "20260830010000_weekly_send_delivery_cursors.sql",
    sha256: "2c0618cb391876eb461b6a18adba44ab90d101c55c558e80a72c43eb90af535d",
  },
  {
    name: "20260830020000_account_privacy_retry_bounds.sql",
    sha256: "7a15e7a532273503af760985f38aeecbf951c2797c08fbc3683db6c5b1a832e5",
  },
  {
    name: "20260830030000_distributed_rate_limits.sql",
    sha256: "ce883004cdeadf566ed3a2f92b62857c56e4e22aec7c769b9ab4e2e2c370ca57",
  },
  {
    name: "20260830040000_quantity_update_leases.sql",
    sha256: "ac6a67cba64374b5f9b08585c297fd32fbc5dd5d183c889500b878392a14b61d",
  },
  {
    name: "20260830050000_resend_suppression_causality.sql",
    sha256: "97f3916f438ba4ab4bd2f6226a8dc3b0dea661b7c44c03189e7543310a144c7f",
  },
] as const;
const migrationNames = (value: string) =>
  [...value.matchAll(/"(\d{14}_[a-z0-9_]+\.sql)"/g)].map(
    (match) => match[1]
  );
const backfillMigrationBlock =
  script.match(/const ROUND_80_MIGRATIONS = \[([\s\S]*?)\]\s+as const;/)?.[1] ||
  "";
const bundlerMigrationBlock =
  bundler.match(/const migrations = \[([\s\S]*?)\];/)?.[1] || "";
assert.deepEqual(migrationNames(backfillMigrationBlock), expectedRound80Migrations);
assert.deepEqual(migrationNames(bundlerMigrationBlock), expectedRound80Migrations);
assert.equal(expectedRound80Migrations.length, 14);
assert.deepEqual(
  expectedRound80Migrations.map((name) => ({
    name,
    sha256: crypto
      .createHash("sha256")
      .update(
        readFileSync(
          new URL(`../supabase/migrations/${name}`, import.meta.url),
          "utf8"
        ).trimEnd()
      )
      .digest("hex"),
  })),
  expectedRound80MigrationFiles
);
const bundlerChecksumBlock =
  bundler.match(
    /const expectedMigrationSha256 = new Map\(\[([\s\S]*?)\]\);/
  )?.[1] || "";
assert.deepEqual(
  [...bundlerChecksumBlock.matchAll(/"(\d{14}_[a-z0-9_]+\.sql)",\s*"([0-9a-f]{64})"/g)].map(
    (match) => ({ name: match[1], sha256: match[2] })
  ),
  expectedRound80MigrationFiles
);

const functionBody =
  migration.match(
    /create or replace function public\.bind_existing_alpha_subscription\([\s\S]*?\n\$\$;/
  )?.[0] || "";
assert.ok(functionBody);
assert.match(functionBody, /security definer\s+set search_path = public/);
assert.match(functionBody, /p_provider_status not in \('active', 'trialing', 'past_due'\)/);
assert.match(functionBody, /p_provider_observed_at < now\(\) - interval '5 minutes'/);
assert.match(functionBody, /return 'stale_provider_evidence'/);

const ownerLock = functionBody.indexOf("80425080");
const customerLock = functionBody.indexOf("80425082");
const pairLock = functionBody.indexOf("80425081");
const rowLock = functionBody.indexOf("for update;");
assert.ok(ownerLock > 0);
assert.ok(ownerLock < customerLock);
assert.ok(customerLock < pairLock);
assert.ok(pairLock < rowLock);
assert.match(functionBody, /pg_try_advisory_xact_lock/);
assert.match(functionBody, /return 'busy'/);
assert.match(functionBody, /stripe_subscription_id = p_subscription_id/);
assert.match(functionBody, /u\.stripe_subscription_id is null/);
assert.match(functionBody, /u\.subscribed_at is not distinct from p_expected_subscribed_at/);
assert.match(functionBody, /u\.cancelled_at is not distinct from p_expected_cancelled_at/);
assert.match(functionBody, /u\.topic_quota is not distinct from p_expected_topic_quota/);
assert.ok(!/set[\s\S]*topic_quota\s*=/.test(functionBody));
assert.ok(!/set[\s\S]*subscribed_at\s*=/.test(functionBody));
assert.ok(!/set[\s\S]*cancelled_at\s*=/.test(functionBody));
assert.match(functionBody, /account_deletion_sagas/);
assert.match(functionBody, /checkout_profiles/);
assert.match(functionBody, /legacy_checkout_fulfillments/);
assert.match(functionBody, /refund_reviews/);
assert.match(functionBody, /return 'reservation_conflict'/);
assert.match(functionBody, /v_already_bound boolean/);
assert.match(
  functionBody,
  /v_already_bound :=[\s\S]*stripe_customer_id is not distinct from p_customer_id[\s\S]*stripe_subscription_id is not distinct from p_subscription_id/
);
const alreadyBoundAssignment = functionBody.indexOf("v_already_bound :=");
const reservationChecks = functionBody.indexOf("from public.account_deletion_sagas");
const strictCheckoutConflict = functionBody.indexOf("p.owner_user_id is null");
const alreadyBoundReturn = functionBody.indexOf("if v_already_bound then");
assert.ok(alreadyBoundAssignment > rowLock);
assert.ok(reservationChecks > alreadyBoundAssignment);
assert.ok(strictCheckoutConflict > reservationChecks);
assert.ok(alreadyBoundReturn > strictCheckoutConflict);
assert.match(
  functionBody,
  /p\.owner_user_id is null[\s\S]*p\.provisioned_user_id is null[\s\S]*p\.owner_user_id is not null[\s\S]*p\.owner_user_id <> p_user_id[\s\S]*p\.provisioned_user_id is not null[\s\S]*p\.provisioned_user_id <> p_user_id/
);

const checkoutOwnerTrigger =
  checkoutMigration.match(
    /create or replace function public\.block_checkout_for_deleting_owner\(\)[\s\S]*?\n\$\$;/
  )?.[0] || "";
assert.ok(checkoutOwnerTrigger);
assert.match(
  checkoutOwnerTrigger,
  /new\.owner_user_id is not null[\s\S]*new\.provisioned_user_id is not null[\s\S]*new\.owner_user_id <> new\.provisioned_user_id[\s\S]*raise exception 'checkout owner and provisioned user must match'/
);

const signature =
  "public.bind_existing_alpha_subscription(uuid, text, text, text, integer, timestamptz, timestamptz, timestamptz, integer)";
assert.ok(
  migration.includes(`revoke all on function ${signature}\n  from public, anon, authenticated;`)
);
assert.ok(
  migration.includes(`grant execute on function ${signature}\n  to service_role;`)
);

const section = (start: string, end: string) => {
  const startAt = script.indexOf(start);
  const endAt = script.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0, `missing section start: ${start}`);
  assert.ok(endAt > startAt, `missing section end: ${end}`);
  return script.slice(startAt, endAt);
};

assert.ok(script.indexOf("--confirm-reviewed-live-alpha") < script.indexOf("loadEnvLocal();"));
assert.match(script, /argv\[0\] === "--apply"/);
assert.match(script, /--approve-sha256/);
assert.match(script, /execFileSync\("git", \["status", "--porcelain"\]/);
assert.match(script, /\^cus_\[A-Za-z0-9\]\+\$/);
assert.match(script, /\^sub_\[A-Za-z0-9\]\+\$/);
assert.match(script, /subscription\.items\.data\.length !== 1/);
assert.match(script, /shape\.quantity \* 5/);
assert.match(
  script,
  /const canonicalVerificationSource = `\$\{readFileSync\([\s\S]*"utf8"[\s\S]*\)\.trimEnd\(\)\}\\n`/
);
assert.match(
  script,
  /sha256\(canonicalVerificationSource\) !== parsed\.verification!\.sourceSha256/
);
assert.match(
  script,
  /const ROUND_80_VERSIONS = ROUND_80_MIGRATIONS\.map\(\(name\) => name\.slice\(0, 14\)\)/
);
assert.match(
  script,
  /const expectedRound80Files = ROUND_80_MIGRATIONS\.map\(\(name\) => \(\{[\s\S]*?sha256: sha256\([\s\S]*?readFileSync\(path\.resolve\("supabase\/migrations", name\), "utf8"\)\.trimEnd\(\)[\s\S]*?\}\)\);/
);
assert.match(
  script,
  /JSON\.stringify\(parsed\.files\) !== JSON\.stringify\(expectedRound80Files\)/
);
assert.match(
  script,
  /parsed\.builderSha256 !== expectedBundleBuilderSha256/
);

const reverseScan = section(
  "async function loadAllAlphaSubscriptions",
  "async function loadAllBillingRows"
);
assert.match(reverseScan, /stripe\.subscriptions\.list\(/);
assert.match(reverseScan, /price: STRIPE_PRICE_ID/);
assert.match(reverseScan, /status: "all"/);
assert.match(reverseScan, /limit: PROVIDER_PAGE_SIZE/);
assert.match(reverseScan, /starting_after: startingAfter/);
assert.match(reverseScan, /for \(;;\)/);
assert.match(reverseScan, /let pageCount = 0/);
assert.match(reverseScan, /pageCount >= MAX_PROVIDER_PAGES/);
assert.match(reverseScan, /subscriptions\.length >= MAX_PROVIDER_SUBSCRIPTIONS/);
assert.match(reverseScan, /subscriptions\.length > MAX_PROVIDER_SUBSCRIPTIONS/);
assert.match(reverseScan, /if \(!page\.has_more\) break/);
assert.match(reverseScan, /page\.data\[page\.data\.length - 1\]\?\.id/);
assert.match(reverseScan, /!nextCursor \|\| nextCursor === startingAfter/);
assert.match(reverseScan, /seen\.has\(subscription\.id\)/);
assert.doesNotMatch(reverseScan, /\bcustomer\s*:/);
assert.match(script, /const PROVIDER_PAGE_SIZE = 100/);
assert.match(script, /const MAX_PROVIDER_PAGES = 10/);

const allBillingRows = section(
  "async function loadAllBillingRows",
  "async function loadBoundedRows"
);
assert.match(
  allBillingRows,
  /stripe_customer_id\.not\.is\.null,stripe_subscription_id\.not\.is\.null/
);
assert.match(allBillingRows, /count: "exact", head: true/);
assert.match(allBillingRows, /count > MAX_LOCAL_BILLING_ROWS/);
assert.match(allBillingRows, /while \(rows\.length < count\)/);
assert.match(allBillingRows, /query = query\.gt\("id", cursor\)/);
assert.match(allBillingRows, /rows\.length !== count/);
assert.doesNotMatch(allBillingRows, /\.not\("subscribed_at"/);
assert.doesNotMatch(allBillingRows, /cancelled_at\.gt/);
assert.match(script, /subscribed_at: string \| null/);

const boundedRows = section(
  "async function loadBoundedRows",
  "async function loadRenewalReservations"
);
assert.match(boundedRows, /count: "exact", head: true/);
assert.match(boundedRows, /count > MAX_CONFLICT_ROWS_PER_TABLE/);
assert.match(boundedRows, /for \(let from = 0; from < count; from \+= LOCAL_PAGE_SIZE\)/);
assert.match(boundedRows, /query\.range\(/);
assert.match(boundedRows, /rows\.length !== count/);

const renewalReservations = section(
  "async function loadRenewalReservations",
  "async function loadConflictSnapshot"
);
assert.match(
  renewalReservations,
  /\.not\("renewal_cancel_pending_at", "is", null\)/
);
assert.match(renewalReservations, /count > MAX_CONFLICT_ROWS_PER_TABLE/);
assert.match(renewalReservations, /while \(rows\.length < count\)/);
assert.match(renewalReservations, /rows\.length !== count/);

const snapshotLoader = section(
  "async function loadConflictSnapshot",
  "function hasReservationConflict"
);
for (const table of [
  "account_deletion_sagas",
  "account_deletion_alpha_subscriptions",
  "checkout_profiles",
  "legacy_checkout_fulfillments",
  "refund_reviews",
]) {
  assert.ok(snapshotLoader.includes(`"${table}"`), `${table} is not snapshotted`);
}
assert.match(snapshotLoader, /loadRenewalReservations\(sb\)/);

const conflictAudit = section(
  "function hasReservationConflict",
  "function buildProviderAudit"
);
assert.match(conflictAudit, /user\.renewal_cancel_pending_at/);
assert.match(conflictAudit, /user\.renewal_cancel_customer_id/);
assert.match(conflictAudit, /user\.renewal_cancel_subscription_id/);
assert.match(conflictAudit, /snapshot\.deletionSagas\.some/);
assert.match(conflictAudit, /row\.user_id === user\.id/);
assert.match(conflictAudit, /row\.stripe_customer_id === customerId/);
assert.match(conflictAudit, /row\.stripe_subscription_id === subscriptionId/);
assert.match(conflictAudit, /snapshot\.deletionSubscriptions\.some/);
assert.match(conflictAudit, /row\.user_id !== user\.id/);
assert.match(conflictAudit, /row\.customer_id === customerId \|\| row\.subscription_id === subscriptionId/);
assert.match(conflictAudit, /snapshot\.renewalReservations\.some/);
assert.match(conflictAudit, /row\.renewal_cancel_customer_id === customerId/);
assert.match(conflictAudit, /row\.renewal_cancel_subscription_id === subscriptionId/);
for (const state of ["open", "creating", "paid", "recovering", "deleting"]) {
  assert.ok(conflictAudit.includes(`"${state}"`), `missing checkout state ${state}`);
}
for (const state of ["pending", "awaiting_issue", "deleting"]) {
  assert.ok(conflictAudit.includes(`"${state}"`), `missing legacy state ${state}`);
}
assert.match(conflictAudit, /const unresolvedRefundStates = new Set\(\["pending", "reviewed"\]\)/);
assert.match(
  conflictAudit,
  /row\.customer_id === customerId &&[\s\S]*row\.subscription_id === subscriptionId/
);
assert.match(
  conflictAudit,
  /row\.winner_customer_id === customerId &&[\s\S]*row\.winner_subscription_id === subscriptionId/
);
assert.match(
  conflictAudit,
  /row\.id !== user\.id &&[\s\S]*row\.stripe_customer_id === customerId[\s\S]*row\.stripe_subscription_id === subscriptionId/
);
assert.match(
  conflictAudit,
  /row\.owner_user_id === null && row\.provisioned_user_id === null[\s\S]*row\.owner_user_id !== null && row\.owner_user_id !== user\.id[\s\S]*row\.provisioned_user_id !== null &&[\s\S]*row\.provisioned_user_id !== user\.id/
);
assert.match(conflictAudit, /row\.user_id !== user\.id/);

const providerAudit = section("function buildProviderAudit", "async function discover");
assert.match(providerAudit, /const terminal = isTerminalSubscriptionStatus\(subscription\.status\)/);
assert.match(providerAudit, /if \(!identifierSafe\)[\s\S]*if \(!terminal\)/);
assert.match(providerAudit, /if \(!shape\.ok && !terminal\)/);
assert.match(
  providerAudit,
  /const nonTerminal = customerSubscriptions\.filter\([\s\S]*!isTerminalSubscriptionStatus\(subscription\.status\)/
);
assert.match(providerAudit, /if \(nonTerminal\.length > 1\)/);
assert.match(providerAudit, /row\.stripe_customer_id === customerId/);
assert.match(providerAudit, /row\.stripe_subscription_id === subscription\.id/);
assert.match(providerAudit, /subscriptionOwners\.some\(\(row\) => row\.id !== owner\.id\)/);
assert.match(providerAudit, /const localAccess = hasCurrentLocalAccess\(owner, observedAt\)/);
assert.match(
  providerAudit,
  /if \(!KNOWN_SUBSCRIPTION_STATUSES\.has\(subscription\.status\)\)[\s\S]*decision: "provider_status_unknown"/
);
assert.match(providerAudit, /if \(grantsAccess !== localAccess\)/);
assert.doesNotMatch(providerAudit, /if \(!localAccess\)/);
for (const blocker of [
  "provider_status_unknown",
  "provider_nonterminal_ambiguous",
  "provider_nonterminal_local_missing",
  "provider_nonterminal_local_ambiguous",
  "provider_access_state_mismatch",
  "provider_nonterminal_binding_missing",
  "provider_nonterminal_binding_mismatch",
]) {
  assert.ok(providerAudit.includes(`"${blocker}"`), `missing provider blocker ${blocker}`);
}

const discoverBody = section("async function discover", "function canonicalDiscovery");
assert.match(discoverBody, /const subscriptions = await loadAllAlphaSubscriptions\(stripe\)/);
assert.match(discoverBody, /const conflictSnapshot = await loadConflictSnapshot\(sb\)/);
assert.match(
  discoverBody,
  /const nonTerminal = shaped\.filter\([\s\S]*!isTerminalSubscriptionStatus\(subscription\.status\)/
);
assert.match(discoverBody, /if \(nonTerminal\.length > 1\)/);
const selectedSubscription = discoverBody.indexOf("const subscription = eligible[0].subscription");
const conflictCall = discoverBody.indexOf("hasReservationConflict(");
const existingVerified = discoverBody.indexOf('exact.decision = "verified_existing"');
assert.ok(selectedSubscription >= 0);
assert.ok(conflictCall > selectedSubscription);
assert.ok(existingVerified > conflictCall);
assert.match(
  discoverBody,
  /hasReservationConflict\([\s\S]*user,[\s\S]*customerId,[\s\S]*subscription\.id,[\s\S]*billingRows,[\s\S]*conflictSnapshot/
);
assert.match(
  discoverBody,
  /exact\.decision = "local_reservation_conflict";[\s\S]*else if \(user\.topic_quota/
);

const databaseDeadline = section(
  "const boundedDatabaseFetch",
  "loadEnvLocal();"
);
assert.match(script, /const DATABASE_REQUEST_TIMEOUT_MS = 15_000/);
assert.match(databaseDeadline, /new AbortController\(\)/);
assert.match(databaseDeadline, /const upstreamSignals = \[/);
assert.match(databaseDeadline, /input instanceof Request \? input\.signal/);
assert.match(databaseDeadline, /addEventListener\("abort", relayAbort/);
assert.match(databaseDeadline, /setTimeout\(/);
assert.match(databaseDeadline, /signal: controller\.signal/);
assert.match(databaseDeadline, /clearTimeout\(timeout\)/);
assert.match(databaseDeadline, /for \(const \{ signal, relayAbort \} of relays\)/);
assert.match(databaseDeadline, /signal\.removeEventListener\("abort", relayAbort\)/);
assert.match(script, /global: \{ fetch: boundedDatabaseFetch \}/);

assert.match(script, /formatVersion: 3/);
assert.match(script, /providerSubscriptionCount/);
assert.match(script, /providerIssueCount/);
assert.match(script, /providerInventorySha256/);
assert.match(script, /canonicalDiscovery/);
assert.match(script, /manifest\.providerIssueCount !== 0/);
assert.match(script, /discovery\.providerIssues\.length !== 0/);
assert.match(script, /finalDiscovery\.providerIssues\.length !== 0/);
assert.match(
  script,
  /const expectedFinalEvidence: Evidence\[\] = evidence\.map/
);
assert.match(
  script,
  /JSON\.stringify\(finalEvidence\) !== JSON\.stringify\(expectedFinalEvidence\)/
);
assert.match(
  script,
  /providerInventorySha256\(finalDiscovery\) !==[\s\S]*manifest\.providerInventorySha256/
);
assert.match(
  script,
  /manifest\.blockedCount > 0 \|\| manifest\.providerIssueCount > 0/
);
assert.match(script, /approved manifest SHA256 does not match/);
assert.match(script, /stripe\.subscriptions\.retrieve/);
assert.match(script, /provider evidence unavailable before apply item/);
assert.match(script, /binding RPC stopped at item \$\{index \+ 1\}/);
assert.doesNotMatch(
  script,
  /(?:error|readError|countError)\?*\.message|String\(result\.data\)/
);
assert.match(script, /bind_existing_alpha_subscription/);
assert.match(script, /result\.data === "busy"/);
assert.match(script, /const repairable = evidence\.filter/);
assert.match(script, /every binding and provider coverage check is exact/);
assert.match(script, /const stripe = getStripeClient\(\)/);
assert.match(stripeClientSource, /timeout: 20_000/);
assert.match(stripeClientSource, /maxNetworkRetries: 1/);
assert.match(stripeClientSource, /httpClient: Stripe\.createFetchHttpClient\(\)/);
assert.ok(!/stripe\.[A-Za-z]+\.(create|update|cancel|del|remove|refund)\s*\(/.test(script));
assert.ok(!script.includes("sendOpsAlert"));
assert.ok(!script.includes("email,"));
assert.ok(!script.includes("first_name"));
assert.ok(!script.includes("profile_text"));

assert.match(bundler, /ledgerMode: "atomic-version-insert"/);
assert.match(bundler, /ledgerVersions: migrationVersions/);
assert.match(bundler, /scripts\/r80-live-verification\.sql/);
assert.match(bundler, /Round 80 live verification SQL must remain read-only/);
assert.match(bundler, /verification: \{/);
assert.match(bundler, /Supabase migration ledger is missing/);
assert.match(bundler, /i\.indpred is null/);
assert.match(bundler, /i\.indnatts = 1/);
assert.match(bundler, /i\.indexprs is null/);
assert.match(bundler, /Round 80 migration ledger recording was incomplete/);
assert.match(bundler, /insert into supabase_migrations\.schema_migrations \(version\)/);

console.log("PASS verify-subscription-binding-backfill (offline, 217 assertions)");
