# NIGHT_LOG — Alpha overnight autonomous run (started 2026-06-02)

Repo: `C:\Users\Algy\alpha`. Stack: **Next.js** App Router. Live: youngalgy.com/alpha. Start HEAD: `2b417bb`.
Real-generation harnesses (reuse to verify any generation/letter change; scripts/ excluded from tsconfig):
- `npx tsx scripts/verify-url-guard.mts [topic]` — Brave+Claude, asserts URL guard holds + links resolve.
- `npx tsx scripts/audit-topic-signal.mts` — Brave-only signal-strength sweep across all topics.
- `npx tsx scripts/verify-resilient-assemble.mts` — forces a partial topic failure, asserts letter still ships.
- `npx tsx scripts/verify-mock-fallback.mts` — Brave-disabled, asserts mock fallback yields guard-passing links.

---

## QUEUE (ranked, living)
1-7. ✅ DONE (see below).
8. **[next] Design consistency** — sweep all surfaces for Forest chrome + lowercase `alpha.` wordmark consistency, spacing/hierarchy, a11y (heading order, contrast, focus states). Candidates: landing, signin, settings, support, checkout, 404. Pick the highest-impact inconsistency and fix.
9. **SEO/landing** — CWV/Lighthouse; headers already set.
10. **Security re-spot-check** — RLS, webhook tamper, prompt-injection via topic selections.
11. **web3-updates mock signal** — only topic without a mock entry; add one.
12. **Monitoring** — surface guard drop-count / generation health in admin stats. Low.
13. (note) Consider a mobile section-nav for the letter (LetterTOC is desktop-only `hidden xl:block`); debatable value for a linear letter — left for later.
7. **Reading experience / skeletons** during generation; mobile viewport on /inbox + letter.
8. **Design consistency** — Forest chrome, lowercase `alpha.` wordmark, spacing/hierarchy/a11y across surfaces.
9. **SEO/landing** — CWV/Lighthouse; headers already set.
10. **Security re-spot-check** — RLS, webhook tamper, prompt-injection via topic selections.
11. **web3-updates mock signal** — only topic without a mock entry; add one (real, stable web3 URLs) so it has a fallback in an empty-Brave week. Low-med.
12. **Monitoring** — surface guard drop-count / generation health in admin stats. Low.

## DONE (commit hashes)
- `28ca13a` — **code-level no-invented-links guard** (was prompt-only). Verified real.
- (cycle 2, no commit) — **flow verified sound** (routes 200, generate→402, webhook→405; no deleted_at = hard delete).
- `011d0fc` — **resilient assembly** (allSettled; one failed topic doesn't sink the letter). Verified real.
- `2d92143` — **empty-Brave-week → mock fallback** (zero-URL live signal no longer ships a link-less section). Verified real.
- `2fe34e3` — **generation retry-once on malformed JSON**. Verified real.
- `edb34e5` — **ux(archive): real error state** (was masking DB errors as "no letters"), friendly week labels, empty-state CTA, bigger tap targets. tsc+build clean, /archive 200.
- `ce2c7cd` — **a11y(topic picker):** aria-pressed on toggles, role=group, aria-live count, aria-label. Verified attrs render. Keyboard already worked; touch targets fine.
- `5621d3f` — **ux(writing): paced generation animation** to the real ~45s wait (steps scale to chosen topics, ~6s cadence) — no more stall at "Almost there"/80%. tsc+build clean, /writing 200.
- Signal audit: all 24 topics healthy (11–25 URLs). Mock covers 23/24 (missing web3-updates).

## OPS NOTES
- Dev-server port detection flaky across cycles (leftover `next dev`/`next-server` procs hold 3000/3001). Before a dev render check: `pkill -f "next dev"; pkill -f "next-server"` then curl BOTH 3000 and 3001 to find the live one. Always pkill after.

## DECISIONS I MADE
- `C:\Users\Algy\alpha`; Next.js (not Vite). Sacred guard was prompt-only → built CODE enforcement (strengthen-only).
- Live DB direct-query unavailable (token 403 + not in MCP); did NOT hunt creds; HTTP+code verification used.
- Resilience philosophy: keep partial letters over failing whole; fall back to mock over shipping link-less; retry-once over first-fail giving up.
- libuv `async.c` assertion at tsx script exit = harmless Windows teardown noise, not a failure.
