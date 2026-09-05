// Fully local refund-review retention checks. Supabase is an injected stub.
// No env file, provider, database, or network call is made.
import { readFileSync } from "node:fs";
import { pruneResolvedRefundReviews } from "../lib/refund-review.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed += 1;
  else failed += 1;
}

function extractSqlFunctionBody(source: string, functionName: string): string {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${escapedName}\\s*\\(`,
    "i"
  ).exec(source);
  if (!declaration || declaration.index === undefined) {
    throw new Error(`SQL function ${functionName} was not found`);
  }

  const functionSource = source.slice(declaration.index);
  const bodyMarker = /\bas\s+\$\$/i.exec(functionSource);
  if (!bodyMarker || bodyMarker.index === undefined) {
    throw new Error(`SQL function ${functionName} has no dollar-quoted body`);
  }
  const bodyStart = bodyMarker.index + bodyMarker[0].length;
  const bodyEnd = functionSource.indexOf("$$;", bodyStart);
  if (bodyEnd < 0) {
    throw new Error(`SQL function ${functionName} has no closing body marker`);
  }

  return functionSource
    .slice(bodyStart, bodyEnd)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");
}

const calls: Array<{ name: string; args: unknown }> = [];
const values = [2, 1];
const stub = {
  rpc: async (name: string, args: unknown) => {
    calls.push({ name, args });
    return { data: values.shift(), error: null };
  },
};

console.log("(1) bounded service helper");
const result = await pruneResolvedRefundReviews(
  stub as never,
  "2026-08-28T12:00:00.000Z",
  25
);
check("(1a) helper returns exact deleted and remaining counts", result.pruned === 2 && result.remaining === 1);
check(
  "(1b) helper passes one immutable clock and the bounded limit",
  calls[0]?.name === "prune_resolved_refund_reviews" &&
    JSON.stringify(calls[0]?.args) ===
      JSON.stringify({ p_now: "2026-08-28T12:00:00.000Z", p_limit: 25 }) &&
    calls[1]?.name === "count_prunable_resolved_refund_reviews" &&
    JSON.stringify(calls[1]?.args) ===
      JSON.stringify({ p_now: "2026-08-28T12:00:00.000Z" })
);
let nullResultRejected = false;
try {
  await pruneResolvedRefundReviews(
    { rpc: async () => ({ data: null, error: null }) } as never,
    "2026-08-28T12:00:00.000Z",
    25
  );
} catch {
  nullResultRejected = true;
}
check(
  "(1c) a null RPC payload cannot silently become a zero-work success",
  nullResultRejected
);

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260827040000_refund_review_resolution.sql",
    import.meta.url
  ),
  "utf8"
);
const dueMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260828000000_alpha_renewal_cancellation.sql",
    import.meta.url
  ),
  "utf8"
);
const route = readFileSync(
  new URL("../app/api/cron/maintenance/route.ts", import.meta.url),
  "utf8"
);
const runbook = readFileSync(
  new URL("../docs/REFUND_REVIEW_RUNBOOK.md", import.meta.url),
  "utf8"
);
const pruneResolvedRefundReviewsBody = extractSqlFunctionBody(
  migration,
  "prune_resolved_refund_reviews"
);
const countPrunableResolvedRefundReviewsBody = extractSqlFunctionBody(
  migration,
  "count_prunable_resolved_refund_reviews"
);
const scheduledMaintenanceDueBody = extractSqlFunctionBody(
  dueMigration,
  "alpha_scheduled_maintenance_due"
);

console.log("(2) finite, PII-free terminal retention");
check(
  "(2a) only final decisions older than 180 days are deleted",
  /status in \('refunded', 'not_required'\)[\s\S]*resolved_at <= p_now - interval '180 days'[\s\S]*delete from public\.refund_reviews/.test(
    pruneResolvedRefundReviewsBody
  )
);
check(
  "(2b) unresolved rows and nonterminal legacy cleanup remain untouched",
  !/delete from public\.refund_reviews[\s\S]*status in \('pending', 'reviewed'\)/.test(
    pruneResolvedRefundReviewsBody
  ) &&
    /not exists \([\s\S]*legacy_checkout_fulfillments[\s\S]*l\.status in \('pending', 'deleting'\)/.test(
      pruneResolvedRefundReviewsBody
    ) &&
    /legacy_checkout_fulfillments[\s\S]*l\.status in \('pending', 'deleting'\)/.test(
      countPrunableResolvedRefundReviewsBody
    )
);
check(
  "(2h) a resolved charge cannot prune a nonterminal current subscription cleanup proof",
  /not exists \([\s\S]*from public\.checkout_profiles p[\s\S]*p\.stripe_session_id = r\.session_id[\s\S]*p\.stripe_customer_id = r\.customer_id[\s\S]*p\.stripe_subscription_id = r\.subscription_id[\s\S]*p\.billing_state in \([\s\S]*'paid'[\s\S]*'recovering'[\s\S]*'deleting'/.test(
    pruneResolvedRefundReviewsBody
  ) &&
    /from public\.checkout_profiles p[\s\S]*p\.stripe_session_id = r\.session_id[\s\S]*p\.billing_state in \([\s\S]*'paid'[\s\S]*'recovering'[\s\S]*'deleting'/.test(
      countPrunableResolvedRefundReviewsBody
    )
);
check(
  "(2g) a pending current duplicate finalizer keeps its exact review authorization",
  /checkout_fulfillments[\s\S]*checkout_profiles[\s\S]*f\.status = 'pending'[\s\S]*p\.stripe_customer_id = r\.customer_id[\s\S]*p\.stripe_subscription_id = r\.subscription_id/.test(
    pruneResolvedRefundReviewsBody
  ) &&
    /checkout_fulfillments[\s\S]*checkout_profiles[\s\S]*f\.status = 'pending'/.test(
      countPrunableResolvedRefundReviewsBody
    ) &&
    /checkout_fulfillments[\s\S]*checkout_profiles[\s\S]*f\.status = 'pending'/.test(
      scheduledMaintenanceDueBody
    )
);
check(
  "(2c) prune and remaining-count RPCs are service-role only",
  /revoke all on function public\.prune_resolved_refund_reviews[\s\S]*grant execute on function public\.prune_resolved_refund_reviews[\s\S]*to service_role/.test(
    migration
  ) &&
    /revoke all on function public\.count_prunable_resolved_refund_reviews[\s\S]*grant execute on function public\.count_prunable_resolved_refund_reviews[\s\S]*to service_role/.test(
      migration
    )
);
check(
  "(2d) maintenance stays due while an eligible final row remains",
  /status in \('refunded', 'not_required'\)[\s\S]*resolved_at <= p_now - interval '180 days'/.test(
    scheduledMaintenanceDueBody
  )
);
check(
  "(2e) maintenance reports prune errors and remaining eligible rows as attention",
  route.includes("resolvedRefundReviewsPruned") &&
    route.includes("resolvedRefundReviewsRemaining > 0") &&
    route.includes("refundReviewPruneErrors > 0")
);
check(
  "(2f) the operator runbook states the same finite policy",
  runbook.includes("180 days") &&
    runbook.includes("Pending and `reviewed` rows remain")
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("REFUND REVIEW RETENTION VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL REFUND REVIEW RETENTION ASSERTIONS PASS");
