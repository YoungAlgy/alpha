# NIGHT_LOG — Alpha overnight autonomous run (started 2026-06-02)

Repo: `C:\Users\Algy\alpha`. Stack: **Next.js** App Router (basePath `/alpha`). Live: youngalgy.com/alpha. Start HEAD: `2b417bb`.
Real-generation / verification harnesses (reuse to verify any change; scripts/ excluded from tsconfig):
- `npx tsx scripts/verify-url-guard.mts [topic]` — Brave+Claude, asserts URL guard holds + links resolve.
- `npx tsx scripts/audit-topic-signal.mts` — Brave-only signal-strength sweep across all topics.
- `npx tsx scripts/verify-resilient-assemble.mts` — forces a partial topic failure, asserts letter still ships.
- `npx tsx scripts/verify-mock-fallback.mts [topic]` — Brave-disabled, asserts mock fallback yields guard-passing links.
- `npx tsx scripts/verify-email-validation.mts` — asserts the funnel email validator accept/reject table (19 cases).
- `npx tsx scripts/verify-access-window.mts` — hasActiveAccess boundary table + READ-ONLY live-DB check that the weekly-send `.or` filter parses + counts reconcile.
- `npx tsx scripts/preview-email.mts` — renders the letter email HTML to /tmp (no live send).

---

## QUEUE (ranked, living) — FRESH RE-AUDIT mode (targeted queue exhausted after 15 cycles)
Re-audit IS still finding real high-leverage bugs (cycles 16, 17). Keep going on untouched surfaces.
18. **[next] RE-AUDIT continues** — strongest remaining candidate already spotted: **`checkout.session.completed` upsert clobber** (app/api/stripe/webhook/route.ts ~L67) — it upserts `topic_quota: 5, cancelled_at: null, subscribed_at: now` on conflict, so a **re-delivered or out-of-order** checkout event (Stripe is at-least-once) RESETS an upgraded subscriber back to 5 topics and un-cancels them. Fix: make it non-clobbering for subscription-state columns (read-then-insert-identity-only, or let subscription.* events own quota/cancelled_at). NOTE: a true event-id idempotency table needs a migration — NOT doable tonight (no live DB write/migrate access), so do the non-clobbering-upsert version instead. Also still lightly-checked: app/inbox + inbox/[issueId] render/empty/error states, app/auth/callback, app/welcome + app/theme a11y, lib/user-sync + deleteUserAccount (note: NO `deleted_at` column exists in this schema — deletion path needs confirming), generation cron edges. Pick the single highest-leverage NEW finding; if nothing material → smallest polish + log convergence.
19. **Monitoring** — surface URL-guard drop-count / generation health in admin stats. Low.
20. (polish notes, only if idle) account-delete `alert()`→in-page feedback (settings, rare path); not-found.tsx `title` "Lost? — Alpha" → "Lost?" (template doubles it to "Lost? — Alpha · alpha."); mobile letter TOC; `<Wordmark>` DRY (~12× inline).

