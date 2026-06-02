# NIGHT_LOG — Alpha overnight autonomous run (started 2026-06-02)

Repo: `C:\Users\Algy\alpha`. Stack: **Next.js** App Router (basePath `/alpha`). Live: youngalgy.com/alpha. Start HEAD: `2b417bb`.
Real-generation / verification harnesses (reuse to verify any change; scripts/ excluded from tsconfig):
- `npx tsx scripts/verify-url-guard.mts [topic]` — Brave+Claude, asserts URL guard holds + links resolve.
- `npx tsx scripts/audit-topic-signal.mts` — Brave-only signal-strength sweep across all topics.
- `npx tsx scripts/verify-resilient-assemble.mts` — forces a partial topic failure, asserts letter still ships.
- `npx tsx scripts/verify-mock-fallback.mts [topic]` — Brave-disabled, asserts mock fallback yields guard-passing links.
- `npx tsx scripts/verify-email-validation.mts` — funnel email validator accept/reject table (19 cases).
- `npx tsx scripts/verify-access-window.mts` — hasActiveAccess boundary table + READ-ONLY live-DB check that the weekly-send `.or` filter parses + counts reconcile.
- `npx tsx scripts/verify-webhook-mutation.mts` — checkout.session.completed non-clobber invariant + READ-ONLY live tie-in.
- `npx tsx scripts/preview-email.mts` — renders the letter email HTML to /tmp (no live send).

---

## QUEUE (ranked, living) — FRESH RE-AUDIT mode (targeted queue exhausted after 15 cycles)
Re-audit keeps finding real bugs (cycles 16, 17, 18 all shipped material fixes). Keep going.
19. **[next] RE-AUDIT continues** — top candidate: **the account-deletion path** (`lib/user-sync.deleteUserAccount` + wherever it deletes). The project's soft-delete rule says "filter `deleted_at IS NULL` in all counts" but **there is NO `deleted_at` column** anywhere in code (grep clean). So either deletion is a HARD delete (confirm it removes BOTH the auth user AND the public.users row — no orphan that still receives weekly letters!) or it's incomplete. A deleted account that leaves a public.users row with subscribed_at set + cancelled_at null would KEEP getting letters → privacy/cost bug. Verify end-to-end; fix if orphaning is possible. Other lightly-checked: app/inbox + inbox/[issueId] empty/error states, app/auth/callback, app/welcome + app/theme a11y/validation, generation cron edges. Pick the single highest-leverage NEW finding; if nothing material → smallest polish + log convergence.
20. **Monitoring** — surface URL-guard drop-count / generation health in admin stats. Low.
21. (polish notes, only if idle) account-delete `alert()`→in-page feedback (settings, rare path); not-found.tsx `title` "Lost? — Alpha" → "Lost?" (template doubles it); mobile letter TOC; `<Wordmark>` DRY (~12× inline).

