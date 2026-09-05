import { readFileSync } from "node:fs";

let assertions = 0;

function check(label: string, value: boolean): void {
  assertions += 1;
  if (!value) throw new Error(`FAIL: ${label}`);
}

const source = readFileSync(
  new URL("../lib/suppression-reconciliation.ts", import.meta.url),
  "utf8"
);
const retryMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260830020000_account_privacy_retry_bounds.sql",
    import.meta.url
  ),
  "utf8"
);
check(
  "the bounded review worker never imports or calls provider suppression removal",
  !source.includes("removeResendSuppression") &&
    !source.includes("fail_suppression_cleanup")
);
check(
  "the review worker does not clear local delivery evidence or pending markers",
  !source.includes(".update(") &&
    !source.includes("suppression_cleanup_pending_at: null") &&
    !source.includes("bounced_at: null") &&
    !source.includes("complained_at: null")
);
check(
  "due review discovery remains bounded, ordered, and excludes terminal legacy rows",
  source.includes("Math.max(1, Math.min(10, limit))") &&
    source.includes('.is("suppression_cleanup_dead_lettered_at", null)') &&
    source.includes('.order("suppression_cleanup_pending_at", { ascending: true })') &&
    source.includes(".limit(safeLimit)")
);
check(
  "each due marker is reported for operator review without a synthetic retry transition",
  source.includes("const reviewRequired = data?.length ?? 0") &&
    source.includes("result.inspected = reviewRequired") &&
    source.includes("result.deferred = reviewRequired") &&
    !source.includes("Date.now() + 5 * 60_000")
);
check(
  "legacy retry metadata remains available for historical rows without driving this worker",
  retryMigration.includes("suppression_cleanup_attempt_count between 0 and 8") &&
    retryMigration.includes("create or replace function public.fail_suppression_cleanup") &&
    retryMigration.includes("suppression_cleanup_dead_lettered_at") &&
    retryMigration.includes("create or replace function public.requeue_suppression_cleanup")
);

console.log(`OK: ${assertions} suppression reconciliation assertions passed`);
