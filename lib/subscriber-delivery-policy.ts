// The approved release is for reader access only. Generating, retrying,
// backfilling, and sending subscriber letters stay paused until Alex approves
// resuming delivery after the live callback and delivery checks pass.
// There is deliberately no environment override for this release hold.
// Operator alerts, support mail, and account sign-in are separate paths.
export const SUBSCRIBER_LETTERS_ENABLED: boolean = false;
