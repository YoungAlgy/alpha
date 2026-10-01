# Alpha

An invite-only personal daily newsletter. Approved readers pick 5 topics from a curated menu. Alpha builds each letter from current real sources, and every cited link must come from validated source resolution for that issue date, including a saved section from an earlier run. A local deterministic formatter can finish a source-grounded issue with no writer-model call. Each send only looks at what is new since the last one (`lib/cadence.ts`).

## Current access mode

Alpha is free and invite-only. New people complete onboarding and request
access. Alex approves requests from the Accounts panel. Approval writes the
protected invite entitlement and creates no Stripe customer or monthly charge.
After the request is stored, Alpha can post a PII-free best-effort notice to
the optional Alpha-only ops webhook. The Accounts queue remains authoritative.
Signup answers saved on each step prefill when the visitor resumes in the same
browser. Local storage is preferred, with same-tab session storage as a backup.
If neither can save, the form stays open with an error. Expired email drafts are
prefilled for confirmation without restarting the other questions. A stored
request has a persistent waiting-for-approval screen. Explicit sign-out clears
the local draft, and signup never grants access or enrolls letter delivery.
Existing paid accounts remain supported while renewal is wound down. The
Accounts panel can give a Stripe-linked reader permanent invite access without
changing `cancelled_at` or another billing mirror. Renewal must still be turned
off through the exact cancellation flow. The access policy is fixed to invite
mode in source. Old `ALPHA_ACCESS_MODE` and `NEXT_PUBLIC_ALPHA_ACCESS_MODE`
values cannot reopen paid checkout, paid quantity changes, or the billing
portal. Cancellation and historical payment settlement stay available.

The initial rollout is a three-person private circle. Every approved reader
gets free access. Additional readers need Alex's approval. There are no paid
tiers or paid topic upgrades in the product experience. Prioritize dependable
operation for this small group over work aimed at hundreds or thousands of
readers. Keep reader identities in protected account data, not hard-coded
allowlists. Removing old billing history or cancellation safeguards is a
separate wind-down step, not a prerequisite for free invite access.

The current release enables daily delivery for approved readers. `delivery_enrolled` is an
owner-controlled account field, separate from reading access. It defaults to
false, cannot be changed by subscribers, and is checked in the population
query, immediately before sending, and in the locked provider-attempt claim.
Accounts offers separate Enable letters and Pause letters actions. Neither
action changes access, billing history, unsubscribe, or suppression markers.

`lib/subscriber-delivery-policy.ts` enables the enrolled sender while keeping
direct reader-triggered generation paused. Setting its global literal false
remains the emergency stop. There is no environment override. The daily job
accepts only scheduled events or manual dispatch after verified first-batch delivery. It pins
no-model mode on and paid AI off. Historical overrides and forced resends are
closed during this rollout. Health reports subscriber delivery open, which
does not itself prove a schedule is active or a letter has been delivered.
Saved letters, invite approval, sign-in, support, and operator alerts remain
available. The 14:17 UTC primary slot and 15:37/18:47 UTC recovery slots share
one concurrency group. Already-covered days skip installation and build.
Live deployment and first-batch evidence belong in the dated Desktop Files
launch checkpoint. Scheduled configuration alone does not prove that a future
scheduled run started or completed.

Access approval, signup, paid checkout, and email reconciliation preserve
provider do-not-email blocks. Manual provider-suppression removal is
hard-disabled pending late-event ordering and terminal-resolution proof. An
email change leaves delivery pending for review. Account deletion no longer
depends on removing a Resend suppression. It still requires exact billing
settlement and local privacy cleanup.

The invite request columns are part of the exact fourteen-migration Round 80
atomic release package. Do not apply
`supabase/migrations/20260830000000_invite_access.sql` by itself. The additive
`20260924000000_delivery_enrollment.sql` requires the reviewed post-clock-fence
function bodies. Its guarded manual release wrapper checks the existing
25-entry ledger and records the 26th version atomically. It enrolls nobody.

Free-mode generation also fails closed against paid AI. Anthropic and DeepSeek
are disabled unless `ALPHA_ALLOW_PAID_AI` is explicitly enabled. If search has
already returned safe source material and every writer tier fails, Alpha uses
the deterministic formatter in `lib/engine/deterministic-fallback.ts` so the
issue can still be archived without another model call.

