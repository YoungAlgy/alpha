# Alpha remaining work

Reconciled locally October 5, 2026 from the calendar release receipt, the
October 5 05:34 UTC normal-outcome record and the fresh feed/cache review.
Reviewed release base: `7c33961f7feb7cb80ff8b3e8320f00e66061f9f2`.
The calendar receipt last verified that website release at 16:29:34 UTC.
No remote or live check was repeated for this local review.
This is a dated decision record. New local and authorized live evidence takes
priority. Historical release approvals are completed and cannot be reused.

## Current result

Alpha's free invite-only daily delivery is already released. The October 5
calendar repair completed its separate exact build, push, CI and deployment.
A further feed-pool repair is local, uncommitted and unreleased. Rejected entries
could previously fill the 100-item limit and hide a usable later item. The
candidate retains only permitted metadata in a shared, size-bounded snapshot,
then filters and caps usable items on every read. Ten focused offline checks,
typecheck and two final independent reviews passed. Its fresh production build
and release remain separate approval gates.
The latest normal delivery evidence covers three delivery-eligible readers.
Current eligibility is resolved from protected records, never a launch-group
allowlist. Access approval and letter enrollment remain separate.

The October 1 source-dispatch and watchdog Issue-channel patch shipped as
`6f6e8c12`. Its exact build, CI and twelve non-sending live checks passed.
The October 2 exact PLOS release build, CI and twelve non-sending live checks
also passed. Do not repeat those completed
gates or reopen historical Round-script debt merely to close this backlog.

## Completed work

- Free invite access, separate owner-controlled delivery enrollment, resumed
  signup drafts and in-app confirmation UI are implemented.
- Scheduled writing is no-model with paid AI off. Valid source material can
  be formatted locally without a writer API call.
- Public backups are installed: Google News RSS, mapped NIST/FDA/Federal Reserve
  feeds, Global Voices, narrow licensed Crossref nutrition metadata and PLOS
  research metadata for nutrition, mental health and AI. PLOS is released and
  its scheduled opt-in is enabled. Each tier's coverage limits still apply.
- Shared request ceilings and separate persistent provider cooldowns are
  activated. Outage history and one owned recovery probe survive separate runs.
  Raw caches remain process-local. Finished sections remain durable.
- Scheduled email selection can choose Brevo before new attempts when Resend
  cannot serve the new batch and Brevo readiness/capacity checks pass. Existing attempts retain their
  recorded provider. Unknown outcomes cannot trigger an unsafe provider switch.
- Same-day recovery shares the sender's concurrency group and acceptance
  coverage guard. Suppression and current-address checks remain mandatory.
- Watchdog timing uncertainty and exact bounded Issue selection/error handling
  shipped. Due scheduled watchdogs for October 3 and 4 later completed with
  three eligible readers and zero uncovered. This closes the earlier missing
  normal-coverage evidence. It does not prove future punctual starts or every
  delivery outcome below.
- The October 3 citation-history release and service-only RPC installation are
  complete. Ordinary history-enabled runs are recorded on two issue dates.
  Aggregate logs do not prove a particular history-RPC call or natural failover.

## Remaining backlog, in priority order

Priority scores use (impact + risk) x (6 - effort). Each input is 1 to 5.
Effort is relative, not an elapsed-time promise.

| Item | Status and next step | Impact / risk / effort | Score |
| --- | --- | --- | --- |
| Record natural fallback and safety-event evidence | Ordinary healthy Resend sends do not prove automatic Brevo or content fallback. Accepted IDs do not prove provider-confirmed delivery or inbox receipt. Empty callbacks do not prove bounce, complaint or unsubscribe handling. Read sanitized aggregate evidence only under an appropriate requested check. Do not manufacture events or send letters just to make a test green. | 3 / 3 / 3 | 18 |
| Improve independent topic coverage where evidence supports it | Existing public-source adapters remain released. Broad news/music coverage is still limited. The October 5 research pass qualified no new adapter: Wikidata timed out once, Pressenza's exact original-item reuse boundary remains unresolved, and SciDev.Net's documented route does not establish current complete-credit coverage. Do not replay held probes or relax source guards to force output. See `public-source-gaps.md` and the named dated receipt below. The separate local calendar repair is described next. | 4 / 3 / 4 | 14 |

