# Exact Alpha subscription binding backfill

This is a one-time release tool that inventories every Stripe Subscription
containing the exact Alpha price and every local row with a billing identifier.
It enforces bidirectional coverage for every non-terminal provider Subscription
and every active local billed row. It repairs active users created before
`public.users.stripe_subscription_id` existed only after that audit proves their
exact provider binding.

It binds an existing database user to one existing Stripe Subscription. It does
not change Stripe, access dates, quota, cancellation state, email, or profile
data.

## Hard boundaries

- Run only after the Round 80 atomic migration and post-migration backup pass.
- Keep checkout paused for the entire dry-run and apply window.
- Use the dedicated Alpha Supabase and Stripe accounts only.
- Run from the exact clean committed Round 80 repository state.
- `scripts/reconcile-stripe-vs-supabase.mts` is the strictly read-only recurring
  audit. Never use it as the writer or as a substitute for this backfill's
  unresolved-obligation and reservation gates. It scans the exact Alpha price
  in both directions using the stored Customer and Subscription IDs. Its public
  workflow output contains aggregate counts and finding types only. Exact
  identifiers and details may appear only in the private Alpha ops alert.
- Do not continue if any candidate is ambiguous, blocked, stale, or mismatched.
- Both modes load `.env.local` and contact live Stripe and Supabase. Each run
  needs Alex's exact approval.
- The provider inventory stops after 10 pages or 1,000 Alpha-price
  Subscriptions. Each database inventory stops after 1,000 rows. A cap or count
  drift is a release stop, not a partial success.
- Stripe calls use the shared bounded client. Supabase requests use a 15-second
  deadline that preserves an upstream abort signal.

## What dry-run proves

The tool reads only billing, access-control, and unresolved-obligation fields.
It never loads subscriber profile text, email, or name.

The reverse provider pass pages through every Subscription containing the exact
Alpha price. It requires every non-terminal provider Subscription to have one
unambiguous local Customer owner. It requires `active`, `trialing`, and
`past_due` to match an active local access window. It requires `incomplete`,
`paused`, and `unpaid` to retain the exact billing identity with local access
off. An unknown provider status, an access-state mismatch, a different stored
Subscription, or another local row reserving the same Subscription blocks the
release. A missing stored Subscription is allowed only for one active local row
that is eligible for the exact repair.

For each Customer, only one non-terminal Alpha Subscription is allowed.
Historical `canceled` and `incomplete_expired` objects may remain as terminal
extras. A second `active`, `trialing`, `past_due`, `incomplete`, `paused`,
`unpaid`, or other non-terminal object is ambiguous and blocks the release.
Inactive local rows and terminal provider objects are inventory-only unless they
conflict with current or non-terminal ownership. This tool does not certify that
every terminal historical local pair still matches a retained Stripe object.

For every active row with either a Customer or Subscription ID, it requires:

- Canonical non-blank `cus_*` and, when present, `sub_*` identifiers with no
  surrounding whitespace.
- One database owner for the exact Stripe Customer.
- No pending renewal marker on the row.
- Inclusion in the complete bounded reverse Stripe inventory.
- One exact Alpha line item at the hardcoded Alpha price.
- Quantity 1 through 5.
- Exactly one `active`, `trialing`, or `past_due` candidate.
- Provider quantity times five equal to the stored topic quota.
- Provider cancellation time equal to the stored access end.
- Any existing non-null Subscription ID to equal the one exact provider
  Subscription discovered for that Customer.
- No account-deletion saga or other-user deletion reservation for the exact
  user, Customer, or Subscription.
- No same-row or cross-row pending renewal marker for the exact pair.
- No active checkout profile or legacy checkout fulfillment involving the user
  or exact pair.
- No pending or reviewed refund for the exact loser or winner pair.
- No cross-owner user, checkout profile, or legacy fulfillment reservation.

Rows with an exact existing binding are recorded as `verified_existing`. Rows
with a missing binding can be `eligible` for repair. The same read-only
obligation and ownership checks run for both decisions. Any malformed, stale,
wrong, duplicated, ambiguous, or conflicting binding or provider-coverage issue
blocks the release.

