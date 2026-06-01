import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/alpha", "/alpha/sample", "/alpha/welcome", "/alpha/privacy", "/alpha/terms", "/alpha/support", "/alpha/signin"],
        disallow: [
          "/alpha/inbox",
          "/alpha/archive",
          "/alpha/settings",
          "/alpha/writing",
          "/alpha/checkout",
          "/alpha/name",
          "/alpha/city",
          "/alpha/role",
          "/alpha/focus",
          "/alpha/topics",
          "/alpha/theme",
          "/alpha/fun",
          "/alpha/email",
          "/alpha/api/",
          "/alpha/auth/",
        ],
      },
    ],
    sitemap: "https://youngalgy.com/alpha/sitemap.xml",
  };
}
