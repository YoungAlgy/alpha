# Delivery timing and issue dates

Status: released October 7, 2026 in
`53b901eae0181be55016655624ac63886cccb472`. The timing patch was committed as
`e63e2d30`; the successor also contains the narrow dependency security repair.
The additive RPC was installed before release. Source, build, CI and live
readback evidence is recorded below. The later bounded normal-run evidence
records provider acceptance for October 7 only. The scheduler cause remains
unknown, and future schedule punctuality is not established.

## Scheduled sends

The scheduled slots are 14:17, 15:37 and 18:47 UTC. A run that starts before
14:17 UTC is deferred before provider preflight, dependency installation or
build. Once a scheduled run is ready, it pins the actual UTC issue date and
start time. Each page uses that same date across midnight while the run is less
than 90 minutes old. A new run after that bound cannot continue the old run's
pin.

Manual dispatch uses the actual current UTC date and keeps the existing Resend
selection behavior. This timing policy does not authorize resending a previous
issue or opening an older issue date.

## Coverage checks

The additive `watchdog_issue_delivery_check(issue_date date)` checks one exact
`issues.week_of` value and returns `checked_issue_date`, uncovered count and
eligible count. It accepts today or yesterday in UTC. Eligibility comes from
the current protected user state: `delivery_enrolled`, a subscription, either
granted access or no current cancellation, and no unsubscribe, provider
unsubscribe, bounce, complaint or pending suppression cleanup.

An issue counts as covered when it belongs to that user and exact week date,
has a nonblank Resend or Brevo message ID, and has a `delivered_at` claim marker
inside that UTC date and no later than now. `delivered_at` is the app's claim
marker, not the provider acceptance timestamp. A returned covered count cannot
prove acceptance time, provider delivery, inbox receipt or outcomes for accepted
rows outside the selected date window. The existing
`watchdog_delivery_check(timestamptz)` remains available for its existing
cutoff-based callers.

The scheduled send precheck sends its immutable pinned issue date and skips
work only when that same date is verified as fully covered. A missing,
mismatched or malformed RPC response stops before provider preflight,
dependency installation, build or sending.

## Watchdog behavior

The watchdog target is 20:37 UTC. Before that target, a scheduled execution
checks the most recent closed UTC day. It still records a timing failure even
when that date has zero uncovered readers. This date choice does not reveal the
original date of a delayed cron event or explain why the scheduler started
late.

A due scheduled check can resolve the timing notice. A manual check cannot
resolve it. Only a due scheduled or manual check with a nonempty eligible
audience and zero uncovered readers can close date-scoped coverage notices for
the exact date checked. An empty audience or a closed-day check never closes
those notices. Existing undated delivery alerts are left untouched in open
mode. The explicit paused-mode branch retains its prior closure behavior and
disclaimer.

## Evidence and release state

The latest bounded normal-delivery receipt is
`postrelease-normal-check-20261007-2313.md` in the external receipt folder.
Run `37678700835` on `53b901ea` started October 7 at 20:00:01 UTC and recorded
three provider acceptances for that day's issue, zero retry-required and zero final
uncovered readers. Resend readiness/capacity passed, so automatic Brevo
selection was unnecessary. Later run `37684420132` started at 20:45:15 UTC and
skipped the covered issue before provider selection or sending.

Those two invocations show no duplicate or unsafe provider switch. Per-message
provider identity, provider delivery and inbox receipt were not independently
read. No postrelease watchdog invocation was visible in the one 23:13 UTC
history query. Natural fallback and a normal postrelease watchdog result remain
unproven. This local review made no fresh external read. The result does not
establish future schedule punctuality or the original scheduler cause.

Focused offline checks, typecheck and disposable local PostgreSQL verification
passed. The approved additive RPC installation completed October 7 at 15:00:41
UTC without changing the old cutoff function or protected delivery contracts.

The fresh successor production build passed at 15:40:29 UTC. Exact-source CI
`37646022019` passed all three jobs. Deployment completed at 15:45:06 UTC.
All twelve non-sending live checks passed. Final canonical and Worker readback
at 15:46:23 UTC matched `53b901ea` at 100 percent, with invite access, billing
closed and delivery open. No manual letter, retry or enrollment change occurred.

The completed release receipt is `dependency-security-release-receipt-20261007.md`
in the external receipt folder. It supersedes the earlier pending candidate and
CI-blocked timing receipt. Rollback source is
`ba22400eed642bc570d2e667922398e6adb42573`, Worker
`5e4fa775-d622-4739-acf2-9085a5bc9db1`. Retain the unused additive RPC if rolling
back. This records the target and does not authorize a rollback or another release.
