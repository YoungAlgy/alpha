# Delivery timing and issue dates

Status: local timing candidate, October 7, 2026. This document describes the
current candidate in the active checkout. It is not evidence that the candidate
has been built for production or released. The October 5 feed-pool repair is
already released and is separate work.

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
`normal-delivery-check-20261007.md` in the external receipt folder. Its result
applies only to that check and does not establish future schedule punctuality
or arbitrary-date acceptance evidence. The scheduler cause remains unknown.

Focused offline checks, typecheck and local offline PostgreSQL verification
passed for the candidate. No production build, RPC installation, push or
deployment is included. Each of those release actions needs separate exact
approval.
