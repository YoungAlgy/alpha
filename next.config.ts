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
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" }, // clickjacking
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
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
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.google.com https://*.gstatic.com; font-src 'self'; connect-src 'self' https://xpqxhdciaoicsnyyfshy.supabase.co https://us.i.posthog.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
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
    ];
  },
};

export default nextConfig;
