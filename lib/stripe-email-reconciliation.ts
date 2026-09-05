import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe";
import type { supabaseServiceClient } from "@/lib/supabase/server";

type ServiceClient = Awaited<ReturnType<typeof supabaseServiceClient>>;

interface ClaimedEmailSync {
  decision: string;
  canonical_email: string | null;
  customer_id: string | null;
  pending_at: string | null;
}

export interface StripeEmailReconciliationResult {
  inspected: number;
  cleared: number;
  deferred: number;
  deadLettered: number;
  errors: string[];
}

function customerEmail(customer: Stripe.Customer): string | null {
  return customer.email?.trim().toLowerCase() || null;
}

async function releaseClaim(
  sb: ServiceClient,
  userId: string,
  leaseToken: string,
  errorCode: StripeEmailSyncErrorCode,
  retryAt: string
): Promise<string> {
  const { data, error } = await sb.rpc("fail_stripe_email_sync", {
    p_user_id: userId,
    p_lease_token: leaseToken,
    p_error_code: errorCode,
    p_retry_at: retryAt,
  });
  if (error) {
    throw new Error(`Stripe email retry transition failed: ${error.message}`);
  }
  if (typeof data !== "string") {
    throw new Error(`Stripe email retry transition returned ${String(data)}`);
  }
  return data;
}

type StripeEmailSyncErrorCode =
  | "provider_unavailable"
  | "database_transient"
  | "state_changed"
  | "unexpected";

function stripeEmailSyncErrorCode(error: unknown): StripeEmailSyncErrorCode {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("stripe") ||
    message.includes("customer") ||
    message.includes("provider")
  ) {
    return "provider_unavailable";
  }
  if (message.includes("changed") || message.includes("lease")) {
    return "state_changed";
  }
  if (
    message.includes("lookup") ||
    message.includes("claim") ||
    message.includes("completion") ||
    message.includes("database") ||
    message.includes("mirror")
  ) {
    return "database_transient";
  }
  return "unexpected";
}

/**
 * Mirror confirmed Auth email to the exact stored Stripe Customer. A durable
 * owner-scoped lease blocks account deletion across the provider call. The
 * database rechecks that same lease and the absence of a deletion saga
 * immediately before mutation, then completion is an exact CAS.
 */
