# Alpha

A $5/mo personal weekly newsletter. Users pick 5 topics from a curated menu of 25; we deliver an AI-sourced, human-reviewed letter every Sunday on what actually matters in those topics.

Lives at `youngalgy.com/alpha` (Vercel rewrite from a separate Next.js project at this repo).

## Stack

| Layer | Tool |
|---|---|
| Framework | Next.js 16 (App Router, basePath `/alpha`) |
| Styling | Tailwind CSS 4 + CSS custom properties (10 themes) |
| Hosting | Vercel |
| DB / Auth | Supabase (project `xpqxhdciaoicsnyyfshy` in the "Algy" org) |
| AI | Claude Sonnet 4.6 via `@anthropic-ai/sdk` |
| Web search | Brave Search API ($5/mo free credit covers V0) |
| Payments | Stripe Checkout + customer portal + webhooks |
| Email | Resend (temp sender `alpha@avahealth.co` until AWS SES is wired) |

## Architecture highlights

- **Shared topic_blurbs cache** (`lib/engine/blurb-cache.ts`): generate each topic-week's content once in Supabase, serve to every subscriber. ~10× cost reduction vs. naive per-user generation.
- **Onboarding-first funnel** (12 screens, no landing page): users invest in name → city → role → 5 topics → theme → email before the $5 reveal at Step 9. Conversion play borrowed from Headway/Noom.
- **Magic-link auth post-payment**: `admin.generateLink` finds-or-creates the auth user using the Stripe email and embeds the magic link in the welcome email. User reads the first letter immediately; clicks the email link for a frictionless sign-in next time.
- **RLS-by-default**: every PII table (`users`, `issues`, `support_tickets`) has policies scoped to `auth.uid()`. Service role bypasses RLS for server-side operations (webhook, persistence).
- **Theme system**: 10 themes implemented as CSS variable sets on `[data-theme="..."]`. Brand chrome stays Forest; the letter renders in the user's chosen theme.

## Directory layout

```
app/
  welcome / name / city / role / focus / topics / theme / fun / email / checkout   onboarding funnel
  writing                                                                          engine progress UI
  inbox / inbox/[issueId] / archive                                                 letter reading
  settings / signin / privacy / terms / support / not-found                        static + account
  api/
    generate                  Claude pipeline (rate-limited, zod-validated)
    send-letter               Resend trigger (also auto-called from /api/generate)
    support                   support form → Supabase + Resend notify
    stripe/checkout           creates Stripe Checkout Session
    stripe/webhook            handles checkout.session.completed, sub events
    stripe/portal             customer-portal session for billing self-service
    health                    uptime check + env-var presence
  auth/callback               Supabase magic-link redirect handler
  robots.ts / sitemap.ts      SEO

components/
  Digest                      letter render
  ThemeSwitcher / AudioToggle / ReadingProgress / LetterTOC / ScrollFadeIn
  FirstLetterCelebration / InstallPrompt / Footer / LegalLayout
  onboarding/StepShell / ProgressDots / QuestionStep

lib/
  types.ts                    canonical app types (Issue, UserProfile, ItemKind, etc.)
  topics.ts                   25-topic registry with emoji + blurb + tier
  themes.ts                   10-theme registry
  audio.ts                    Web Audio synth sound palette
  onboarding-state.ts         localStorage state + cross-step nav helpers
  user-sync.ts                Supabase user sync + delete
  rate-limit.ts               in-memory IP bucket
  stripe.ts                   constants
  email.ts                    Resend client + HTML/text letter renderer
  brave.ts                    Brave Search client
  supabase/                   client.ts / server.ts / types.ts
  engine/
    types.ts                  TopicSignal / TopicBlurb / DigestSection
    mock-signals.ts           hand-written fallback signal for each of the 25 topics
    topic-queries.ts          Brave queries per topic
    source-resolver.ts        Brave-first + mock fallback
    topic-blurb.ts            Claude synthesis prompt for one section
    editor-note.ts            Claude synthesis prompt for the personalized intro
    blurb-cache.ts            Supabase-backed (topic, week_of) cache
    assemble.ts               full Issue assembly
    persist.ts                find-or-create auth user + upsert profile + issue
    client.ts                 Anthropic SDK wrapper

supabase/migrations/          schema migration (applied via dashboard SQL editor)
public/                       favicon + manifest + static assets
middleware.ts                 Supabase session refresh
```

## Environment

Required for full functionality (see `.env.local`):

```
ANTHROPIC_API_KEY=             # Claude
RESEND_API_KEY=                # Email delivery
RESEND_FROM=                   # Alpha <alpha@avahealth.co> (temp)
STRIPE_SECRET_KEY=             # Stripe (live or test)
STRIPE_WEBHOOK_SECRET=         # whsec_... once webhook URL is registered
BRAVE_SEARCH_API_KEY=          # Brave Search
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
```

`GET /alpha/api/health` returns which services are configured.

## Development

```bash
npm run dev     # localhost:3003 (port set in .claude/launch.json so it doesn't clash with other projects)
npm run build
npm run lint
```

The dev server uses Turbopack. Hot-reload across `app/`, `components/`, `lib/`.

## Deployment

1. Push to GitHub
2. Connect repo to Vercel as a new project
3. Set all env vars above in Vercel project settings
4. Add a Vercel rewrite on the `youngalgy.com` portfolio project: `/alpha/:path*` → this app's domain
5. After deploy, register Stripe webhook endpoint at `<vercel-domain>/alpha/api/stripe/webhook` and paste the `whsec_...` into env

## Operational notes

- **Stripe**: currently shares the Ava Health account. Move to dedicated Alpha account before public launch (memory note exists).
- **Resend**: sending from `alpha@avahealth.co` (free tier, single-domain). Swap to AWS SES + `alpha@youngalgy.com` per `~/.claude/projects/.../memory/project_alpha_todo_aws_ses.md`.
- **Supabase**: free tier in "Algy" org. Paused if idle 7+ days; daily traffic prevents that.

## Project memory

Plan + decisions tracked at:
- `~/.claude/plans/ally_app_plan_2026-05-13.md` — original plan doc
- `~/.claude/projects/C--Users-Algernon/memory/project_ally_app.md` — locked decisions
- `~/.claude/projects/C--Users-Algernon/memory/project_alpha_todo_aws_ses.md` — AWS SES follow-up
- `~/.claude/projects/C--Users-Algernon/memory/feedback_alpha_brand_independence.md` — visual independence rule

## Commits

See `git log` — semver-style `v0.X` commit messages with structured changelog notes.
