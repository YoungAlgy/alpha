import crypto from "crypto";
import { NextResponse } from "next/server";
import {
  type CheckoutCreationRecoveryResult,
  countPendingCheckoutCreationReviews,
  reconcileStaleCheckoutSessionCreations,
} from "@/lib/checkout-creation-recovery";
import {
  countDeadLetteredCheckoutProfiles,
  finalizeStaleCheckoutFulfillments,
  scrubExpiredCheckoutProfiles,
  scrubTerminalCheckoutTombstones,
} from "@/lib/checkout-profile-retention";
import {
  type CheckoutRecoveryResult,
  reconcileOverdueCheckoutProfiles,
} from "@/lib/checkout-recovery";
import { sendOpsAlert } from "@/lib/email";
import {
  countUnresolvedRefundReviews,
  pruneResolvedRefundReviews,
} from "@/lib/refund-review";
import {
  countDeadLetteredLegacyCheckoutFulfillments,
  type LegacyFulfillmentReconciliationResult,
  reconcileStaleLegacyCheckoutFulfillments,
} from "@/lib/legacy-duplicate-reconciliation";
import {
  type RenewalCancellationReconciliationResult,
  reconcilePendingAlphaRenewalCancellations,
} from "@/lib/renewal-cancellation";
import { isInviteOnly } from "@/lib/access-mode";
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
    console.warn(`[cron/maintenance] ${label} failed before returning a summary`);
    return failure(`${label} failed before returning a summary`);
  }
}

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected || !bearerMatches(req.headers.get("authorization"), expected)) {
    console.warn("[cron/maintenance] unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const checkoutCreationMode = isInviteOnly(true)
    ? "invite_review"
    : "paid_replay";
  const sb = await supabaseServiceClient();
  const nowIso = new Date().toISOString();
  let staleCheckoutFinalizer = {
    completed: 0,
    aborted: 0,
    errors: 0,
  };
  try {
    staleCheckoutFinalizer = {
      ...(await finalizeStaleCheckoutFulfillments(sb, nowIso, 100)),
      errors: 0,
    };
  } catch (error) {
    staleCheckoutFinalizer.errors = 1;
    console.warn(
      "[cron/maintenance] stale checkout fulfillment finalizer failed:",
      error instanceof Error ? error.message : error
    );
  }
  let terminalCheckoutScrub = {
    profilesScrubbed: 0,
    fulfillmentsScrubbed: 0,
    errors: 0,
  };
  try {
    terminalCheckoutScrub = {
      ...(await scrubTerminalCheckoutTombstones(sb, nowIso, 100)),
      errors: 0,
    };
  } catch (error) {
    terminalCheckoutScrub.errors = 1;
    console.warn(
      "[cron/maintenance] terminal checkout tombstone scrub failed:",
      error instanceof Error ? error.message : error
    );
  }
  const initialRetentionErrors = await scrubExpiredCheckoutProfiles(
    sb,
    nowIso,
    false
  );

  // Every bounded lifecycle queue gets a chance on every run. Their database
  // claims use owner, Customer, and Subscription locks plus exact CAS checks,
  // so an outage or slow provider call in one queue cannot starve the rest.
  const [checkoutCreation, legacyFulfillment, renewalCancellation, checkoutRecovery] =
    await Promise.all([
      captureMaintenance<CheckoutCreationRecoveryResult>(
        "checkout creation recovery",
        () =>
          reconcileStaleCheckoutSessionCreations(sb, {
            nowIso,
            limit: 1,
          }),
        (message) => ({
          inspected: 0,
          claimed: 0,
          inProgress: 0,
          reviewRequired: 0,
          bound: 0,
          expired: 0,
          deletionPending: 0,
          replayWindowMissed: 0,
          errors: [message],
        })
      ),
      captureMaintenance<LegacyFulfillmentReconciliationResult>(
        "legacy fulfillment reconciliation",
        () =>
          reconcileStaleLegacyCheckoutFulfillments(sb, {
            nowIso,
            limit: 1,
          }),
        (message) => ({
          inspected: 0,
          inProgress: 0,
          finalized: 0,
          completed: 0,
          aborted: 0,
          awaitingIssue: 0,
          retired: 0,
          unresolved: 0,
          deadLettered: 0,
          errors: [message],
        })
      ),
      captureMaintenance<RenewalCancellationReconciliationResult>(
        "renewal cancellation recovery",
        () =>
          reconcilePendingAlphaRenewalCancellations(sb, {
            now: new Date(nowIso),
            // Three sequential Stripe checks fit under the five-minute route
            // ceiling even at the SDK timeout, while one bad marker backs off
            // and cannot hide every cancellation queued behind it.
            limit: 3,
          }),
        (message) => ({
          inspected: 0,
          scheduled: 0,
          alreadyScheduled: 0,
          retired: 0,
          inProgress: 0,
          unresolved: 0,
          errors: [message],
        })
      ),
      captureMaintenance<CheckoutRecoveryResult>(
        "checkout recovery",
        () => reconcileOverdueCheckoutProfiles(sb, nowIso, 1),
        (message) => ({
          inspected: 0,
          recovered: 0,
          nonAccessBound: 0,
          inProgress: 0,
          cancelled: 0,
          terminallyScrubbed: 0,
          reviewSubscriptionIds: [],
          errors: [message],
        })
      ),
    ]);

  const retentionErrors = [
    ...initialRetentionErrors,
    ...(await scrubExpiredCheckoutProfiles(sb, nowIso, true)),
  ];

  let resolvedRefundReviewsPruned = 0;
  let resolvedRefundReviewsRemaining = 0;
  let refundReviewPruneErrors = 0;
  try {
    const result = await pruneResolvedRefundReviews(sb, nowIso, 100);
    resolvedRefundReviewsPruned = result.pruned;
    resolvedRefundReviewsRemaining = result.remaining;
  } catch (error) {
    refundReviewPruneErrors = 1;
    console.warn(
      "[cron/maintenance] resolved refund-review retention failed:",
      error instanceof Error ? error.message : error
    );
  }

  let unresolvedRefundReviews = 0;
  let refundReviewErrors = 0;
  try {
    unresolvedRefundReviews = await countUnresolvedRefundReviews(sb);
  } catch (error) {
    refundReviewErrors = 1;
    console.warn(
      "[cron/maintenance] unresolved refund-review count failed:",
      error instanceof Error ? error.message : error
    );
  }

  let pendingCheckoutCreationReviews = 0;
  let checkoutCreationReviewErrors = 0;
  try {
    pendingCheckoutCreationReviews =
      await countPendingCheckoutCreationReviews(sb);
  } catch (error) {
    checkoutCreationReviewErrors = 1;
    console.warn(
      "[cron/maintenance] pending checkout-creation review count failed:",
      error instanceof Error ? error.message : error
    );
  }

  let deadLetteredCheckoutProfiles = 0;
  let checkoutDeadLetterCountErrors = 0;
  try {
    deadLetteredCheckoutProfiles =
      await countDeadLetteredCheckoutProfiles(sb);
  } catch (error) {
    checkoutDeadLetterCountErrors = 1;
    console.warn(
      "[cron/maintenance] dead-lettered checkout profile count failed:",
      error instanceof Error ? error.message : error
    );
  }

  let deadLetteredLegacyCheckoutFulfillments = 0;
  let legacyDeadLetterCountErrors = 0;
  try {
    deadLetteredLegacyCheckoutFulfillments =
      await countDeadLetteredLegacyCheckoutFulfillments(sb);
  } catch (error) {
    legacyDeadLetterCountErrors = 1;
    console.warn(
      "[cron/maintenance] dead-lettered legacy checkout count failed:",
      error instanceof Error ? error.message : error
    );
  }

  let pendingRenewalCancellations = 0;
  let renewalCancellationCountErrors = 0;
  const { data: pendingRenewalCount, error: pendingRenewalCountError } =
    await sb.rpc("count_pending_alpha_renewal_cancellations");
  const parsedPendingRenewalCount =
    typeof pendingRenewalCount === "number"
      ? pendingRenewalCount
      : Number.NaN;
  if (
    pendingRenewalCountError ||
    !Number.isSafeInteger(parsedPendingRenewalCount) ||
    parsedPendingRenewalCount < 0
  ) {
    renewalCancellationCountErrors = 1;
    console.warn(
      "[cron/maintenance] pending renewal-cancellation count failed:",
      pendingRenewalCountError?.message ?? String(pendingRenewalCount)
    );
  } else {
    pendingRenewalCancellations = parsedPendingRenewalCount;
  }

  if (retentionErrors.length > 0) {
    console.warn(
      `[cron/maintenance] ${retentionErrors.length} checkout retention item(s) failed`
    );
  }
  for (const [label, count] of [
    ["checkout creation recovery", checkoutCreation.errors.length],
    ["checkout recovery", checkoutRecovery.errors.length],
    ["legacy fulfillment reconciliation", legacyFulfillment.errors.length],
    ["renewal cancellation", renewalCancellation.errors.length],
  ] as const) {
    if (count > 0) {
      console.warn(`[cron/maintenance] ${count} ${label} item(s) failed`);
    }
  }

  const summary = {
    checkoutRetentionErrors: retentionErrors.length,
    staleCheckoutFinalizer,
    terminalCheckoutScrub,
    checkoutCreation: {
      mode: checkoutCreationMode,
      inspected: checkoutCreation.inspected,
      claimed: checkoutCreation.claimed,
      inProgress: checkoutCreation.inProgress,
      reviewRequired: checkoutCreation.reviewRequired,
      bound: checkoutCreation.bound,
      expired: checkoutCreation.expired,
      deletionPending: checkoutCreation.deletionPending,
      replayWindowMissed: checkoutCreation.replayWindowMissed,
      errors: checkoutCreation.errors.length,
    },
    checkoutRecovery: {
      inspected: checkoutRecovery.inspected,
      recovered: checkoutRecovery.recovered,
      nonAccessBound: checkoutRecovery.nonAccessBound,
      inProgress: checkoutRecovery.inProgress,
      cancelled: checkoutRecovery.cancelled,
      terminallyScrubbed: checkoutRecovery.terminallyScrubbed,
      errors: checkoutRecovery.errors.length,
    },
    legacyFulfillment: {
      inspected: legacyFulfillment.inspected,
      inProgress: legacyFulfillment.inProgress,
      finalized: legacyFulfillment.finalized,
      completed: legacyFulfillment.completed,
      aborted: legacyFulfillment.aborted,
      awaitingIssue: legacyFulfillment.awaitingIssue,
      retired: legacyFulfillment.retired,
      unresolved: legacyFulfillment.unresolved,
      deadLettered: legacyFulfillment.deadLettered,
      errors: legacyFulfillment.errors.length,
    },
    // Backward-compatible shape for the workflow parser deployed with the
    // original duplicate-only finalizer. These counts now cover every stale
    // legacy fulfillment, including the duplicate subset.
    legacyDuplicate: {
      inspected: legacyFulfillment.inspected,
      inProgress: legacyFulfillment.inProgress,
      finalized: legacyFulfillment.finalized,
      unresolved:
        legacyFulfillment.unresolved + legacyFulfillment.awaitingIssue,
      errors: legacyFulfillment.errors.length,
    },
    renewalCancellation: {
      inspected: renewalCancellation.inspected,
      scheduled: renewalCancellation.scheduled,
      alreadyScheduled: renewalCancellation.alreadyScheduled,
      retired: renewalCancellation.retired,
      inProgress: renewalCancellation.inProgress,
      unresolved: renewalCancellation.unresolved,
      errors: renewalCancellation.errors.length,
    },
    pendingCheckoutCreationReviews,
    checkoutCreationReviewErrors,
    deadLetteredCheckoutProfiles,
    checkoutDeadLetterCountErrors,
    deadLetteredLegacyCheckoutFulfillments,
    legacyDeadLetterCountErrors,
    pendingRenewalCancellations,
    renewalCancellationCountErrors,
    unresolvedRefundReviews,
    refundReviewErrors,
    resolvedRefundReviewsPruned,
    resolvedRefundReviewsRemaining,
    refundReviewPruneErrors,
  };
  console.log("[cron/maintenance] summary:", JSON.stringify(summary));

  const needsAttention =
    summary.checkoutRetentionErrors > 0 ||
    summary.staleCheckoutFinalizer.errors > 0 ||
    summary.staleCheckoutFinalizer.aborted > 0 ||
    summary.terminalCheckoutScrub.errors > 0 ||
    summary.checkoutCreation.inProgress > 0 ||
    summary.checkoutCreation.reviewRequired > 0 ||
    summary.checkoutCreation.deletionPending > 0 ||
    summary.checkoutCreation.replayWindowMissed > 0 ||
    summary.checkoutCreation.errors > 0 ||
    summary.checkoutRecovery.inProgress > 0 ||
    summary.checkoutRecovery.errors > 0 ||
    summary.legacyFulfillment.inProgress > 0 ||
    summary.legacyFulfillment.awaitingIssue > 0 ||
    summary.legacyFulfillment.unresolved > 0 ||
    summary.legacyFulfillment.deadLettered > 0 ||
    summary.legacyFulfillment.errors > 0 ||
    summary.renewalCancellation.inProgress > 0 ||
    summary.renewalCancellation.unresolved > 0 ||
    summary.renewalCancellation.errors > 0 ||
    checkoutCreationReviewErrors > 0 ||
    pendingCheckoutCreationReviews > 0 ||
    checkoutDeadLetterCountErrors > 0 ||
    deadLetteredCheckoutProfiles > 0 ||
    legacyDeadLetterCountErrors > 0 ||
    deadLetteredLegacyCheckoutFulfillments > 0 ||
    renewalCancellationCountErrors > 0 ||
    pendingRenewalCancellations > 0 ||
    refundReviewErrors > 0 ||
    unresolvedRefundReviews > 0 ||
    refundReviewPruneErrors > 0 ||
    resolvedRefundReviewsRemaining > 0 ||
    checkoutRecovery.cancelled > 0;
  if (needsAttention) {
    await sendOpsAlert(
      "[alpha] scheduled maintenance needs review",
      [
        `Checkout retention errors: ${summary.checkoutRetentionErrors}.`,
        `Stale checkout fulfillment finalizer completed ${staleCheckoutFinalizer.completed} replay guard(s), aborted and scrubbed ${staleCheckoutFinalizer.aborted}, and had ${staleCheckoutFinalizer.errors} error(s).`,
        `Terminal checkout retention scrubbed ${terminalCheckoutScrub.profilesScrubbed} profile tombstone(s) and ${terminalCheckoutScrub.fulfillmentsScrubbed} fulfillment tombstone(s), with ${terminalCheckoutScrub.errors} error(s).`,
        `Checkout creation recovery mode ${checkoutCreationMode} inspected ${checkoutCreation.inspected}, held ${checkoutCreation.reviewRequired} for operator review, bound ${checkoutCreation.bound}, expired ${checkoutCreation.expired}, deletion-pending ${checkoutCreation.deletionPending}, missed-window ${checkoutCreation.replayWindowMissed}, and had ${checkoutCreation.errors.length} error(s).`,
        `Checkout recovery inspected ${checkoutRecovery.inspected}, recovered ${checkoutRecovery.recovered}, retained ${checkoutRecovery.nonAccessBound} non-access billing binding(s), cancelled ${checkoutRecovery.cancelled}, in progress ${checkoutRecovery.inProgress}, and had ${checkoutRecovery.errors.length} error(s).`,
        checkoutRecovery.reviewSubscriptionIds.length > 0
          ? `${checkoutRecovery.reviewSubscriptionIds.length} checkout recovery item(s) were queued for refund review. Use the protected refund-review queue for exact records.`
          : "",
        `Legacy fulfillment reconciliation inspected ${legacyFulfillment.inspected}, completed ${legacyFulfillment.completed}, duplicate-aborted ${legacyFulfillment.aborted}, retired ${legacyFulfillment.retired}, awaiting issue ${legacyFulfillment.awaitingIssue}, unresolved ${legacyFulfillment.unresolved}, newly dead-lettered ${legacyFulfillment.deadLettered}, and had ${legacyFulfillment.errors.length} error(s).`,
        `Renewal cancellation recovery inspected ${renewalCancellation.inspected}, newly scheduled ${renewalCancellation.scheduled}, already scheduled ${renewalCancellation.alreadyScheduled}, retired ${renewalCancellation.retired}, in progress ${renewalCancellation.inProgress}, unresolved ${renewalCancellation.unresolved}, and had ${renewalCancellation.errors.length} error(s).`,
        `Pending checkout creation reviews: ${pendingCheckoutCreationReviews}. Count errors: ${checkoutCreationReviewErrors}.`,
        `Dead-lettered checkout profiles awaiting operator requeue: ${deadLetteredCheckoutProfiles}. Count errors: ${checkoutDeadLetterCountErrors}.`,
        `Dead-lettered legacy checkout fulfillments awaiting operator requeue: ${deadLetteredLegacyCheckoutFulfillments}. Count errors: ${legacyDeadLetterCountErrors}.`,
        `Pending renewal cancellations: ${pendingRenewalCancellations}. Count errors: ${renewalCancellationCountErrors}.`,
        `Unresolved refund decisions: ${unresolvedRefundReviews}. Count errors: ${refundReviewErrors}.`,
        `Resolved refund reviews pruned after 180 days: ${resolvedRefundReviewsPruned}. Remaining eligible: ${resolvedRefundReviewsRemaining}. Retention errors: ${refundReviewPruneErrors}.`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return NextResponse.json(summary);
}
