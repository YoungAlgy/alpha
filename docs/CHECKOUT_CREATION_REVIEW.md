# Checkout creation review

`checkout_creation_reviews` is the durable queue for a rare crash after Stripe
accepted Session creation but before Alpha stored the Session ID. The queue is
PII-free. A pending review keeps scheduled maintenance red and blocks account
deletion from reaching `billing_clean`.

When Alpha is invite-only, scheduled maintenance moves a due, unbound legacy
creation into this queue with reason `invite_mode_transition`. It does not
decrypt the stored request, claim a replay lease, or call Stripe. Leave that
review pending until an operator has exact Session evidence or authoritative
no-create proof.

Never release one of these reservations because it is old. After Stripe's
idempotency replay window, age cannot prove that a Session and subscription do
not exist.

## Resolve with a Session ID

1. Work in the same Alpha Stripe account and mode used by the checkout.
2. Find the exact Session from Stripe request logs or the persisted idempotency
   key, `alpha-checkout-<profile UUID>`. Do not pick a Session by email.
3. From the exact reviewed release checkout, run:

   ```bash
   ./node_modules/.bin/tsx scripts/resolve-checkout-creation-review.mts \
     with-session PROFILE_UUID cs_EXACT_SESSION_ID \
     --confirm-reviewed-evidence
   ```

   The command loads the Alpha-only local environment and uses the normal
   Alpha Stripe client. It can expire an open Session when account deletion is
   already pending. Run it only with explicit production approval.
4. The helper retrieves the Session and checks its exact profile metadata,
   mode, encrypted-request email, fixed expiry, and Alpha line item. An expired
   Session is terminal after its immutable binding checks. Open and completed
   Sessions must have the exact one-item Alpha shape.
5. The helper uses `bind_checkout_session`, settles an expired Session through
   the normal terminal RPC, then marks the review resolved. A crash after the
   bind is safe to retry with the same Session ID.

Do not write `stripe_session_id` directly and do not resolve the queue before
the helper returns successfully.

## Resolve with authoritative no-create proof

Use this path only when Stripe request logs, an event record, or a Stripe
support case proves that no Session was created for the persisted idempotent
request.

1. Keep a PII-free evidence identifier with one of these prefixes: `req_`,
   `evt_`, `case_`, or `ticket_`.
2. From the exact reviewed release checkout, run:

   ```bash
   ./node_modules/.bin/tsx scripts/resolve-checkout-creation-review.mts \
     no-create PROFILE_UUID req_OR_EVT_OR_CASE_OR_TICKET_PROOF \
     --confirm-reviewed-evidence
   ```

   This command changes the review and reservation in the Alpha database. Run
   it only with explicit production approval.
3. The token-gated database function requires the pending review, an unbound
   reservation, no billing pair, and the missed replay window. It then expires
   the reservation and clears the encrypted Session email in one transaction.

An empty provider search, a missing Session lookup, the current date, or a
different Stripe account is not no-create proof. Leave the review pending and
escalate it if the evidence is incomplete.

## Completion check

Run scheduled maintenance again. `pendingCheckoutCreationReviews` must fall to
zero. A resolved Session may still have separate checkout recovery, refund, or
account-deletion work, which remains visible in the same maintenance summary.