Keyed search was removed from normal scheduled content by the approved October 2
05:47 UTC activation. The `1eb3a14b` maintenance cleanup was retained in the exact
PLOS release. Both completed items have been removed from the remaining table.
Broad-topic coverage would need more evidence-backed research. Outcome proof
needs an observed event. Neither is a currently confirmed runtime bug.
No further live configuration change or external probe is authorized here.

## Unreleased local calendar repair, October 5

Node's permissive `Date.parse` converted an impossible RSS February 30 into
March 2. The old freshness gate could treat that malformed item as current and
stop the resolver before an otherwise useful backup. An offline regression
reproduced the failure before the patch and passes with the repair.

The shared parser now checks the original calendar and a complete explicit-zone
timestamp before applying the zone. Google/publisher filtering and both GDELT
date gates use it. Valid RSS/ISO timestamps, zone crossings, valid leap dates,
good siblings and raw-cache reuse are covered. The existing no-key resolver
test proves malformed Google dates can fall through to an eligible backup.
GDELT remains off and live-unproven. No adapter or live flag was added.

Twelve focused offline checks and the non-incremental application typecheck
passed. Independent follow-up review found no blocking issue. Timeouts, request
ceilings, cooldowns, credits, repeat-link exclusions and reader access are
unchanged. No paid/model/source call, send or release occurred. A fresh production
build was not run because normal environment loading is separately gated.
Evidence: `source-review-calendar-fix-20261005.md` in the external receipt folder.

That earlier local calendar candidate has since shipped as `7c33961f`.
The exact build, CI, deploy and twelve non-sending live checks passed under
separate approval. `calendar-release-receipt-20261005.md` supersedes its earlier
pending-build status. This does not authorize a release of the new feed-pool fix.

## Local usable-feed-pool repair, October 5

The new offline regression failed on the released base and passes on the local
candidate. It covers valid item 101 behind bad dates, stale/future metadata,
wrong hosts or missing credits. It also covers the 100-result limit, fixed-feed
sharing across date windows, publication-time changes in a warm cache and the
one-minute empty/unusable TTL. Cached publisher/licensed data omit bodies and
media. Google retains its existing source snippet. Input and serialized cache
snapshots are both bounded at 256 KiB. Existing budget/circuit identities,
request limits, source order, attribution and prior-link guards are unchanged.

Final independent feed and persistence reviews found no supported defect.
All ten focused offline checks and non-incremental typecheck passed. No
production build, external request, real generation/send, commit, push or deploy
occurred. Native owned mirrors were untouched. Full evidence is in
`source-valid-pool-review-20261005.md` in the external receipt folder.

## Earlier safety cleanup, released October 2

The obsolete `scripts/verify-watchdog-proof-of-send.mts` entrypoint used to load
local credentials, borrow an active reader and write/delete a fake issue in the
configured database. It is unused by current workflows. It is now hard-blocked
before environment loading. Its historical body remains only for old source-text
assertions. No argument reopens it. The new offline
`scripts/verify-legacy-watchdog-test-guard.mjs` checks empty configuration,
non-secret configuration markers and attempted override arguments, while
denying all sockets/fetches and environment-file reads. This is a tooling safety
fix. No reader record was touched.

That six-file maintenance scope was committed and pushed as `1eb3a14b` with
passing exact CI. No runtime deployment was required for that maintenance step.
The subsequent PLOS source release completed under separate approval as
`207a4fae`, with its exact build, deployment, migration and activation recorded.

## Latest recorded normal outcomes, checked October 5 at 05:34 UTC

