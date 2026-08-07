# Secret inventory + rotation runbook

alpha-drift-r14-07 (review 2026-08-06): every real credential this app uses
lives in 2-4 separate stores with no single source of truth and no script
that checks they're actually in sync. This doc exists so rotating a
compromised or expiring credential is a checklist, not a memory test.

## Why so many copies

Three independent execution environments each need their own copy of
whatever they touch, because none of them can read another's secret store:

- **`.env.local`** — local dev only (`npm run dev`, `npx tsx scripts/*.mts`).
  Never deployed anywhere. Gitignored.
- **Cloudflare Worker secrets** (`npx wrangler secret put NAME`, from
  `~/alpha` in WSL — the Windows wrangler install lacks OAuth scope) — what
  the live site at alpha.everyday.report actually reads at runtime.
- **GitHub Actions secrets**, under three different prefixes because three
  different workflows need different subsets:
  - `SEND_*` — `.github/workflows/daily-send.yml`. Builds and runs a real
    `next start` server on the runner itself (see the workflow's own header
    comment for why), so it needs everything the app needs to fully
    function: every AI/search provider key, Supabase, Resend, Stripe is
    NOT included (the daily send never touches Stripe).
  - `WATCHDOG_*` — `.github/workflows/letter-watchdog.yml`. Deliberately
    minimal: only a Supabase **anon** key (never the secret/service-role
    key — see that workflow's own comment on why) and a Resend key for its
    own alert emails. No AI/search keys at all; the watchdog never
    generates anything.
  - `RECONCILE_*` — `.github/workflows/stripe-reconcile.yml`. Only what it
    needs beyond the `SEND_*` Supabase/Resend secrets it reuses: a Stripe
    secret key (the one credential no other GitHub workflow needed before
    this one, since daily-send never touches Stripe).

## The table

| Credential | `.env.local` | Cloudflare secret | GitHub secret(s) | Breaks if wrong/stale |
|---|---|---|---|---|
| Anthropic API key | `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | `SEND_ANTHROPIC_API_KEY` | Generation falls through the whole Gemini→Groq→DeepSeek waterfall for every letter, or fails outright if all fallbacks also degraded |
| Brave Search API key | `BRAVE_SEARCH_API_KEY` | `BRAVE_SEARCH_API_KEY` | `SEND_BRAVE_SEARCH_API_KEY` | Falls to Gemini grounded search → You.com; stale content if all three degrade |
| Gemini API key | `GEMINI_API_KEY` | `GEMINI_API_KEY` | `SEND_GEMINI_API_KEY` | Loses the Brave-rate-limited search fallback AND the Claude-down generation fallback simultaneously (Gemini serves both roles) |
| Groq API key | `GROQ_API_KEY` | `GROQ_API_KEY` | `SEND_GROQ_API_KEY` | Generation fallback tier 2 gone; falls straight to DeepSeek |
| DeepSeek API key | `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | `SEND_DEEPSEEK_API_KEY` | The uncapped backstop generation tier gone — if Claude AND Gemini AND Groq are all down, letters fail outright instead of degrading |
| You.com API key | `YOU_API_KEY` | `YOU_API_KEY` | `SEND_YOU_API_KEY` | Search fallback tier 3 gone |
| Resend API key | `RESEND_API_KEY` | `RESEND_API_KEY` | `SEND_RESEND_API_KEY`, `WATCHDOG_RESEND_API_KEY` | No letters, no welcome emails, no watchdog alert emails send at all (4 copies — the easiest one to rotate incompletely) |
| Resend "From" address | `RESEND_FROM` | `RESEND_FROM` | `SEND_RESEND_FROM` | Falls back to the hardcoded default in code (same value today) if unset — low risk, but keep in sync if the sending identity ever changes |
| Resend webhook signing secret | *(not set — commented out, see its own comment)* | `RESEND_WEBHOOK_SECRET` | *(not needed — daily-send never receives Resend webhooks)* | `/api/webhooks/resend` 503s; bounce/complaint suppression silently stops (deliverability risk, not an outage) |
| Stripe secret key | `STRIPE_SECRET_KEY` | `STRIPE_SECRET_KEY` | `RECONCILE_STRIPE_SECRET_KEY` (daily-send doesn't need this one) | Every Stripe-touching route hard-503s (checkout/portal/update-quantity/webhook); `/api/generate` silently treats requests as a paid dev stub — see the README's own callout on this being a payment-bypass risk if ever unset in production. If only the GitHub copy is stale, `stripe-reconcile.yml` just fails to run (a read-only check), no production impact |
| Stripe webhook signing secret | *(not set — commented out, see its own comment)* | `STRIPE_WEBHOOK_SECRET` | *(not needed)* | `/api/stripe/webhook` 503s; NO subscription/dispute/refund events get mirrored to `public.users` at all — silent billing/access drift, the most severe entry in this table if missed |
| Supabase URL | `NEXT_PUBLIC_SUPABASE_URL` | `NEXT_PUBLIC_SUPABASE_URL` | `SEND_SUPABASE_URL`, `WATCHDOG_SUPABASE_URL` | Total outage (every DB-touching route) or the watchdog silently checking the wrong project |
| Supabase publishable/anon key | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (old name `NEXT_PUBLIC_SUPABASE_ANON_KEY` still accepted) | same | `SEND_SUPABASE_PUBLISHABLE_KEY`, `WATCHDOG_SUPABASE_ANON_KEY` | Auth/session paths break, or the watchdog's own RLS-scoped delivery check fails closed (routes to its alert path, which is at least fail-safe, not fail-silent) |
| Supabase secret/service-role key | `SUPABASE_SECRET_KEY` (old name `SUPABASE_SERVICE_ROLE_KEY` still accepted) | same | `SEND_SUPABASE_SECRET_KEY` (**not** used by the watchdog — see above) | Every service-role DB write fails: webhooks, cron sends, admin actions, account deletes |
| `CRON_SECRET` | a **local-only dev value**, independent of prod | gates the **live deployed Cloudflare Worker's** `/api/cron/weekly-send` route directly | `SEND_CRON_SECRET` — used by the **locally-built GitHub Actions server**, a completely separate process | **These do not need to match each other** — the Cloudflare one and the GitHub Actions one gate two different servers running the same code. Rotating one does NOT require rotating the other. Confusing this with `UNSUBSCRIBE_SECRET` below (which DOES need to match everywhere) is the most likely mistake here. |
| `UNSUBSCRIBE_SECRET` | `UNSUBSCRIBE_SECRET` | `UNSUBSCRIBE_SECRET` | `SEND_UNSUBSCRIBE_SECRET` | **All three MUST be the identical value.** This HMAC-signs unsubscribe + letter-view tokens; a token minted by one path (e.g. a GitHub Actions daily send) must verify against whichever path later checks it (e.g. the deployed Worker, when a subscriber clicks the link in their inbox). If these ever drift, valid-looking unsubscribe/letter links mint by one path start silently failing "Invalid or expired link" when clicked, for every letter sent while they were out of sync. |
| Ops alert webhook URL (Discord) | `OPS_ALERT_WEBHOOK_URL` | `OPS_ALERT_WEBHOOK_URL` | `SEND_OPS_ALERT_WEBHOOK_URL` | `sendOpsAlert()`'s webhook fallback channel goes silent (the Resend-email channel is independent and still works) |
| DB backup encryption key | *(not needed locally — `db-backup.yml` only runs in CI)* | *(not needed)* | `BACKUP_ENCRYPTION_KEY` | **This repo is public.** `db-backup.yml`'s artifact is downloadable by anyone; this key is the only thing standing between that artifact and a full subscriber PII leak (alpha-drift-r15-11, found+fixed live 2026-08-07 — the first backup run uploaded the raw JSON unencrypted before this existed). If lost, old backup artifacts become permanently undecryptable — that's an acceptable trade for never letting this value leave GitHub Secrets. To decrypt a downloaded artifact: `openssl enc -d -aes-256-cbc -pbkdf2 -in backup.tar.gz.enc -out backup.tar.gz -pass pass:THE_KEY && tar -xzf backup.tar.gz` |

## Rotating a credential

1. Get the new value from the provider (Anthropic/Stripe/Resend/etc.
   dashboard, or Supabase's own key-rotation flow).
2. Update **every** row in that credential's table entry above, in this
   order (safest first): `.env.local` → Cloudflare (`npx wrangler secret
   put NAME`, from WSL) → GitHub (`gh secret set NAME --repo
   YoungAlgy/alpha`, once per `SEND_*`/`WATCHDOG_*` name that credential
   appears under).
3. For `UNSUBSCRIBE_SECRET` specifically: rotating it invalidates every
   unsubscribe/letter-view link already sent in prior emails (they were
   signed with the old value). Only rotate this one if it's actually been
   compromised — routine rotation has a real subscriber-facing cost the
   others don't.
4. Deploy (`bash scripts/deploy-from-wsl.sh` — this also runs
   `scripts/smoke-test-deploy.mjs`, which will catch a missed Cloudflare
   secret via `/api/health`'s `checks` object).
5. Trigger `daily-send.yml` via `workflow_dispatch` once (or wait for the
   next scheduled run) to confirm the GitHub-side copies actually took.
6. Revoke the OLD value at the provider only after confirming the new one
   works end to end — don't revoke-then-verify.

No automated check currently confirms these stay in sync between rotations
(flagged, not built — see the round-14 audit finding this doc closes for
why: this is documentation, not a new monitoring system).
