// Fully local Round 80 reconciliation verification. It imports only the pure
// audit functions, injects in-memory fixtures, and reads source text. Direct
// execution of the live reconciler is guarded, so this file does not load env
// files or contact GitHub, Stripe, Supabase, Resend, or an ops webhook.
// Run: npx tsx scripts/verify-reconcile-findings-cap.mts
import { readFileSync } from "node:fs";
import {
  EXACT_ALPHA_PRICE_ID,
  buildPrivateReconciliationAlert,
  buildPublicReconciliationSummary,
  reconcileExactAlphaBindings,
  type LocalBillingSnapshot,
  type ProviderSubscriptionSnapshot,
  type ReconciliationFindingType,
} from "./reconcile-stripe-vs-supabase.mts";

let pass = 0;
let fail = 0;
const check = (label: string, condition: boolean) => {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) pass += 1;
  else fail += 1;
};

const OBSERVED_AT = new Date("2026-08-30T12:00:00.000Z");

function provider(
  overrides: Partial<ProviderSubscriptionSnapshot> = {}
): ProviderSubscriptionSnapshot {
  return {
    id: "sub_fixture1",
    customerId: "cus_fixture1",
    status: "active",
    cancelAt: null,
    itemsHasMore: false,
    items: [{ priceId: EXACT_ALPHA_PRICE_ID, quantity: 1 }],
    ...overrides,
  };
}

function user(
  overrides: Partial<LocalBillingSnapshot> = {}
): LocalBillingSnapshot {
  return {
    id: "user_fixture1",
    stripeCustomerId: "cus_fixture1",
    stripeSubscriptionId: "sub_fixture1",
    subscribedAt: "2026-08-01T12:00:00.000Z",
    cancelledAt: null,
    topicQuota: 5,
    ...overrides,
  };
}

function audit(
  subscriptions: ProviderSubscriptionSnapshot[],
  users: LocalBillingSnapshot[]
) {
  return reconcileExactAlphaBindings({ subscriptions, users, observedAt: OBSERVED_AT });
}

function hasType(
  findings: ReturnType<typeof audit>,
  type: ReconciliationFindingType
): boolean {
  return findings.some((finding) => finding.type === type);
}

console.log("(1) exact Alpha price and clean bidirectional binding");
{
  check(
    "(1a) the exact dedicated Alpha price is pinned",
    EXACT_ALPHA_PRICE_ID === "price_1TWfeHAhrDpDN9sHC2Ay0w7h"
  );
  check(
    "(1b) one exact active provider/local pair is clean",
    audit([provider()], [user()]).length === 0
  );
  const cancelAt = Date.parse("2026-09-30T12:00:00.000Z") / 1000;
  check(
    "(1c) an exact future period-end cancellation remains active and clean",
    audit(
      [provider({ cancelAt })],
      [user({ cancelledAt: "2026-09-30T12:00:00.000Z" })]
    ).length === 0
  );
  check(
    "(1d) one terminal historical Alpha subscription may remain unmapped",
    audit(
      [
        provider(),
        provider({ id: "sub_terminal1", status: "canceled" }),
      ],
      [user()]
    ).length === 0
  );
}

console.log("(2) provider-side shape and ownership blockers");
{
  const multiple = audit(
    [
      provider(),
      provider({ id: "sub_fixture2", status: "paused" }),
    ],
    [user()]
  );
  check(
    "(2a) a second nonterminal Alpha subscription is rejected",
    hasType(multiple, "provider_multiple_nonterminal")
  );

  const mixed = audit(
    [
      provider({
        items: [
          { priceId: EXACT_ALPHA_PRICE_ID, quantity: 1 },
          { priceId: "price_other1", quantity: 1 },
        ],
      }),
    ],
    [user()]
  );
  check(
    "(2b) mixed provider items are rejected",
    hasType(mixed, "provider_mixed_items")
  );
  check(
    "(2c) an active local row bound to mixed items lacks an exact provider pair",
    hasType(mixed, "local_active_exact_pair_missing")
  );

  const truncated = audit(
    [provider({ itemsHasMore: true })],
    [user()]
  );
  check(
    "(2d) a truncated provider item list is rejected as unsafe",
    hasType(truncated, "provider_mixed_items")
  );

  const invalidQuantity = audit(
    [provider({ items: [{ priceId: EXACT_ALPHA_PRICE_ID, quantity: 0 }] })],
    [user()]
  );
  check(
    "(2e) an out-of-range provider quantity is rejected",
    hasType(invalidQuantity, "provider_quantity_invalid")
  );

  const wrongPrice = audit(
    [provider({ items: [{ priceId: "price_other1", quantity: 1 }] })],
    [user()]
  );
  check(
    "(2f) a provider object without the exact Alpha price is rejected",
    hasType(wrongPrice, "provider_price_mismatch") &&
      hasType(wrongPrice, "local_active_exact_pair_missing")
  );

  const orphan = audit([provider()], []);
  check(
    "(2g) a nonterminal provider subscription without a local owner is rejected",
    hasType(orphan, "provider_orphan")
  );

  const unknown = audit(
    [provider({ status: "future_status" })],
    [user({ cancelledAt: "2026-08-29T12:00:00.000Z" })]
  );
  check(
    "(2h) an unknown provider status fails closed",
    hasType(unknown, "provider_status_unknown")
  );
}