The saved requested check inspected completed October 3/4 runs on `583ef265`.
Primaries `37142507128` and `37223445816` started at 17:59:07 and 18:11:26 UTC
on their respective dates. Each reported three eligible readers, three new
Resend acceptances and zero failures, retries, backup letters or uncovered
readers. Resend readiness and capacity passed, so Brevo selection was unnecessary.
All four corresponding recoveries found zero uncovered and skipped sending.

Watchdogs `37161266016` and `37244079305` started at 23:17:00 and 23:31:37 UTC
on their respective dates. Both completed successfully with three eligible and
zero uncovered. No timing-uncertainty or Issue-channel error was reported.
No cause for the difference from configured start times is asserted.

No-model/no-key and durable source controls were enabled. Provider-confirmed
delivery, inbox receipt, natural provider/source fallback and real safety-event
processing remain unproven. This is dated saved evidence. No October 5 delivery
result or fresh provider/database read is claimed by this local review.

## Earlier normal outcome evidence, October 2 at 20:19 UTC

One requested bounded check found scheduled run `37053631148` on `207a4fae`
started at 19:21:55 UTC and completed successfully at 19:23:14 UTC. Its protected
precheck found three delivery-eligible readers. One HTTP 200 page recorded three
Resend acceptances, zero failures, deferrals, retry-required or final uncovered
readers, and zero backup content letters. Resend sender and both usage windows
had capacity, so Brevo fallback was unnecessary. No-model/no-key/PLOS and durable
budget/cooldown flags reached preflight/runtime. Paid calls were zero.

Later scheduled recovery `37058464041` started 20:06:41 UTC and its job completed
20:06:49 UTC. Its protected check found three eligible and zero uncovered.
Provider selection, build and sending skipped. No competing recovery send or
unsafe provider switch was observed. Exact transport retry counts, provider
delivery confirmation, inbox receipt and natural PLOS use remain unverified.
No cron-expression identity or scheduler delay cause is inferred.

The 20:37 UTC watchdog remains unchecked in this recorded pass. Sender targets
remain 14:17/15:37/18:47 UTC, with watchdog at 20:37 UTC. Tampa daylight-saving
targets are 10:17 AM, 11:37 AM, 2:47 PM and 4:37 PM. They do not promise actual
starts or inbox arrival. No polling or background monitoring was started.

## Earlier normal evidence, October 2 at 04:53 UTC

Bounded GitHub metadata checked October 2 at 04:51 UTC. Only the two newly
visible completed jobs were projected at 04:53 UTC. No raw logs, addresses,
message bodies or credentials were saved or printed.

- October 1 primary `36915309804` remains successful. Earlier protected
  aggregates recorded three eligible readers and three Resend acceptances,
  with zero failures or uncovered readers. Sender readiness and both usage
  windows passed. Brevo selection was unnecessary. Earlier logs were not reread.
- Later recovery `36937919693` started October 1 at 22:55:29 UTC and completed
  at 22:56:13 UTC. Its protected precheck at 22:56:11 reported three eligible,
  zero uncovered. Provider selection and all sending steps were skipped.
- Watchdog `36944331854` started October 2 at 00:06:48 UTC and completed with
  a timing-uncertainty failure by 00:07:07 UTC. Its coverage guard reported
  `scheduled_window_not_due` at 00:06:57. Coverage was not queried. Secrets and
  heartbeat jobs passed. No logged Issue-channel error was observed. This does
  not prove today's letter failed, an original cron date or a scheduler cause.

The next unchanged targets on October 2 are 14:17 UTC primary, 15:37 and
18:47 UTC recovery, and 20:37 UTC watchdog. Tampa daylight-saving targets are
10:17 AM, 11:37 AM, 2:47 PM and 4:37 PM. Targets do not promise actual starts
or inbox arrival. No polling or background monitoring was started.

