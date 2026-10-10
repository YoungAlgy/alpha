# ADR: Durable public-source outage memory

Status: Accepted, released and activated October 1, 2026 at 15:44 UTC.
Date: October 1, 2026

## Context

Raw caches and failure cooldowns expire within one process. The shared request
ceiling persists, but cannot represent an outage. Scheduled recovery slots are
80 and 270 minutes after the primary, longer than the old 15-minute cooldown.
Alpha must preserve useful validated work and never store reader/query data in
operational provider state. No paid dependency or additional service is needed.

## Decision

The original October 1 rollout used seven fixed private Supabase circuit rows
and two service-role-only RPCs. The approved October 2 PLOS migration brought
the set to eight fixed rows. The approved October 8 ccMixter migration added
the ninth identity as part of release `2d8a6a4d`. Both additions preserved all
prior provider state, RPC definitions and privileges.
`ALPHA_DURABLE_SOURCE_COOLDOWN` is off by default. The migration was reviewed
and applied before the approved activation. Its scheduled variable is
`SEND_ALPHA_DURABLE_SOURCE_COOLDOWN`. Existing request ceilings stay separate.

An uncached request first receives database admission, then reserves the
existing budget, then fetches/parses under the existing deadline/body ceiling.
Healthy requests remain concurrent. Actual fetch/parse failures open a
15-minute cooldown. Failed recovery probes increase it to 30, 60, 120 and at
most 240 minutes. Counts survive expired cooldowns and separate processes.
After expiry, exactly one caller gets a 30-second recovery lease. A dead caller
cannot leave a permanent lock. Success changes the generation and clears only
its owned live lease. Failure also changes the generation, so delayed/duplicate
completions cannot overwrite a newer failure or recovery. After 24 hours with
no new failure and no live probe, old history decays to a new healthy generation.

Quota, admission/database and local queue errors are not source failures.
Budget failure releases only the owned probe, without clearing outage history.
RPC calls have a three-second caller deadline. A request may finish at the
shared transport's later deadline, but cannot cause a source fetch after its
caller timed out. A late begin may occupy one lease for at most 30 seconds.

Valid local raw cache hits happen before admission and survive an outage.
Freshness and reader link exclusions remain downstream. No durable raw cache
is added. The existing finished-section cache already persists useful sections.
Fixed providers have isolated outage state, except the two Global Voices feeds
share one circuit. Publisher feeds and Crossref retain their shared request cap.

A failed optional completion write does not invalidate actual validated source
metadata. Return that useful work with a fixed-provider warning. This proves
retrieval only, and does not claim durable recovery. Future uncached requests
still require admission and budget. An unavailable/malformed admission denies
the request. No provider response/error body is stored or logged by this layer.

## Options considered

- Reuse rate-limit buckets: rejected. Consuming quota cannot safely check or
  clear outage state, and window resets are unrelated to recovery ownership.
- GitHub cache: rejected. Short-lived raw metadata is already stale by recovery
  time, cache writes are not atomic leases, and custom query keys add privacy risk.
- Persistent cooldown without a probe lease: smaller, but permits simultaneous
  cross-run recovery and requires never clearing state or accepting stale races.
- Dedicated fixed circuit: selected. Tiny bounded state, no new service cost,
  generation-fenced recovery, and no changes to account/letter/provider attempts.

## Verification and rollout

Focused tests cover adapter denial before budget/fetch, independent providers,
cache-first behavior, expiry/backoff, concurrent generation fencing, neutral
quota errors, RPC timeout/malformed response, unconfirmed completion and privacy.
The SQL was tested in a new disposable local PostgreSQL cluster, including role
privileges and two-session probe admission. Those tests used no managed database.

The approved live rollout completed with exact release
`8d9b09db328068f71a362c7e0982017f0c07bf01`. Managed catalog and ledger checks
confirmed the atomic schema/ACL/ledger update, seven fixed rows and the two RPCs.
Only `SEND_ALPHA_DURABLE_SOURCE_COOLDOWN=1` was activated. Defaults remain off
in code. Strict no-key mode, GDELT, source order, schedules, delivery enrollment
and the no-model/paid-AI-off rules were unchanged. This approval is complete.

