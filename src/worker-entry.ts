// Cloudflare Worker entry point, wrapping OpenNext's generated handler.
//
// Replaces the deleted proxy.ts — Next 16's Proxy convention can't run under
// OpenNext Cloudflare at all ("Node.js middleware is not currently
// supported"), so this logic moved one layer below Next, applying to every
// request before Next/Supabase ever see it. See git history on proxy.ts for
// the original comments this is ported from.
//
// Two jobs carried over unchanged:
//   1. CSRF defense on 8 state-changing endpoints — this is NOT redundant
//      with anything else. None of those routes have their own Sec-Fetch-Site
//      check, so dropping this (the way pitchroom's genuinely-redundant auth
//      gate was dropped) would be a real security regression on account
//      deletion and both Stripe endpoints.
//   2. Supabase session refresh — implemented here with plain cookie
//      parsing/serialization instead of NextResponse, since nothing
//      Next-specific is actually required by @supabase/ssr's cookie
//      interface.
//
// Deliberately NOT carried over: the signed-in-user redirect away from
// /welcome and /signin to /inbox. Both pages already do this client-side
// (per the original proxy.ts comment) — losing this server-side version
// just brings back a one-time page flash, not a functional bug.
import { createServerClient } from '@supabase/ssr'
import openNextWorker from '../.open-next/worker.js'

export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from '../.open-next/worker.js'

// CSRF defense for the state-changing, session-authed POST endpoints. A
// forged browser request — a malicious page calling fetch() to one of these
// on a logged-in reader's behalf, riding their cookie — carries Sec-Fetch-Site
// of "cross-site" or "same-site"; both are rejected. Every legitimate in-app
// call is same-ORIGIN (relative "/api/..." fetches), and server-to-server
// callers (Stripe webhook, cron) send no Sec-Fetch-Site header at all and
// aren't in this list anyway.
const CSRF_GUARDED_SUFFIXES = [
  '/api/resume',
  '/api/account/delete',
  '/api/account/profile',
  '/api/account/email/reconcile',
  '/api/account/topics',
  '/api/admin/users',
  '/api/stripe/portal',
  '/api/stripe/update-quantity',
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

export function parseCookieHeader(header: string | null): { name: string; value: string }[] {
  if (!header) return []
  return header
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=')
      const name = idx === -1 ? pair : pair.slice(0, idx)
      const value = idx === -1 ? '' : pair.slice(idx + 1)
      return { name, value: decodeURIComponent(value) }
    })
}

type CookieOptions = {
  path?: string
  domain?: string
  maxAge?: number
  expires?: Date
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'lax' | 'strict' | 'none' | boolean
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.domain) parts.push(`Domain=${options.domain}`)
  if (typeof options.maxAge === 'number') parts.push(`Max-Age=${options.maxAge}`)
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.sameSite !== undefined && options.sameSite !== false) {
    const s = options.sameSite === true ? 'strict' : options.sameSite
    parts.push(`SameSite=${s.charAt(0).toUpperCase()}${s.slice(1)}`)
  }
  return parts.join('; ')
}

