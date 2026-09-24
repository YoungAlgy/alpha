# Alpha

An invite-only personal daily newsletter. Approved readers pick 5 topics from a curated menu. Alpha builds each letter from current real sources, and every cited link must come from that run's source resolution. A local deterministic formatter can finish a source-grounded issue with no writer-model call. Each send only looks at what is new since the last one (`lib/cadence.ts`).

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
available. The 14:00 UTC primary slot and 15:00/18:00 UTC recovery slots share
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
| Email | Resend — letters from `"alpha." <alpha@everyday.report>`, sign-in (Supabase SMTP) from `noreply@everyday.report`. Domain verified via Cloudflare DNS. Old sender was alpha@youngalgy.com (that domain now removed from Resend — free plan holds 1 domain). |

## Architecture highlights

- **Theme-first onboarding** — `/theme` is step 2 (right after `/welcome`). The chosen theme is applied app-wide via `ThemeApplier` (root layout) so every step from `/name` through `/checkout` adopts the user's palette. ThemeApplier reads from `public.users` for signed-in users, falls back to localStorage for mid-funnel users.
- **Shared topic_blurbs cache** (`lib/engine/blurb-cache.ts`) — generate each topic-week's content once in Supabase, serve to every subscriber. ~10× cost reduction vs. naive per-user generation.
- **Onboarding-first funnel** (11 screens) — `welcome → theme → name → city → role → focus → topics → fun → you → email → checkout`, reached via a minimal public landing page (`/`) for cold/SEO traffic. Conversion play borrowed from Headway/Noom.
- **Confirmed account before checkout** — the email-code step creates and confirms the Supabase Auth owner before Stripe starts. Checkout stores the validated profile on that exact canonical user, and keeps only a pseudonymous billing reservation for Session matching and one-time fulfillment. `/writing` requires the same confirmed session owner.
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
    stripe/checkout           creates Stripe Checkout Session (success_url uses NEXT_PUBLIC_APP_URL)
    stripe/webhook            handles checkout.session.completed (upsert), sub events
    stripe/portal             customer-portal session for billing self-service
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
  onboarding-state.ts         localStorage state + ONBOARDING_STEPS ordering
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
RESEND_API_KEY=                # Email (sole provider)
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
14:00 UTC primary + 15:00 UTC and 18:00 UTC retries — the second retry was added 2026-08-06 after
a real GitHub Actions platform-wide outage took out both the 14:00 and 15:00 runs the same day),
starting its own temporary server on the GitHub runner and calling that server's
`/api/cron/weekly-send` route over localhost. `.github/workflows/letter-watchdog.yml` checks delivery + secrets health daily and
opens a GitHub Issue on failure.

DNS for `everyday.report` is Cloudflare-managed (migrated from Vercel DNS 2026-07-30).

The youngalgy.com portfolio repo (`YoungAlgy/youngalgy`) 308-redirects `youngalgy.com/alpha/*` page paths to `alpha.everyday.report/*`, but 301-redirects `/alpha/api/*` rather than proxying it, breaking one-click unsubscribe on pre-2026-07-03 email links (see the top of this file and next.config.ts).

## Operational notes

- **Stripe** — dedicated Alpha account, fully Alpha-branded checkout. FOUNDER coupon (100%-off forever, owner-curated promo codes) for testing.
- **Email** — Resend is the sole provider. Letters send as `"alpha." <alpha@everyday.report>`; Supabase sign-in emails (custom SMTP through Resend) send as `"alpha." <noreply@everyday.report>`. The everyday.report sending domain is verified via records in Cloudflare's DNS zone (migrated from Vercel DNS 2026-07-30).
- **Transport capacity**. Search and writing have several bounded fallbacks, but subscriber email still has one transport. Resend availability, reputation controls, and account quota remain hard limits. The current app cannot honestly promise free delivery to hundreds or thousands of readers until a second approved transport or verified capacity plan exists.
- **Supabase** — free tier in "Algy" org. Daily traffic prevents the 7-day idle pause.

## Decision records

Current product and repository rules live in `AGENTS.md`, this README, and the
checked-in docs. Treat outside Claude history as dated archive material. Keep
Alpha's product, subscriber, provider, billing, messaging, and release context
separate from every other product.

## Commits

See `git log` — semver-style `v0.X` commit messages with structured notes.
