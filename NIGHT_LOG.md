# NIGHT_LOG — Alpha overnight autonomous run (started 2026-06-02)

Repo: `C:\Users\Algy\alpha`. Stack: **Next.js** App Router (basePath `/alpha`). Live: youngalgy.com/alpha. Start HEAD: `2b417bb`.
Real-generation / verification harnesses (reuse to verify any change; scripts/ excluded from tsconfig):
- `npx tsx scripts/verify-url-guard.mts [topic]` — Brave+Claude, asserts URL guard holds + links resolve.
- `npx tsx scripts/audit-topic-signal.mts` — Brave-only signal-strength sweep across all topics.
- `npx tsx scripts/verify-resilient-assemble.mts` — forces a partial topic failure, asserts letter still ships.
- `npx tsx scripts/verify-mock-fallback.mts [topic]` — Brave-disabled, asserts mock fallback yields guard-passing links.
- `npx tsx scripts/verify-email-validation.mts` — asserts the funnel email validator accept/reject table (19 cases).
- `npx tsx scripts/preview-email.mts` — renders the letter email HTML to /tmp (no live send).

---

## QUEUE (ranked, living) — FRESH RE-AUDIT mode (targeted queue exhausted after 15 cycles)
Cycle 16 re-audit DID find a real high-leverage bug (lax email validation on the money path — shipped `fef33f1`). Keep re-auditing untouched surfaces with fresh eyes each cycle.
17. **[next] RE-AUDIT continues** — surfaces still only lightly checked: the Stripe **webhook** correctness (idempotency, subscription.updated→quota mirror, soft-delete on cancel), `app/inbox` + `inbox/[issueId]` render/empty/error states, `app/auth/callback`, `app/welcome` + `app/theme` step a11y/validation, `lib/user-sync` + `deleteUserAccount` edge cases, the generation cron path. Pick the single highest-leverage NEW finding and ship it. If nothing material → smallest worthwhile polish + log convergence.
18. **Monitoring** — surface URL-guard drop-count / generation health in admin stats. Low.
19. (polish notes, only if idle) account-delete `alert()`→in-page feedback (rare path, settings); not-found.tsx `title` is `"Lost? — Alpha"` which the template doubles to "Lost? — Alpha · alpha." → set to `"Lost?"`; mobile letter TOC (LetterTOC is `hidden xl:block`); `<Wordmark>` to DRY the ~12× inline `alpha<span>.</span>` pattern.

