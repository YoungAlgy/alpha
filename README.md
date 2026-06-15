# Alpha

A $5/mo personal newsletter. Users pick 5 topics from a curated menu of 25 (add-on bundles up to 25 topics, $25/mo); three times a week (Sun/Tue/Thu) we deliver an AI-written letter built from real sources — every cited link must come from that send's live search, enforced in code (lib/engine/url-guard.ts). Each send only looks at what's new since the last one (lib/cadence.ts).

Lives at `youngalgy.com/alpha` (Vercel rewrite from a separate Next.js project at this repo to `alpha-chi-five.vercel.app`).

## Stack

| Layer | Tool |
|---|---|
| Framework | Next.js 16 (App Router, basePath `/alpha`, Turbopack) |
| Styling | Tailwind CSS 4 + CSS custom properties (10 themes) |
| Hosting | Vercel (project `alpha`) |
| DB / Auth | Supabase (project `xpqxhdciaoicsnyyfshy` in the "Algy" org) |
| AI | Claude Sonnet 4.6 via `@anthropic-ai/sdk` |
| Web search | Brave Search API ($5/mo free credit covers V0) |
| Payments | Stripe — dedicated Alpha account (`acct_1TWfDlAhrDpDN9sH`), not shared with Ava |
| Email | Resend (`alpha@youngalgy.com` — SPF/DKIM/DMARC verified). SES was dropped (AWS denied prod access); its code is removed. |

## Architecture highlights

- **Theme-first onboarding** — `/theme` is step 2 (right after `/welcome`). The chosen theme is applied app-wide via `ThemeApplier` (root layout) so every step from `/name` through `/checkout` adopts the user's palette. ThemeApplier reads from `public.users` for signed-in users, falls back to localStorage for mid-funnel users.
- **Shared topic_blurbs cache** (`lib/engine/blurb-cache.ts`) — generate each topic-week's content once in Supabase, serve to every subscriber. ~10× cost reduction vs. naive per-user generation.
- **Onboarding-first funnel** (10 screens, no public landing) — `welcome → theme → name → city → role → focus → topics → fun → email → checkout`. Conversion play borrowed from Headway/Noom.
- **Auto-sign-in after checkout** — `/api/generate` calls `admin.generateLink` once to create the auth user; `/writing` redirects through that link to set the session cookie via `/auth/callback`. User lands on `/inbox` already signed in. The magic link is invisible to the user — never surfaced in an email.
- **Returning sign-in: 6-digit code** — `/signin` uses Supabase `signInWithOtp` + `verifyOtp({ type: "email" })`. Magic Link template is overridden with `{{ .Token }}` only. No clickable email links for returning users.
- **RLS-by-default** — every PII table (`users`, `issues`, `support_tickets`) has policies scoped to `auth.uid()`. Service role bypasses RLS for server-side operations (webhook upsert, generate persistence, admin endpoint).
- **Admin Accounts panel** at `/settings/accounts` — gated to `youngalgy@gmail.com` via server-side session check. List, grant free subscription, revoke free, delete. Real Stripe customers protected from accidental revoke.
- **In-app changelog** at `/settings/changelog` — hand-curated entries in `app/settings/changelog/page.tsx`. Server-rendered, `noindex` meta, private behind `/settings` (already in `robots.ts` disallow).

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
  ThemeSwitcher               in-app theme switcher (not used in V1 — settings does this now)
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
proxy.ts                      Supabase session refresh middleware (renamed from middleware.ts for Next 16)
```

## Environment

Required for full functionality (see `.env.local`):

```
ANTHROPIC_API_KEY=             # Claude
RESEND_API_KEY=                # Email (sole provider)
RESEND_FROM=Alpha <alpha@youngalgy.com>
STRIPE_SECRET_KEY=             # Stripe (Alpha account)
STRIPE_WEBHOOK_SECRET=         # whsec_... for the webhook endpoint
BRAVE_SEARCH_API_KEY=          # Brave Search
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
NEXT_PUBLIC_APP_URL=https://youngalgy.com  # canonical origin for Stripe URLs + ALL email links
UNSUBSCRIBE_SECRET=            # HMAC secret for unsubscribe + letter-view tokens
CRON_SECRET=                   # bearer for /api/cron/weekly-send (Vercel Cron sends it)
SUPPORT_FORWARD_EMAIL=         # where /api/support notifications go (optional)
NEXT_PUBLIC_POSTHOG_KEY=       # analytics (optional — inert if unset)
```

`GET /alpha/api/health` returns which services are configured + active email provider.

## Development

```bash
npm run dev     # localhost:3003
npm run build
npm run lint
```

Hot-reload across `app/`, `components/`, `lib/`.

## Deployment

Pushes to `master` auto-deploy via Vercel Git integration. For manual deploys:

```bash
vercel deploy
# preview URL printed
vercel promote <preview-url>   # explicit promote — confirms before swapping prod
```

`youngalgy.com/alpha/*` paths proxy to this app via a `vercel.json` rewrite in the youngalgy.com portfolio repo (`YoungAlgy/youngalgy`).

## Operational notes

- **Stripe** — dedicated Alpha account, fully Alpha-branded checkout. FOUNDER coupon (100%-off forever, owner-curated promo codes) for testing.
- **Email** — SES out of sandbox is **still pending AWS support case 177814045700922**. While in sandbox, only verified recipient identities receive (currently: `youngalgy@gmail.com`). The Resend fallback (FROM `alpha@avahealth.co`) is kept in code so any unverified-recipient send still arrives — it just won't be from the brand sender until sandbox lifts.
- **Supabase** — free tier in "Algy" org. Daily traffic prevents the 7-day idle pause.

## Project memory

Plan + decisions tracked at:
- `~/.claude/plans/ally_app_plan_2026-05-13.md` — original plan doc
- `~/.claude/projects/C--Users-Algernon/memory/project_ally_app.md` — locked decisions
- `~/.claude/projects/C--Users-Algernon/memory/feedback_alpha_brand_independence.md` — visual independence rule
- `~/.claude/projects/C--Users-Algernon/memory/feedback_alpha_changelog.md` — keep `/settings/changelog` current after every user-visible ship

## Commits

See `git log` — semver-style `v0.X` commit messages with structured notes.
