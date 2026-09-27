// Source-owned rollout gates shared by the app and the daily-send preflight.
// Environment variables cannot activate unreleased Brevo behavior.
// Owner-approved activation after the restore, controlled send, quota read
// and provider-originated inert callback checks passed.
export const BREVO_DELIVERY_SCHEMA_ENABLED = true;
export const BREVO_SUBSCRIBER_DELIVERY_ENABLED = true;
// Scheduled preflight may select Brevo before new attempts are claimed.
// Existing attempts stay pinned to their original provider.
export const BREVO_AUTOMATIC_FAILOVER_ENABLED = true;
// The separate exact-reader manual Actions canary remains approval-gated.
export const BREVO_CANARY_DELIVERY_ENABLED = true;
