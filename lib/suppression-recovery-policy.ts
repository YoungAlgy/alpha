/**
 * Checked-in safety hold. Manual provider suppression removal remains disabled
 * until late-event ordering and terminal-resolution proof are available.
 */
export const MANUAL_PROVIDER_SUPPRESSION_REMOVAL_ENABLED = false;

export const MANUAL_PROVIDER_SUPPRESSION_REMOVAL_HOLD_MESSAGE =
  "Manual delivery recovery is temporarily unavailable pending late-event review. Delivery remains blocked and no provider change was made.";
