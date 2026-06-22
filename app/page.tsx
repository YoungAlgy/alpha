import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/Footer";
import { TOPICS, PARENT_TOPIC } from "@/lib/topics";

// The landing page for cold traffic. Sits in FRONT of the onboarding funnel:
// it sells (pitch, sample, price, how-it-works), then the CTA drops visitors
// into /welcome — the existing 10-step flow, which is a deliberate commitment
// device. Warm visitors are one click from starting; cold visitors get the
// context they need first. Static + indexable (this is the SEO/share surface).
export const metadata: Metadata = {
  title: { absolute: "alpha. your alpha" },
  description:
    "A personal letter on the five topics you care about. Sourced and edited so it's worth your time. Three times a week.",
  alternates: { canonical: "https://youngalgy.com/alpha" },
};

const HOW = [
  {
    n: "1",
    t: "Pick five topics",
    d: "Longevity, markets, gardening, trading cards, or your own niche thing. The five you actually want to keep up with.",
  },
  {
    n: "2",
    t: "We read the week for you",
    d: "Three times a week we pull the signal on your topics from real sources, then edit it into something you'll actually finish.",
  },
  {
    n: "3",
    t: "A letter lands, addressed to you",
    d: "Not a feed, not a firehose. One calm letter, written like a friend who happens to read everything.",
  },
];

const WHY = [
  {
    t: "No doomscroll",
    d: "You don't have to hunt across ten apps and a hundred tabs. The good stuff comes to you, three times a week.",
  },
  {
    t: "Real sources, enforced in code",
    d: "Every link in your letter comes from a real, live search that week. If a source isn't real, it can't appear. That rule is enforced in code, not vibes.",
  },
  {
    t: "Yours, and only yours",
    d: "Built around your five topics, addressed by name. No ads, no tracking-for-sale, no selling your data. Ever.",
  },
];

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

      {/* Hero */}
      <section className="relative px-6 pt-16 pb-24 md:pt-24 md:pb-32 overflow-hidden">
        <span
          aria-hidden
          className="alpha-watermark"
          style={{ top: "-14vmin", left: "50%", transform: "translateX(-50%)" }}
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

      {/* How it works */}
      <section className="px-6 py-16 md:py-20" style={{ background: "var(--paper-deep)" }}>
        <div className="max-w-4xl mx-auto">
          <div className="alpha-mono mb-10 text-center" style={{ color: "var(--accent-ink)" }}>
            HOW IT WORKS
          </div>
          <div className="grid md:grid-cols-3 gap-10 md:gap-8">
            {HOW.map((s) => (
              <div key={s.n} className="text-center md:text-left space-y-3">
                <div
                  className="alpha-display text-5xl font-bold"
                  style={{ color: "var(--accent)", opacity: 0.9 }}
                >
                  {s.n}
                </div>
                <h3 className="alpha-display text-xl font-semibold">{s.t}</h3>
                <p className="alpha-ui text-sm leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                  {s.d}
                </p>
              </div>
            ))}
          </div>
          <div className="text-center mt-12">
            <Link
              href="/sample"
              className="alpha-ui text-base underline underline-offset-4 font-semibold"
              style={{ color: "var(--accent-ink)" }}
            >
              Read a full sample issue →
            </Link>
          </div>
        </div>
      </section>

      {/* Topics breadth */}
      <section className="px-6 py-16 md:py-24">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="alpha-display text-3xl md:text-4xl font-bold tracking-tight mb-4">
            Any topic you want. You pick five.
          </h2>
          <p className="alpha-ui text-base mb-10 leading-relaxed" style={{ color: "var(--ink-soft)" }}>
            Whatever you want to stay sharp on, there&apos;s almost certainly a lane for it.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {/* Broad topics only — sub-genre chips (EDM under Music, etc.) live
                in the picker, not the marketing cloud. */}
            {TOPICS.filter((t) => !PARENT_TOPIC[t.id]).map((t) => (
              <span
                key={t.id}
                className="alpha-ui text-sm px-3 py-1.5 rounded-full"
                style={{ background: "var(--callout-bg)", color: "var(--ink)" }}
              >
                {t.emoji} {t.label}
              </span>
            ))}
            <span
              className="alpha-ui text-sm px-3 py-1.5 rounded-full"
              style={{ background: "transparent", color: "var(--accent-ink)", border: "1.5px solid var(--accent)" }}
            >
              ✨ or add your own
            </span>
          </div>
          <p className="alpha-ui text-sm mt-8 leading-relaxed max-w-xl mx-auto" style={{ color: "var(--ink-soft)" }}>
            Want something hyper-specific? Type your own, like &quot;crypto regulation in Asia&quot;
            or &quot;F1 aerodynamics,&quot; and we&apos;ll hunt the real signal on it three times a week.
          </p>
        </div>
      </section>

      {/* Why it's different */}
      <section className="px-6 py-16 md:py-20" style={{ background: "var(--paper-deep)" }}>
        <div className="max-w-4xl mx-auto grid md:grid-cols-3 gap-10 md:gap-8">
          {WHY.map((w) => (
            <div key={w.t} className="space-y-3">
              <h3 className="alpha-display text-xl font-semibold">{w.t}</h3>
              <p className="alpha-ui text-sm leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                {w.d}
              </p>
            </div>
          ))}
        </div>
      </section>

      <Footer />
    </main>
  );
}
