import { hasActiveAccess, hasReaderAccess } from "@/lib/access";
import { hasUsableReaderProfile } from "@/lib/reader-profile-state";

export interface AdminAccountStateInput {
  first_name: string | null;
  topics: string[] | null;
  birthday?: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id?: string | null;
  subscribed_at: string | null;
  cancelled_at: string | null;
  access_requested_at: string | null;
  access_granted_at: string | null;
  delivery_enrolled: boolean;
  unsubscribed_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  suppression_cleanup_pending_at: string | null;
  suppression_recovery_started_at: string | null;
  has_suppression_recovery?: boolean;
}

// One presentation policy for the Accounts row. Historical billing fields
// stay intact, but do not change the label of an owner's permanent free grant.
// Server-side authorization and delivery checks remain authoritative.
export function getAdminAccountState(row: AdminAccountStateInput) {
  const readerAccess = hasReaderAccess(row.subscribed_at, row.cancelled_at, row.access_granted_at);
  const billingBound = !!(row.stripe_customer_id || row.stripe_subscription_id);
  const freeGranted = readerAccess && (!!row.access_granted_at || !billingBound);
  const pending = !!row.access_requested_at && !row.access_granted_at;
  const recovery = !!row.suppression_recovery_started_at || !!row.has_suppression_recovery;
  const suppressed = !!(row.bounced_at || row.complained_at || row.suppression_cleanup_pending_at);
  const profileComplete = hasUsableReaderProfile(row);
  const deliveryBlockReason = !readerAccess
    ? "Approve free access before enabling letters."
    : row.unsubscribed_at
    ? "This reader unsubscribed. They must resume letters from their account."
    : recovery || suppressed
    ? "Delivery is blocked for review. Enabling letters cannot clear this block."
    : !profileComplete
    ? "Signup is unfinished. The reader needs to confirm their email and save their name and topics."
    : null;

  const grantAction = !billingBound && !freeGranted
    ? "grant_free" as const
    : row.stripe_customer_id && row.subscribed_at && !row.access_granted_at
    ? "grant_invite" as const
    : null;
  // A subscription-only binding (no customer id) is malformed. The server
  // holds it for account review, so no linked-account action is offered.
  const malformedBinding = billingBound && !row.stripe_customer_id;
  const revokeAction = !freeGranted ? null
    : !billingBound ? "revoke_free" as const
    : malformedBinding ? null
    : "revoke_invite" as const;
  const legacyAccessRemains = !!row.subscribed_at && billingBound && hasActiveAccess(row.cancelled_at);

  return {
    readerAccess, freeGranted, pending, recovery, suppressed, profileComplete,
    grantAction, revokeAction, deliveryBlockReason,
    canEnableDelivery: !row.delivery_enrolled && !deliveryBlockReason,
    accessLabel: freeGranted ? "Free (granted)" : pending ? "Access requested"
      : readerAccess ? "Legacy access" : row.subscribed_at || row.access_granted_at || row.cancelled_at
      ? "Access ended" : "Signup started",
    deliveryLabel: row.delivery_enrolled && deliveryBlockReason ? "Letters blocked"
      : row.delivery_enrolled ? "Letters enabled" : "Letters paused",
    needsAccountReview: billingBound && !grantAction &&
      ((!readerAccess && !row.access_granted_at) || (freeGranted && malformedBinding)),
    revokeNote: legacyAccessRemains
      ? " Previously recorded access may remain until its existing end date."
      : "",
  };
}
