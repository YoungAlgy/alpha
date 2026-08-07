# Alpha

A $5/mo personal newsletter. Users pick 5 topics from a curated menu of 25 (add-on bundles up to 25 topics, $25/mo); every day (14:00 UTC) we deliver an AI-written letter built from real sources — every cited link must come from that send's live search, enforced in code (lib/engine/url-guard.ts). Each send only looks at what's new since the last one (lib/cadence.ts).

Lives at `alpha.everyday.report` (its own domain, app at the root — no basePath). `everyday.report` redirects there. The old home, `youngalgy.com/alpha/*`, 308-redirects page paths here, but `/alpha/api/*` is 301-redirected, not proxied — the youngalgy.com Vercel project this used to proxy to is gone. That breaks one-click unsubscribe (GET/POST, List-Unsubscribe-Post) for any letter sent before the 2026-07-03 domain move; see next.config.ts for detail. Old magic-link/email-change callbacks are NOT proxied — they survive only because browsers follow the 308 to `/auth/callback` AND `https://youngalgy.com/alpha/auth/callback**` stays in the Supabase redirect allowlist. Never remove that allowlist entry.

## Stack

| Layer | Tool |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Styling | Tailwind CSS 4 + CSS custom properties (10 themes) |
| Hosting | Cloudflare Workers (via OpenNext) for the website; the daily send itself runs on GitHub Actions (see Deployment below) |
| DB / Auth | Supabase (project `xpqxhdciaoicsnyyfshy` in the "Algy" org) |
| AI | Claude Sonnet 5 (topic blurbs) + Claude Opus 4.8 (editor's note) via `@anthropic-ai/sdk` |
| Web search | Brave Search API ($5/mo free credit covers V0) |
| Payments | Stripe — dedicated Alpha account (`acct_1TWfDlAhrDpDN9sH`), not shared with Ava |
| Email | Resend — letters from `"alpha." <alpha@everyday.report>`, sign-in (Supabase SMTP) from `noreply@everyday.report`. Domain verified via Cloudflare DNS. Old sender was alpha@youngalgy.com (that domain now removed from Resend — free plan holds 1 domain). |

## Architecture highlights

- **Theme-first onboarding** — `/theme` is step 2 (right after `/welcome`). The chosen theme is applied app-wide via `ThemeApplier` (root layout) so every step from `/name` through `/checkout` adopts the user's palette. ThemeApplier reads from `public.users` for signed-in users, falls back to localStorage for mid-funnel users.
- **Shared topic_blurbs cache** (`lib/engine/blurb-cache.ts`) — generate each topic-week's content once in Supabase, serve to every subscriber. ~10× cost reduction vs. naive per-user generation.
- **Onboarding-first funnel** (10 screens, no public landing) — `welcome → theme → name → city → role → focus → topics → fun → email → checkout`. Conversion play borrowed from Headway/Noom.
- **Auto-sign-in after checkout** — `/api/generate` calls `admin.generateLink` once to create the auth user; `/writing` redirects through that link to set the session cookie via `/auth/callback`. User lands on `/inbox` already signed in. The magic link is invisible to the user — never surfaced in an email.
- **Returning sign-in: 6-digit code** — `/signin` uses Supabase `signInWithOtp` + `verifyOtp({ type: "email" })`. Magic Link template is overridden with `{{ .Token }}` only. No clickable email links for returning users.
- **RLS-by-default** — every PII table (`users`, `issues`, `support_tickets`) has policies scoped to `auth.uid()`. Service role bypasses RLS for server-side operations (webhook upsert, generate persistence, admin endpoint).
- **Admin Accounts panel** at `/settings/accounts` — gated to `youngalgy@gmail.com` via server-side session check. List, grant free subscription, revoke free, delete. Real Stripe customers protected from accidental revoke.
- **In-app changelog** at `/settings/changelog` — hand-curated entries in `app/settings/changelog/page.tsx`. Server-rendered, `noindex` meta, private behind `/settings` (already in `robots.ts` disallow).
- **Delivery reliability** (all added 2026-08-05, after moving the daily send off Cloudflare) —
  - **Stuck-claim reclaim** — `runPersistAndSend` stamps `delivered_at` as an atomic claim *before* calling Resend; if the process dies in between (a killed runner, an OOM), the row is left claimed with no email ever sent. The cron's GET handler reclaims any row matching "claimed, no proof of send, older than a 10-minute safety margin" back into the undelivered pool at the top of every run.
  - **`resend_message_id` proof-of-send** — only ever set after a *confirmed* successful Resend call, so `delivered_at` alone can no longer be read as "done" anywhere in the system (the reclaim step above, `watchdog_delivery_check()`, and the retry pre-check all require it).
  - **`watchdog_delivery_check()` per-subscriber coverage** — a security-definer RPC, callable with the anon key, that both `letter-watchdog.yml`'s alert check and `daily-send.yml`'s retry pre-check call. Returns `uncovered_count`: the number of currently active subscribers with no proven-delivered issue since a cutoff — a genuine per-subscriber existence check, not an aggregate-count comparison (which can coincidentally net out even when one specific subscriber has nothing, e.g. an unsubscribe and a signup in the same window).
  - **`prior_issue_counts()`** — one grouped RPC for every subscriber's lifetime "Issue N" count, replacing N per-subscriber count queries.
  - **Resend retry-with-backoff** (`retryResendCall` in `lib/email.ts`) — up to 3 attempts with backoff on transient errors (`rate_limit_exceeded`, `internal_server_error`, `application_error`, `concurrent_idempotent_requests`); permanent errors (bad API key, invalid recipient, quota exceeded) fail fast with no retry.

## Directory layout

```
app/
  welcome / theme / name / city / role / focus / topics / fun / email / checkout   onboarding funnel
  writing                                                                          generate progress UI
  inbox / inbox/[issueId] / archive                                                 letter reading
  settings / settings/accounts / settings/changelog                                 account, admin, what's new
  signin / privacy / terms / support / not-found                                   static + sign-in
  api/
    generate                  Claude pipeline (rate-limited, zod-validated, persists issue + user, sends first-letter email)
    support                   support form → Supabase + email notify
    stripe/checkout           creates Stripe Checkout Session (success_url uses NEXT_PUBLIC_APP_URL)
    stripe/webhook            handles checkout.session.completed (upsert), sub events
    stripe/portal             customer-portal session for billing self-service
    admin/users               admin GET list + POST delete/grant_free/revoke_free (email gate)
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
  topics.ts                   25-topic registry (latest add: trading-cards, 2026-06-10)
  themes.ts                   10-theme registry
  audio.ts                    Web Audio synth sound palette
  onboarding-state.ts         localStorage state + ONBOARDING_STEPS ordering
  user-sync.ts                Supabase user sync + delete-account
  rate-limit.ts               in-memory IP bucket
  stripe.ts                   product/price constants (new Alpha account)
  email.ts                    Resend sender + HTML/text renderers (letter + welcome)
  brave.ts                    Brave Search client
  supabase/                   client.ts / server.ts / types.ts
  engine/
    types.ts                  TopicSignal / TopicBlurb / DigestSection
    mock-signals.ts           hand-written fallback signal for each topic
    topic-queries.ts          Brave queries per topic
    source-resolver.ts        Brave-first + mock fallback
    topic-blurb.ts            Claude synthesis prompt for one section
    editor-note.ts            Claude synthesis prompt for the personalized intro
    blurb-cache.ts            Supabase-backed (topic, week_of) cache
    assemble.ts               full Issue assembly
    persist.ts                find-or-create auth user + upsert profile + issue (returns magicLink)
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
ANTHROPIC_API_KEY=             # Claude
RESEND_API_KEY=                # Email (sole provider)
RESEND_FROM="alpha." <alpha@everyday.report>  # optional -- every send site already defaults to this exact value if unset
RESEND_WEBHOOK_SECRET=         # whsec_... for app/api/webhooks/resend (bounce/complaint suppression). If unset,
                                # that route hard-503s -- bounces/complaints silently stop being suppressed, not a
                                # payment-bypass risk but a slow sender-reputation one.
STRIPE_SECRET_KEY=             # Stripe (Alpha account). NOTE: not hard-required everywhere -- if unset,
                                # /api/generate treats the request as a paid dev/Stripe-less stub flow (bypasses
                                # payment verification entirely) and /api/account/email/reconcile silently skips
                                # its Stripe customer-email sync. Every other Stripe route (checkout/portal/
                                # update-quantity/webhook) does hard-503 without it. Leaving it unset in a real
                                # deployment is a payment-bypass risk, not just a missing-feature.
STRIPE_WEBHOOK_SECRET=         # whsec_... for the webhook endpoint
BRAVE_SEARCH_API_KEY=          # Brave Search
GEMINI_API_KEY=                # search + generation fallback tier (Brave rate-limited, or Claude down)
GROQ_API_KEY=                  # generation fallback tier 2 (Gemini -> Groq -> DeepSeek -> Haiku -> Sonnet)
DEEPSEEK_API_KEY=              # generation fallback tier 3, the uncapped backstop behind Groq
YOU_API_KEY=                   # search fallback tier 3 (Brave -> Gemini grounded search -> You.com)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=  # old name NEXT_PUBLIC_SUPABASE_ANON_KEY still accepted as a fallback
SUPABASE_SECRET_KEY=            # old name SUPABASE_SERVICE_ROLE_KEY still accepted as a fallback
NEXT_PUBLIC_APP_URL=https://alpha.everyday.report  # optional -- canonical origin for Stripe URLs + ALL email
                                # links; every call site already falls back to this exact value (or the
                                # request's own origin, on the Stripe routes) if unset
UNSUBSCRIBE_SECRET=            # HMAC secret for unsubscribe + letter-view tokens
CRON_SECRET=                   # bearer for /api/cron/weekly-send (GitHub Actions sends it)
SUPPORT_FORWARD_EMAIL=         # where /api/support notifications go (optional)
NEXT_PUBLIC_POSTHOG_KEY=       # analytics (optional — inert if unset)
NEXT_PUBLIC_POSTHOG_HOST=      # optional, defaults to PostHog US cloud -- for a self-hosted PostHog instance
OPS_ALERT_EMAIL=               # internal ops-alert recipient (optional, defaults to youngalgy@gmail.com)
OPS_ALERT_WEBHOOK_URL=         # Discord/Slack webhook fallback when Resend itself is broken (optional)
JINA_API_KEY=                  # Jina Reader auth for deep-read article fetch (optional — Jina Reader works keyless, this just raises its rate limit)
ALPHA_DISABLE_DEEPREAD=        # set to "1" to kill deep-read and fall back to snippet-only signal (optional)

# Optional per-tier model overrides (A/B a model without a deploy; each has a hardcoded default):
ALPHA_BLURB_MODEL=             # default claude-sonnet-5
ALPHA_BLURB_CHEAP_MODEL=       # default claude-haiku-4-5
ALPHA_EDITOR_MODEL=            # default claude-opus-4-8
ALPHA_GEMINI_TEXT_MODEL=       # default gemini-2.5-flash
ALPHA_GEMINI_SEARCH_MODEL=     # default gemini-2.5-flash
```

`GET /api/health` returns which services are configured + active email provider.

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

`cf:deploy` chains: verify build env → `opennextjs-cloudflare build` → `opennextjs-cloudflare deploy` → a post-deploy smoke test against the live site (`scripts/smoke-test-deploy.mjs`).

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
14:00 UTC primary + 15:00 UTC retry), calling this deployment's `/api/cron/weekly-send` route
over HTTP. `.github/workflows/letter-watchdog.yml` checks delivery + secrets health daily and
opens a GitHub Issue on failure.