## Local reporting and privacy cleanup, October 2 at 21:28 UTC

This follow-up was separately approved and pushed as `81d25bc` after the local
review. The preflight reports PLOS under its exact four gates, describes the local
no-model writer correctly and omits warnings for intentionally skipped API
tiers. Public page summaries use a bounded fixed allowlist, so unexpected
private response fields cannot enter the Actions log. Raw page validation,
provider routing, recipient checks and schedules are unchanged.

Twelve current focused offline checks passed. They include the real preflight
body with injected provider fixtures, stdin privacy limits, exact workflow scope,
YAML/Bash syntax, provider ownership and source failure/budget/cooldown behavior.
No application TypeScript or Next runtime code changed, so the completed exact
release builds and typechecks were not repeated. The owned native mirror stayed
clean and unchanged at the released commit.

The older `verify-send-watchdog-resilience.mjs` check has 29 stale contract
assertions that were reproduced against unchanged `207a4fae` source. It still
expects the retired maintenance preflight and old workflow step layout. Only its
summary-print assertion was aligned with this privacy cleanup. Its other old
assertions were not rewritten or bypassed. That test debt is recorded separately
from the passing current focused checks and is not a confirmed delivery failure.
No historical regression result is claimed green by this pass.

Push-triggered CI run `37069512363` completed successfully at 21:55:13 UTC.
Production build, offline watchdog contracts, scheduler/worker guard and
dependency audit passed. The normal hook and exact remote master readback also
passed. No website deployment, migration or send was performed. That approval
is complete and does not authorize another release.

## Dependencies and explicit limits

Finite provider allowances cannot guarantee thousands of free daily letters.
Supabase remains required for protected delivery. GitHub runs both sender and
watchdog, so the watchdog does not independently cover a GitHub-wide outage.
Sign-in SMTP still depends on Resend. Public feeds are best-effort and may lack
fresh relevant material. If every safe source is exhausted, the existing bounded
section/backup rules apply. Stale, malformed or invented content must not be
silently labeled current.

GDELT live usability is unproven after the earlier timeout. It stays off and
must not be retried just to force validation. A budget reservation before later
queue expiry is a bounded known contract limit. Existing non-failing build
warnings have no confirmed runtime repair in this pass.

No perpetual-uptime, unlimited-free-capacity or complete all-topic claim is made.
An independent scheduler or sign-in transport would need a separate reviewed
design and exact live approval. They are architectural options, not hidden
unfinished patches.

## Evidence and authority

Operational receipts live in the owner's Desktop Files Alpha-Migration folder,
outside the public repository. The authoritative resume checkpoint is
`2026-09-26-codex-resume/checkpoint.md`. Named receipts in
`2026-09-26-delivery-reliability` include:

- `final-patch-release-20261001.md`
- `postrelease-review-6f6e8c12.md`
- `build-only-6f6e8c12-checkpoint-20261002.md`
- `backlog-reconciliation-20261002.md`
- `plos-release-checkpoint-20261002.md`
- `plos-normal-delivery-check-20261002-2019.json`
- `reporting-cleanup-push-20261002.json`
- `extended-resilience-v1-release-receipt-20261003.md`
- `post-history-normal-check-20261005.md`
- `post-history-normal-outcomes-20261005.json`
- `independent-source-decision-20261005.md`
- `source-review-calendar-fix-20261005.md`

Use current source, exact release receipts and fresh authorized evidence.
Preserve unrelated work and the owned native mirror. The October 3 receipt
records a clean active Windows checkout at `583ef265` and a separate native
release checkout, with earlier owned mirrors untouched. The October 5 local
review confirmed that Windows baseline before the local calendar and documentation changes.
These edits remain uncommitted. Further local work stays unreleased until
separately approved. No commit/push/deploy, send,
retry/backfill, source probe, audience/enrollment, account/billing/secrets or
remote-setting change follows from this backlog. Keep Alpha separate from the
owner's other products.