console.log("(3) exact local Customer + Subscription binding blockers");
{
  const missingBinding = audit(
    [provider()],
    [user({ stripeSubscriptionId: null })]
  );
  check(
    "(3a) a nonterminal provider subscription requires the stored local Subscription",
    hasType(missingBinding, "provider_binding_missing")
  );
  check(
    "(3b) an active billed local row without stripe_subscription_id is rejected",
    hasType(missingBinding, "local_binding_missing") &&
      hasType(missingBinding, "local_active_exact_pair_missing")
  );

  const wrongBinding = audit(
    [provider()],
    [user({ stripeSubscriptionId: "sub_wrong1" })]
  );
  check(
    "(3c) a different stored Subscription is rejected from both directions",
    hasType(wrongBinding, "provider_binding_mismatch") &&
      hasType(wrongBinding, "local_provider_missing")
  );

  const wrongCustomer = audit(
    [provider()],
    [user({ stripeCustomerId: "cus_wrong1" })]
  );
  check(
    "(3d) a stored Subscription under the wrong Customer is rejected",
    hasType(wrongCustomer, "local_provider_pair_mismatch") &&
      hasType(wrongCustomer, "local_active_exact_pair_missing")
  );

  const localOnly = audit([], [user()]);
  check(
    "(3e) an active local billed row without an exact provider object is rejected",
    hasType(localOnly, "local_provider_missing") &&
      hasType(localOnly, "local_active_exact_pair_missing")
  );

  const duplicateCustomer = audit(
    [provider()],
    [user(), user({ id: "user_fixture2", stripeSubscriptionId: null })]
  );
  check(
    "(3f) duplicate local Customer ownership is rejected",
    hasType(duplicateCustomer, "local_customer_ambiguous") &&
      hasType(duplicateCustomer, "provider_local_customer_ambiguous")
  );

  const duplicateSubscription = audit(
    [provider()],
    [user(), user({ id: "user_fixture2", stripeCustomerId: "cus_fixture2" })]
  );
  check(
    "(3g) duplicate local Subscription ownership is rejected",
    hasType(duplicateSubscription, "local_subscription_ambiguous")
  );
}

console.log("(4) status, access, cancellation, quantity, and quota checks");
{
  const pausedActive = audit(
    [provider({ status: "paused" })],
    [user()]
  );
  check(
    "(4a) a paused provider subscription cannot retain local access",
    hasType(pausedActive, "access_status_mismatch")
  );

  const activeEnded = audit(
    [provider()],
    [user({ cancelledAt: "2026-08-29T12:00:00.000Z" })]
  );
  check(
    "(4b) an access-granting provider status cannot map to ended local access",
    hasType(activeEnded, "access_status_mismatch")
  );

  const pausedEnded = audit(
    [provider({ status: "paused" })],
    [user({ cancelledAt: "2026-08-29T12:00:00.000Z" })]
  );
  check(
    "(4c) paused can retain the exact identity when local access is off",
    pausedEnded.length === 0
  );

  const cancellation = audit(
    [
      provider({
        cancelAt: Date.parse("2026-09-30T12:00:00.000Z") / 1000,
      }),
    ],
    [user({ cancelledAt: "2026-10-01T12:00:00.000Z" })]
  );
  check(
    "(4d) the exact provider period end must match local cancelled_at",
    hasType(cancellation, "cancellation_mismatch")
  );

  const quota = audit(
    [provider({ items: [{ priceId: EXACT_ALPHA_PRICE_ID, quantity: 2 }] })],
    [user({ topicQuota: 5 })]
  );
  check(
    "(4e) provider quantity must map to the exact five-topic quota grid",
    hasType(quota, "quantity_quota_mismatch")
  );
}

