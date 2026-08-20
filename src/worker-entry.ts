// Cloudflare Worker entry point, wrapping OpenNext's generated handler.
//
// Replaces the deleted proxy.ts — Next 16's Proxy convention can't run under
// OpenNext Cloudflare at all ("Node.js middleware is not currently
// supported"), so this logic moved one layer below Next, applying to every
// request before Next/Supabase ever see it. See git history on proxy.ts for
// the original comments this is ported from.
//
// Two jobs carried over unchanged:
//   1. CSRF defense on 9 state-changing endpoints (alpha-drift-r26-07,
//      2026-08-14: this said "8" -- stale since /api/generate was added to
//      lib/csrf-guard.ts's CSRF_GUARDED_SUFFIXES in a later review pass.
//      That array is the actual source of truth; count it directly rather
//      than trusting this comment if the two ever drift again) — this is NOT redundant
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

// CSRF defense on 9 state-changing endpoints — see lib/csrf-guard.ts for the
// guard logic itself and why it lives there instead of here (short version:
// testability — this file's own top-level import above pulls in the built
// Workers bundle, which a plain node/tsx script can't load).
export { isCsrfGuarded, blocksCsrf } from '../lib/csrf-guard'
import { blocksCsrf } from '../lib/csrf-guard'

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
      // decodeURIComponent throws on malformed percent-encoding (e.g. a bare
      // '%'), and this runs on every cookie in the header for every
      // non-static request — an unrelated bad cookie (analytics, stale from
      // a prior app version, or a crafted probe) must not 500 the whole
      // Worker. Fall back to the raw value, matching the 'cookie' npm
      // package's parse() behavior.
      let decoded = value
      try {
        decoded = decodeURIComponent(value)
      } catch {
        // keep raw value
      }
      return { name, value: decoded }
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
      // A blocked request never reaches the route it targeted, so that
      // route's own logging never runs -- without this, a false-positive
      // block (a future frontend regression away from a same-origin fetch, a
      // proxy/CDN header quirk) would silently 403 real requests with zero
      // signal anywhere; the first sign would be a customer complaint. Found
      // in review 2026-08-06, right after /api/generate was added to the
      // guarded list.
      console.warn(
        `[csrf-guard] blocked ${request.method} ${url.pathname} (sec-fetch-site=${request.headers.get('sec-fetch-site')})`,
      )
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
    let refreshedCookies: { name: string; value: string }[] = []
    const incomingCookies = parseCookieHeader(request.headers.get('cookie'))
    if (!isStaticAsset && supabaseUrl && supabaseKey) {
      const supabase = createServerClient(supabaseUrl, supabaseKey, {
        // @supabase/ssr's own default cookie options carry no `secure` key —
        // matching lib/supabase/server.ts and lib/supabase/client.ts's own
        // explicit override for this app's session cookie. serializeCookie
        // above only appends `Secure` when options.secure is truthy, so
        // without this every Set-Cookie this Worker layer issues silently
        // omits it.
        cookieOptions: { secure: true },
        cookies: {
          getAll: () => incomingCookies,
          setAll: (cookiesToSet) => {
            setCookieHeaders = cookiesToSet.map(({ name, value, options }) =>
              serializeCookie(name, value, options),
            )
            refreshedCookies = cookiesToSet.map(({ name, value }) => ({ name, value }))
          },
        },
      })
      // Refresh the session if it exists — this is the whole job; nothing
      // downstream needs the resolved user, just the refreshed cookie.
      await supabase.auth.getUser()
    }

    // Merge any just-refreshed cookie(s) into the REQUEST before it reaches
    // Next -- every app/api/* route instantiates its OWN Supabase client via
    // lib/supabase/server.ts, reading cookies from this same request object.
    // Without this, that layer's client reads the ORIGINAL, now-stale
    // cookie (this Worker layer's client already consumed/rotated the
    // refresh token by this point), racing to refresh it AGAIN independently
    // -- Supabase's own maintainers call this out by name ("random logouts,
    // early session termination or increased token refresh requests," the
    // exact warning @supabase/ssr logs when setAll is missing/misused).
    // Supabase's official Next.js middleware reference does the equivalent
    // (`request.cookies.set(...)`) for this exact reason. Found in review
    // 2026-08-06; deliberately not touched in the same round that already
    // modified this file's cookie handling (the secure:true fix above) --
    // done as its own separately-tested change.
    let downstreamRequest = request
    if (refreshedCookies.length > 0) {
      const merged = new Map(incomingCookies.map((c) => [c.name, c.value]))
      for (const { name, value } of refreshedCookies) merged.set(name, value)
      const cookieHeader = Array.from(merged.entries())
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('; ')
      const headers = new Headers(request.headers)
      headers.set('cookie', cookieHeader)
      downstreamRequest = new Request(request, { headers })
    }

    const response: Response = await openNextWorker.fetch(downstreamRequest, env, ctx)

    // alpha-drift-r16-07 (found+fixed 2026-08-07): /letter server-renders
    // real subscriber PII (name, city, editor's note, full letter body)
    // keyed solely by a signed token in ?t=, no session required -- the
    // exact traffic pattern email security gateways (Defender Safe Links,
    // Proofpoint, Mimecast) auto-fetch on every subscriber's behalf. It
    // already sets dynamic="force-dynamic" and enforces hasActiveAccess(),
    // but next.config.ts's headers() rule for this path was tried FIRST and
    // found insufficient: Next's own dynamic-page rendering sets its own
    // default `Cache-Control: no-cache, must-revalidate` on the response
    // AFTER next.config.ts's rule would apply, silently winning over the
    // stricter `no-store` this route actually needs (confirmed live via
    // curl against a local dev server). This Worker layer runs strictly
    // after Next has already built the full response, so it's the one
    // place late enough to actually override it.
    //
    // alpha-drift-r49-05 (2026-08-20, cache-header-audit -- this finding
    // never got adversarial review, a mid-round Claude session-limit outage
    // killed all 3 verify votes; personally re-verified against
    // public/_headers' own documented ASSETS-binding default and
    // next.config.ts's headers() rule before acting on it): /letter used to
    // be the ONLY route this Worker forced no-store on. Every OTHER
    // non-static-asset route -- every one of the app's ~19 statically-
    // prerendered pages (/checkout, /settings, /settings/accounts, /inbox,
    // /topics, /archive, /signin, every onboarding step...), plus
    // /inbox/[issueId], plus every /api/* route (already covered by
    // next.config.ts, harmless to repeat here) -- fell through to a generic
    // branch that appended a Set-Cookie header, whenever THIS request's
    // session happened to be due for a refresh, onto a response that still
    // carried whatever Cache-Control the underlying static asset or Next
    // render already had. public/_headers' own comment confirms the ASSETS
    // binding's default for anything outside /_next/static/* is `max-age=0,
    // must-revalidate` -- NOT no-store -- which a shared cache (a
    // corporate/ISP proxy, a misconfigured CDN rule) can legally store and
    // later replay, including whatever Set-Cookie it captured on the first
    // request: handing one subscriber's live session token to a different
    // visitor of the same path. Broadened to force no-store on every real
    // (non-static-asset) route unconditionally, not just /letter and not
    // only on the specific request that happened to rotate a cookie -- so
    // every page's caching contract is one easy invariant to reason about
    // and test, matching this exact route's own precedent above instead of
    // depending on catching the one request in many that carries a
    // Set-Cookie. This subsumes the old /letter-only branch entirely.
    if (isStaticAsset) {
      // Never ran the session-refresh block above (see its own comment), so
      // setCookieHeaders is always empty here -- nothing to merge in, and
      // the ASSETS binding's own Cache-Control (long-lived + immutable for
      // /_next/static/*, per public/_headers) is exactly right to keep.
      return response
    }

    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store, must-revalidate')
    for (const cookie of setCookieHeaders) headers.append('Set-Cookie', cookie)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
}