export default {
  // Cloudflare's equivalent of Vercel's vercel.json cron: this fires the
  // scheduled() handler directly (NOT an HTTP call from outside), so it
  // calls the same /api/cron/weekly-send route the app already has via the
  // WORKER_SELF_REFERENCE service binding, carrying the same
  // `Authorization: Bearer ${CRON_SECRET}` header Vercel Cron used to send
  // automatically — the route's own auth check is unchanged and unaware
  // this call now originates from inside the Worker instead of Vercel's
  // infrastructure. DISARMED since 2026-08-05 — wrangler.jsonc deliberately
  // has no triggers.crons entry (it raced the GitHub Actions cron and burned
  // free-tier quota before losing that race), so this handler is dormant,
  // kept ready for a future paid-plan re-activation. See
  // alpha_cloudflare_cron_outage_2026-08-05 in Claude's memory for why it
  // sat unwired before that, and don't let this comment go stale again the
  // way that one did.
  async scheduled(controller: unknown, env: unknown, ctx: unknown): Promise<void> {
    const e = env as { WORKER_SELF_REFERENCE?: { fetch: typeof fetch }; CRON_SECRET?: string }
    if (!e.WORKER_SELF_REFERENCE || !e.CRON_SECRET) {
      // Silent by design of the surrounding try-less scheduled() contract --
      // Cloudflare records a non-throwing scheduled() as a successful run,
      // so this console.error is the ONLY signal this branch ever produces.
      // wrangler-config-guard.yml's services-binding check (added 2026-08-05)
      // exists specifically so wrangler.jsonc can't drop WORKER_SELF_REFERENCE
      // without CI catching it -- if you're reading this because a real cron
      // run silently no-op'd, check that guard didn't get bypassed or edited.
      console.error('[scheduled] missing WORKER_SELF_REFERENCE binding or CRON_SECRET, skipping cron run')
      return
    }
    const response = await e.WORKER_SELF_REFERENCE.fetch('https://alpha/api/cron/weekly-send', {
      method: 'GET',
      headers: { Authorization: `Bearer ${e.CRON_SECRET}` },
    })
    if (!response.ok) {
      console.error(`[scheduled] cron route returned ${response.status}: ${await response.text()}`)
    }
  },

  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    const url = new URL(request.url)

    if (blocksCsrf(request.method, request.headers.get('sec-fetch-site'), url.pathname)) {
      return new Response(JSON.stringify({ error: 'Cross-site request blocked.' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Supabase session refresh, only if configured (matches proxy.ts's own
    // pass-through fallback when env vars are missing) AND only for real page/
    // API routes. wrangler.jsonc's `assets.run_worker_first: true` routes
    // EVERY request through this Worker first, including every static asset
    // (/_next/static/*.js, /og-image.png, favicons) -- the old middleware.ts
    // matcher (`/((?!_next).*)`) used to exclude those, but that matcher sat
    // above Next and never protected this file, which runs below it. Without
    // this bypass, a signed-in reader loading /inbox pays one real Supabase
    // Auth network round trip (getUser() is not a local JWT decode -- see
    // @supabase/auth-js's GoTrueClient._getUser) per same-origin asset the
    // page loads, serialized in front of each one. Anonymous traffic already
    // skips the cost (no session -> AuthSessionMissingError, no fetch); this
    // just extends the same skip to authed traffic on files that can't
    // possibly need a refreshed session cookie. A dot in the last path
    // segment reliably means a static file here -- every real page/API route
    // in this app is extension-less.
    const isStaticAsset = /\.[a-zA-Z0-9]+$/.test(url.pathname)
    const e = env as Record<string, string>
    const supabaseUrl = e?.NEXT_PUBLIC_SUPABASE_URL
    const supabaseKey = e?.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || e?.NEXT_PUBLIC_SUPABASE_ANON_KEY

    let setCookieHeaders: string[] = []
    if (!isStaticAsset && supabaseUrl && supabaseKey) {
      const incomingCookies = parseCookieHeader(request.headers.get('cookie'))
      const supabase = createServerClient(supabaseUrl, supabaseKey, {
        cookies: {
          getAll: () => incomingCookies,
          setAll: (cookiesToSet) => {
            setCookieHeaders = cookiesToSet.map(({ name, value, options }) =>
              serializeCookie(name, value, options),
            )
          },
        },
      })
      // Refresh the session if it exists — this is the whole job; nothing
      // downstream needs the resolved user, just the refreshed cookie.
      await supabase.auth.getUser()
    }

    const response: Response = await openNextWorker.fetch(request, env, ctx)

    if (setCookieHeaders.length === 0) return response

    const headers = new Headers(response.headers)
    for (const cookie of setCookieHeaders) headers.append('Set-Cookie', cookie)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
}