DNS for `everyday.report` is Cloudflare-managed (migrated from Vercel DNS 2026-07-30).

The youngalgy.com portfolio repo (`YoungAlgy/youngalgy`) 308-redirects `youngalgy.com/alpha/*` page paths to `alpha.everyday.report/*`, but 301-redirects `/alpha/api/*` rather than proxying it, breaking one-click unsubscribe on pre-2026-07-03 email links (see the top of this file and next.config.ts).

## Operational notes

- **Stripe** — dedicated Alpha account, fully Alpha-branded checkout. FOUNDER coupon (100%-off forever, owner-curated promo codes) for testing.
- **Email** — Resend is the sole provider. Letters send as `"alpha." <alpha@everyday.report>`; Supabase sign-in emails (custom SMTP through Resend) send as `"alpha." <noreply@everyday.report>`. The everyday.report sending domain is verified via records in Cloudflare's DNS zone (migrated from Vercel DNS 2026-07-30).
- **Supabase** — free tier in "Algy" org. Daily traffic prevents the 7-day idle pause.

## Project memory

Plan + decisions tracked at:
- `~/.claude/plans/ally_app_plan_2026-05-13.md` — original plan doc
- `~/.claude/projects/C--Users-Algernon/memory/project_ally_app.md` — locked decisions
- `~/.claude/projects/C--Users-Algernon/memory/feedback_alpha_brand_independence.md` — visual independence rule
- `~/.claude/projects/C--Users-Algernon/memory/feedback_alpha_changelog.md` — keep `/settings/changelog` current after every user-visible ship

## Commits

See `git log` — semver-style `v0.X` commit messages with structured notes.