export async function reconcilePendingStripeEmails(
  sb: ServiceClient,
  limit = 2,
  options: { stripeClient?: Stripe } = {}
): Promise<StripeEmailReconciliationResult> {
  const safeLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(5, limit))
    : 2;
  const result: StripeEmailReconciliationResult = {
    inspected: 0,
    cleared: 0,
    deferred: 0,
    deadLettered: 0,
    errors: [],
  };
  const nowIso = new Date().toISOString();
  // Discovery is identity-light and never authorizes a provider call. The
  // claim RPC returns the exact current fields under the owner lock.
  const { data, error } = await sb
    .from("users")
    .select("id")
    .not("stripe_email_sync_pending_at", "is", null)
    .is("stripe_email_sync_dead_lettered_at", null)
    .or(
      `stripe_email_sync_next_attempt_at.is.null,stripe_email_sync_next_attempt_at.lte.${nowIso}`
    )
    .or(
      `stripe_email_sync_lease_expires_at.is.null,stripe_email_sync_lease_expires_at.lte.${nowIso}`
    )
    .order("stripe_email_sync_pending_at", { ascending: true })
    .limit(safeLimit);
  if (error) {
    result.errors.push(`pending Stripe email lookup failed: ${error.message}`);
    return result;
  }
  if ((data?.length ?? 0) === 0) return result;

  let stripe: Stripe | null = options.stripeClient ?? null;
  for (const raw of data ?? []) {
    const userId = (raw as { id?: unknown }).id;
    if (typeof userId !== "string") {
      result.errors.push("pending Stripe email lookup returned an invalid id");
      continue;
    }
    result.inspected += 1;
    const leaseToken = randomUUID();
    let claimed = false;
    let retryErrorCode: StripeEmailSyncErrorCode = "unexpected";
    let retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
    try {
      const { data: claimData, error: claimError } = await sb.rpc(
        "claim_stripe_email_sync",
        { p_user_id: userId, p_lease_token: leaseToken }
      );
      if (claimError) {
        throw new Error(`Stripe email claim failed: ${claimError.message}`);
      }
      const claim = (Array.isArray(claimData) ? claimData[0] : claimData) as
        | ClaimedEmailSync
        | null;
      if (!claim?.decision) {
        throw new Error("Stripe email claim returned no decision");
      }
      if (
        claim.decision === "deletion_pending" ||
        claim.decision === "in_progress" ||
        claim.decision === "not_due" ||
        claim.decision === "changed"
      ) {
        result.deferred += 1;
        continue;
      }
      if (claim.decision === "dead_lettered") {
        result.deadLettered += 1;
        continue;
      }
      if (claim.decision === "missing" || claim.decision === "not_pending") {
        continue;
      }
      if (claim.decision !== "claimed") {
        throw new Error(`Stripe email claim returned ${claim.decision}`);
      }
      claimed = true;
      const claimedEmail = claim.canonical_email?.trim().toLowerCase() || null;
      if (!claim.customer_id || !claim.pending_at) {
        throw new Error("pending Stripe email sync has no exact binding");
      }

      const { data: authData, error: authError } =
        await sb.auth.admin.getUserById(userId);
      const authEmail = authData?.user?.email?.trim().toLowerCase() || null;
      if (authError || !authEmail) {
        throw new Error(
          `confirmed Auth email lookup failed: ${
            authError?.message ?? "email missing"
          }`
        );
      }

      let expectedEmail = claimedEmail;
      let pendingAt = claim.pending_at;
      if (expectedEmail !== authEmail) {
        const nextPendingAt = new Date().toISOString();
        const { data: mirrored, error: mirrorError } = await sb
          .from("users")
          .update({
            email: authEmail,
            stripe_email_sync_pending_at: nextPendingAt,
            suppression_cleanup_pending_at: nextPendingAt,
          })
          .eq("id", userId)
          .eq("stripe_customer_id", claim.customer_id)
          .eq("stripe_email_sync_pending_at", pendingAt)
          .eq("stripe_email_sync_lease_token", leaseToken)
          .select("id")
          .maybeSingle();
        if (mirrorError || !mirrored) {
          throw new Error(
            `confirmed email mirror changed concurrently: ${
              mirrorError?.message ?? "no row updated"
            }`
          );
        }
        expectedEmail = authEmail;
        pendingAt = nextPendingAt;
      }
      if (!expectedEmail) {
        throw new Error("pending Stripe email sync has no canonical email");
      }

      const { data: authorized, error: authorizeError } = await sb.rpc(
        "authorize_stripe_email_sync",
        {
          p_user_id: userId,
          p_lease_token: leaseToken,
          p_customer_id: claim.customer_id,
          p_pending_at: pendingAt,
          p_canonical_email: expectedEmail,
        }
      );
      if (authorizeError || authorized !== true) {
        throw new Error(
          `Stripe email provider mutation was not authorized: ${
            authorizeError?.message ?? String(authorized)
          }`
        );
      }

      if (!stripe) stripe = getStripeClient();
      const customer = await stripe.customers.update(claim.customer_id, {
        email: expectedEmail,
      });
      if (
        customer.deleted ||
        customer.id !== claim.customer_id ||
        customerEmail(customer) !== expectedEmail
      ) {
        throw new Error("Stripe returned a different Customer email binding");
      }
      const { data: completed, error: completeError } = await sb.rpc(
        "complete_stripe_email_sync",
        {
          p_user_id: userId,
          p_lease_token: leaseToken,
          p_customer_id: claim.customer_id,
          p_pending_at: pendingAt,
          p_canonical_email: expectedEmail,
        }
      );
      if (completeError || completed !== true) {
        throw new Error(
          `Stripe email completion failed: ${
            completeError?.message ?? String(completed)
          }`
        );
      }
      claimed = false;
      result.cleared += 1;
    } catch (syncError) {
      result.errors.push(
        `Stripe email sync ${userId}: ${
          syncError instanceof Error ? syncError.message : "reconciliation failed"
        }`
      );
      retryErrorCode = stripeEmailSyncErrorCode(syncError);
      retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
    } finally {
      if (claimed) {
        try {
          const retryStatus = await releaseClaim(
            sb,
            userId,
            leaseToken,
            retryErrorCode,
            retryAt
          );
          if (retryStatus === "dead_lettered") {
            result.deadLettered += 1;
          } else if (
            ![
              "deferred",
              "manual_review",
              "already_dead_lettered",
              "state_changed",
              "lease_lost",
              "missing",
            ].includes(retryStatus)
          ) {
            result.errors.push(
              `Stripe email sync ${userId}: retry transition returned ${retryStatus}`
            );
          }
        } catch (releaseError) {
          result.errors.push(
            releaseError instanceof Error
              ? releaseError.message
              : "Stripe email lease release failed"
          );
        }
      }
    }
  }
  return result;
}
