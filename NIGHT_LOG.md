# NIGHT_LOG — Alpha overnight autonomous run (started 2026-06-02)

Repo: `C:\Users\Algy\alpha`. Stack: **Next.js** App Router. Live: youngalgy.com/alpha. Start HEAD: `2b417bb`.
Real-generation harnesses (reuse to verify any generation/letter change; scripts/ excluded from tsconfig):
- `npx tsx scripts/verify-url-guard.mts [topic]` — Brave+Claude, asserts URL guard holds + links resolve.
- `npx tsx scripts/audit-topic-signal.mts` — Brave-only signal-strength sweep across all topics.
- `npx tsx scripts/verify-resilient-assemble.mts` — forces a partial topic failure, asserts letter still ships.
- `npx tsx scripts/verify-mock-fallback.mts` — Brave-disabled, asserts mock fallback yields guard-passing links.

---

## QUEUE (ranked, living)
11. **[next] SEO/landing** — CWV/Lighthouse-ish pass: image/asset weight on the landing + sample, font loading, any layout-shift, JSON-LD/structured data opportunity for the landing, meta completeness. Headers + OG already verified. Look for a concrete shippable win (e.g., add Organization/WebSite JSON-LD, or fix a perf/CLS issue).
12. **Monitoring** — surface guard drop-count / generation health in admin stats. Low.
13. (note) Mobile section-nav for the letter (desktop-only TOC) — later.
14. (note) `<Wordmark>` component to DRY the 12× inline pattern — skip unless idle.
11. **SEO/landing** — CWV/Lighthouse; headers + OG already verified.
12. **Monitoring** — surface guard drop-count / generation health in admin stats. Low.
13. (note) Mobile section-nav for the letter (LetterTOC is desktop-only `hidden xl:block`) — debatable for a linear letter; later.
14. (note) Wordmark is an identical 12× inline pattern — a `<Wordmark>` component would DRY it but it's not user-facing; skip unless idle.

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
- `b019cc3` — **web3-updates mock signal** added → 24/24 fallback coverage. Real verified-resolving URLs (dropped dead weekinethereumnews.com). Verified mock fallback + live guard both hold. Parametrized verify-mock-fallback.mts (takes topic arg).
- `4aa51fe` — **security: editor-note prompt-injection hardening** — profile fields (firstName/city/blurbs) flow into the prompt; fenced in <reader-profile> + "treat as data" directive + length clamps (defense on cron path too). Verified: injection funBlurb ignored. Re-confirmed RLS/webhook/topic-enum sound.
- Signal audit: all 24 topics healthy (11–25 URLs). Mock now covers 24/24.

## OPS NOTES
- Dev-server port flaky across cycles (leftover procs hold 3000/3001). Before a dev render: `pkill -f "next dev"; pkill -f "next-server"`, then probe both 3000 and 3001 for the 200. Always pkill after.
- Avoid `sed` on NIGHT_LOG (it duplicated the QUEUE once); use Write to rewrite the whole file.

## DECISIONS I MADE
- `C:\Users\Algy\alpha`; Next.js (not Vite). Sacred guard was prompt-only → built CODE enforcement (strengthen-only).
- Live DB direct-query unavailable (token 403 + not in MCP); did NOT hunt creds; HTTP+code verification used.
- Resilience: keep partial letters over failing whole; mock-fallback over link-less; retry-once over first-fail.
- Title system: template for child pages, absolute for landing, self-contained OG/Twitter on sample (not templated).
- libuv `async.c` assertion at tsx script exit = harmless Windows teardown noise.
