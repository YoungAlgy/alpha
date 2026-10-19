# Scheduled pre-request failure notice

Scheduler-only candidate qualified October 19, 2026. The owner approved its
publication separately. Exact commit and remote readback belong to the matching
release receipt. This document alone is not proof that a release is active.

The daily workflow can fail before the application route is reached. Its
existing route alerts cannot observe checkout, clock, coverage precheck,
dependency, build or server-startup failures. The existing final upload keeps
diagnostics but does not itself notify the owner.

## Behavior

One failure step uses only the existing Alpha operations webhook. It runs on a
failed scheduled daily workflow before a delivery-route request has been
attempted. It precedes the existing failure-artifact upload. It never dispatches
a workflow, sends a letter, switches a provider, changes enrollment or repairs
delivery.

The notice contains a validated pinned issue date, a fixed stage label, numeric
run attempt and fixed-origin Alpha run link. Before the clock step establishes
the issue date, the notice says unavailable. It does not infer the date from the
wall clock or claim readers missed a letter. Logs, arbitrary errors, source
content, reader data, provider responses and secrets never enter the payload.

The helper source has no imports, package requirements or import-time I/O. An
exact checked inline mirror runs in the workflow so checkout failure does not
remove the alert implementation. It uses runner Node, which the existing clock
step already requires before Node setup.

Only the canonical HTTPS Discord webhook shape is accepted. Credentials,
alternate hosts, explicit ports, query strings, fragments and normalized path
tricks are rejected. A single POST has a five-second abort signal, no redirects,
no credentials, no response-body access and no retry. Mentions are disabled.
Only fixed result strings are logged. A failed notice never clears or replaces
the original workflow failure.

The delivery step writes route_attempted=true immediately before each daily
route request. The new notice then stays silent, including when the route
request had an uncertain outcome. Existing route and later watchdog reporting
retain responsibility after that point. There is no new provider switch or
duplicate-delivery opportunity.

## Limits

This is earlier detection, not autonomous recovery. Runner allocation failure,
cancellation, an exhausted job timeout or a GitHub-wide outage can prevent the
failure step from running. A missing/bad webhook or Discord failure can prevent
notification. Once a delivery request has been attempted, some transport or
contract errors may only surface through existing watchdogs. The conservative
pre-request marker can also suppress this notice if execution stops between
writing the marker and starting the HTTP call.

No persistent notification dedupe is introduced. Each failing scheduled run may
try one notice, so a later failed recovery slot can report its own distinct run.
HTTP acceptance does not prove channel receipt. No real alert was sent to
qualify this candidate.

## Focused verification

- Helper tests inject fetch and cover payload isolation, endpoint and context
  rejection, date handling, stage priority, disabled mentions, HTTP failures and
  uncertain POST outcomes with no retry.
- The wiring verifier's local --release-scope mode compares the complete
  current workflow to its pinned approved baseline after
  removing exactly the new notice, added stage IDs and pre-request marker.
  All schedules, concurrency, permissions, time budgets, source flags and
  existing delivery commands must match. Mutation cases cannot hide drift.
- The exact inline runner executes with injected fetch from a fresh empty
  directory and a minimal synthetic environment. No checkout or package is
  available. This proves its checkout-failure path without a real alert.
- Default wiring verification also runs in a shallow CI checkout without Git
  history. The existing build job now runs the helper, inline-contract and
  YAML/Bash syntax checks offline. No test alert is sent by CI.
- The existing YAML/Bash syntax gate parses all seven workflows and syntax-
  checks 28 run blocks without executing them.

## Proposed release, separate approval required

Publish only .github/workflows/daily-send.yml, the focused offline test step in
wrangler-config-guard.yml, the dependency-free helper, its two focused
verification scripts and this document. The protected existing
62-file worktree changes remain outside that release. No website/Worker build,
deployment, database migration, dispatch, test notice or letter send is part of
the proposal. Normal upcoming scheduled runs are the only new consumers.

Rollback target is the daily workflow at source
350587afdd6558379cad949e661ddc217cac9458. A later explicitly approved rollback
commit would restore that workflow and remove the added CI test step, removing
this notice, added IDs and output marker. It would not change the website,
provider ledger, enrollment or issue
rows. Publishing/rollback authority is not granted by this document.
