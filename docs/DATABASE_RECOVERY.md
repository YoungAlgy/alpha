# Alpha database recovery boundary

The daily encrypted artifact is a partial recovery snapshot. It protects the
subscriber rows and durable operational obligations that Alpha cannot safely
reconstruct after a database loss. It is not a PostgreSQL dump, point-in-time
recovery, or a complete Supabase project backup.

## Snapshot contents

The files in `MANIFEST.json` are ordered for restore dependencies:

1. `users`
2. `issues`
3. `resend_delivery_attempts`
4. `resend_webhook_events`
5. `support_tickets`
6. `checkout_profiles`
7. `checkout_fulfillments`
8. `checkout_creation_reviews`
9. `account_deletion_sagas`
10. `account_deletion_alpha_subscriptions`
11. `refund_reviews`
12. `legacy_checkout_fulfillments`

Format 4 remains the default. An explicit `ALPHA_BACKUP_FORMAT_VERSION=5` adds
`brevo_suppression_events` immediately after `resend_delivery_attempts`, ordered
by `message_id`, `event_type`, and `event_at`. Format 5 requires that table and
its file even when it has zero rows. The restore tool reads each validated
package's own version, so existing format 4 packages remain readable.
The existing `formatVersion: 4` inventory still has all twelve tables above.

The callback release has a required order:

1. Apply and verify the Brevo schema migration. Setting format 5 before the
   `brevo_suppression_events` table exists makes the backup fail closed.
2. Run the backup workflow with `ALPHA_BACKUP_FORMAT_VERSION=5`. Confirm the
   actual encrypted format 5 artifact includes the Brevo table, then verify an
   isolated restore of that artifact.
3. Release the callback with `BREVO_DELIVERY_SCHEMA_ENABLED=true` and
   `BREVO_SUBSCRIBER_DELIVERY_ENABLED=false`. Keep subscriber delivery on Resend.

Enabling Brevo subscriber sends is a separate future release decision. Do not
turn on the send flag as part of callback rollout. Format 4 packages remain
readable for earlier recovery points, but omit Brevo suppression ownership and
review records from a Brevo-enabled period.

This preserves subscriber profiles and letters, immutable email retry identity,
durable Resend suppression ownership and review records, support requests,
checkout ownership and replay guards, account-deletion work, exact subscription
cleanup, and unresolved refund decisions.

The snapshot deliberately omits generated caches, Stripe webhook dedup rows, and
the one-day `alpha_paid_call_budgets` counter. Those are transient bookkeeping.
Resend suppression audit rows remain in the snapshot because unresolved owner
review cannot be reconstructed safely. Stripe, Resend, and Supabase Auth remain
separate systems of record.

`MANIFEST.json` format 4 records the exact evidence for every file:

- `file`: the fixed table JSON filename
- `rowCount`: the exact number of rows in the JSON array
- `bytes`: the exact file byte length
- `sha256`: the lowercase SHA-256 hash of those exact bytes

The manifest also records the fixed table order, each stable export ordering,
the aggregate row count, and whether any export failed. A restore must reject a
missing file, extra table entry, failed manifest, changed byte count, changed
hash, or JSON array length that differs from `rowCount`.

## Important limit

The REST exporter reads pages and tables in separate requests. Exact counts,
stable ordering and file hashes do not create one database snapshot. A live
change that leaves the row count unchanged can still produce a mixed package.
For a release recovery point, keep all relevant writers quiescent for the
export or use an approved database-consistent backup mechanism. An isolated
restore of a quiet fixture does not prove consistency during live writes.

`public.users.id` references `auth.users(id)`. The JSON snapshot does not export
`auth.users`, passwordless identities, Supabase configuration, storage, database
functions, triggers, grants, or provider account settings. Restoring these JSON
files alone cannot recreate working subscriber accounts.

A full loss therefore requires a supported Supabase database and Auth recovery
path. If the Auth identities cannot be recovered with the same user IDs, stop.
Do not invent replacement accounts or import `public.users` under new IDs.

## Before relying on a snapshot

- Confirm the workflow completed and uploaded only `backup.tar.gz.enc`.
- Confirm `MANIFEST.json` has `failed: false`, `rowCount`, `bytes`, and `sha256`
  for every file. Format 4 requires the twelve tables above. Format 5 requires
  all thirteen tables, including `brevo_suppression_events` after delivery
  attempts. A format 4 artifact is not complete evidence for a Brevo-enabled
  period.
- Keep the current `BACKUP_ENCRYPTION_KEY_V2` outside the artifact. Never print
  it in a log. Keep the older `BACKUP_ENCRYPTION_KEY` only for decrypting
  historical artifacts that were created with that key.
- Run an approved decrypt and restore drill in an isolated Alpha-only project.
  A successful export does not prove the data can be restored.

## Offline local restore guard

`scripts/restore-critical-tables-local.mjs` is deliberately limited to a fresh,
explicit loopback PostgreSQL database. It accepts `localhost`, `127.0.0.1`, or
`::1`. It rejects remote hosts and URL query options. The generated SQL also
checks PostgreSQL's server-side address before taking its first table lock.
Ambient libpq service and host-address settings are removed so they cannot
redirect the explicit loopback target.

The local tool performs these steps before it commits anything:

1. Validate the complete format 4 or 5 manifest, file inventory, exact byte counts,
   SHA-256 hashes, JSON arrays, per-table row counts, and aggregate row count.
2. Read only `id` and `email` from the validated `users.json` rows. Require
   unique valid UUIDs and emails, then prepare those exact local Auth anchors.
   It never prints the anchors or any backup row.
3. Open one PostgreSQL transaction, take an advisory lock, lock Auth and every
   table required by the package's format, and require each destination to be empty.
