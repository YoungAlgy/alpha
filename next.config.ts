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
  // paid product handling auth sessions. (No CSP yet — Next's inline runtime
  // scripts make a strict CSP fiddly; revisit if we add nonce support.)
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
        ],
      },
    ];
  },
};

export default nextConfig;
