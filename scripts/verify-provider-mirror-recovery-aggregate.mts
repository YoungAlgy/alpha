// Offline source guard for the unresolved manual suppression-recovery signal.
// It checks aggregate-only observability and explicitly rejects an automatic
// provider recovery path.
import { readFileSync } from "node:fs";

let assertions = 0;
function check(label: string, condition: boolean): void {
  assertions += 1;
  if (!condition) throw new Error(`FAIL: ${label}`);
}

const route = readFileSync(
  new URL("../app/api/cron/provider-mirror-maintenance/route.ts", import.meta.url),
  "utf8"
);
const workflow = readFileSync(
  new URL("../.github/workflows/daily-send.yml", import.meta.url),
  "utf8"
);
const aggregateStart = route.indexOf("let unresolvedSuppressionRecoveries = 0;");
const aggregateEnd = route.indexOf("let finalMaintenanceDue = true;", aggregateStart);
const aggregate = aggregateStart >= 0 && aggregateEnd > aggregateStart
  ? route.slice(aggregateStart, aggregateEnd)
  : "";
const summaryStart = route.indexOf("const summary = {");
const summaryEnd = route.indexOf("const needsAttention =", summaryStart);
const summary = summaryStart >= 0 && summaryEnd > summaryStart
  ? route.slice(summaryStart, summaryEnd)
  : "";
const alertStart = route.indexOf("await sendOpsAlert(");
const alertEnd = route.indexOf("return NextResponse.json(summary);", alertStart);
const alert = alertStart >= 0 && alertEnd > alertStart ? route.slice(alertStart, alertEnd) : "";

check(
  "unresolved recovery count is exact, head-only, and reads no identity columns",
  aggregate.includes('.from("users")') &&
    aggregate.includes('.select("id", { count: "exact", head: true })') &&
    aggregate.includes('.not("suppression_recovery_token", "is", null)') &&
    !aggregate.includes("email") &&
    !aggregate.includes("snapshot")
);
check(
  "count failure has a separate numeric error field and no fallback retry",
  aggregate.includes("let suppressionRecoveryCountErrors = 0;") &&
    aggregate.includes("suppressionRecoveryCountErrors = 1;") &&
    !aggregate.includes("removeResendSuppression") &&
    !aggregate.includes("recoverResendSuppression")
);
check(
  "summary exposes only aggregate recovery observability",
  summary.includes("unresolvedSuppressionRecoveries,") &&
    summary.includes("suppressionRecoveryCountErrors,") &&
    !summary.includes("suppression_recovery_token") &&
    !summary.includes("recipient_email") &&
    !summary.includes("suppression_recovery_snapshot")
);
check(
  "unresolved recoveries and count errors trigger needs-attention",
  /unresolvedSuppressionRecoveries > 0[\s\S]*suppressionRecoveryCountErrors > 0/.test(route)
);
check(
  "alert names reviewed settlement and says automatic provider retry is disabled without identity material",
  alert.includes("terminal reviewed settlement") &&
    alert.includes("No automatic provider retry is performed") &&
    !alert.includes("recipient_email") &&
    !alert.includes("suppression_recovery_token") &&
    !alert.includes("suppression_recovery_snapshot")
);
check(
  "workflow validates both aggregate fields and counts them as unresolved",
  workflow.includes("s.unresolvedSuppressionRecoveries, s.suppressionRecoveryCountErrors") &&
    workflow.includes("s.unresolvedSuppressionRecoveries + s.suppressionRecoveryCountErrors")
);

console.log(`PASS verify-provider-mirror-recovery-aggregate (${assertions} assertions, offline source-only)`);
