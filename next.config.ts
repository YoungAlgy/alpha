import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  // No basePath: the app lives at the ROOT of its own domain,
  // alpha.everyday.report. It previously carried basePath "/alpha" from its
  // life as youngalgy.com/alpha; that hub now 308-redirects /alpha/* here.
  //
  // CORRECTION (2026-08-05): this comment used to claim youngalgy.com still
  // PROXIES /alpha/api/* so old emailed unsubscribe / one-click
  // List-Unsubscribe-Post links "keep working forever". Verified false: the
  // youngalgy.com Vercel project this pointed at is gone (404 on every path),
  // and the live youngalgy.com (now on Cloudflare) 301-redirects /alpha/api/*
  // here instead of proxying it — a 301 that mail providers' one-click
  // List-Unsubscribe-Post agents don't follow (per the very justification
  // this comment used to give), and that would downgrade POST->GET even if
  // they did. Any letter sent before the 2026-07-03 domain move carries a
  // youngalgy.com/alpha/api/unsubscribe URL that can no longer be unsubscribed
  // one-click -- a real deliverability/compliance gap. The actual fix belongs
  // in youngalgy's live redirect config (point that one path at
  // alpha.everyday.report instead of 301-ing it), not here.
  reactStrictMode: true,
  async redirects() {
    return [
      // The apex/www -> alpha.everyday.report host redirect lives in
      // middleware.ts now, not here -- see that file's comment for why.
      // Safety net for any straggler still carrying the old /alpha prefix
      // (an old bookmark that reached this host directly, a hardcoded link).
      // Bare /alpha needs its own rule: with zero segments the :path* rule
      // renders an empty destination (blank Location header under next start).
      { source: "/alpha", destination: "/", permanent: true },
      { source: "/alpha/:path*", destination: "/:path*", permanent: true },
    ];
  },
  // Baseline security headers on every response. Cheap defense-in-depth for a
  // paid product handling auth sessions.
  async headers() {
    // Every OTHER Supabase call site in the app (lib/supabase/client.ts,
    // lib/supabase/server.ts, components/ThemeApplier.tsx, lib/engine/
    // persist.ts, lib/engine/blurb-cache.ts) reads this from env -- the CSP
    // below used to hardcode the literal hostname instead. A future project-
    // ref rotation would update every env-driven call site correctly while
    // this one kept pointing at the dead old host, silently breaking every
    // client-side Supabase call (auth, theme sync, session refresh) as a
    // connect-src violation with no server-side error -- the same failure
    // class this file's own gstatic.com comment above already describes
    // being bitten by once. Fallback is today's known-good value, not a
    // functional change for the common case where the env var IS set.
    const supabaseOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://xpqxhdciaoicsnyyfshy.supabase.co";
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" }, // clickjacking
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          // alpha-drift-r31-01 (2026-08-14): every OTHER header in this list
          // exists as defense-in-depth for a threat class that isn't
          // concretely exploited today (this repo-wide grep confirmed zero
          // existing HSTS anywhere -- no code-level evidence Cloudflare's
          // zone-level dashboard toggle is relied on instead, since that
          // isn't checked into this repo and can't be verified from source).
          // The app is HTTPS-only on alpha.everyday.report with no HTTP
          // fallback path, so HSTS fits the same "cheap, no functional
          // downside" rationale as the rest of this list. Deliberately no
          // `preload` directive: wrangler.jsonc's routes cover the whole
          // everyday.report apex (everyday.report/*, www.everyday.report/*,
          // alpha.everyday.report/*), and `includeSubDomains` + `preload`
          // would commit every one of those hosts to browsers' hardcoded
          // preload list -- slow and hard to reverse, needs Algy to confirm
          // every host under that apex is HTTPS-only first, not something to
          // ship unilaterally inside an audit-round fix.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            // A real CSP was previously deferred entirely ("Next's inline
            // runtime scripts make a strict CSP fiddly"). Investigated
            // properly (2026-08-06): script-src/style-src genuinely can't be
            // tightened past 'unsafe-inline' without forcing this app's 29
            // statically-prerendered routes (/, /checkout, /settings, /writing,
            // etc.) into per-request dynamic rendering just to get a fresh
            // nonce on every load -- Next's own nonce mechanism only reads a
            // nonce from the REQUEST headers at render time, which a
            // statically-cached page never has. That's a real latency/cost
            // regression on a Workers deployment already tight against
            // free-tier limits, not worth it for this app's threat model.
            // But most CSP directives don't touch that problem at all and
            // cost nothing to ship: this locks down every OTHER real attack
            // class (cross-origin form hijack, base-tag injection,
            // clickjacking, object/embed injection, protocol downgrade)
            // while leaving script-src/style-src open on purpose, not
            // silently. connect-src covers Supabase (the only client-side
            // fetch target, confirmed via repo-wide grep) and PostHog's
            // default ingestion host (inert today -- NEXT_PUBLIC_POSTHOG_KEY
            // is unset -- but the code path exists). img-src covers Google's
            // favicon service (components/Digest.tsx's per-source favicons)
            // alongside 'self' and data: (inline SVGs/placeholders).
            //
            // CAUGHT LIVE (2026-08-06): www.google.com/s2/favicons doesn't
            // serve the icon itself -- it 301s to a sharded
            // tN.gstatic.com/faviconV2 host (confirmed via curl -IL; shard
            // number varies by request, seen t2 so far). CSP checks BOTH the
            // original AND the final redirect-target origin against the
            // source list, so without *.gstatic.com here every favicon in
            // every letter would have silently 404'd under this policy --
            // caught by actually loading a real <img> in a browser and
            // watching for a securitypolicyviolation event, not just by
            // reading Digest.tsx's fetch URL.
            //
            // CAUGHT LIVE (2026-08-13): Cloudflare auto-injects a
            // <script src="static.cloudflareinsights.com/beacon.min.js">
            // into every response for this zone (Web Analytics is on in the
            // dashboard) -- this CSP has been silently blocking it since the
            // day it shipped, confirmed via zero network requests ever
            // reaching that host despite the tag being present in the DOM.
            // No console error was visible through one check method (a
            // console.log/error listener), only through a direct
            // securitypolicyviolation-style check -- same lesson as the
            // gstatic redirect above: verify CSP changes against real
            // network activity, not just the console. script-src covers
            // the beacon load.
            //
            // alpha-drift-r34-03 (2026-08-14): the line above ORIGINALLY
            // also said "connect-src covers the RUM data it POSTs back to
            // cloudflareinsights.com after loading" -- re-checked live via
            // real Chrome network capture and that's not what actually
            // happens. The beacon posts its RUM data to THIS origin's own
            // /cdn-cgi/rum (a same-origin path Cloudflare intercepts at the
            // edge), not to the bare cloudflareinsights.com host -- already
            // covered by 'self', so the explicit connect-src allowance
            // below was dead config, silently widening the policy for
            // nothing. Removed.
            //
            // alpha-drift-r24-04 (2026-08-14): added worker-src explicitly.
            // public/sw.js (the offline service worker, shipped 2026-08-13)
            // had been registering under the CSP3 script-src fallback only --
            // works today since 'self' covers same-origin /sw.js, but was
            // never a deliberate policy decision (the SW landed the morning
            // after this CSP was last touched). No blob:/other Worker usage
            // exists anywhere in the codebase, so 'self' alone is sufficient.
            key: "Content-Security-Policy",
            value:
              `default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.google.com https://*.gstatic.com; font-src 'self'; connect-src 'self' ${supabaseOrigin} https://us.i.posthog.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`,
          },
        ],
      },
      {
        // API routes can carry per-user PII (admin/users, account/export) or
        // drive real state changes. Route Handler dynamic execution keeps
        // them out of NEXT's own cache, but that says nothing about a
        // browser, a corporate/ISP proxy, or a future Cloudflare cache rule
        // storing a copy. /api/health sets its own explicit Cache-Control
        // already -- this merges in harmlessly there.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
      },
      {
        // alpha-drift-r16-07 (found+fixed 2026-08-07): /letter is the ONE
        // page route (not under /api/) that server-renders real subscriber
        // PII -- name, city, editor's note, full letter body -- keyed
        // solely by a signed token in ?t=, with no session/cookie required.
        // It already sets `dynamic = "force-dynamic"` and enforces
        // hasActiveAccess(), but dynamic rendering alone says nothing about
        // caching, exactly the gap /api/health's own comment already
        // documents learning once on this same OpenNext/Cloudflare stack.
        // This is also the one route email security gateways (Defender Safe
        // Links, Proofpoint, Mimecast) auto-fetch on every subscriber's
        // behalf (see app/api/unsubscribe/route.ts's own comment) -- exactly
        // the traffic pattern that would prime a caching intermediary.
        source: "/letter",
        headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
      },
    ];
  },
  // alpha-drift-r30-02 (2026-08-14): components/Footer.tsx used to seed its
  // copyright year via `useState(() => new Date().getFullYear())`, on the
  // belief that a useState lazy initializer "freezes" the value from the
  // server render. It doesn't -- the initializer function re-executes fresh
  // on the CLIENT'S OWN hydration render too, so the statically-prerendered
  // HTML (baked at build time) and the client's hydration pass (evaluated
  // against the visitor's live clock) only agreed within the same calendar
  // year, producing a real hydration text mismatch on 8+ static pages the
  // moment a page is visited after a Dec-to-Jan rollover with no fresh
  // deploy since. Next's `env` config is the one mechanism that actually
  // freezes a value identically into BOTH the server-prerendered output and
  // the client bundle -- it's a compile-time literal substitution, not a
  // runtime read, so `process.env.NEXT_PUBLIC_BUILD_YEAR` resolves to the
  // exact same string wherever the bundle runs. Computed once per `next
  // build` invocation, no manual Algy step needed.
  env: {
    NEXT_PUBLIC_BUILD_YEAR: String(new Date().getFullYear()),
  },
};

export default nextConfig;
