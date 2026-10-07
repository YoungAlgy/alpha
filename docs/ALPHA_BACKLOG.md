# Alpha remaining work

Current local timing candidate review, October 7, 2026. The active release base
is `ba22400eed642bc570d2e667922398e6adb42573`; the October 5 feed-pool repair
has since shipped. The fresh bounded normal-delivery receipt is
`normal-delivery-check-20261007.md` in the external receipt folder. It records
that bounded check only. It does not establish an arbitrary scheduled start,
the cause of a scheduler delay, or provider acceptance time for deliveries
outside the diagnostic's date window.

The current checkout contains an unreleased local timing candidate. Focused
offline checks, typecheck and disposable local PostgreSQL SQL verification
passed. No production build or RPC installation, push, or deployment is
included. Those actions require separate exact approval. The additive exact-date
coverage RPC does not change the old cutoff RPC. Historical test debt below is
preserved as history and is not reopened by this candidate.

The October 5 reconciliation and its feed-pool status below are retained as a
dated record, superseded by this current summary. Historical release approvals
are completed and cannot be reused.

## Current result

Alpha's free invite-only daily delivery is released. The October 5 calendar
and feed-pool repairs are completed release history. The October 7 normal
delivery receipt is the newest bounded evidence. Current eligibility is
resolved from protected records, never a launch-group allowlist. Access
approval and letter enrollment remain separate.

The local timing candidate defers scheduled delivery before 14:17 UTC, ahead of
provider preflight, install or build. A ready run pins the actual UTC issue date
and start time. Later pages preserve that date across midnight while the run is
under 90 minutes old. Manual dispatch uses the actual current UTC date and keeps
legacy Resend selection. No new resend or old-issue permission is added.

The candidate's additive `watchdog_issue_delivery_check(date)` checks exact
`week_of` values for today or yesterday UTC. It counts only currently eligible
accounts and exact-date issues with a nonblank Resend/Brevo message ID and a
`delivered_at` claim marker within that UTC day and no later than now. The claim
marker does not prove acceptance time. Out-of-window accepted rows remain
unproven by this bounded check. Eligibility follows enrollment, subscription,
access/cancellation, unsubscribe and suppression state.

Before 20:37 UTC, a scheduled watchdog checks the most recent closed day and
retains timing failure, even when uncovered count is zero. Due scheduled or
manual checks may close only exact-date notices for the date checked, with a
nonempty eligible audience and complete coverage. Closed-day and empty-audience
checks cannot close those notices. Undated alerts remain untouched in open
mode. The explicit paused branch keeps its prior closure behavior and
disclaimer. The original scheduler cause remains unknown.

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

The date-scoped timing candidate does not change the separate outcome evidence
items below. Its local passing checks do not reopen historical acceptance,
delivery-event, inbox-receipt or scheduler-cause questions.

Priority scores use (impact + risk) x (6 - effort). Each input is 1 to 5.
Effort is relative, not an elapsed-time promise.

| Item | Status and next step | Impact / risk / effort | Score |
| --- | --- | --- | --- |
| Decide on the October 7 delivery timing candidate | Local focused checks, typecheck and offline PostgreSQL verification passed. The candidate remains unreleased. Production build and the RPC installation, push and deployment are separate actions requiring fresh exact approval. No live timing change has occurred. | 5 / 4 / 3 | 27 |
| Record natural fallback and safety-event evidence | Ordinary healthy Resend sends do not prove automatic Brevo or content fallback. Accepted IDs do not prove provider-confirmed delivery or inbox receipt. Empty callbacks do not prove bounce, complaint or unsubscribe handling. Read sanitized aggregate evidence only under an appropriate requested check. Do not manufacture events or send letters just to make a test green. | 3 / 3 / 3 | 18 |
| Improve independent topic coverage where evidence supports it | Existing public-source adapters remain released. Broad news/music coverage is still limited. The October 5 research pass qualified no new adapter: Wikidata timed out once, Pressenza's exact original-item reuse boundary remains unresolved, and SciDev.Net's documented route does not establish current complete-credit coverage. Do not replay held probes or relax source guards to force output. See `public-source-gaps.md` and the named dated receipt below. The separate local calendar repair is described next. | 4 / 3 / 4 | 14 |

Keyed search was removed from normal scheduled content by the approved October 2
05:47 UTC activation. The `1eb3a14b` maintenance cleanup was retained in the exact
PLOS release. Both completed items have been removed from the remaining table.
Broad-topic coverage would need more evidence-backed research. Outcome proof
needs an observed event. Neither is a currently confirmed runtime bug.
No further live configuration change or external probe is authorized here.

## Calendar repair, released October 5 (historical record)

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

## Usable-feed-pool repair, released October 5 (historical record)

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
