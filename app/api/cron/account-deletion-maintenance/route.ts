import crypto from "crypto";
import { NextResponse } from "next/server";
import { reconcileStaleAccountDeletions } from "@/lib/account-deletion-reconciler";
import { pruneUnownedResendEvents } from "@/lib/resend-event-retention";
import { sendOpsAlert } from "@/lib/email";
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

async function countRows(
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
    console.warn("[cron/account-deletion-maintenance] unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sb = await supabaseServiceClient();
  // Run retention before slower Auth/billing recovery. A failed item must not
  // prevent the next scheduled batch from removing expired webhook evidence.
  const resendEventRetention = await pruneUnownedResendEvents(sb);
  const nowIso = new Date().toISOString();
  const accountDeletion = await reconcileStaleAccountDeletions(sb, {
    nowIso,
    limit: 1,
  });

  let deletionTombstonesPruned = 0;
  let deletionPruneErrors = 0;
  const { data: pruned, error: pruneError } = await sb.rpc(
    "prune_completed_account_deletion_sagas",
    { p_limit: 100 }
  );
  if (pruneError || !Number.isInteger(pruned) || pruned < 0) {
    deletionPruneErrors = 1;
    console.warn(
      "[cron/account-deletion-maintenance] deletion tombstone prune failed:",
      pruneError?.message ?? String(pruned)
    );
  } else {
    deletionTombstonesPruned = pruned;
  }

  let pendingDeletionSagas = 0;
  let pendingDeletionCountErrors = 0;
  try {
    pendingDeletionSagas = await countRows(
      sb
        .from("account_deletion_sagas")
        .select("user_id", { count: "exact", head: true })
        .neq("state", "complete"),
      "pending account-deletion count"
    );
  } catch (error) {
    pendingDeletionCountErrors = 1;
    console.warn(
      "[cron/account-deletion-maintenance] pending deletion count failed:",
      error instanceof Error ? error.message : error
    );
  }

  let dueDeletionTombstones = 0;
  let dueDeletionTombstoneCountErrors = 0;
  try {
    dueDeletionTombstones = await countRows(
      sb
        .from("account_deletion_sagas")
        .select("user_id", { count: "exact", head: true })
        .eq("state", "complete")
        .lte("purge_after", nowIso),
      "due account-deletion tombstone count"
    );
  } catch (error) {
    dueDeletionTombstoneCountErrors = 1;
    console.warn(
      "[cron/account-deletion-maintenance] due tombstone count failed:",
      error instanceof Error ? error.message : error
    );
  }

  if (accountDeletion.errors.length > 0) {
    console.warn(
      `[cron/account-deletion-maintenance] ${accountDeletion.errors.length} account deletion item(s) failed`
    );
  }

  const summary = {
    accountDeletion: {
      inspected: accountDeletion.inspected,
      billingResumed: accountDeletion.billingResumed,
      authDeleted: accountDeletion.authDeleted,
      completed: accountDeletion.completed,
      privacyBlocked: accountDeletion.privacyBlocked,
      deadLettered: accountDeletion.deadLettered,
      errors: accountDeletion.errors.length,
    },
    deletionTombstonesPruned,
    deletionPruneErrors,
    pendingDeletionSagas,
    pendingDeletionCountErrors,
    dueDeletionTombstones,
    dueDeletionTombstoneCountErrors,
    resendEventRetention,
  };
  console.log(
    "[cron/account-deletion-maintenance] summary:",
    JSON.stringify(summary)
  );

  const needsAttention =
    summary.accountDeletion.privacyBlocked > 0 ||
    summary.accountDeletion.deadLettered > 0 ||
    summary.accountDeletion.errors > 0 ||
    summary.deletionPruneErrors > 0 ||
    summary.pendingDeletionSagas > 0 ||
    summary.pendingDeletionCountErrors > 0 ||
    summary.dueDeletionTombstones > 0 ||
    summary.dueDeletionTombstoneCountErrors > 0 ||
    resendEventRetention.errors > 0 ||
    resendEventRetention.remaining;
  if (needsAttention) {
    await sendOpsAlert(
      "[alpha] account deletion maintenance needs review",
      [
        `Account deletion inspected ${accountDeletion.inspected}, completed ${accountDeletion.completed}, privacy-blocked ${accountDeletion.privacyBlocked}, dead-lettered ${accountDeletion.deadLettered}, and had ${accountDeletion.errors.length} error(s).`,
        `Pending account deletion sagas: ${pendingDeletionSagas}.`,
        `Due deletion tombstones remaining: ${dueDeletionTombstones}.`,
        `Expired unowned delivery events removed: ${resendEventRetention.pruned}. More due: ${resendEventRetention.remaining}. Retention errors: ${resendEventRetention.errors}.`,
        deletionPruneErrors > 0
          ? "Completed deletion-marker pruning failed."
          : "",
        pendingDeletionCountErrors > 0
          ? "Pending deletion counting failed."
          : "",
        dueDeletionTombstoneCountErrors > 0
          ? "Due deletion-tombstone counting failed."
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return NextResponse.json(summary);
}