console.log("(5) public aggregation and private exact evidence");
{
  const findings = audit(
    [provider()],
    [user({ stripeSubscriptionId: "sub_private1" })]
  );
  const publicSummary = buildPublicReconciliationSummary({
    subscriptions: [provider()],
    users: [user({ stripeSubscriptionId: "sub_private1" })],
    findings,
    checkedAt: OBSERVED_AT,
  });
  const publicJson = JSON.stringify(publicSummary);
  check(
    "(5a) public output keeps real totals and deterministic type counts",
    publicSummary.findingsCount === findings.length &&
      publicSummary.findingTypes.length > 0 &&
      publicSummary.findingTypes.every(
        (entry, index, entries) =>
          entry.count > 0 &&
          (index === 0 || entries[index - 1].type < entry.type)
      )
  );
  check(
    "(5b) public JSON contains no exact Customer, Subscription, user, or detail",
    !/cus_fixture1|sub_fixture1|sub_private1|user_fixture1|Local owner|locally held/.test(
      publicJson
    )
  );

  const privateAlert = buildPrivateReconciliationAlert(findings);
  check(
    "(5c) private Alpha alert retains exact identifiers and details",
    /cus_fixture1|sub_fixture1|sub_private1|user_fixture1/.test(privateAlert)
  );

  const repeated = Array.from({ length: 30 }, (_, index) => ({
    type: "provider_orphan" as const,
    detail: `private detail ${index}`,
    stripeCustomerId: `cus_private${index}`,
    stripeSubscriptionId: `sub_private${index}`,
  }));
  const capped = buildPrivateReconciliationAlert(repeated);
  check(
    "(5d) private alert keeps the 25-item cap and exact omitted count",
    capped.split("\n- [").length === 25 &&
      capped.includes("(+5 more exact findings omitted from this private alert.)")
  );
  check(
    "(5e) private alert never points to public logs for exact findings",
    !/GitHub Actions log|full findings list|see the full findings/i.test(capped)
  );
}

console.log("(6) live source remains bounded, read-only, and privacy-safe");
{
  const source = readFileSync(
    new URL("./reconcile-stripe-vs-supabase.mts", import.meta.url),
    "utf8"
  );
  const workflow = readFileSync(
    new URL("../.github/workflows/stripe-reconcile.yml", import.meta.url),
    "utf8"
  );
  const publicStart = source.indexOf("const publicSummary = buildPublicReconciliationSummary");
  const privateStart = source.indexOf("const privateBody = buildPrivateReconciliationAlert", publicStart);
  const publicSection = source.slice(publicStart, privateStart);

  check(
    "(6a) Stripe inventory is filtered by the exact Alpha price and all statuses",
    /price: STRIPE_PRICE_ID/.test(source) &&
      /status: "all"/.test(source) &&
      source.includes(EXACT_ALPHA_PRICE_ID)
  );
  check(
    "(6b) provider scan has independent page and object caps with progress checks",
    /MAX_PROVIDER_PAGES = 10/.test(source) &&
      /MAX_PROVIDER_SUBSCRIPTIONS/.test(source) &&
      /provider pagination made no progress/.test(source)
  );
  check(
    "(6c) local inventory includes stripe_subscription_id and exact count drift checks",
    /stripe_customer_id, stripe_subscription_id, subscribed_at, cancelled_at, topic_quota/.test(
      source
    ) &&
      /count: "exact"/.test(source) &&
      /local billing row count changed during pagination/.test(source)
  );
  check(
    "(6d) Supabase reads have a bounded deadline that preserves upstream abort",
    /DATABASE_REQUEST_TIMEOUT_MS = 15_000/.test(source) &&
      /signal\.addEventListener\("abort", relayAbort/.test(source) &&
      /global: \{ fetch: boundedDatabaseFetch \}/.test(source)
  );
  check(
    "(6e) live reconciliation contains no Stripe or Supabase mutation call",
    !/subscriptions\.(create|update|cancel|del)\(/.test(source) &&
      !/\.from\([^)]*\)[\s\S]{0,180}\.(insert|update|upsert|delete)\(/.test(
        source
      ) &&
      !/\.rpc\(/.test(source)
  );
  check(
    "(6f) direct-execution guard lets fixture imports avoid live startup",
    /entryPath === fileURLToPath\(import\.meta\.url\)/.test(source)
  );
  check(
    "(6g) stdout serializes only the aggregate public summary",
    /console\.log\(JSON\.stringify\(publicSummary, null, 2\)\)/.test(
      publicSection
    ) &&
      !/detail|stripeCustomerId|stripeSubscriptionId|userId/.test(publicSection)
  );
  check(
    "(6h) exact findings are passed only to the private Alpha alert formatter",
    /buildPrivateReconciliationAlert\(findings\)/.test(source) &&
      /await sendOpsAlert\(/.test(source)
  );
  check(
    "(6i) public GitHub Issue reads and validates finding type counts only",
    /Array\.isArray\(j\.findingTypes\)/.test(workflow) &&
      /findingType\.type/.test(workflow) &&
      /findingType\.count/.test(workflow) &&
      !/j\.findings\b|stripeCustomerId|stripeSubscriptionId|userId|\.detail\b/.test(
        workflow
      )
  );
  check(
    "(6j) no wording points operators to public logs for exact findings",
    !/see the full findings|full findings list in this run|go to get the FULL list/i.test(
      source
    ) &&
      !/Full run:|full findings|exact findings|check the workflow run:/i.test(
        workflow
      )
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("ROUND 80 RECONCILIATION VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ROUND 80 RECONCILIATION ASSERTIONS PASS");
