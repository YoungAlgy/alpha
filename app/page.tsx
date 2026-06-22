import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/Footer";

// The landing page for cold traffic. A deliberately minimal hero — the pitch
// plus the CTA into /welcome (the onboarding flow) and a sample link. Sits in
// FRONT of the funnel; warm visitors are one click from starting. Static +
// indexable (this is the SEO/share surface).
export const metadata: Metadata = {
  title: { absolute: "alpha. your alpha" },
  description:
    "A personal letter on the five topics you care about. Sourced and edited so it's worth your time. Three times a week.",
  alternates: { canonical: "https://youngalgy.com/alpha" },
};

// Structured data for richer search results. Static + app-controlled (no user
// input → safe to inline). Every claim is true: $5/mo, USD, in stock. No
// aggregateRating/reviewCount — we won't fabricate social proof.
const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://youngalgy.com/alpha#org",
      name: "alpha.",
      url: "https://youngalgy.com/alpha",
      logo: "https://youngalgy.com/alpha/icon-512.png",
      email: "youngalgy@gmail.com",
    },
    {
      "@type": "WebSite",
      "@id": "https://youngalgy.com/alpha#website",
      name: "alpha.",
      url: "https://youngalgy.com/alpha",
      publisher: { "@id": "https://youngalgy.com/alpha#org" },
    },
    {
      "@type": "Product",
      name: "alpha. A personal letter",
      description:
        "A personal letter on the five topics you choose, sourced and edited so it's worth your time. Three times a week.",
      brand: { "@id": "https://youngalgy.com/alpha#org" },
      url: "https://youngalgy.com/alpha",
      offers: {
        "@type": "Offer",
        price: "5.00",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
        url: "https://youngalgy.com/alpha",
      },
    },
  ],
};

export default function Landing() {
  return (
    <main className="min-h-screen flex flex-col">
      <script
        type="application/ld+json"
        // Static, app-controlled object — no user input. Standard Next JSON-LD pattern.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      {/* Nav */}
      <nav className="px-6 py-6 max-w-5xl mx-auto w-full flex items-center justify-between">
        <span
          className="alpha-display text-2xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          alpha<span style={{ color: "var(--accent)" }}>.</span>
        </span>
        <Link
          href="/signin"
          className="alpha-ui text-sm"
          style={{ color: "var(--ink-soft)" }}
        >
          Sign in →
        </Link>
      </nav>

      {/* Hero — the whole landing now. Grow to fill the space between the nav
          and the footer and center it, with the α watermark behind it. */}
      <section className="relative flex-1 flex items-center justify-center px-6 py-16 overflow-hidden">
        <span
          aria-hidden
          className="alpha-watermark"
          style={{ top: "50%", left: "50%", transform: "translate(-50%, -50%)" }}
        >
          α
        </span>
        <div className="relative z-10 max-w-2xl mx-auto text-center space-y-8">
          <h1 className="alpha-display alpha-hero text-5xl md:text-7xl font-bold tracking-tight leading-[1.05]">
            Your{" "}
            <em style={{ color: "var(--accent-ink)", fontStyle: "italic" }}>
              alpha.
            </em>
          </h1>
          <p
            className="alpha-display text-xl md:text-2xl leading-relaxed max-w-xl mx-auto"
            style={{ color: "var(--ink-soft)" }}
          >
            A personal letter on the five topics you care about. Sourced,
            edited, and worth your time. Three times a week.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-2">
            <Link href="/welcome" className="alpha-button alpha-button-accent text-base">
              Start your letter →
            </Link>
            <Link
              href="/sample"
              className="alpha-ui text-base underline underline-offset-4"
              style={{ color: "var(--accent-ink)" }}
            >
              See a sample first
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
