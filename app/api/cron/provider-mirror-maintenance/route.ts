import crypto from "crypto";
import { NextResponse } from "next/server";
import { sendOpsAlert } from "@/lib/email";
import {
  type StripeEmailReconciliationResult,
  reconcilePendingStripeEmails,
} from "@/lib/stripe-email-reconciliation";
import {
  type SuppressionReconciliationResult,
  reconcilePendingSuppressions,
} from "@/lib/suppression-reconciliation";
import { supabaseServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

function bearerMatches(authHeader: string | null, expected: string): boolean {
  if (!authHeader) return false;
  const supplied = crypto.createHash("sha256").update(authHeader).digest();
  const wanted = crypto
    .createHash("sha256")
    .update(`Bearer ${expected}`)
    .digest();
  return crypto.timingSafeEqual(supplied, wanted);
}

async function captureMaintenance<T>(
  label: string,
  run: () => Promise<T>,
  failure: (message: string) => T
): Promise<T> {
  try {
    return await run();
  } catch {
    console.warn(
      `[cron/provider-mirror-maintenance] ${label} failed before returning a summary`
    );
    return failure(`${label} failed before returning a summary`);
  }
}

async function countPending(
  query: PromiseLike<{ count: number | null; error: { message: string } | null }>,
  label: string
): Promise<number> {
  const { count, error } = await query;
  if (error || !Number.isSafeInteger(count) || (count ?? -1) < 0) {
    throw new Error(`${label} failed: ${error?.message ?? String(count)}`);
  }
  return count as number;
}

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected || !bearerMatches(req.headers.get("authorization"), expected)) {
    console.warn("[cron/provider-mirror-maintenance] unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sb = await supabaseServiceClient();

  // Canonical Stripe email settles first. Suppression only reports markers
  // awaiting reviewed recovery. It never clears provider suppression.
  const stripeEmailSync =
    await captureMaintenance<StripeEmailReconciliationResult>(
      "Stripe email reconciliation",
      () => reconcilePendingStripeEmails(sb, 2),
      (message) => ({
        inspected: 0,
        cleared: 0,
        deferred: 0,
        deadLettered: 0,
        errors: [message],
      })
    );
  const suppression =
    await captureMaintenance<SuppressionReconciliationResult>(
      "suppression review",
      () => reconcilePendingSuppressions(sb, 5),
      (message) => ({
        inspected: 0,
        cleared: 0,
        deferred: 0,
        deadLettered: 0,
        errors: [message],
      })
    );

  let pendingStripeEmailSyncs = 0;
  let stripeEmailSyncCountErrors = 0;
  try {
    pendingStripeEmailSyncs = await countPending(
      sb
        .from("users")
        .select("id", { count: "exact", head: true })
        .not("stripe_email_sync_pending_at", "is", null),
      "pending Stripe email count"
    );
  } catch (error) {
    stripeEmailSyncCountErrors = 1;
    console.warn(
      "[cron/provider-mirror-maintenance] pending Stripe email count failed:",
      error instanceof Error ? error.message : error
    );
  }

  let pendingSuppressions = 0;
  let suppressionCountErrors = 0;
  try {
    pendingSuppressions = await countPending(
      sb
        .from("users")
        .select("id", { count: "exact", head: true })
        .not("suppression_cleanup_pending_at", "is", null),
      "pending suppression count"
    );
  } catch (error) {
    suppressionCountErrors = 1;
    console.warn(
      "[cron/provider-mirror-maintenance] pending suppression count failed:",
      error instanceof Error ? error.message : error
    );
  }

  // A claimed manual recovery is a separate durable hold. This lane only
  // counts it for operators. It never retries, clears, or exposes recovery
  // identity material.
  let unresolvedSuppressionRecoveries = 0;
  let suppressionRecoveryCountErrors = 0;
  try {
    unresolvedSuppressionRecoveries = await countPending(
      sb
        .from("users")
        .select("id", { count: "exact", head: true })
        .not("suppression_recovery_token", "is", null),
      "unresolved suppression recovery count"
    );
  } catch (error) {
    suppressionRecoveryCountErrors = 1;
    console.warn(
      "[cron/provider-mirror-maintenance] unresolved suppression recovery count failed:",
      error instanceof Error ? error.message : error
    );
  }

  let finalMaintenanceDue = true;
  let finalMaintenanceDueErrors = 0;
  const { data: finalDue, error: finalDueError } = await sb.rpc(
    "alpha_scheduled_maintenance_due",
    { p_now: new Date().toISOString() }
  );
  if (finalDueError || typeof finalDue !== "boolean") {
    finalMaintenanceDueErrors = 1;
    console.warn(
      "[cron/provider-mirror-maintenance] final due check failed:",
      finalDueError?.message ?? String(finalDue)
    );
  } else {
    finalMaintenanceDue = finalDue;
  }

  for (const [label, count] of [
    ["Stripe email", stripeEmailSync.errors.length],
    ["suppression", suppression.errors.length],
  ] as const) {
    if (count > 0) {
      console.warn(
        `[cron/provider-mirror-maintenance] ${count} ${label} item(s) failed`
      );
    }
  }

  const summary = {
    stripeEmailSync: {
      inspected: stripeEmailSync.inspected,
      cleared: stripeEmailSync.cleared,
      deferred: stripeEmailSync.deferred,
      deadLettered: stripeEmailSync.deadLettered,
      errors: stripeEmailSync.errors.length,
    },
    suppression: {
      inspected: suppression.inspected,
      cleared: suppression.cleared,
      deferred: suppression.deferred,
      deadLettered: suppression.deadLettered,
      errors: suppression.errors.length,
    },
    pendingStripeEmailSyncs,
    stripeEmailSyncCountErrors,
    pendingSuppressions,
    suppressionCountErrors,
    unresolvedSuppressionRecoveries,
    suppressionRecoveryCountErrors,
    finalMaintenanceDue,
    finalMaintenanceDueErrors,
  };
  console.log(
    "[cron/provider-mirror-maintenance] summary:",
    JSON.stringify(summary)
  );

  const needsAttention =
    summary.stripeEmailSync.deferred > 0 ||
    summary.stripeEmailSync.deadLettered > 0 ||
    summary.stripeEmailSync.errors > 0 ||
    summary.suppression.deferred > 0 ||
    summary.suppression.deadLettered > 0 ||
    summary.suppression.errors > 0 ||
    pendingStripeEmailSyncs > 0 ||
    stripeEmailSyncCountErrors > 0 ||
    pendingSuppressions > 0 ||
    suppressionCountErrors > 0 ||
    unresolvedSuppressionRecoveries > 0 ||
    suppressionRecoveryCountErrors > 0 ||
    finalMaintenanceDue ||
    finalMaintenanceDueErrors > 0;
  if (needsAttention) {
    await sendOpsAlert(
      "[alpha] provider mirror maintenance needs review",
      [
        `Stripe email sync inspected ${stripeEmailSync.inspected}, cleared ${stripeEmailSync.cleared}, deferred ${stripeEmailSync.deferred}, dead-lettered ${stripeEmailSync.deadLettered}, and had ${stripeEmailSync.errors.length} error(s).`,
        `Suppression review found ${suppression.deferred} marker(s) awaiting explicit reviewed recovery. Automatic provider cleanup is disabled.`,
        `Pending Stripe email markers: ${pendingStripeEmailSyncs}.`,
        `Pending suppression markers awaiting reviewed recovery: ${pendingSuppressions}.`,
        `Unresolved suppression recoveries requiring terminal reviewed settlement: ${unresolvedSuppressionRecoveries}. No automatic provider retry is performed.`,
        `Scheduled maintenance still due after every lane: ${finalMaintenanceDue}.`,
      ].join("\n")
    );
  }

  return NextResponse.json(summary);
}
