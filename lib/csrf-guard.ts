// CSRF defense for the state-changing, session-authed POST endpoints. A
// forged browser request — a malicious page calling fetch() to one of these
// on a logged-in reader's behalf, riding their cookie — carries Sec-Fetch-Site
// of "cross-site" or "same-site"; both are rejected. Every legitimate in-app
// call is same-ORIGIN (relative "/api/..." fetches), and server-to-server
// callers (Stripe webhook, cron) send no Sec-Fetch-Site header at all and
// aren't in this list anyway.
//
// Pulled out of src/worker-entry.ts (which stays the caller) so these two
// pure functions can be imported by a plain node/tsx script without dragging
// in worker-entry.ts's `import openNextWorker from '../.open-next/worker.js'`
// — that pulls in the built Workers bundle, which itself imports `cloudflare:`
// scheme modules that only resolve inside the actual Workers runtime, not
// plain Node. See scripts/verify-csrf-guard.mts for the behavioral test this
// split makes possible.
export const CSRF_GUARDED_SUFFIXES = [
  '/api/resume',
  '/api/account/delete',
  '/api/account/profile',
  '/api/account/email/reconcile',
  '/api/account/topics',
  '/api/admin/users',
  '/api/stripe/portal',
  '/api/stripe/update-quantity',
  // /api/generate's primary use (onboarding, gated by a Stripe checkout
  // session id) needs no cookie and was never CSRF-relevant on its own. But
  // verifyPaid() (app/api/generate/route.ts) also has a live authenticated
  // branch -- an already-subscribed reader's ambient session cookie alone
  // grants access, no session id required -- fitting this guard's own
  // criteria exactly. Found in review 2026-08-06: a forged cross-site POST
  // riding that cookie could trigger a real generation (AI spend, an extra
  // email) on a signed-in subscriber's behalf. Safe to add: the real caller
  // (app/writing/page.tsx) is a same-origin relative fetch, which blocksCsrf
  // never blocks.
  '/api/generate',
]

export function isCsrfGuarded(pathname: string): boolean {
  return CSRF_GUARDED_SUFFIXES.some((s) => pathname.endsWith(s))
}

export function blocksCsrf(method: string, secFetchSite: string | null, pathname: string): boolean {
  return (
    method === 'POST' &&
    (secFetchSite === 'cross-site' || secFetchSite === 'same-site') &&
    isCsrfGuarded(pathname)
  )
}
