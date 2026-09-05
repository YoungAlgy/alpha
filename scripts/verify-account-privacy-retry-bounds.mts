// Fully local checks for account email reconciliation and bounded exports.
// This script imports only pure helpers and reads source/migration text. It
// never loads environment variables or contacts Supabase, Stripe, or Resend.
import { readFileSync } from "node:fs";
import {
  AccountExportTooLargeError,
  fetchCompleteExportRows,
  normalizeAccountEmails,
} from "../lib/account-privacy.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean): void {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed += 1;
  else failed += 1;
}

console.log("(1) account email identity is normalized and deduplicated");
check(
  "(1a) Auth and mirror addresses are lower-cased, trimmed, and unique",
  normalizeAccountEmails(
    " Reader@Example.com ",
    "old@example.com",
    "reader@example.com",
    null,
    undefined
  ).join(",") === "reader@example.com,old@example.com"
);

console.log("(2) export pages must reach the exact count");
{
  const ranges: string[] = [];
  const rows = await fetchCompleteExportRows(
    "issues",
    async (from, to) => {
      ranges.push(`${from}-${to}`);
      if (from === 0) return { data: [1, 2], count: 3, error: null };
      return { data: [3], count: 3, error: null };
    },
    { pageSize: 2, maxRows: 10 }
  );
  check("(2a) bounded pages return every row", rows.join(",") === "1,2,3");
  check("(2b) pagination advances by the requested page size", ranges.join(",") === "0-1,2-3");
}

console.log("(3) incomplete and oversized exports fail explicitly");
{
  let incompleteRejected = false;
  try {
    await fetchCompleteExportRows(
      "support tickets",
      async () => ({ data: [], count: 1, error: null }),
      { pageSize: 2, maxRows: 10 }
    );
  } catch {
    incompleteRejected = true;
  }
  check("(3a) an empty page before the exact count is an error", incompleteRejected);

  let oversizedRejected = false;
  try {
    await fetchCompleteExportRows(
      "issues",
      async () => ({ data: [], count: 11, error: null }),
      { pageSize: 2, maxRows: 10 }
    );
  } catch (error) {
    oversizedRejected = error instanceof AccountExportTooLargeError;
  }
  check("(3b) a count above the bounded limit uses a distinct error", oversizedRejected);
}

const exportRoute = readFileSync(
  new URL("../app/api/account/export/route.ts", import.meta.url),
  "utf8"
);
const deleteRoute = readFileSync(
  new URL("../app/api/account/delete/route.ts", import.meta.url),
  "utf8"
);
const retryMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260830020000_account_privacy_retry_bounds.sql",
    import.meta.url
  ),
  "utf8"
);

console.log("(4) routes and migration preserve the privacy/retry contract");
check(
  "(4a) export reads Auth and public mirror email addresses",
  exportRoute.includes("normalizeAccountEmails(user.email, mirrorEmail)") &&
    exportRoute.includes('.is("user_id", null)')
);
check(
  "(4b) export uses exact counts and bounded ranges",
  exportRoute.includes('.select("*", { count: "exact" })') &&
    exportRoute.includes(".range(from, to)") &&
    exportRoute.includes("status: 413") &&
    exportRoute.includes('"Cache-Control": "private, no-store"')
);
check(
  "(4c) self-delete cleans Auth and stale public mirror addresses",
  deleteRoute.includes("normalizeAccountEmails(user.email, row.email)") &&
    deleteRoute.includes("settleAccountDeletionPrivacy") &&
    !deleteRoute.includes("removeResendSuppression")
);
check(
  "(4d) all three reconciliation lanes have bounded attempts and requeue functions",
  retryMigration.includes("reconcile_attempt_count between 0 and 8") &&
    retryMigration.includes("stripe_email_sync_attempt_count between 0 and 8") &&
    retryMigration.includes("suppression_cleanup_attempt_count between 0 and 8") &&
    retryMigration.includes("fail_account_deletion_reconciliation") &&
    retryMigration.includes("fail_stripe_email_sync") &&
    retryMigration.includes("fail_suppression_cleanup") &&
    retryMigration.includes("requeue_account_deletion_reconciliation") &&
    retryMigration.includes("requeue_stripe_email_sync") &&
    retryMigration.includes("requeue_suppression_cleanup")
);
check(
  "(4e) terminal rows are discoverable through dead-letter markers",
  retryMigration.includes("account_deletion_sagas_reconcile_dead_letter_idx") &&
    retryMigration.includes("users_stripe_email_sync_dead_letter_idx") &&
    retryMigration.includes("users_suppression_cleanup_dead_letter_idx")
);
check(
  "(4f) scheduled retry precheck excludes terminal rows",
  /account_deletion_sagas s[\s\S]*reconcile_dead_lettered_at is null[\s\S]*reconcile_next_attempt_at/.test(
    retryMigration
  ) &&
    /suppression_cleanup_pending_at is not null[\s\S]*suppression_cleanup_dead_lettered_at is null/.test(
      retryMigration
    ) &&
    /stripe_email_sync_pending_at is not null[\s\S]*stripe_email_sync_dead_lettered_at is null/.test(
      retryMigration
    )
);
check(
  "(4g) the later invite audit markers remain service-owned",
  retryMigration.includes("new.access_requested_at := old.access_requested_at") &&
    retryMigration.includes("new.access_granted_at := old.access_granted_at")
);
check(
  "(4h) suppression failure retries pin the permanent invite entitlement snapshot",
  retryMigration.includes("p_access_granted_at timestamptz") &&
    retryMigration.includes(
      "v_user.access_granted_at is distinct from p_access_granted_at"
    ) &&
    retryMigration.includes(
      "fail_suppression_cleanup(uuid, timestamptz, text, timestamptz, timestamptz, timestamptz, text, text, timestamptz, timestamptz, timestamptz, text, timestamptz)"
    )
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("ACCOUNT PRIVACY RETRY VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ACCOUNT PRIVACY RETRY ASSERTIONS PASS");
