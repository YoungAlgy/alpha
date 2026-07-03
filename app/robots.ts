import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/sample", "/welcome", "/privacy", "/terms", "/support", "/signin"],
        disallow: [
          "/letter", // tokenized view-in-browser URLs — never index
          "/inbox",
          "/archive",
          "/settings",
          "/writing",
          "/checkout",
          "/name",
          "/city",
          "/role",
          "/focus",
          "/topics",
          "/theme",
          "/fun",
          "/you",
          "/email",
          "/api/",
          "/auth/",
        ],
      },
    ],
    sitemap: "https://alpha.everyday.report/sitemap.xml",
  };
}