## DONE (commit hashes)
- `28ca13a` — **code-level no-invented-links guard** (was prompt-only). Verified real.
- (cycle 2, no commit) — **flow verified sound** (routes 200, generate→402, webhook→405).
- `011d0fc` — **resilient assembly** (allSettled; one failed topic doesn't sink the letter). Verified real.
- `2d92143` — **empty-Brave-week → mock fallback** (zero-URL live signal no longer ships a link-less section). Verified real.
- `2fe34e3` — **generation retry-once on malformed JSON**. Verified real.
- `edb34e5` — **ux(archive): real error state** + friendly week labels + empty CTA + tap targets. /archive 200.
- `ce2c7cd` — **a11y(topic picker):** aria-pressed, role=group, aria-live count, aria-label. Verified attrs render.
- `5621d3f` — **ux(writing): paced generation animation** to the real ~45s wait. /writing 200.
- `d360bb9` — **design: consistent lowercase-brand titles** via title.template; landing absolute; sample OG keeps "— alpha.".
- `b019cc3` — **web3-updates mock signal** → 24/24 fallback coverage. Real verified-resolving URLs.
- `4aa51fe` — **security: editor-note prompt-injection hardening** — profile fields fenced + "treat as data" + length clamps. Verified.
- `f5a4286` — **seo(landing): Organization+WebSite+Product JSON-LD** (@graph, $5 USD InStock, no fake ratings). Verified valid.
- `b5bcbf9` — **email: mobile viewport + dark-mode color-scheme=light + mobile gutters** on the letter HTML. No live send.
- `3144dab` — **ux(signin): resend-code 30s cooldown + "new code sent ✓"**. /signin 200.
- `bcdae87` — **ux(settings): in-page billing feedback** replacing alert() on tier buttons + portal (aria-live). /settings 200.
- `cc3fe77` — **perf(fonts): dropped unused Fraunces weight 800 + preload:false on non-default-theme fonts.** Build clean.
- `fef33f1` — **CYCLE 16 / fix(funnel): real email validation** before a typo costs a subscriber their letter. New lib/validate-email.ts; QuestionStep `validate` prop (inline aria-live error, removed dead `required`); email step + signin wired. 19/19 table, clean build, /email /signin /topics /city 200.
- `57db88d` — **CYCLE 17 / fix(billing): keep delivering through the paid period after a cancel-at-period-end.** weekly-send filtered `.is(cancelled_at,null)` and /api/generate gated on `!cancelled_at`, but the webhook stores cancelled_at as the date access ENDS (a FUTURE date for cancel-at-period-end, intent "keep reading until period_end"). So a paying sub who scheduled cancellation was dropped from delivery + blocked from generating IMMEDIATELY — losing weeks of paid letters. New `lib/access.ts` hasActiveAccess (null OR future = active; unparseable fails safe); weekly-send now `.or(cancelled_at.is.null,cancelled_at.gt.<now>)`; generate gate uses the helper. Verified: 6/6 boundary table + READ-ONLY live-DB check (.or parses against PostgREST, counts reconcile 2==2+0), clean build, served probe health 200 / cron 401 (guard intact, no send) / inbox 200.
- Signal audit: all 24 topics healthy (11–25 URLs). Mock covers 24/24.

## STATUS @ 17 cycles
Generation engine fully hardened (URL-guard, allSettled, empty→mock, JSON retry, 24/24 mock, injection-hardened note). **Money/delivery path now correct on two axes the re-audit surfaced: (16) email typo can't reach Stripe/the send silently; (17) cancel-at-period-end subscribers keep their paid letters.** Billing UX in-page feedback. Webhook signature verification is solid; remaining webhook gap = the checkout.session.completed upsert clobber (queued #18). UX: archive/onboarding-a11y/writing-pacing/signin-cooldown+validation/settings-feedback. Email mobile+dark-mode. Landing JSON-LD + brand titles. Fonts trimmed. error.tsx + not-found.tsx exist & branded. App converging but re-audit still paying off — continue.

## OPS NOTES
- **Live DB IS reachable read-only via the service key in `.env.local`** (`SUPABASE_SECRET_KEY`). Harnesses can load .env.local and run READ-ONLY counts/selects to verify query semantics + PostgREST filter syntax against real data. (The *Management API* token is the one that 403s; the data-plane service key works.) Never write/seed/delete — reads only.
- **Route render-check: prefer `npx next start -p <isolated port>` over `next dev`.** `next dev`'s single-instance lock + leftover procs cause HTTP 000. `next start` serves the prod build cleanly. A clean `next build` that prerenders a page `○ Static` is itself proof it renders.
- Avoid `sed` on NIGHT_LOG (it duplicated the QUEUE once); use Write to rewrite the whole file.
- Background dev/serve commands auto-detach; read the task .output file for results (HTTP 000 = server never bound, not a route failure).

## DECISIONS I MADE
- `C:\Users\Algy\alpha`; Next.js (not Vite). Sacred guard was prompt-only → built CODE enforcement (strengthen-only).
- Resilience: keep partial letters over failing whole; mock-fallback over link-less; retry-once over first-fail.
- Email validation is **pragmatic, not RFC-5322** — catch deliverability-killing typos; validate at entry (email step + signin); native type="email" alone too lax.
- Cycle 17: chose the paid-period access bug over the checkout-upsert clobber (both real; access bug is higher leverage — denies paid service in the *normal* cancel flow vs. a re-delivery race). Fix lives in the CONSUMERS (send filter + generate gate), not the webhook — the webhook's cancelled_at=end-date model is correct by its own stated intent.
- Deliberately did NOT change: update-quantity's `if (row.cancelled_at)` plan-change block (defensible — don't let a cancelling sub upsize) or admin stats/labels classifying a future-cancel as "Cancelled" (cosmetic, internal). Logged as low-pri.
- Title system: template for child pages, absolute for landing, self-contained OG/Twitter on sample.
