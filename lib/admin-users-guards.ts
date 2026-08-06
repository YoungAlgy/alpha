// Pulled out of app/api/admin/users/route.ts as a pure function so a
// deterministic verify script (scripts/verify-admin-users-guards.mts) can
// exercise the decision with stubbed inputs -- both grant_free and
// revoke_free guard against the same mistake (comping over, or silently
// un-comping under, a REAL Stripe subscriber's row) but had zero coverage
// beyond "grep confirms the route checks stripe_customer_id somewhere." An
// inverted condition here would let an admin action silently clobber a
// paying subscriber's Stripe-managed state, or block a legitimate comp
// grant/revoke on a genuinely free-granted reader.

/** True if this row is safe for the admin free-grant/revoke actions to
 *  touch -- i.e. it has NO real Stripe customer on file. A real Stripe
 *  subscriber must be managed in Stripe, never comped over or silently
 *  un-comped by an admin click (grant_free would un-cancel a real
 *  cancellation; revoke_free would blow away a real paid subscription). */
export function isFreeGrantEligible(stripeCustomerId: string | null | undefined): boolean {
  return !stripeCustomerId;
}