For a strict no-model send, set `ALPHA_NO_MODEL_MODE=1`. The topic and editor
note formatters then run locally from the resolved sources, so one editor call
is not made for every reader. This mode also skips Gemini grounded search and
deep reads. Brave, You.com, and the optional public RSS tier remain available
for current sources. Delivery limits remain unchanged.

Search has an optional no-key last resort through `ALPHA_PUBLIC_FEED_FALLBACK`.
When explicitly enabled, it uses a bounded public RSS search after the keyed
search tiers fail. It is a fallback only and does not promise unlimited feed
capacity.

A malformed Brave response opens the existing fallback path. Valid rows survive
alongside malformed rows, but an incomplete response cannot prove a topic is
quiet if its remaining links are already used. Documented empty responses still
keep the topic quiet.

For source discovery without keyed API calls, set `ALPHA_NO_KEY_SOURCES=1`.
This skips Brave, Gemini grounded search and You.com even if their keys are
configured, and enables Google News RSS regardless of the older feed flag.
Pair it with `ALPHA_NO_MODEL_MODE=1` and `ALPHA_ALLOW_PAID_AI=0` for content
generation without metered search or writer calls. This does not remove email,
database or hosting capacity limits. No-key mode is opt-in, not active merely
because the code is installed.

`ALPHA_PUBLISHER_FEED_FALLBACK=1` adds fixed first-party NIST, FDA MedWatch and Federal Reserve Board
feeds after Google RSS has no usable signal. They receive no topic or profile
data. Topic matching stays local and conservative. These feeds cover selected
technology, construction, environment, health/safety and macroeconomics topics only. There is
no claim that they cover music, every custom topic or every day. Only dated
HTTPS links on the expected publisher host are accepted. Legacy HTTP article
links from FDA's HTTPS feed are upgraded only on the verified `www.fda.gov`
host; no HTTP request is made. Source titles and
attribution are retained; article bodies, images and feed descriptions are not
republished. A failed feed cannot discard a result already obtained elsewhere.
The Board's speeches/testimony feed covers `macro-markets` only, with explicit
economic-policy title matches and first-party document paths. Its
[RSS directory](https://www.federalreserve.gov/feeds/feeds.htm) documents the feed.
The Board's [reuse policy](https://www.federalreserve.gov/disclaimer.htm) allows
redistribution of Board information unless otherwise indicated and asks for
source credit. Only attributed headlines, dates and links are used. This tier
does not fetch third-party material, statistical APIs, images or policy models.
Each publisher keeps its own process-local failure cooldown and raw cache,
while sharing the existing durable publisher request ceiling.

`ALPHA_OPEN_NEWS_FALLBACK=1` adds licensed Global Voices music and general-news
feeds after Google and the mapped first-party feeds. It also requires no-model
mode. Requests use fixed URLs. Topic/genre matching is local, with no reader
data sent to the publisher. Both the RSS publication timestamp and dated
article path must fit the requested freshness window. Missing bylines, invalid
dates, unsupported topics and uncertain genre matches are rejected. Only
headline/date/link/byline/category metadata is read. Article bodies and media
are discarded. The publisher's [republishing policy](https://globalvoices.org/about/global-voices-attribution-policy/)
and [CC BY 3.0 license](https://creativecommons.org/licenses/by/3.0/) provide the
reuse basis. Each item and its email preview keep author/original-story credit,
license and formatting notice. License links are separate from story citations
and repeated-link checks. Licensed feed signals always use the local formatter.
This is a limited backup with sparse music coverage, not all-topic daily search.
Exact custom phrases `country music` and `indie music` use the existing genre
filters on the fixed music feed. Other custom phrases keep general-feed local
matching. Saved topics are unchanged, and bare `country` or `indie` is ambiguous.
It is off by default, including in strict no-key mode.

`ALPHA_RESEARCH_METADATA_FALLBACK=1` adds a narrow Crossref nutrition-research
backup after the feeds. It requires no-model mode and stays off by default,
including in strict no-key mode. Only the fixed word `nutrition` and date bounds
reach the public metadata API. No topic text, profile, account, key or contact
address is sent. Crossref's [metadata reuse policy](https://www.crossref.org/services/metadata-retrieval/)
allows free reuse. Alpha accepts only journal metadata with a precise online
publication date, a direct HTTPS publisher link and an already active CC BY or
CC BY-SA version-of-record license. Existing denied-host, date, repeated-link,
ranking and citation checks still apply. Paper bodies, abstracts and images are
not read or republished. Items are labeled research citations with the supplied
date. License metadata does not prove the linked full text is currently reachable.
This covers `nutrition-food` only. Other topics make no Crossref request.
One request runs at a time, with at least one second between completion and the
next start. The queue holds at most four calls and expires after fifteen seconds.
Each network response has a five-second deadline and 256 KiB ceiling. Failure
blocks queued requests and starts the existing bounded cooldown. No automatic
retry, keyed search or model call is added by this tier.

`ALPHA_GDELT_FALLBACK=1` adds an independent public discovery tier after RSS
and the enabled publisher feeds have no usable sources. It makes one topic-phrase query, never reads full article
bodies, and uses dated headline/link metadata. Source timestamps are discovery
metadata, not independently verified publication times. Raw results are shared
briefly before per-reader repeat filtering. Requests, response size, queue wait
and failure cooldown are bounded. GDELT remains best-effort and can rate limit
or be unavailable. Sparse fallback results produce source-linked reading items.
They are not invented summaries. Without safe sources the existing bounded
backup behavior remains in place.

Google and publisher feed clients locally reject missing, future or out-of-window
dates. They share raw successful metadata in-process for five minutes (valid
empty feeds for one minute), with request coalescing and failure cooldowns up
to fifteen minutes. Reader exclusions still apply after raw-cache retrieval.
The bounded 100-entry feed pool reaches the ranker before reader exclusions and
final host limits. A reader's previously cited first ten links cannot hide an
unseen eleventh feed item or remove that item for another reader.
The existing Supabase `topic_blurbs` cache already preserves finished sections
across runs. Raw-feed caches remain process-local. Base failure cooldowns are
process-local too. The separate circuit below persists outage memory when enabled.

The opt-in `ALPHA_DURABLE_SOURCE_COOLDOWN=1` adds private cross-run outage memory.
It requires the reviewed `20261001000000_public_source_circuit.sql` migration,
which was applied during the approved October 1 rollout.
It is off by default. Exactly seven fixed provider identities are stored, with
no query, topic, link, reader, credential or response data. Admission runs only
on a raw-cache miss and before the existing budget reservation. A source fetch
failure starts a fifteen-minute cooldown. Failed recovery probes increase it
to 30,60,120 and at most240 minutes. Healthy calls stay concurrent;
an expired failed circuit admits only one thirty-second recovery probe. Database
generation and lease checks reject late/duplicate completions. Failure history
decays after24 hours without a new failure or live probe. Budget and database
errors do not become provider failures. Real validated metadata survives a
failed optional completion write, but durable recovery remains unconfirmed.
Raw caches remain local, freshness/repeated-link checks stay downstream, and
the shared request ceilings are unchanged. The approved October 1 release
`8d9b09db` installed the migration and enabled only its scheduled cooldown flag
at 15:44 UTC. An ordinary delivery run later logged that enabled flag. Actual
source outage/recovery has not yet been observed. A separately approved release,
`02ccaff18cd6c95ac73fb79f2a8c1e1c7d953942`, later shipped the shared neutral-error
policy and watchdog timing guard with no new migration or activation. See
[`docs/public-source-circuit.md`](docs/public-source-circuit.md).

The scheduled runtime pins `ALPHA_DURABLE_SOURCE_BUDGET=1`. The existing private
Supabase rate-limit RPC then caps all runs together at 60 Google, 12 publisher
and 12 GDELT requests per fixed fifteen-minute provider window. Global Voices
shares the existing 12-request publisher ceiling, as does Crossref when enabled.
Crossref's serial lane and base failure cooldown are process-local. Separate runs
share the same fixed publisher reservation ceiling. When enabled, the separate
circuit also shares outage state and one recovery lease, not normal serial spacing.
Global Voices' two fixed endpoints
share one process-local outage cooldown and one optional durable circuit identity.
Reservations use fixed provider
identities, no query or reader data. A missing/exhausted/
unavailable budget blocks that source request. These are ceilings, not provider
quota guarantees or a persisted failure circuit. The caller stops waiting at
three seconds; the shared client's database request can continue up to ten
seconds and consume a slot without causing a later source fetch. No new schema
or secret is needed. A database outage still blocks daily delivery itself.

The daily workflow passes `SEND_ALPHA_NO_KEY_SOURCES`,
`SEND_ALPHA_PUBLISHER_FEED_FALLBACK`, `SEND_ALPHA_OPEN_NEWS_FALLBACK`,
`SEND_ALPHA_RESEARCH_METADATA_FALLBACK` and
`SEND_ALPHA_GDELT_FALLBACK` into both
preflight and runtime.
`SEND_ALPHA_DURABLE_SOURCE_COOLDOWN` separately forwards the opt-in circuit flag.
The scheduled setting enables it while the code default remains off.
Missing or unreadable admission state blocks a
new source request.
Enabling new sources or switching a live run to no-key mode requires a reviewed
release and separate owner approval. A release must verify public-source
availability and acceptable topic coverage before dropping existing source tiers.

Lives at `alpha.everyday.report` (its own domain, app at the root — no basePath). `everyday.report` redirects there. The old home, `youngalgy.com/alpha/*`, 308-redirects page paths here, but `/alpha/api/*` is 301-redirected, not proxied — the youngalgy.com Vercel project this used to proxy to is gone. That breaks one-click unsubscribe (GET/POST, List-Unsubscribe-Post) for any letter sent before the 2026-07-03 domain move; see next.config.ts for detail. Old magic-link/email-change callbacks are NOT proxied — they survive only because browsers follow the 308 to `/auth/callback` AND `https://youngalgy.com/alpha/auth/callback**` stays in the Supabase redirect allowlist. Never remove that allowlist entry.

## Stack

| Layer | Tool |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Styling | Tailwind CSS 4 + CSS custom properties (25 themes) |
| Hosting | Cloudflare Workers (via OpenNext) for the website; the daily send itself runs on GitHub Actions (see Deployment below) |
| DB / Auth | Supabase (project `xpqxhdciaoicsnyyfshy` in the "Algy" org) |
| AI | Optional Gemini, Groq, DeepSeek, and Anthropic writer tiers behind cost controls. `ALPHA_NO_MODEL_MODE` uses the local deterministic formatter. |
| Web search | Bounded Brave, Gemini grounded search, You.com, and optional public RSS fallback |
| Payments | Stripe, dedicated Alpha account, retained for exact cancellation and legacy paid-account cleanup. Invite approval creates no charge. |
| Email | Resend is primary for letters from `"alpha." <alpha@everyday.report>` and sign-in (Supabase SMTP) from `noreply@everyday.report`. Scheduled letters can select the separately verified Brevo backup before new send attempts. Sign-in stays on Resend. |

## Architecture highlights

- **Theme-first onboarding** — `/theme` is step 2 (right after `/welcome`). The chosen theme is applied app-wide via `ThemeApplier` (root layout) so every step from `/name` through `/checkout` adopts the user's palette. ThemeApplier reads from `public.users` for signed-in users, falls back to localStorage for mid-funnel users.
- **Shared topic_blurbs cache** (`lib/engine/blurb-cache.ts`) — generate each topic-week's content once in Supabase, serve to every subscriber. ~10× cost reduction vs. naive per-user generation.
- **Onboarding-first funnel** (11 screens) — `welcome → theme → name → city → role → focus → topics → fun → you → email → checkout`, reached via a minimal public landing page (`/`) for cold/SEO traffic. Conversion play borrowed from Headway/Noom.
- **Confirmed account before requesting access**: the email-code step confirms the Supabase Auth owner. The access-request route stores the validated profile on that matching account before reporting success. Approval and letter enrollment remain separate owner actions. Historical billing settlement stays isolated from signup.
- **Returning sign-in: 6-digit code** — `/signin` uses Supabase `signInWithOtp` + `verifyOtp({ type: "email" })`. Magic Link template is overridden with `{{ .Token }}` only. No clickable email links for returning users.
- **RLS-by-default** — every PII table (`users`, `issues`, `support_tickets`) has row level security enabled. `users` keeps self-read/self-update policies scoped to `auth.uid()` (billing/identity columns further locked by a trigger); `issues` keeps a self-read policy gated on active access; `support_tickets` has zero policies as of 2026-08-05 (its one anonymous-insert policy was dropped as dead code) — all access, including the public `/support` form, goes through the service role. Service role bypasses RLS for every server-side operation (webhook upsert, generate persistence, admin endpoint).
- **Admin Accounts panel** at `/settings/accounts` — gated to `youngalgy@gmail.com` via server-side session check. List, approve invite access, preserve permanent invite access for a Stripe-linked reader, revoke invite or free access, view delivery-review state, and delete. Invite actions do not change Stripe billing.
- **In-app changelog** at `/settings/changelog` — hand-curated entries in `app/settings/changelog/page.tsx`. Server-rendered, `noindex` meta, private behind `/settings` (already in `robots.ts` disallow).
- **Delivery reliability** (started 2026-08-05 and extended through Round 80) —
  - **Stuck-claim reclaim** — `runPersistAndSend` stamps `delivered_at` as an atomic claim *before* calling Resend; if the process dies in between (a killed runner, an OOM), the row is left claimed with no email ever sent. The cron's GET handler reclaims any row matching "claimed, no proof of send, older than a 10-minute safety margin" back into the undelivered pool at the top of every run.
  - **`resend_message_id` proof-of-send** — only ever set after a *confirmed* successful Resend call, so `delivered_at` alone can no longer be read as "done" anywhere in the system (the reclaim step above, `watchdog_delivery_check()`, and the retry pre-check all require it).
  - **`watchdog_delivery_check()` per-subscriber coverage** — a security-definer RPC, callable with the anon key, that both `letter-watchdog.yml`'s alert check and `daily-send.yml`'s retry pre-check call. Returns `uncovered_count`: the number of currently active subscribers with no proven-delivered issue since a cutoff — a genuine per-subscriber existence check, not an aggregate-count comparison (which can coincidentally net out even when one specific subscriber has nothing, e.g. an unsubscribe and a signup in the same window).
  - **`prior_issue_counts()`** — one grouped RPC for every subscriber's lifetime "Issue N" count, replacing N per-subscriber count queries.
  - **Resend retry-with-backoff** (`retryResendCall` in `lib/email.ts`) — up to 3 attempts with backoff on transient errors (`rate_limit_exceeded`, `internal_server_error`, `application_error`, `concurrent_idempotent_requests`); permanent errors (bad API key, invalid recipient, quota exceeded) fail fast with no retry.
  - **Bounded fair delivery cursor**. Each route call inspects at most 250 readers with a one-row lookahead. One workflow drains at most 16 pages or 55 minutes, records inspected position with a compare-and-swap cursor, and leaves retry-required readers visible. The next same-day slot resumes beyond the bound and later wraps to uncovered readers. A retry outcome, undrained tail, or cursor conflict keeps the job red.
  - **Stable provider retry payload**. A normal live issue and every content fallback share one provider lane. An uncertain pending-issue read, malformed stored issue, or uncertain issue number stops before generation, send, or cursor movement. A forced resend requires one operator-supplied UUID, replays stored content, and uses that UUID as a separate retry-safe provider lane.
  - **Current-address delivery check**. Access, suppression state, and the current account email are read again immediately before every provider call, including forced resends. A missing or unreadable current address stops the attempt.
  - **Durable provider attempt ledger**. Before a subscriber email leaves the app, the database binds one canonical recipient and one exact payload fingerprint to the issue and provider lane. Eligibility is rechecked under the same user-row lock. A five-minute lease blocks conflicting account changes while the provider result is uncertain. Automatic ambiguous retries stop after 23 hours and move to manual review.
  - **Causal suppression audit**. Signed bounce and complaint events are stored with hashed recipients and an ownership state. Fast webhooks are replayed during delivery finalization. Older events cannot undo a newer explicit suppression clear. Unowned evidence expires seven days after the earlier event/receipt clock and is removed by scheduled bounded cleanup. A replay cannot refresh that window. Exact owned events can still apply after seven days. Late unknown-message finalization stops at the existing 23-hour retry deadline for manual review.

## Directory layout

```
app/
  welcome / theme / name / city / role / focus / topics / fun / you / email / checkout   onboarding funnel
  writing                                                                          generate progress UI
  inbox / inbox/[issueId] / archive                                                 letter reading
  settings / settings/accounts / settings/changelog                                 account, admin, what's new
  signin / privacy / terms / support / not-found                                   static + sign-in
  api/
    generate                  source-grounded generation pipeline with bounded provider use and deterministic writer fallback
    support                   support form → Supabase + email notify
    stripe/checkout           permanently closed to new payments (HTTP 410)
    stripe/webhook            handles checkout.session.completed (upsert), sub events
    stripe/portal             permanently closed billing portal (HTTP 410)
    admin/users               admin list, invite/free access, delivery review, and deletion actions (email gate)
    health                    uptime + env-var presence + active email provider
  auth/callback               Supabase magic-link handler — client page, handles BOTH PKCE + implicit flows
  robots.ts / sitemap.ts      SEO

components/
  ThemeApplier                applies user's theme to <html data-theme> on every route
  Digest                      letter render
  ThemeSwitcher               in-app theme switcher, rendered in settings + inbox pages
  AudioToggle / ReadingProgress / LetterTOC / ScrollFadeIn
  FirstLetterCelebration / InstallPrompt / Footer / LegalLayout
  onboarding/StepShell / ProgressDots / QuestionStep

lib/
  types.ts                    canonical app types (Issue, UserProfile, ItemKind, ThemeId, TopicId)
  topics.ts                   38-topic registry (latest add: trading-cards, 2026-06-10, plus more since)
  themes.ts                   25-theme registry
  audio.ts                    Web Audio synth sound palette
  onboarding-state.ts         saved signup draft, session fallback, cross-tab reset + step ordering
  user-sync.ts                Supabase user sync + delete-account
  rate-limit.ts               per-isolate burst bucket
  distributed-rate-limit.ts   Supabase-backed cross-isolate request ceilings
  stripe.ts                   product/price constants (new Alpha account)
  email.ts                    Resend sender + HTML/text renderers (letter + welcome)
  brave.ts                    Brave Search client
  supabase/                   client.ts / server.ts / types.ts
  engine/
    types.ts                  TopicSignal / TopicBlurb / DigestSection
    mock-signals.ts           local development fixtures, never a production source
    topic-queries.ts          Brave queries per topic
    source-resolver.ts        Brave search with Gemini, You.com, and optional public RSS fallback
    topic-blurb.ts            bounded free/paid writer policy plus deterministic source formatter
    editor-note.ts            optional model intro with deterministic no-model fallback
    blurb-cache.ts            Supabase-backed (topic, week_of) cache
    assemble.ts               full Issue assembly
    persist.ts                auth/profile/issue persistence with server-only hashed verification metadata
    client.ts                 Anthropic SDK wrapper

supabase/migrations/          schema migrations (applied via dashboard SQL editor)
public/                       favicon + manifest + static assets

src/
  worker-entry.ts             Cloudflare Worker entry point wrapping OpenNext's handler —
                               CSRF defense + Supabase session refresh (replaces the deleted proxy.ts)
```

## Environment

Required for full functionality (see `.env.local`). Every one of these also
lives in Cloudflare Worker secrets and (a subset of) GitHub Actions
secrets — see [`docs/SECRETS.md`](docs/SECRETS.md) for the full inventory
of where each one lives and how to rotate it.

```
ANTHROPIC_API_KEY=             # paid Claude writer tier, ignored unless ALPHA_ALLOW_PAID_AI is enabled
RESEND_API_KEY=                # Primary email provider
RESEND_FROM="alpha." <alpha@everyday.report>  # optional -- every send site already defaults to this exact value if unset
RESEND_WEBHOOK_SECRET=         # whsec_... for app/api/webhooks/resend (bounce/complaint suppression). If unset,
                                # that route hard-503s -- bounces/complaints silently stop being suppressed, not a
                                # payment-bypass risk but a slow sender-reputation one.
STRIPE_SECRET_KEY=             # Stripe (Alpha account). Invite access itself does not require Stripe. Production
                                # generation fails closed if a paid-session check needs Stripe and the key is
                                # missing. Legacy checkout, portal, renewal cancellation, quantity, webhook,
                                # account-deletion billing cleanup, and customer-email sync still require it.
STRIPE_WEBHOOK_SECRET=         # whsec_... for the webhook endpoint
BRAVE_SEARCH_API_KEY=          # Brave Search
GEMINI_API_KEY=                # grounded-search fallback plus the primary free writer tier. No-model mode
                                # skips both Gemini paths and formats already-resolved sources locally.
GROQ_API_KEY=                  # optional free writer fallback after Gemini. No-model mode skips it.
DEEPSEEK_API_KEY=              # paid writer fallback, ignored unless ALPHA_ALLOW_PAID_AI is enabled
YOU_API_KEY=                   # search fallback tier 3 (Brave -> Gemini grounded search -> You.com)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=  # old name NEXT_PUBLIC_SUPABASE_ANON_KEY still accepted as a fallback
SUPABASE_SECRET_KEY=            # old name SUPABASE_SERVICE_ROLE_KEY still accepted as a fallback
NEXT_PUBLIC_APP_URL=https://alpha.everyday.report  # optional -- canonical origin for Stripe URLs + ALL email
                                # links; every call site already falls back to this exact value (or the
                                # request's own origin, on the Stripe routes) if unset
UNSUBSCRIBE_SECRET=            # 32+ character HMAC root for unsubscribe, letter-view tokens, and domain-separated distributed limiter keys
CHECKOUT_BINDING_SECRET=       # Stable root key for checkout email HMAC bindings and domain-separated AES-GCM Session replay encryption. Local, Worker, and GitHub daily-maintenance copies must match.
LEGACY_CHECKOUT_ROOT_CUTOFF_ISO= # Exact UTC cutoff proved after the paused guard, old Stripe key revocation, and drain. Temporary, not secret.
CRON_SECRET=                   # bearer for /api/cron/weekly-send (GitHub Actions sends it)
SUPPORT_FORWARD_EMAIL=         # where /api/support notifications go (optional)
NEXT_PUBLIC_POSTHOG_KEY=       # analytics (optional — inert if unset)
NEXT_PUBLIC_POSTHOG_HOST=      # optional, defaults to PostHog US cloud -- for a self-hosted PostHog instance.
                                # NOTE: next.config.ts's CSP connect-src only allows the US-cloud host today.
                                # Setting this to anything else also requires adding that host to connect-src,
                                # or PostHog calls are silently blocked with no server-side error (the same
                                # silent-CSP-breakage class next.config.ts's own comments describe hitting twice).
OPS_ALERT_EMAIL=               # internal ops-alert recipient (optional, defaults to youngalgy@gmail.com)
ALPHA_OPS_ALERT_WEBHOOK_URL=   # Alpha-only Discord webhook fallback when Resend is broken (optional, exact discord.com/api/webhooks shape)
JINA_API_KEY=                  # Jina Reader auth for deep-read article fetch (optional — Jina Reader works keyless, this just raises its rate limit)
ALPHA_DISABLE_DEEPREAD=        # set to "1" to kill deep-read and fall back to snippet-only signal (optional)
ALPHA_ALLOW_PAID_AI=           # set to "1" only in a reviewed runtime that may call Anthropic or DeepSeek (optional, off by default)
ALPHA_NO_MODEL_MODE=           # set to "1" to skip every writer-model call and format safe sources locally (optional, off by default)
ALPHA_PUBLIC_FEED_FALLBACK=    # set to "1" to allow the bounded no-key Google News RSS search fallback (optional, off by default)
ALPHA_NO_KEY_SOURCES=         # set to "1" to skip all keyed source search and enable Google RSS (optional, off by default)
ALPHA_GDELT_FALLBACK=         # set to "1" for bounded public GDELT discovery after RSS (optional, off by default)
ALPHA_PUBLISHER_FEED_FALLBACK= # set to "1" for fixed NIST/FDA/Federal Reserve topic-matched feeds (optional, off by default)
ALPHA_OPEN_NEWS_FALLBACK=     # set to "1" for licensed Global Voices metadata in no-model mode (optional, off by default)
ALPHA_RESEARCH_METADATA_FALLBACK= # set to "1" for open-license nutrition research metadata in no-model mode (optional, off by default)
ALPHA_DURABLE_SOURCE_BUDGET=  # "1" in scheduled runtime, uses existing private Supabase rate-limit RPC
ALPHA_DURABLE_SOURCE_COOLDOWN= # opt-in private provider circuit, requires reviewed migration before activation
NEXT_PUBLIC_ALPHA_RELEASE_SHA= # injected by the deploy wrapper or GitHub build, never hand-set for a release

# Optional per-tier model overrides. Cloudflare and GitHub daily-send use separate runtime copies:
ALPHA_BLURB_MODEL=             # default claude-sonnet-5
ALPHA_BLURB_CHEAP_MODEL=       # default claude-haiku-4-5
ALPHA_EDITOR_MODEL=            # default claude-opus-4-8
ALPHA_GEMINI_TEXT_MODEL=       # default gemini-2.5-flash
ALPHA_GEMINI_SEARCH_MODEL=     # default gemini-2.5-flash
```

`GET /api/health` returns the built release SHA, configured services, and active email provider.

## Development

```bash
npm run dev     # localhost:3003
npm run build
npm run lint
```

Hot-reload across `app/`, `components/`, `lib/`.

## Deployment

Hosted on Cloudflare Workers (via OpenNext), not Vercel — migrated 2026-08-05 after
the Workers Free plan's fixed CPU-time limit made the daily send unreliable there.
Nothing auto-deploys on push; deploys are manual:

```bash
npm run cf:deploy
```

`cf:deploy` first proves the intended commit matches the deployment checkout. It then verifies build env, builds OpenNext, typechecks the Worker, deploys, and runs the live smoke test. The smoke test requires the canonical host to return that exact commit SHA.

**Must run from a WSL-native checkout, not the `/mnt/c` Windows mount** — `node_modules` here
has Linux-native binaries (workerd, etc.) that fail outright from Windows. Use the wrapper,
which also fixes a real bug hit twice on 2026-08-05 (a stale WSL copy silently redeploying
old config because a changed file wasn't hand-copied over): it force-syncs the WSL checkout
to match `origin/master` immediately before every deploy, so nothing stale can ship. Commit
and push from Windows first, then from WSL:

```bash
bash scripts/deploy-from-wsl.sh
```

The daily letter send itself does **not** run on Cloudflare (see the CPU-limit note above) —
it runs on GitHub Actions instead (`.github/workflows/daily-send.yml`, `next build && next start`,
14:17 UTC primary + 15:37 UTC and 18:47 UTC retries. These off-peak minutes reduce
top-of-hour contention, but GitHub does not guarantee punctual execution),
starting its own temporary server on the GitHub runner and calling that server's
`/api/cron/weekly-send` route over localhost. `.github/workflows/letter-watchdog.yml` checks delivery + secrets health daily and
opens a GitHub Issue on failure. Its 20:37 UTC check follows the final retry's
90-minute job budget and uses UTC midnight for coverage, so yesterday's late
delivery cannot satisfy today's check. It shares GitHub with the sender and is
not an independent safeguard against a GitHub-wide outage.

A scheduled watchdog executing before its current UTC day's 20:37 target reports
timing unverified before querying coverage. A due scheduled check retains the
current-day cutoff. Manual checks do not resolve the scheduler timing alert.
The original issue date of an arbitrarily delayed cron event remains unknown.

The watchdog checks coverage when its source policy and healthy live website
both report delivery open. Their valid release SHAs may differ after a
sender-only update. Skipping coverage for a pause still requires both policies
to report paused and the exact live release to match the checked-out release.
Unrecognized health, invalid release SHAs and policy disagreement still alert.

In Tampa during daylight saving time, the target starts are 10:17 AM, 11:37 AM,
and 2:47 PM, with the watchdog at 4:37 PM. During standard time each is one hour
earlier. These are attempt times, not promised inbox arrival times.

DNS for `everyday.report` is Cloudflare-managed (migrated from Vercel DNS 2026-07-30).

The youngalgy.com portfolio repo (`YoungAlgy/youngalgy`) 308-redirects `youngalgy.com/alpha/*` page paths to `alpha.everyday.report/*`, but 301-redirects `/alpha/api/*` rather than proxying it, breaking one-click unsubscribe on pre-2026-07-03 email links (see the top of this file and next.config.ts).

## Operational notes

- **Billing**: new payments and paid plan changes are closed in source. Retained billing code exists for historical settlement and cleanup, not signup.
- **Email**. Resend remains primary. Letters send as `"alpha." <alpha@everyday.report>`; Supabase sign-in emails (custom SMTP through Resend) send as `"alpha." <noreply@everyday.report>`. The approved Brevo backup uses the separate `backup.alpha.everyday.report` domain for letters only. It does not replace sign-in SMTP.
- **Transport capacity**. Scheduled daily preflight checks Resend sender verification and both usage windows against the known active-reader count. Quota exhaustion or a transient read-only provider outage may select Brevo after its Alpha account, free-plan credits, sender and domain checks pass. Bad credentials, unknown reader counts and malformed responses stop visibly. Selection happens before new attempts. Existing attempts keep their recorded provider, including after an uncertain send, so a provider error cannot cause a cross-provider duplicate. Manual runs keep their existing provider behavior. Both free allowances remain finite and quota reads do not reserve capacity. This does not promise unlimited free delivery or recovery from every outage.
- **Supabase**. Managed database and auth. The current account plan is not
  established by source code or release health checks. Database availability
  remains required for protected delivery and durable source admission.

## Decision records

Current product and repository rules live in `AGENTS.md`, this README, and the
checked-in docs. Treat outside Claude history as dated archive material. Keep
Alpha's product, subscriber, provider, billing, messaging, and release context
separate from every other product.

## Commits

See `git log` — semver-style `v0.X` commit messages with structured notes.
