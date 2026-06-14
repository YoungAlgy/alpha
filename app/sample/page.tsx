import type { Metadata } from "next";
import Link from "next/link";
import { Digest } from "@/components/Digest";
import { Footer } from "@/components/Footer";
import { ShareButton } from "@/components/ShareButton";
import { SAMPLE_ISSUE } from "@/lib/sample-issue";

// Public, indexable sample issue — the trust asset for a pay-before-you-see-it
// product. Rendered through the exact same <Digest> the real letters use, so
// what a visitor sees here is what they'd get. Linked from the landing page and
// every marketing channel.
export const metadata: Metadata = {
  title: "A sample issue",
  description:
    "See what a Sunday letter from alpha. looks like. A personal weekly letter on the five topics you care about. Sourced, edited, and worth your time.",
  alternates: { canonical: "https://youngalgy.com/alpha/sample" },
  openGraph: {
    title: "A sample issue | alpha.",
    description:
      "See what a Sunday letter from alpha. looks like before you sign up.",
    url: "https://youngalgy.com/alpha/sample",
    type: "article",
    images: ["/alpha/og-image.png"],
  },
  // Sample-specific Twitter card too — otherwise X falls back to the layout's
  // generic title/description. Shares are a channel now (the ShareButton), so
  // the preview should match the sample everywhere.
  twitter: {
    card: "summary_large_image",
    title: "A sample issue | alpha.",
    description:
      "See what a Sunday letter from alpha. looks like before you sign up.",
    images: ["/alpha/og-image.png"],
  },
};

export default function SamplePage() {
  return (
    <main className="flex-1">
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
            alpha<span style={{ color: "var(--accent)" }}>.</span>
          </Link>
          <Link
            href="/welcome"
            className="alpha-button text-sm"
          >
            Start your letter →
          </Link>
        </div>
        <div
          className="max-w-5xl mx-auto px-6 pb-3 alpha-mono text-center"
          style={{ color: "var(--accent-ink)" }}
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
            Want one of these every Sunday?
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
              url="https://youngalgy.com/alpha/sample"
              title="alpha. a sample issue"
              text="A weekly letter on the five topics you care about. Here's a sample:"
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