The ordinary October 1 delivery run later logged the enabled runtime flag.
That proves the flag reached execution, not that a source failed or a durable
recovery probe completed. Actual source failover remains unproven. The separately
approved postrelease repair shipped as
`02ccaff18cd6c95ac73fb79f2a8c1e1c7d953942` later on October 1. It separates
admission/budget/queue rejections from process-local provider failure cooldowns
and adds a watchdog timing guard. Exact focused checks, build, push CI and
non-sending live release checks passed. No migration, source activation or
schedule change was part of that later release. Its ordinary watchdog outcome
and a natural source failure/recovery remain unobserved in the recorded evidence.

## October 2 extension

Release `207a4fae` added the independent `plos-research` circuit identity and
the additive `20261002000000_plos_public_source_circuit.sql` migration. The
atomic release preserved the seven existing provider states and the protected
RPC contracts. PLOS uses its own two-request fixed fifteen-minute budget.
The PLOS scheduled flag was enabled only after the exact approved deployment.
The ordinary October 2 run reached the enabled source flags with zero paid
calls. It does not establish a natural PLOS outage, recovery or content selection.

## Consequences and limits

### Local GOV.UK candidate, October 10

The default-off GOV.UK metadata adapter now uses the fixed `govuk-news` circuit
identity and a separate two-request fixed fifteen-minute durable budget.
Both durable switches and no-model mode are required for its opt-in. Its raw
pool shares the existing process cache, without treating it as durable state.
Admission denial occurs before reservation/fetch. Actual upstream failure uses
the existing backoff and fenced probe contract. Quota/control failures remain
neutral. Failed optional completion cannot discard valid retrieved metadata.

`20261010000000_govuk_public_source_circuit.sql` is the guarded additive migration.
It checks the exact ten prior provider rows and recognized prior/extended
constraint, then extends that constraint and inserts only `govuk-news`.
It preserves prior provider state, RPCs and ACLs. Disposable PostgreSQL 17.11
checks passed apply/reapply/rollback, unexpected-prior-state rejection, actual
permission denials and cross-session healthy/probe/budget admission. The prior
constraint guard rejects a matching literal list widened by `OR true`.
The finished adapter's single anonymous qualification used injected reservation
and circuit hooks, with zero durable RPC calls. It does not prove live admission.
Managed installation and scheduled activation require the current external
release receipt. The raw cache remains process-only acceleration.

### Local Statistics Canada candidate, October 10

`statcan-labour` is a separate default-off identity for one fixed Atom endpoint.
It has its own two-request fixed fifteen-minute budget. No-model mode and both
durable switches are required before the source opt-in can run. New requests
use existing protected admission, budget reservation, cooldown and fenced probe
completion. Budget/control errors remain neutral and optional completion failure
preserves validated metadata without claiming recovery. Generic offline fixtures
test both independent budget instances and shared circuit behavior.

The guarded `20261010010000_statcan_public_source_circuit.sql` draft requires the
exact eleven existing identities and recognized constraint shape. It adds only
the twelfth identity without changing existing state, RPCs or ACLs. The prepared
local SQL verifier checks prior outage/probe preservation, RPC/ACL/RLS equality,
admission, cooldown, idempotent reapplication and rollback. Final disposable
PostgreSQL 17.11 execution passed October 10 at 07:09 UTC, 56 helper checks.
Eight unexpected starting states were rejected, including boolean widening.
Exact rollback and prior rows/RPCs/ACLs/RLS preservation passed. Separate sessions
admitted one recovery owner and two requests while denying the third in the same
fixed window. The temporary server is verified stopped. This proves a local
fixture only. Managed installation, activation and release remain separate
approvals. The source's response and projected raw metadata pool
are both capped at 256 KiB, then current dates and prior-link aliases are selected
on each cache read. Raw cache state remains process-local.

Supabase remains a dependency. A database outage can prevent new source requests
when this opt-in is active. Existing valid cache/sections remain usable. Cooldowns
reduce needless attempts but cannot supply missing current coverage or guarantee
unlimited free capacity. Keyed sources, delivery providers and schedules are not
changed. Music/custom coverage remains limited. No always-on promise is made.