The format-version-3 private manifest stores local and provider counts,
decisions, short hashes, release identity, the complete provider-inventory
hash, and the combined evidence hash. It does not store user UUIDs, Customer
IDs, Subscription IDs, email, name, topics, or profile content.

## Approval-gated dry-run command

This example does not authorize execution. Use the current frozen September 4
recovery-fence manifest below. Do not reuse the retired August 31 example.
The separate V3 verifier corrects verification queries without replacing the
frozen migration manifest. Recheck both artifacts before an approved run.

From the Alpha repository root in PowerShell. Replace the example private
directory with the approved manifest's actual location before execution:

```powershell
& '.\node_modules\.bin\tsx.cmd' '.\scripts\backfill-exact-alpha-subscriptions.mts' dry-run --bundle-manifest 'C:\Alpha-Private\2026-09-04-recovery-fence\Alpha-Round-80-Atomic-Migration-2026-09-04.manifest.json'
```

By default, the tool saves the manifest under the repository's ignored backup
directory. `ALPHA_SUBSCRIPTION_BACKFILL_DIR` can select another private directory:

```text
backup/subscription-backfill
```

Exit code 0 means provider coverage is complete and every active billed row is
either already exact or eligible for exact repair. Exit code 2 means at least
one local row or provider object is blocked. A blocked run is a release stop.
Review real evidence and run a fresh dry-run later.

If eligible count is zero and blocked count is zero, no apply run is needed.

## Approval record

Before apply, record all of these without opening the manifest to casual logs:

- Dry-run manifest absolute path.
- Printed manifest SHA256.
- Candidate count.
- Eligible count.
- Verified existing count.
- Local blocked count, which must be zero.
- Provider Subscription count.
- Provider issue count, which must be zero.
- Provider inventory SHA256.
- Repository SHA.
- Atomic migration bundle SHA.
- Approval time.

The approval expires when the manifest expires, the repository changes, the
bundle changes, the script changes, or any live provider evidence changes.

## Approval-gated apply command

Replace the two placeholders with the exact reviewed values:

```powershell
& '.\node_modules\.bin\tsx.cmd' '.\scripts\backfill-exact-alpha-subscriptions.mts' --apply --manifest 'ABSOLUTE_MANIFEST_PATH' --approve-sha256 'EXACT_64_CHARACTER_SHA256' --confirm-reviewed-live-alpha
```

Apply exits before loading credentials if the confirmation shape is incomplete.
It then:

1. Verifies the manifest hash, age, repository SHA, script hash, bundle hash,
   and Alpha price.
2. Repeats the complete paginated database and reverse Stripe discovery.
3. Requires the same provider inventory hash, combined evidence hash,
   verified-existing set, and zero local or provider blockers.
4. Retrieves each repairable exact Subscription again.
5. Calls the service-only locked compare-and-set RPC for missing bindings with
   concurrency one.
6. Changes only `public.users.stripe_subscription_id` and `updated_at`.
7. Re-reads each exact pair.
8. Stops on the first unresolved result.
9. Repeats the full reverse provider, local binding, and unresolved-obligation
   audit. It requires the same provider inventory, zero provider issues, and
   every active billing binding to be exact at the end.

The RPC accepts only `bound` or `already_bound`. A single `busy` result gets one
immediate idempotent retry. Every other result stops the run.

## Failure handling

- Keep checkout paused.
- Do not rerun the atomic migration.
- Do not edit database rows directly.
- Preserve successful exact bindings. The RPC is idempotent.
- Use a fresh dry-run before resuming any unresolved candidate.
- Do not cancel, refund, delete, or update a Stripe object through this process.
- If the provider is unavailable or returns an unsafe shape, wait for a new
  approved dry-run.
- If any provider or database inventory reaches its cap, review and raise the
  bound deliberately. Never treat a capped inventory as complete.

After apply, run the post-migration verification SQL again. Require the
malformed-pair, missing-binding, duplicate Customer, and duplicate Subscription
counts to be zero. Keep the private provider-audit manifest with the release
record.
