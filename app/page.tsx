import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/Footer";
import { TOPICS } from "@/lib/topics";

// The landing page for cold traffic. Sits in FRONT of the onboarding funnel:
// it sells (pitch, sample, price, how-it-works), then the CTA drops visitors
// into /welcome — the existing 10-step flow, which is a deliberate commitment
// device. Warm visitors are one click from starting; cold visitors get the
// context they need first. Static + indexable (this is the SEO/share surface).
export const metadata: Metadata = {
  title: "alpha. — your weekly alpha",
  description:
    "A personal weekly letter on the five topics you care about. Sourced and edited so it's worth your time. $5 a month, every Sunday.",
  alternates: { canonical: "https://youngalgy.com/alpha" },
};

const HOW = [
  {
    n: "1",
    t: "Pick five topics",
    d: "From 24 — AI and markets to longevity, books, parenting, gardening. The five you actually want to keep up with.",
  },
  {
    n: "2",
    t: "We read the week for you",
    d: "Every Sunday we pull the signal on your topics from real sources, then edit it into something you'll actually finish.",
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
    d: "You don't have to hunt across ten apps and a hundred tabs. The good stuff comes to you, once a week.",
  },
  {
    t: "Real sources, edited by hand",
    d: "We surface from primary sources and known voices — then a human bar decides what earns a slot. Three picks per topic, all worth it.",
  },
  {
    t: "Yours, and only yours",
    d: "Built around your five topics, addressed by name. No ads, no tracking-for-sale, no selling your data. Ever.",
  },
];

const FAQ = [
  {
    q: "Is it just AI spitting out links?",
    a: "AI does the reading and first draft; the format, the bar for what's good, and the voice are set by a person. The goal is a letter that feels edited, not generated.",
  },
  {
    q: "Can I change my topics later?",
    a: "Anytime, from settings. Swap any of your five whenever your interests shift.",
  },
  {
    q: "How do I cancel?",
    a: "One click in settings, through Stripe. No emails to send, no hoops. Cancel and you're done.",
  },
  {
    q: "When does it arrive?",
    a: "Every Sunday. One letter, in your inbox and on the web — read it whenever your Sunday is.",
  },
];

export default function Landing() {
  return (
    <main className="min-h-screen flex flex-col">
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
            Your weekly{" "}
            <em style={{ color: "var(--accent-ink)", fontStyle: "italic" }}>
              alpha.
            </em>
          </h1>
          <p
            className="alpha-display text-xl md:text-2xl leading-relaxed max-w-xl mx-auto"
            style={{ color: "var(--ink-soft)" }}
          >
            A personal letter on the five topics you care about — sourced,
            edited, and worth your time. Every Sunday.
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
          <p className="alpha-ui text-sm pt-1" style={{ color: "var(--ink-soft)" }}>
            $5 a month · cancel anytime · no ads
          </p>
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
            Twenty-four topics. You pick five.
          </h2>
          <p className="alpha-ui text-base mb-10 leading-relaxed" style={{ color: "var(--ink-soft)" }}>
            Whatever you want to stay sharp on — there&apos;s almost certainly a lane for it.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {TOPICS.map((t) => (
              <span
                key={t.id}
                className="alpha-ui text-sm px-3 py-1.5 rounded-full"
                style={{ background: "var(--callout-bg)", color: "var(--ink)" }}
              >
                {t.emoji} {t.label}
              </span>
            ))}
          </div>
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

      {/* Price */}
      <section className="px-6 py-20 md:py-24">
        <div className="max-w-md mx-auto text-center space-y-5">
          <div className="flex items-baseline justify-center gap-3">
            <span className="alpha-display text-6xl font-bold">$5</span>
            <span className="alpha-ui text-lg" style={{ color: "var(--ink-soft)" }}>
              per month
            </span>
          </div>
          <p className="alpha-ui text-base leading-relaxed" style={{ color: "var(--ink-soft)" }}>
            One tier. No upsell, no &ldquo;premium.&rdquo; Cancel in one click whenever you want.
          </p>
          <div className="pt-2">
            <Link href="/welcome" className="alpha-button alpha-button-accent text-base">
              Start your letter →
            </Link>
          </div>
        </div>
      </section>

      {/* Founder note */}
      <section className="px-6 pb-20">
        <div
          className="max-w-xl mx-auto alpha-card p-8 text-center"
          style={{ borderColor: "var(--rule)", borderRadius: "var(--radius-card)" }}
        >
          <p className="alpha-display text-lg md:text-xl leading-relaxed italic" style={{ color: "var(--ink)" }}>
            &ldquo;I built alpha. because I was tired of either missing things
            that mattered or drowning trying not to. This is the letter I wanted
            to get.&rdquo;
          </p>
          <p className="alpha-ui text-sm mt-4" style={{ color: "var(--ink-soft)" }}>
            — the person behind alpha.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="px-6 pb-24">
        <div className="max-w-2xl mx-auto">
          <div className="alpha-mono mb-8 text-center" style={{ color: "var(--accent-ink)" }}>
            QUESTIONS
          </div>
          <div className="space-y-8">
            {FAQ.map((f) => (
              <div key={f.q} className="space-y-2">
                <h3 className="alpha-display text-lg font-semibold">{f.q}</h3>
                <p className="alpha-ui text-base leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                  {f.a}
                </p>
              </div>
            ))}
          </div>
          <div className="text-center mt-12">
            <Link href="/welcome" className="alpha-button alpha-button-accent text-base">
              Start your letter →
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
