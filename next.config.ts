import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/alpha",
  reactStrictMode: true,
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
