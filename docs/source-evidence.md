# Content-source evidence, released October 8, 2026

Released as `9b41f5c531bbe68606507f64a312b5e9dc41e873` on base `b12cc587`.
The fresh production build, exact-source CI and twelve non-sending live checks
passed. The external `source-reporting-release-final-20261008.md` receipt
records the exact scope and dated release evidence. It changes diagnostics only.
Source order, request ceilings, cooldowns, citations, enrollment and
email-provider ownership stay
unchanged. It adds no source, schema, flag or external request.

## What is recorded

`resolveTopicSignal` can report an optional fixed-shape observation after a
source tier completes ranking, prior-link exclusion and citable-URL checks.
Provider IDs are fixed internal enums. No reader, topic, URL, headline, source
text, raw error or profile field enters this reporting interface.

The outcomes are `signal`, `healthy-empty`, `unavailable` and
`no-signal-unconfirmed`. Unavailable includes control/quota failures, not just
an outage. Gemini's legacy helper returns the same undefined value for some
failures and genuine empty results, so that value remains unconfirmed. No
selection behavior is changed to obtain a stronger diagnosis.

The selection field describes earlier observed results in that resolver call:
`first-enabled`, `after-empty`, `after-unavailable` or `after-unconfirmed`.
A known unavailable result takes precedence over uncertainty, which takes
precedence over healthy emptiness. `first-enabled` can be the Google primary
in no-key mode. It does not assert that a fallback or outage occurred.

One `[source-evidence]` JSON line is emitted after an issue is assembled:

- `attempts` counts logical source-tier outcomes in this assembly. It does
  not count HTTP requests. One result can represent several queries, a cache
  hit or a control denial. Discarded section candidates are included here.
- `admittedSources` sums citable-URL counts from successful observations.
  It is not a distinct-source total or a count of final letter items.
- `selected` counts final selected sections with known fresh discovery
  provenance. It includes the selection reason for those sections only.
- Cached clones and shared in-flight results get separate unknown-provenance
  counts. A missing association remains unknown. No provider is guessed from
  a destination host, stored content or an earlier caller's result.

Each resolver owns its selection state. Each assembly owns its collector and
weak object associations. Nothing is added to issue JSON, shared cache entries
or protected records. Snapshots copy and freeze nested counts so late work
cannot rewrite an emitted result. Synchronous and asynchronous observer
failures are consumed without waiting. A logging failure cannot reject an
otherwise usable issue.

## What this cannot prove

`stage: assembled` is explicit. This line does not establish issue persistence,
provider acceptance, provider-confirmed delivery or inbox receipt. Orphaned
assembly work can also finish after its caller has moved on. Logs must not be
treated as a delivery ledger or summed into a unique-recipient count.

Fresh provider provenance establishes a source tier supplying a selected
section. It does not establish coverage of every topic or every day. Existing
cache and shared-work use remains unproven at provider level. Natural source
failover still needs an ordinary run observed after this release under a
requested check. No letters or safety events should be created just to fill
evidence.

The new offline test covers the fixed privacy shape, post-exclusion outcomes,
Gemini uncertainty, observer failures, isolated immutable state, cached/shared
unknowns and candidates discarded by same-letter citation deduplication.
The seven focused offline scripts and two typechecks passed on the same code
and test hashes before release. A fresh committed-source production build and
exact-source CI subsequently passed. This bounded release evidence does not
establish ordinary delivery or natural failover. The completed release approval
does not authorize another release, source probe or send.

## October 9: unreleased Federal Register enum

The local default-off finance-source candidate adds the fixed enum
`federal-register`. It uses the existing logical outcome/final-selection collector
without adding reader, topic, URL or source text. The fixture path verifies
post-exclusion counts and saved/rendered proposal labels. This is local evidence
only. A public metadata request proves two current-week proposal matches, not
ordinary source use, durable production readiness or delivery.

Ten focused offline scripts and application typecheck pass. The separate local
PostgreSQL fixture proves budget/circuit preservation and recovery ownership.
Production build and release remain pending. No new normal-run/watchdog read.
Exact evidence: `federal-register-local-candidate-20261009.md` outside the repo.
