import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  // No basePath: the app lives at the ROOT of its own domain,
  // alpha.everyday.report. It previously carried basePath "/alpha" from its
  // life as youngalgy.com/alpha; that hub now 308-redirects /alpha/* here
  // (except /alpha/api/*, which it still PROXIES so links baked into
  // already-sent emails — unsubscribe, one-click List-Unsubscribe-Post —
  // keep working forever; those callers don't follow redirects).
  reactStrictMode: true,
  async redirects() {
    return [
      // The apex (and www) exist to be typed; the brand home is the subdomain.
      {
        source: "/:path*",
        has: [{ type: "host" as const, value: "everyday.report" }],
        destination: "https://alpha.everyday.report/:path*",
        permanent: true,
      },
      {
        source: "/:path*",
        has: [{ type: "host" as const, value: "www.everyday.report" }],
        destination: "https://alpha.everyday.report/:path*",
        permanent: true,
      },
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
