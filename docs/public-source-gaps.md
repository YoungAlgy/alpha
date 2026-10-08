# Public source coverage, reviewed October 8, 2026

Status: PLOS was released as `207a4fae` and its scheduled opt-in was activated
October 2 at 14:00 UTC. The additive migration and exact release checks passed.
The no-key source activation completed earlier at 05:47 UTC. Both approvals are
closed. Scheduled writing remains no-model with paid AI off.
The PLOS qualification below is dated October 2. The October 5 and October 8
held-source decisions are recorded below. The calendar and usable-feed-pool
repairs later shipped as `7c33961f` and `ba22400e`, respectively. Those repairs are also included
in the October 7 successor `53b901ea`. No new adapter or live setting was added
by those repairs.
The earlier documentation cleanup used recorded evidence only. The later
October 8 remaining-gaps pass made bounded new-source qualifications and one
normal-run history read. The ccMixter candidate subsequently shipped and was
activated as `2d8a6a4d` at 18:29 UTC. Its completed receipt is
`ccmixter-release-final-20261008.md` outside the repository. Earlier candidate
states below are historical. The later Global Voices qualifier repair shipped
as `b12cc587`, with website readback at 20:19:53 UTC and final release controls
at 20:20:50 UTC. Its fresh committed build, exact-source CI and twelve
non-sending live checks passed. Source order, controls and live opt-ins
stayed unchanged. See `source-qualifier-release-final-20261008.md`.

## Selected backup

PLOS is the original publisher of open research, independent of Google and
Crossref's metadata service. Its [search API FAQ](https://api.plos.org/solr/faq/)
permits metadata use with source credit and publishes limits of 10 calls per
minute, 300 per hour, 7,200 per day, five simultaneous connections and 100 rows
per response. Alpha's adapter uses at most 20 rows and a shared cross-run cap
of two requests per fixed fifteen-minute window. At a boundary that can admit
four requests in one minute. It is still below the published limits.

One unauthenticated generic metadata query returned HTTP 200, 7,025 bytes and
eight records dated September 29 through October 1. The title sample included
nutrition, mental health and artificial intelligence. Author arrays and
copyright metadata were present. No abstract or body fields were requested or
returned. This established public endpoint usability.

The finished adapter was then checked at 07:33:34 UTC with one API request and
one body-free HEAD to its first retained canonical article. The API returned
200, 9,418 bytes and eleven records. All eleven had unrestricted license markers,
nine had usable bounded author lists, and no abstract or body field was returned.
Strict weekly filtering retained one mental-health citation and three AI
citations. Ranking kept one and two respectively, all with valid source credit.
Nutrition retained zero. The canonical HTTPS article answered HEAD with 200.
No author names, titles, article URLs or private reader inputs were saved.