## DONE (commit hashes)
- `28ca13a` — **code-level no-invented-links guard** (was prompt-only). Verified real.
- (cycle 2, no commit) — **flow verified sound** (routes 200, generate→402, webhook→405).
- `011d0fc` — **resilient assembly** (allSettled). Verified real.
- `2d92143` — **empty-Brave-week → mock fallback**. Verified real.
- `2fe34e3` — **generation retry-once on malformed JSON**. Verified real.
- `edb34e5` — **ux(archive): real error state** + friendly week labels + empty CTA + tap targets.
- `ce2c7cd` — **a11y(topic picker):** aria-pressed, role=group, aria-live count, aria-label.
- `5621d3f` — **ux(writing): paced generation animation** to the real ~45s wait.
- `d360bb9` — **design: consistent lowercase-brand titles** via title.template.
- `b019cc3` — **web3-updates mock signal** → 24/24 fallback coverage.
- `4aa51fe` — **security: editor-note prompt-injection hardening** (fenced + "treat as data" + clamps).
- `f5a4286` — **seo(landing): Organization+WebSite+Product JSON-LD** ($5 USD InStock, no fake ratings).
- `b5bcbf9` — **email: mobile viewport + dark-mode color-scheme=light + gutters**. No live send.
- `3144dab` — **ux(signin): resend-code 30s cooldown + "new code sent ✓"**.
- `bcdae87` — **ux(settings): in-page billing feedback** replacing alert() (aria-live).
- `cc3fe77` — **perf(fonts): dropped unused weight + preload:false on non-default-theme fonts.**
- `fef33f1` — **CYCLE 16 / fix(funnel): real email validation** (lib/validate-email + QuestionStep `validate` prop + email step + signin). 19/19 table; clean build; routes 200.
- `57db88d` — **CYCLE 17 / fix(billing): keep delivering through the paid period after cancel-at-period-end.** lib/access.hasActiveAccess; weekly-send `.or(cancelled_at.is.null,cancelled_at.gt.<now>)`; generate gate uses helper. 6/6 boundary + READ-ONLY live-DB reconcile; clean build; cron 401/inbox 200.
- `ad7ce29` — **CYCLE 18 / fix(webhook): checkout.session.completed idempotent (no quota/cancel clobber).** Stripe is at-least-once + out-of-order; the blind `upsert(onConflict:id)` reset upgraded subs to 5 topics + un-cancelled them on re-delivery. New lib/webhook-user-mutation.checkoutUserMutation (pure): INSERT full on first contact; else UPDATE only stripe_customer_id (+subscribed_at iff null), NEVER topic_quota/cancelled_at/name/city. 19/19 (branches + hard no-clobber invariant + READ-ONLY live tie-in vs a real subscriber); clean build; served health 200 + webhook route alive (config-gated 503 locally w/o STRIPE_WEBHOOK_SECRET).
- Signal audit: all 24 topics healthy (11–25 URLs). Mock covers 24/24.

## STATUS @ 18 cycles
Generation engine fully hardened. **Money/delivery path now correct on three axes the re-audit surfaced: (16) email typos can't reach Stripe/the send; (17) cancel-at-period-end subscribers keep their paid letters; (18) re-delivered checkout webhooks no longer clobber quota/cancel state.** Stripe webhook is now solid end-to-end (signature ✓, paid-period honored in consumers ✓, idempotent writes ✓). UX: archive/onboarding-a11y/writing-pacing/signin/settings. Email mobile+dark. Landing JSON-LD + brand titles. Fonts trimmed. error.tsx + not-found.tsx exist & branded. Converging, but re-audit still paying off — next big unknown is the account-deletion path (no deleted_at column → confirm no orphan-keeps-getting-letters bug).

## OPS NOTES
- **Live DB IS reachable read-only via `SUPABASE_SECRET_KEY` in `.env.local`** — harnesses can run READ-ONLY counts/selects to verify query semantics + PostgREST filter syntax + tie pure logic to real rows. Never write/seed/delete. (The *Management API* token 403s; the data-plane service key works.)
- **`.env.local` has STRIPE_SECRET_KEY but NOT STRIPE_WEBHOOK_SECRET** — so the webhook route returns 503 (config-gated) locally and can't be exercised end-to-end here. Verify webhook handler logic via pure helpers + harness + build; the signature guard + handler run only in prod (Vercel has the secret). Do NOT forge Stripe events.
- **Route render-check: prefer `npx next start -p <isolated port>` over `next dev`** (dev's single-instance lock + leftover procs → HTTP 000). A clean build that prerenders a page `○ Static` is itself proof it renders.
- Avoid `sed` on NIGHT_LOG; use Write to rewrite the whole file. Background serve commands auto-detach; read the task .output file.

## DECISIONS I MADE
- `C:\Users\Algy\alpha`; Next.js. Sacred guard was prompt-only → built CODE enforcement (strengthen-only).
- Resilience: partial letters over failing whole; mock-fallback over link-less; retry-once over first-fail.
- Email validation pragmatic not RFC-5322; validate at entry; native type="email" too lax.
- Cycle 17: paid-period fix lives in the CONSUMERS (send filter + generate gate); the webhook's cancelled_at=end-date model is correct by its own intent. Left update-quantity's cancel block + admin labels (defensible/cosmetic).
- Cycle 18: code-only non-clobbering upsert (read-then-branch). A real event-id idempotency table needs a migration (no live DB write access) — deferred; the clobber vector is removed regardless. Pure decision extracted to lib so it's unit-testable.
- Title system: template for child pages, absolute for landing, self-contained OG/Twitter on sample.
