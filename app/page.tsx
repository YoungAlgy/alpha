import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 flex items-center justify-between max-w-5xl mx-auto w-full">
        <Link
          href="/"
          className="alpha-display text-2xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          alpha<span style={{ color: "var(--accent)" }}>.</span>
        </Link>
        <Link
          href="/sample"
          className="alpha-ui text-sm"
          style={{ color: "var(--ink-soft)" }}
        >
          Sign in
        </Link>
      </nav>

      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 pb-12">
        <div
          className="alpha-mono mb-10"
          style={{ color: "var(--accent-ink)" }}
        >
          A WEEKLY LETTER
        </div>

        <h1 className="alpha-display text-6xl md:text-8xl font-bold tracking-tight leading-[1.02] max-w-3xl">
          Your weekly{" "}
          <em style={{ color: "var(--accent-ink)", fontStyle: "italic" }}>
            alpha.
          </em>
        </h1>

        <p
          className="alpha-display text-xl md:text-2xl mt-8 max-w-xl leading-relaxed"
          style={{ color: "var(--ink-soft)" }}
        >
          Pick five topics. Get a letter every Sunday on what actually matters.
          Five dollars a month.
        </p>

        <Link href="/start" className="alpha-button mt-12 text-base">
          Start for $5 →
        </Link>

        <p
          className="alpha-ui text-sm mt-4"
          style={{ color: "var(--ink-soft)" }}
        >
          $5/month · cancel anytime
        </p>
      </section>

      <footer
        className="px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-3 max-w-5xl mx-auto w-full alpha-mono"
        style={{ color: "var(--ink-soft)" }}
      >
        <div>ALPHA · 2026</div>
        <div className="flex gap-6 alpha-ui text-xs">
          <Link href="/privacy" className="hover:opacity-70">
            Privacy
          </Link>
          <Link href="/terms" className="hover:opacity-70">
            Terms
          </Link>
          <Link href="/support" className="hover:opacity-70">
            Support
          </Link>
        </div>
      </footer>
    </main>
  );
}
