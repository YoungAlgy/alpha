import type { Metadata } from "next";
import Link from "next/link";
import { Digest } from "@/components/Digest";
import { Footer } from "@/components/Footer";
import { Wordmark } from "@/components/Wordmark";
import { ShareButton } from "@/components/ShareButton";
import { SAMPLE_ISSUE } from "@/lib/sample-issue";
import { PITCH, SHARE_LEAD } from "@/lib/copy";

// Public, indexable sample issue — the trust asset for a pay-before-you-see-it
// product. Rendered through the exact same <Digest> the real letters use, so
// what a visitor sees here is what they'd get. Linked from the landing page and
// every marketing channel.
// alpha-drift-r28-03 (2026-08-15): added siteName -- this page already kept
// its own openGraph.images (so og:image itself was never lost, unlike the 5
// pages app/privacy/page.tsx's comment covers), but Next's per-page
// openGraph object still fully replaces the root layout's rather than
// merging into it, so og:site_name was silently dropped here too. Confirmed
// live: this was the only one of the 6 affected pages missing JUST
// site_name, not image+site_name both.
export const metadata: Metadata = {
  title: "A sample issue",
  description: `See what a letter from alpha. looks like. ${PITCH}`,
  alternates: { canonical: "https://alpha.everyday.report/sample" },
  openGraph: {
    title: "A sample issue | alpha.",
    description:
      "See what a letter from alpha. looks like before you sign up.",
    url: "https://alpha.everyday.report/sample",
    type: "article",
    siteName: "alpha.",
    images: ["/og-image.png"],
  },
  // Sample-specific Twitter card too — otherwise X falls back to the layout's
  // generic title/description. Shares are a channel now (the ShareButton), so
  // the preview should match the sample everywhere.
  twitter: {
    card: "summary_large_image",
    title: "A sample issue | alpha.",
    description:
      "See what a letter from alpha. looks like before you sign up.",
    images: ["/og-image.png"],
  },
};

// alpha-drift-r18-01 (found+fixed 2026-08-07): the homepage has a full
// Organization+WebSite+Product JSON-LD graph (app/page.tsx), but /sample --
// the second-highest sitemap-priority page (0.9), already set up as
// openGraph.type: "article" -- had none at all. No datePublished/
// dateModified: SAMPLE_ISSUE.weekOf is a hand-authored placeholder string
// ("A SAMPLE ISSUE"), not a real date, and this file's own header comment
// says to keep it evergreen -- fabricating a date here would be the exact
// mistake app/sitemap.ts already deliberately avoids by omitting
// lastModified rather than faking `new Date()`.
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "A sample issue from alpha.",
  description: `See what a letter from alpha. looks like. ${PITCH}`,
  url: "https://alpha.everyday.report/sample",
  author: { "@type": "Organization", name: "alpha.", url: "https://alpha.everyday.report" },
  publisher: {
    "@type": "Organization",
    name: "alpha.",
    url: "https://alpha.everyday.report",
    logo: "https://alpha.everyday.report/icon-512.png",
  },
  isPartOf: { "@type": "WebSite", name: "alpha.", url: "https://alpha.everyday.report" },
};

export default function SamplePage() {
  return (
    <main className="flex-1">
      <script
        type="application/ld+json"
        // Static, app-controlled object — no user input. Standard Next JSON-LD pattern.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      {/* Top ribbon — honest framing + a way back to the pitch */}
      <div
        className="w-full border-b"
        style={{ background: "var(--paper)", borderColor: "var(--rule)" }}
      >
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            href="/"
            className="alpha-display text-xl font-bold leading-none"
            style={{ color: "var(--ink)" }}
          >
            <Wordmark />
          </Link>
          <Link
            href="/welcome"
            className="alpha-button text-sm"
          >
            Start your letter →
          </Link>
        </div>
        {/* alpha-drift-r25-04: --accent-ink fails WCAG AA 4.5:1 vs --paper in most
        themes; this banner is plain informational text, so it needs --ink-soft
        (passes 4.5:1 in all 26 themes), not --accent-ink. */}
        <div
          className="max-w-5xl mx-auto px-6 pb-3 alpha-mono text-center"
          style={{ color: "var(--ink-soft)" }}
        >
          A SAMPLE · YOUR REAL LETTERS ARE BUILT AROUND YOUR FIVE TOPICS
        </div>
      </div>

      <Digest issue={SAMPLE_ISSUE} />

      {/* Conversion footer — the whole point of the page */}
      <div
        className="border-t"
        style={{ borderColor: "var(--rule)", background: "var(--paper-deep)" }}
      >
        <div className="max-w-2xl mx-auto px-6 py-16 md:py-20 text-center space-y-6">
          <h2 className="alpha-display text-3xl md:text-4xl font-bold tracking-tight">
            Want one of these every day?
          </h2>
          <p
            className="alpha-display text-lg md:text-xl leading-relaxed max-w-lg mx-auto"
            style={{ color: "var(--ink-soft)" }}
          >
            Pick your five topics and we&apos;ll build a letter just for you.
            $5 a month, cancel anytime, no ads.
          </p>
          <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/welcome" className="alpha-button alpha-button-accent text-base">
              Start your letter →
            </Link>
            <ShareButton
              context="sample"
              url="https://alpha.everyday.report/sample"
              title="alpha. a sample issue"
              text={`${SHARE_LEAD} Here's a sample:`}
              label="Share this sample"
              className="alpha-ui text-base underline underline-offset-4"
              style={{ color: "var(--accent-ink)" }}
            />
          </div>
        </div>
      </div>
      <Footer />
    </main>
  );
}
