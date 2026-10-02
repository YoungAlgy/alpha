# Alpha remaining work

Reconciled October 2, 2026. Source base:
`1eb3a14be5b68b18933bfc19cf1c77f8a04d63a5`. Website runtime remains `6f6e8c12`.
This is a dated decision record. New local and authorized live evidence takes
priority. Historical release approvals are completed and cannot be reused.

## Current result

Alpha's free invite-only daily delivery is already released. The bounded
independent reviews found no new runtime defect requiring another deployment.
The latest normal delivery evidence covers three delivery-eligible readers.
Current eligibility is resolved from protected records, never a launch-group
allowlist. Access approval and letter enrollment remain separate.

The October 1 source-dispatch and watchdog Issue-channel patch shipped as
`6f6e8c12`. Its exact build, CI and twelve non-sending live checks passed.
The October 2 local production build also passed. Do not repeat those completed
gates or reopen historical Round-script debt merely to close this backlog.

## Completed work

- Free invite access, separate owner-controlled delivery enrollment, resumed
  signup drafts and in-app confirmation UI are implemented.
- Scheduled writing is no-model with paid AI off. Valid source material can
  be formatted locally without a writer API call.
- Public backups are installed: Google News RSS, mapped NIST/FDA/Federal Reserve
  feeds, Global Voices and narrow licensed Crossref nutrition metadata.
- Shared request ceilings and separate persistent provider cooldowns are
  activated. Outage history and one owned recovery probe survive separate runs.
  Raw caches remain process-local. Finished sections remain durable.
- Scheduled email selection can choose Brevo before new attempts when Resend
  cannot serve the new batch and Brevo readiness/capacity checks pass. Existing attempts retain their
  recorded provider. Unknown outcomes cannot trigger an unsafe provider switch.
- Same-day recovery shares the sender's concurrency group and acceptance
  coverage guard. Suppression and current-address checks remain mandatory.
- Watchdog timing uncertainty and exact bounded Issue selection/error handling
  shipped. The completed fixes do not establish every live outcome below.

## Remaining backlog, in priority order

Priority scores use (impact + risk) x (6 - effort). Each input is 1 to 5.
Effort is relative, not an elapsed-time promise.

| Item | Status and next step | Impact / risk / effort | Score |
| --- | --- | --- | --- |
| Remove keyed search from normal scheduled content | Completed October 2 at 05:47 UTC after the approved bounded generic sample. `SEND_ALPHA_NO_KEY_SOURCES=1` was read back. This is activation proof. It is not natural failover or ordinary postactivation delivery proof. | Completed | Completed |
| Retain the completed local safety/tests/docs cleanup remotely | Completed maintenance commit/push `1eb3a14b` and exact passing CI `36969801114`. No website deployment. The native mirror deliberately preserves the six owned changes on its earlier base. GDELT remains disabled. | Completed | Completed |
| Establish useful scheduled watchdog coverage | Verification remains open. New run `36944331854` on `6f6e8c12` started October 2 at 00:06:48 UTC. It correctly stopped with `scheduled_window_not_due` before coverage. An early run cannot identify its original cron date. Assess the next requested normal outcome once. Do not shift the cutoff, dispatch a competing check or reopen scheduler history without new evidence. | 4 / 4 / 2 | 32 |
| Record natural fallback and safety-event evidence | Ordinary healthy Resend sends do not prove automatic Brevo or content fallback. Accepted IDs do not prove provider-confirmed delivery or inbox receipt. Empty callbacks do not prove bounce, complaint or unsubscribe handling. Read sanitized aggregate evidence only under an appropriate requested check. Do not manufacture events or send letters just to make a test green. | 3 / 3 / 3 | 18 |
| Improve independent topic coverage where evidence supports it | October 2 local PLOS candidate adds research metadata for nutrition, mental health and AI with separate persistent limits and source credit. Its exact adapter proved one current mental-health citation and two ranked AI citations, with zero nutrition retained. Eighteen focused checks, app typecheck, actual disposable database tests and independent review passed. The exact candidate production build passed at 13:18 UTC, including the generated-worker typecheck. An approved release rebuilds with its committed identity. Global Voices compact byline is unproven, NSF was quiet for mapped topics and USDA RSS was stale. See `public-source-gaps.md`. Google remains the broad public discovery tier. | 4 / 3 / 4 | 14 |

The PLOS coverage candidate now has a bounded local implementation. Remaining
broad-topic coverage needs evidence-backed research. The outcome-evidence item
needs an observed event. Neither is a currently confirmed runtime bug.
No live configuration change or external probe is authorized by this document.

## Local safety cleanup completed in this pass

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
passing exact CI. No runtime deployment was required. The new PLOS source
candidate is separate and uncommitted. It needs its own release approval.

## Latest normal outcome evidence

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

Use current source, exact release receipts and fresh authorized evidence.
Preserve the dirty test and both owned checkouts. No commit/push/deploy, send,
retry/backfill, source probe, audience/enrollment, account/billing/secrets or
remote-setting change follows from this backlog. Keep Alpha separate from the
owner's other products.
