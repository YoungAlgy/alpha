# Alpha database recovery boundary

The daily encrypted artifact is a partial recovery snapshot. It protects the
subscriber rows and durable operational obligations that Alpha cannot safely
reconstruct after a database loss. It is not a PostgreSQL dump, point-in-time
recovery, or a complete Supabase project backup.

## Snapshot contents

The files in `MANIFEST.json` are ordered for restore dependencies:

1. `users`
2. `issues`
3. `support_tickets`
4. `checkout_profiles`
5. `checkout_fulfillments`
6. `checkout_creation_reviews`
7. `account_deletion_sagas`
8. `account_deletion_alpha_subscriptions`
9. `refund_reviews`
10. `legacy_checkout_fulfillments`

This preserves subscriber profiles and letters, support requests, checkout
ownership and replay guards, account-deletion work, exact subscription cleanup,
and unresolved refund decisions.

The snapshot deliberately omits generated caches, webhook delivery ledgers, and
the one-day `alpha_paid_call_budgets` counter. Those are transient bookkeeping.
Stripe, Resend, and Supabase Auth remain separate systems of record.

`MANIFEST.json` format 3 records the exact evidence for every file:

- `file`: the fixed table JSON filename
- `rowCount`: the exact number of rows in the JSON array
- `bytes`: the exact file byte length
- `sha256`: the lowercase SHA-256 hash of those exact bytes

The manifest also records the fixed table order, each stable export ordering,
the aggregate row count, and whether any export failed. A restore must reject a
missing file, extra table entry, failed manifest, changed byte count, changed
hash, or JSON array length that differs from `rowCount`.

## Important limit

`public.users.id` references `auth.users(id)`. The JSON snapshot does not export
`auth.users`, passwordless identities, Supabase configuration, storage, database
functions, triggers, grants, or provider account settings. Restoring these JSON
files alone cannot recreate working subscriber accounts.

A full loss therefore requires a supported Supabase database and Auth recovery
path. If the Auth identities cannot be recovered with the same user IDs, stop.
Do not invent replacement accounts or import `public.users` under new IDs.

## Before relying on a snapshot

- Confirm the workflow completed and uploaded only `backup.tar.gz.enc`.
- Confirm `MANIFEST.json` has `formatVersion: 3`, `failed: false`, all ten tables
  in the order above, and `rowCount`, `bytes`, and `sha256` for every file.
- Keep `BACKUP_ENCRYPTION_KEY` outside the artifact. Never print it in a log.
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

1. Validate the complete format 3 manifest, file inventory, exact byte counts,
   SHA-256 hashes, JSON arrays, per-table row counts, and aggregate row count.
2. Read only `id` and `email` from the validated `users.json` rows. Require
   unique valid UUIDs and emails, then prepare those exact local Auth anchors.
   It never prints the anchors or any backup row.
3. Open one PostgreSQL transaction, take an advisory lock, lock Auth and all ten
   public tables, and require every destination table to be empty.
4. Pause user-defined triggers inside the transaction, insert the exact local
   Auth anchors, and restore the ten public tables in the documented order.
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

The drill uses synthetic fixture data only. It never reads `.env.local`, opens
a real backup, or contacts Supabase, Stripe, Resend, an AI provider, or any
other external system. It creates a temporary PostgreSQL cluster bound only to
`127.0.0.1`, initializes the minimal Supabase roles and `auth.uid()`, applies
every repository migration to fresh source and destination databases, creates
one synthetic row per critical table, builds a format 3 snapshot, and runs the
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
6. Validate the format 3 row counts, byte counts, and SHA-256 hashes before
   importing. Import the JSON in the manifest order. Preserve every primary key
   and exact Stripe identifier. Use a controlled database transaction where the
   supported recovery path allows it.
7. Compare imported row counts with the manifest. Check foreign keys, serial
   sequences, and the unresolved checkout, deletion, refund, renewal, and
   maintenance queues.
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
