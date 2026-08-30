# Checkout maintenance gate

Alpha has a fail-closed gate at the very start of `POST /api/stripe/checkout`.
It exists so a schema or billing release can stop new Checkout Sessions while
existing subscribers keep normal site access.

## Controls

- `ALPHA_CHECKOUT_MODE=open` is the only production value that opens checkout.
- Missing, blank, `paused`, and misspelled values fail closed.
- Local checkout also stays paused until `.env.local` explicitly sets `open`.
- The gate runs before rate limiting, request-body parsing, database access,
  and Stripe access.
- The production value is versioned in `wrangler.jsonc`. It is not a secret.
- There is no bypass header or hidden public path.

## Required pre-release shape

The current production Worker cannot honor a flag added only in the full Round
80 release. Ship the gate as a small standalone release first.

Use a clean temporary checkout based on the current production commit. The
guard-only commit may contain only:

1. `lib/checkout-maintenance.ts`
2. The helper import and first maintenance block in
   `app/api/stripe/checkout/route.ts`
3. `scripts/verify-checkout-maintenance-pause.mts`
4. `wrangler.jsonc` with `ALPHA_CHECKOUT_MODE` set to `paused`
5. A minimal health response that reports the exact guard SHA and paused mode,
   without requiring the still-unknown legacy cutoff
6. A reviewed guard deploy path that exports
   `NEXT_PUBLIC_ALPHA_RELEASE_SHA=<GUARD_SHA>` and captures the old Worker
7. This runbook if desired

Do not include Round 80 migrations, workflow changes, new maintenance routes,
or checkout persistence changes in the guard-only release. The full Round 80
release commit must later descend from this guard commit.

## Approved activation sequence

Every GitHub read or write, Cloudflare read or write, push, and deployment below
needs Alex's explicit approval.

1. Run the local test and normal checks against the guard-only commit.
2. Confirm the commit contains none of the Round 80 schema-dependent code.
3. Capture the current Worker rollback version.
4. Push and deploy the guard-only commit.
5. Confirm the guard build received `NEXT_PUBLIC_ALPHA_RELEASE_SHA=<GUARD_SHA>`.
6. Confirm health reports the exact guard commit and `checkoutMode: paused`.
7. Send an empty POST to the canonical checkout route. Require
   status 503, `checkout_temporarily_paused`,
   `Cache-Control: no-store, must-revalidate`, and `Retry-After: 300`.
8. Confirm no Stripe Checkout Session or database row was created by
   that blocked request.
9. With every scheduled Stripe caller stopped, create the approved replacement
   Alpha Stripe secret key and install it in the paused guard, GitHub Actions,
   and the approved operator runtime without logging its value.
10. Revoke the exact old Stripe key held by every pre-guard Worker. This is the
    hard boundary that makes an arbitrarily delayed old request unable to
    create a Session after it resumes.
11. Capture the resulting paused guard Worker version with the replacement key
    as the only allowed rollback target for every later phase.
12. Wait at least 90 seconds after confirmed revocation. The old Stripe client
    has 20-second attempts and at most one retry. A request still blocked on its
    body or database work reaches only the revoked key later.
13. Read Alpha Checkout Sessions created since the guard deploy. Repeat the
    read at least 30 seconds later. Require no new legacy-shaped root Session.
14. Repeat the canonical empty POST and require the same maintenance 503.
15. Record a whole UTC second strictly after the latest observed legacy Session
    and after the final stable provider read. This is
    `LEGACY_CHECKOUT_ROOT_CUTOFF_ISO` because Stripe creation timestamps use
    whole seconds.
16. Add that exact non-secret value to the full Round 80 `wrangler.jsonc` and
    its approved build environment before the full release commit is made.
17. Keep this paused guard release active through the migration and full Round
    80 deployment.

If the guard deploy fails before the old Stripe key is revoked, its captured
pre-guard Worker remains an available rollback version. Once the old key is
revoked, never roll back to that original unpaused Worker. The post-rotation
paused guard Worker is the only later rollback target. If the 503 gate cannot
be proved, stop before migration.

## Reopen sequence

1. Complete every migration, backup, binding-backfill, health, and queue gate.
2. Create a separate reopen commit that changes only the versioned
   `wrangler.jsonc` value from `paused` to `open`.
3. Record the reopen commit SHA and confirm the full Round 80 release is its
   parent.
4. Push and deploy the reopen commit only after Alex approves both actions.
5. Confirm health reports the reopen commit and `checkoutMode: open`.
6. Run the controlled real-account checkout as the first monitored request.

The controlled checkout changes Stripe and Supabase. It needs separate
approval. Record the exact operator account, Alpha price, and quantity first.
After it completes, verify the exact Session, Customer, Subscription, webhook
event, checkout profile, fulfillment row, and access state. Resolve only those
exact controlled objects.

7. Monitor public checkout and every Round 80 maintenance queue through the
   release window.

If any step is uncertain, deploy or retain `paused`. A missing or misspelled
mode fails closed by design.
