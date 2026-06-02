# NIGHT_LOG — Alpha overnight autonomous run (started 2026-06-02)

Repo: `C:\Users\Algy\alpha`. Stack: **Next.js** App Router. Live: youngalgy.com/alpha. Start HEAD: `2b417bb`.
Real-generation harnesses (reuse to verify any generation/letter change):
- `npx tsx scripts/verify-url-guard.mts [topic]` — runs Brave+Claude, asserts the URL guard holds.
- `npx tsx scripts/audit-topic-signal.mts` — Brave-only signal-strength sweep across all topics.
- `npx tsx scripts/verify-resilient-assemble.mts` — forces a partial topic failure, asserts the letter still ships.
(scripts/ is excluded from tsconfig so tsx-only `.ts` import extensions don't break the Next build.)

---

## QUEUE (ranked, living)
1. ✅ DONE — code-level real-URL guard.
2. ✅ DONE (verify only) — signup→pay→first-letter flow verified sound.
3. ✅ DONE — resilient assembly (allSettled).
4. **[next] Generation reliability edges** — (a) empty-signal topic: `resolveTopicSignal` falls back to mock; confirm a real "no Brave results" path doesn't yield an all-links-dropped section now that the guard is strict; (b) `extractJson` malformed-JSON path — wrap with a clearer error/retry-once. Verify with harness.
5. **UX: archive of past letters** (`/archive`) — empty/loading/error states; mobile touch targets.
6. **UX: onboarding topic picker** — touch targets, mobile, a11y (the key conversion moment).
7. **Reading experience / skeletons** during generation; mobile viewport.
8. **Design consistency** — Forest chrome, lowercase `alpha.` wordmark, spacing/hierarchy/a11y across surfaces.
9. **SEO/landing** — CWV/Lighthouse; headers already set.
10. **Security re-spot-check** — RLS, webhook tamper, prompt-injection via topic selections.
11. (new) **Monitoring** — the guard logs dropped URLs; consider surfacing a per-generation drop count in the admin stats panel so hallucination rate is visible. Low priority.

## DONE (commit hashes)
- `28ca13a` — **code-level no-invented-links guard** (was prompt-only). url-guard.ts + topic-blurb wired. Verified real: ai-news 18-URL signal, 0 violations, negative test PASS, links resolve.
- (cycle 2, no commit) — **flow verified sound:** routes 200, unpaid generate→402, webhook GET→405. No `deleted_at` in schema (hard-cascade delete; soft-delete rule N/A). Live DB spot-check skipped — cached Mgmt token 403s now + alpha not in Supabase MCP; verified at HTTP+code layer instead.
- `011d0fc` — **resilient assembly:** Promise.all→allSettled so one failed topic doesn't sink the whole letter; editor-note fallback intro. Verified real: 2 valid + 1 invalid topic → letter shipped with 2 sections.
- Signal audit: all 24 topics healthy (11–25 real URLs each, none thin) — no query-set fix needed.

## DECISIONS I MADE
- `C:\Users\Algy\alpha` (not Algernon — migrated). Stack Next.js (not Vite).
- Sacred guard was PROMPT-ONLY → built CODE enforcement (strengthening, allowed; STOP only forbids weakening).
- Live DB direct-query unavailable this run (token 403 + not in MCP). Did NOT hunt for creds (out of bounds). HTTP+code verification deemed sufficient for the flow.
- Generation resilience: keep partial letters (some sections) over failing the whole; only fail if ALL topics fail.