4. Pause user-defined triggers inside the transaction, insert the exact local
   Auth anchors, and restore all required public tables in the documented order.
   Constraint triggers remain active.
5. Re-enable user-defined triggers. Verify every table count, every exact Auth
   anchor, all validated foreign keys, and the absence of foreign-key orphans.
6. Restart owned serial sequences at the next safe value with transactional
   `ALTER SEQUENCE ... RESTART`, force constraints immediate, and commit.

Any failure rolls back the data and trigger changes. A second restore into the
same target fails because the destination is no longer empty. The CLI prints
one aggregate `RESTORE PASS` or `RESTORE FAIL` line. Raw rows and native `psql`
output are suppressed.

Use the installed native `psql`. Set `PSQL_BIN` when it is not on `PATH`:

```powershell
$env:PSQL_BIN = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
node scripts/restore-critical-tables-local.mjs `
  --backup-dir 'C:\private\alpha-backup' `
  --database-url 'postgresql://postgres@127.0.0.1:55432/alpha_restore'
Remove-Item Env:PSQL_BIN
```

This command is only for an isolated local recovery target. It is not a way to
write a Supabase project. The loopback guard cannot be bypassed by adding a
flag. Production recovery remains the approved, provider-supported manual path
below.

## Repeatable local drill

### Brevo format 5 candidate

`scripts/drill-brevo-backup-restore.mjs` is the focused drill for the 43-migration
Brevo candidate. It uses the installed PostgreSQL 17.11 binaries at
`/home/algy/alpha-pg17-test-20260909/pgsql-17.11/bin` in a nonroot Linux process.
Run the reviewed script from WSL with the installed Node binary:

```text
node scripts/drill-brevo-backup-restore.mjs
```

It creates a new loopback-only cluster and synthetic fixtures in all thirteen
tables. It runs the real exporter with a test-only, local SQL-backed fetch
adapter, including a second page of Brevo events. No HTTP request reaches
Supabase. It encrypts and decrypts the package using a disposable in-memory
key, then invokes the unchanged local restore CLI against an empty database.

Assertions compare every exported and restored row, exact Auth anchors,
provider-specific IDs, opt-out timestamps, suppression ownership/review state,
trigger modes and sequence state. Damaged files, incomplete inventories,
remote destinations, a repeated restore and invalid database rows must fail.
Constraint failures must roll back rows and trigger changes. The restored
opt-out and delivery-identity guards must remain active.

The cluster is stopped in `finally`. Its disposable fixtures and aggregate
`RESULT.json` are written under the printed `/tmp/alpha-brevo-restore-*`
directory. That directory can disappear between WSL invocations, so save the
aggregate console result in the dated Desktop Files checkpoint. Temporary
fixtures are not durable evidence. No production data or actual backup key is used.
This does not verify a downloaded hosted artifact, hosted REST permissions,
concurrent-write consistency or full Supabase Auth recovery. The live
format-5 artifact and approved isolated restore remain a rollout gate.

### Earlier Round 80 format 4 drill

The older drill below targets its matching Round 80 migration chain. Use the
focused format-5 drill above for the current Brevo candidate. Do not interpret
a historical Round 80 result as verification of the changed migration chain.

The drill uses synthetic fixture data only. It never reads `.env.local`, opens
a real backup, or contacts Supabase, Stripe, Resend, an AI provider, or any
other external system. It creates a temporary PostgreSQL cluster bound only to
`127.0.0.1`, initializes the minimal Supabase roles and `auth.uid()`, applies
every repository migration to fresh source and destination databases, creates
one synthetic row per critical table, builds a format 4 snapshot, and runs the
public local restore CLI.

It verifies the successful counts, exact Auth anchors, foreign keys, and serial
sequence state. It also proves that a changed file, a nonlocal URL, and a second
restore into a nonempty destination all fail. The temporary cluster is stopped
and removed after the run.

```powershell
$env:PSQL_BIN = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
node scripts/drill-r80-backup-restore.mjs
Remove-Item Env:PSQL_BIN
```

Expected output is one aggregate `DRILL PASS` line. If native PostgreSQL is
installed elsewhere, point `PSQL_BIN` at that `psql` executable. The drill uses
the sibling `initdb` and `pg_ctl` executables. It adds no npm dependency.

## Manual recovery order

Recovery is intentionally manual. It changes subscriber access and billing
state and requires Alex's approval.

1. Freeze Alpha checkout, account deletion, scheduled maintenance, and sends.
2. Confirm the target belongs only to Alpha. Preserve the damaged state before
   changing it.
3. Recover Supabase Auth identities and the database schema through a supported
   provider recovery path.
4. Apply the exact Alpha migrations needed by the snapshot.
5. Decrypt the artifact in a private temporary directory. Check its manifest
   before importing any row.
6. Validate the format 4 row counts, byte counts, and SHA-256 hashes before
   importing. Import the JSON in the manifest order. Preserve every primary key
   and exact Stripe identifier. Use a controlled database transaction where the
   supported recovery path allows it.
7. Compare imported row counts with the manifest. Check foreign keys, serial
   sequences, and the unresolved checkout, deletion, refund, renewal, Resend
   suppression-review, and maintenance queues.
8. Reconcile read-only state against the dedicated Alpha Stripe account before
   enabling checkout or billing mutations.
9. Verify signed access, unsubscribe links, inbox reads, and one non-mutating
   health request before re-enabling scheduled work.
10. Re-enable one subsystem at a time. Keep sends disabled until account access
    and delivery coverage are verified.

## Stop conditions

Stop the recovery if the target project is unclear, Auth IDs are unavailable,
the manifest is missing or marked failed, row totals do not match, a required
migration is absent, exact Stripe bindings conflict, or any imported row would
overwrite newer valid data. Preserve evidence and choose a reviewed roll-forward
plan before continuing.
