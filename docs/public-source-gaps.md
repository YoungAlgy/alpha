# Public source coverage, October 2, 2026

Status: PLOS is a local candidate. No release or live setting change in this pass.
The no-key source activation completed earlier at 05:47 UTC. Its approval is
closed. Scheduled writing remains no-model with paid AI off.

## Selected backup

PLOS is the original publisher of open research, independent of Google and
Crossref's metadata service. Its [search API FAQ](https://api.plos.org/solr/faq/)
permits metadata use with source credit and publishes limits of 10 calls per
minute, 300 per hour, 7,200 per day, five simultaneous connections and 100 rows
per response. Alpha's candidate uses at most 20 rows and a shared cross-run cap
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
exceptions. The candidate checks the supplied copyright statement and keeps
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
Crossref serves narrow nutrition metadata. The off-default PLOS candidate
follows it for the three fixed topics. GDELT stays off and unproven.

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

## Limits and next gate

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

After the passing exact candidate build, separate approval is required for one
atomic additive migration, exact release and
`SEND_ALPHA_PLOS_METADATA_FALLBACK=1`. Nothing here authorizes a send, retry,
audience change, account or secret change.
