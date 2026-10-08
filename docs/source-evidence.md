# Content-source evidence, local candidate October 8

This change is local and uncommitted on base `b12cc587`. It has not been built
for production or released. It changes diagnostics only. Source order, request
ceilings, cooldowns, citations, enrollment and email-provider ownership stay
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
failover still needs an ordinary run observed after a separately approved
release. No letters or safety events should be created just to fill evidence.

The new offline test covers the fixed privacy shape, post-exclusion outcomes,
Gemini uncertainty, observer failures, isolated immutable state, cached/shared
unknowns and candidates discarded by same-letter citation deduplication.
Focused publisher, PLOS, ccMixter, circuit and input-bound tests remain required.
A fresh production build and a separate release approval remain pending.