## DONE (commit hashes)
- `28ca13a` — **code-level no-invented-links guard** (was prompt-only). Verified real.
- (cycle 2, no commit) — **flow verified sound** (routes 200, generate→402, webhook→405; no deleted_at = hard delete).
- `011d0fc` — **resilient assembly** (allSettled; one failed topic doesn't sink the letter). Verified real.
- `2d92143` — **empty-Brave-week → mock fallback** (zero-URL live signal no longer ships a link-less section). Verified real.
- `2fe34e3` — **generation retry-once on malformed JSON**. Verified real.
- `edb34e5` — **ux(archive): real error state** + friendly week labels + empty CTA + tap targets. /archive 200.
- `ce2c7cd` — **a11y(topic picker):** aria-pressed, role=group, aria-live count, aria-label. Verified attrs render.
- `5621d3f` — **ux(writing): paced generation animation** to the real ~45s wait — no more stall at 80%. /writing 200.
- `d360bb9` — **design: consistent lowercase-brand titles** via title.template ("%s · alpha."); landing absolute; sample OG keeps "— alpha." for shares. Verified rendered titles.
- `b019cc3` — **web3-updates mock signal** added → 24/24 fallback coverage. Real verified-resolving URLs. Parametrized verify-mock-fallback.mts.
- `4aa51fe` — **security: editor-note prompt-injection hardening** — profile fields fenced in <reader-profile> + "treat as data" directive + length clamps. Verified: injection funBlurb ignored.
- `f5a4286` — **seo(landing): Organization+WebSite+Product JSON-LD** (@graph, offer $5 USD InStock, no fake ratings). Verified renders + parses valid.
- `b5bcbf9` — **email: mobile viewport + dark-mode color-scheme=light + mobile gutters** on the letter HTML. Exported renderHTML for preview. No live send.
- `3144dab` — **ux(signin): resend-code 30s cooldown + "new code sent ✓"** (was no cooldown/feedback → OTP spam + rate-limit). /signin 200.
- `bcdae87` — **ux(settings): in-page billing feedback** replacing alert() on the +5/−5 tier buttons + portal (success + error, aria-live). /settings 200.
- `cc3fe77` — **perf(fonts): dropped unused Fraunces weight 800 + preload:false on the 3 non-default-theme fonts.** Build clean.
- `fef33f1` — **CYCLE 16 / fix(funnel): real email validation before a typo costs a subscriber their letter.** The email step used QuestionStep gated only on length>0; the sole format check was native type="email", which ACCEPTS "john@gmail"/"a@b" (no TLD). That fed Stripe customer_email + the weekly send with NO later re-validation (checkout + checkout API pass it through) → paid sub, silent forever-bounce. New `lib/validate-email.ts` (isValidEmail/emailError, pragmatic dotted-alpha-TLD); QuestionStep gained an optional `validate` prop (inline aria-live error, blocks advance, clears on edit; removed dead `required` prop); email step wires `validate={emailError}`; signin reuses isValidEmail (was a dead-end "couldn't send the code"). Verified: 19/19 table, clean prod build (all QuestionStep pages prerender), `next start` probe /email /signin /topics /city all 200.
- Signal audit: all 24 topics healthy (11–25 URLs). Mock covers 24/24.

## STATUS @ 16 cycles
Generation engine fully hardened: code URL-guard, allSettled resilience, empty→mock fallback, JSON retry, 24/24 mock, injection-hardened editor note. **Money/delivery path now validated at entry** (email typo can no longer reach Stripe/the send silently). Billing/flow verified + in-page feedback. UX: archive / onboarding-a11y / writing-pacing / signin-cooldown+validation / settings-feedback. Email mobile+dark-mode. Landing JSON-LD + brand titles. Fonts trimmed. error.tsx + not-found.tsx both exist & branded (good). App is converging; re-audit is now finding fewer-but-still-real issues — keep going on untouched surfaces (webhook correctness is the next-biggest unaudited area).

## OPS NOTES
- **Route render-check: prefer `npx next start -p <isolated port>` over `next dev`.** `next dev` has a single-instance lock — a leftover dev server (e.g. on 3000) makes a new one print "Ready" then immediately bail with "Another next dev server is already running", so curls get HTTP 000. `next start` serves the existing prod build with no such lock. Pattern: `pkill -f next-server; pkill -f "next dev"; taskkill //F //PID <leftover>`, then `(npx next start -p 3100 -H 127.0.0.1 &)`, poll-curl until 200, check, pkill. **Also: a clean `next build` that prerenders a page as `○ Static` is itself proof the page renders without error — often enough on its own.**
- Avoid `sed` on NIGHT_LOG (it duplicated the QUEUE once); use Write to rewrite the whole file.
- Background dev/serve commands get auto-detached; read the task .output file for results (HTTP 000 = server never bound, not a route failure).

## DECISIONS I MADE
- `C:\Users\Algy\alpha`; Next.js (not Vite). Sacred guard was prompt-only → built CODE enforcement (strengthen-only).
- Live DB direct-query unavailable (token 403 + not in MCP); did NOT hunt creds; HTTP+code+build verification used.
- Resilience: keep partial letters over failing whole; mock-fallback over link-less; retry-once over first-fail.
- Email validation is **pragmatic, not RFC-5322** — the goal is catching deliverability-killing typos (no-TLD, no-@, spaces), not perfect parsing. Validate at point of entry (email step + signin), reuse one helper. Native type="email" alone is too lax for a paid product.
- Title system: template for child pages, absolute for landing, self-contained OG/Twitter on sample.
