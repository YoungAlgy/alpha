import type { MetadataRoute } from "next";

const BASE = "https://alpha.everyday.report";

// /privacy and /terms carry a real, tracked effectiveDate (LegalLayout,
// "May 13, 2026" as of this writing) -- reuse it here instead of `new Date()`
// so the sitemap doesn't claim every route changed today on every build. The
// other routes have no tracked last-modified date, so lastModified is
// omitted for them entirely (optional field) rather than faked.
const LEGAL_EFFECTIVE_DATE = new Date("2026-05-13");

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: BASE,
      changeFrequency: "monthly",
      priority: 1.0,
    },
    {
      url: `${BASE}/sample`,
      changeFrequency: "monthly",
      priority: 0.9,
    },
    {
      url: `${BASE}/welcome`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE}/signin`,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE}/privacy`,
      lastModified: LEGAL_EFFECTIVE_DATE,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${BASE}/terms`,
      lastModified: LEGAL_EFFECTIVE_DATE,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${BASE}/support`,
      changeFrequency: "monthly",
      priority: 0.4,
    },
  ];
}
