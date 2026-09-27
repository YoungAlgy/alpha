// Source-owned rollout gates shared by the app and the daily-send preflight.
// Environment variables cannot activate unreleased Brevo behavior.
// Callback-only release after the schema and actual format-5 restore passed.
// Sending requires a separate reviewed release.
export const BREVO_DELIVERY_SCHEMA_ENABLED = true;
export const BREVO_SUBSCRIBER_DELIVERY_ENABLED = false;