[PLOS's current license policy](https://journals.plos.org/plosone/s/licenses-and-copyright)
provides CC BY 4.0 reuse with original-source and author credit, subject to
exceptions. The adapter checks the supplied copyright statement and keeps
credit separate from story citation and repeat-link sets. It excludes unknown
licenses, incomplete authors, mismatched DOI/journal paths and malformed dates.
Research reading items do not claim paper findings or medical advice. A generic
"Creative Commons Attribution License" marker has no per-record version. For
recent PLOS records, the displayed 4.0 version relies on the publisher's current
license policy. Explicit older or restrictive versions are rejected. This is a
documented policy assumption, not a version proved by that marker alone.

## Order and failure behavior

Google News RSS remains first for broad discovery. Mapped NIST/FDA/Federal
Reserve feeds follow. Global Voices remains a limited licensed-feed tier.
Crossref serves narrow nutrition metadata. PLOS follows it for the three fixed
topics, with its scheduled opt-in enabled and code default off. Released and
enabled ccMixter follows for `music-hiphop` only. GDELT stays off and unproven.
The newer release receipt establishes installation and activation. It does not
establish a natural scheduled ccMixter fallback.

An unavailable or quiet optional tier lets the resolver continue. Each source
keeps its deadline, response bound, relevance and freshness checks. Prior reader
links are excluded before the shared host cap. A quota/admission error does not
claim a provider outage. Actual fetch/parse failures open the existing persistent
cooldown. Only an owned recovery lease may clear it. Valid cache hits and finished
sections are preserved. Raw metadata caches remain process-local. The fixed
newest-twenty-record pool can be dominated by one topic, leaving another quiet.
It does not prove that no matching paper exists outside that bounded pool.

## Held or rejected leads

- Global Voices music RSS exceeded the existing 256 KiB bound. Its compact
  WordPress metadata route returned ten posts without article bodies, but no
  author names. A separate term-schema request failed transport and was not
  retried. The [required story byline](https://globalvoices.org/about/global-voices-attribution-policy/)
  is unproven. Do not raise bounds, infer credit from IDs or deploy that route.
- NSF's official news feed returned valid current metadata. The newest item was
  September 30, but no weekly title matched the proposed mapped topics. It is a
  potentially useful slower feed, not a demonstrated current topic backup.
- USDA ARS's official research-news feed returned valid metadata and its first
  fixed-host HTTPS article answered a body-free HEAD with 200. The newest feed
  entry was January 8, 2025. It is too stale for current daily sourcing.
- No broad independent news candidate met the current endpoint, freshness and
  reuse gates in this pass. The Conversation, BBC/Guardian/DW, WHO, Europe PMC
  and other independently reviewed leads were held. No provider was added
  merely for count. The dated research record keeps their specific limits.

### Additional held leads, October 5

The separate bounded research pass added no working provider. Wikidata's
generic exact-date album query timed out at five seconds with no status or
metadata received. No retry occurred. Its CC0 rights do not establish usable
current coverage, and album release dates cannot stand in for news dates.

Pressenza's About page responded and exposed RSS discovery links. Its exact
original-content license subtype and a reliable item-level exception boundary
remain unresolved. Published third-party articles can carry NC/ND terms, so a
blanket CC BY assumption is unsafe. The feed itself was not probed.

SciDev.Net has credited-reuse guidance, but its documented JavaScript embed
does not establish a current structured complete-credit route. Its consulted
home page is not proof of actual feed freshness. No feed probe occurred.

Details and primary references are in the external dated receipt
`independent-source-decision-20261005.md`. That pass consumed two availability
requests, bringing the extended ledger to five of twenty-four. Its closed
probe helper is intentionally blocked from replay. Keep the current chain and
the response, attribution and prior-link guards. The separate calendar repair below
strengthens calendar freshness validation without relaxing the source chain.

### Additional held leads, October 8

The two requested bounded passes added no source adapter or live setting.
FTC's Consumer Alerts RSS returned HTTP 200. Final qualification parsed ten
complete item records and safe first-party links, but zero timestamps under
the existing strict parser and zero exact `BCP Staff` credit matches. The actual
field-format cause remains unknown. The generic whitespace-CDATAs pass the app
helpers, so no app-parser defect was established. Freshness gated the topic
counts, leaving useful topic fit unassessed. Do not infer dates from month-only
paths, relax credit/freshness gates or replay the closed helpers.

Federal Register's generic healthcare and health-workforce metadata queries
returned current structured records. None passed the fixed conservative
healthcare-term AND workforce-context gate in the second bounded query. This
does not establish semantic irrelevance or an exhaustive absence of useful
documents. Its useful Alpha lane remains unproven.

The exact officially documented NIH Research Matters feed returned HTTP 403
on one anonymous request. No response body was read and no feed/date/topic
qualification occurred. Hold that route without retry, alternate URLs or
access-control bypass. This is one refusal, not a global outage or proof of
permanent unavailability.

Music-News.com and All About Jazz document RSS uses, but free automated
newsletter reuse was not clearly established. Neither feed was probed. No
contact, account action or spending occurred. This is a qualification gap,
not a conclusion that all RSS uses are paid or legally prohibited.

Full dated evidence is outside the repository in
`independent-source-decision-20261008.md` and
`source-coverage-followup-20261008-1608.md`. The latter links the closed FTC and
NIH ledgers. The ledger at the end of that earlier pass accounts for eleven availability/feed/API
requests, including one publisher About-page check, with zero outstanding
reservations and thirteen unused slots. Unused budget does not authorize more
requests. Previously held GDELT, MusicBrainz, Wikidata and oversized Global
Voices routes were not retried. The installed chain and safeguards are unchanged.

## Remaining-gaps pass and ccMixter qualification, October 8 (historical review)

One final new generic ccMixter hip-hop/remix query at 17:20 UTC returned HTTP
200 and 19,643 bytes. Ten records had complete fields, strict timestamps,
canonical HTTPS upload links, creator credit and both explicit tags. One was
uploaded in the past week, on October 7 at 20:01:44 UTC. This is endpoint-level
evidence. The new exact adapter has not been exercised against a live response.

The [query API](https://ccmixter.org/query-api) documents upload-date sorting,
off-site feeds and programmatic metadata use. This is community-upload
discovery, with no claim of original release dates, listening quality,
popularity or daily editorial news. The [terms](https://ccmixter.org/terms)
require separate per-track license compliance for music use. The local lane
uses factual title/creator/upload-date/link metadata only. It copies no audio,
images or upload descriptions and assigns no track or site license. Source
labeling does not imply endorsement. It is not advertising or outreach reuse.

The local candidate is fixed to `music-hiphop` and off by default. It follows
the existing useful sources, with no mapping to all music or custom topics.
Both exact tags, one complete creator and strict canonical metadata are
mandatory. The shared ranker excludes prior links before selecting one item.
Unavailable, expired, exhausted or malformed results keep the existing
fallback/backup behavior. No larger source pool or relaxed freshness gate was
added to manufacture coverage.

It uses the existing five-second and 256 KiB bounds. Parsed factual metadata is
cached in process, with per-read freshness and bounded cooldown. The private
`ccmixter-uploads` identity has an independent two-request fixed fifteen-minute
budget and durable outage/probe state across runs. The additive migration is
local only. A disposable PostgreSQL 17.11 test preserved all eight prior rows,
columns, RPC definitions and permissions, tested apply/reapply/rollback and
admitted one of two simultaneous recovery probes. The database is shut down.
Ninety-three adapter assertions, focused chain/storage/rendering/workflow/
preflight/budget/circuit/response tests and application typecheck pass.
Targeted lint has zero errors and three pre-existing unused-catch warnings.

Other new leads remain held. LOC music RSS had ten valid dated metadata items
and one current credited item, but no demonstrated current genre fit for the
catalog music lanes. Its archive/history value does not justify a broad music
adapter. blocSonic's release RSS exceeded 256 KiB and was canceled before
parsing. No larger limit or alternate feed was tried. Techdirt and VOA feed
opens returned web-tool errors without records or confirmed origin HTTP status.
Those two unreserved documentation-agent attempts were disclosed and counted.
Neither route was retried. Older held candidates were not reopened.

The current ledger totals sixteen of twenty-four endpoint/availability
attempts cumulatively, including five in this pass. It is closed with zero
reservations and eight unused slots. All dated network helpers are blocked
against replay. Unused budget is not restart authority.
The one normal-run history read at 17:05 UTC was unchanged. It adds no natural
fallback, provider-delivery, inbox or real safety-event proof.

Full evidence is in `remaining-source-decision-20261008.md`,
`remaining-source-probe-ledger-20261008.json`,
`ccmixter-local-postgres-20261008.json` and
`normal-observation-20261008-1705.md` outside the repository.
A fresh production build needs separate build-only approval. No source probe,
push, deployment, database application, opt-in or send follows from this note.
Broad news, other music genres and arbitrary custom coverage remain limited.

The separate exact frozen rollout subsequently completed as `2d8a6a4d`.
CI, fresh committed build, deployment, protected identity migration and its
single scheduled activation passed. All eight prior source states, RPCs and
permissions were preserved. Nine provider identities are installed. Exact
finished-adapter metadata acceptance was established before release. No extra
letters, retries, source probes or audience changes occurred during rollout.
This supersedes the earlier local-only and pending-build statements above.
Evidence: `ccmixter-release-final-20261008.md` outside the repository.

## Later October 8 source-coverage pass (historical local review)

Independent catalog review found eleven of thirty-eight fixed topics have
dedicated independent lanes. This describes routing, not guaranteed fresh daily
coverage. Global Voices also performs limited general/custom matching. Google
remains the main broad discovery dependency.

New primary-documentation research did not qualify another broad source.
DW's public material describes partnership/feed reuse with terms still
unqualified for this path. The Conversation's licensing and syndication were
documented, but no exact current credited structured route was established.
No endpoint was probed for either source in this pass.

NASA publishes [RSS routes](https://www.nasa.gov/rss-feeds/) and permits credited
factual use under its [media rules](https://www.nasa.gov/nasa-brand-center/images-and-media/),
with endorsement and third-party-content restrictions. One fixed main-feed
request returned HTTP 200 but exceeded the existing 256 KiB bound. It was
rejected without parsing. The bound was not increased and the feed was not
retried. A separately bounded compact WordPress metadata request returned
HTTP 200, 475 bytes and two strictly dated same-day records. Only publication
date, type, title and link were requested. None matched the tested AI/practical
sustainability or generic science-topic qualification. This proves a public
metadata route, not useful coverage for the tested lanes. No NASA adapter,
extra source identity or new source activation was added.

A local offline regression did establish a relevance defect in Global Voices:
custom `US healthcare recruiting` admitted UK or missing-US headlines because
short qualifiers were discarded. The local repair keeps the original two-long-
anchor minimum, appends required non-grammar short qualifiers, and caps all
selection tokens at six. Exact whole-token matching is local. Fixed-topic and
exact music-alias behavior, source order, dates, credit, cache, prior-link
exclusions, request budgets and cooldowns are unchanged. It does not infer
AI/US/ISS aliases or claim geographic semantic understanding. At this local
review the candidate was uncommitted and unreleased, with separate fresh-build
and release approval pending.
The before-fix adapter regression failed as expected on the US/UK distinction.
After the repair, six focused offline scripts pass, including licensed-source
credit/storage/rendering, exclusions, metadata privacy, no-key/no-model policy,
cache reuse, cooldown, exhaustion and timeout paths. Application typecheck passes
with incremental output disabled. Independent code review found no blocker.
No fresh production build had been run at that local review.

The finite new research ledgers are closed. This pass made no delivery-history
read or live service change. Latest normal observation remains the recorded
17:05 UTC check. Natural fallback and real safety-event proof remain separate.

The qualifier candidate subsequently completed its exact approved release as
`b12cc587`. The committed production build, exact-source CI and twelve
non-sending live checks passed. No new adapter, migration, live opt-in change
or letter accompanied that release. The completed approval is consumed.

## New documentation-only candidates, October 8

CFPB is a proposed independent personal-finance metadata lane. Its official
[press resources](https://www.consumerfinance.gov/about-us/newsroom/press-resources/)
link to the newsroom RSS feed. The
[website policy](https://www.consumerfinance.gov/privacy/website-privacy-policy/)
puts CFPB-created material in the public domain and requests citation, with
third-party rights exceptions. Only first-party attributed title/date/link
metadata would be considered. Article bodies and media are outside the proposal.

At the 21:12 UTC documentation review, feed/date/current-fit proof was still
absent and the one-request approval was pending. Alex subsequently approved
that exact check. On October 8 at 22:03:07 UTC, its one anonymous request
returned HTTP 200 and 15,722 decoded UTF-8 bytes. All 22 entries had valid
direct metadata, strict dates and canonical first-party newsroom paths.
Only one entry was within a week or a month, and none passed the conservative
personal-finance title check. Newest source date was October 2.

CFPB remains held for insufficient current topic fit. This proves feed format
and bounded retrieval only. It establishes no daily cadence or useful lane.
No retry, redirect, article/body/media read or raw-feed persistence occurred.
No adapter, topic map, provider identity or opt-in was added. The one-request
approval is consumed. The earlier closed probe ledgers stay closed. Exact
aggregate evidence is `cfpb-feed-qualification-20261008.json` outside the repo.

Census publishes an official economic-indicator feed directory, but the
proposed feed's metadata, topic fit and reuse basis have not been qualified.
Monthly housing indicators cannot be counted as daily backup news. BLS's feed
documentation returned an automated-access refusal. That path was stopped,
without retry or alternate-route probing. Both candidates remain held.

ccMixter's API documents generic tag/date filters. Current, conservatively
matched electronic/indie/country metadata was not established. New genre
queries would share the same upstream infrastructure and would improve
coverage only if separately qualified. They would not add source independence.
The already released narrow hip-hop lane and its evidence remain unchanged.

Separate local diagnostics in `source-evidence.md` address the inability to
observe final fresh content-tier use without inspecting letter text. These
diagnostics are uncommitted and unreleased. They add no provider or coverage.

## Calendar validation, released October 5 (historical review)

An offline review reproduced impossible RSS dates rolling forward through
`Date.parse`. The local candidate replaces that permissive freshness conversion
with shared calendar validation and explicit-zone ISO/RSS parsing. This affects
Google/publisher filtering and both GDELT date gates. Valid dated siblings and
cached pools survive. Malformed-only Google results leave the resolver free to
try its next eligible source. No new provider is enabled or claimed proven.

Twelve focused offline checks and the application typecheck passed. Independent
review found no blocking issue. At that review the fix was uncommitted and
unreleased, with a fresh production build and separate release decision pending.
Full local evidence is
in `source-review-calendar-fix-20261005.md` outside the repository.

The calendar candidate above subsequently completed its exact approved release
as `7c33961f`. See `calendar-release-receipt-20261005.md` for its successful build,
CI, deployment and non-sending acceptance. The earlier pending status is dated.

## Usable-feed-pool repair, released October 5 (historical review)

A fresh offline pass reproduced rejected feed entries consuming the 100-item
limit before a usable later entry could be considered. Google, fixed publishers
and Global Voices now filter feed-specific eligibility before counting results.
Shared snapshots retain only permitted metadata, with full envelope validation
and a 256 KiB serialized ceiling. Bodies/media are dropped before caching.
Fixed feeds still share snapshots across topics and date windows. Each read
rechecks freshness, including publication times becoming current during cache
lifetime. Empty/unusable metadata keeps the one-minute cache lifetime.

Ten focused offline checks, typecheck and two final independent reviews passed.
No source probe or new adapter was added. At that local review a production
build and release were still pending. Source order, credits, request/cooldown controls,
prior-link filters, no-model policy and the coverage limits below are unchanged.
Evidence: `source-valid-pool-review-20261005.md` outside the repository.

The feed-pool repair subsequently shipped as `ba22400e`. Its fresh committed
build, CI, deployment and twelve non-sending live checks passed. The exact
receipt is `source-valid-pool-release-receipt-20261005.md`. The first stale-SHA
observation and later exact readback are retained there. No second deployment
was needed. This closes that candidate's pending release status without proving
natural source failover or provider-confirmed delivery.

## Limits and recorded release outcome

PLOS improves selected research coverage. It does not supply broad general news,
music, every custom topic or a guaranteed fresh result each day. Google remains
the main broad discovery dependency. Free public APIs can change or stop.
Supabase and GitHub remain shared operational dependencies. No infinite free
capacity or perpetual availability claim is made.

Eighteen parent-run focused offline checks and the non-incremental application
typecheck passed. A disposable PostgreSQL 17.11 test proved the additive
migration preserves all seven existing provider states and permissions. A real
two-session recovery race admitted one probe and denied the other. Shared
budget tests admitted two requests, denied the third and kept the separate
publisher budget unchanged. The local database was shut down.

Independent final code review found no concrete blocker. The exact local PLOS
production build passed October 2 at 13:18 UTC with Next 16.3.6, 51/51 pages,
OpenNext and generated-worker typecheck. This closes the earlier Windows check's
missing generated-worker condition. Its baseline release stamp is local proof.
An approved release must rebuild with its actual committed release identity.

That separate approval was completed. The guarded additive migration, exact
release build, CI, deployment and twelve non-sending live checks passed. Only
`SEND_ALPHA_PLOS_METADATA_FALLBACK=1` was activated.

The October 2 normal run started at 19:21:55 UTC and completed at 19:23:14 UTC.
Protected eligibility found three readers. Resend accepted all three letters,
with zero failures, retry-required or final uncovered readers and zero paid
calls. Later recovery found zero uncovered and skipped sending. The enabled
PLOS flag reached execution. The safe summaries do not establish that PLOS
supplied content, that Brevo failover occurred, provider-confirmed delivery or
inbox receipt. The 20:37 UTC watchdog outcome was not checked in that pass.
Full receipts are in the owner's Desktop Files release checkpoint.
Nothing here authorizes another send, retry, live change or release.
