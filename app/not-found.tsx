import Link from "next/link";

export const metadata = { title: "Lost? — Alpha" };

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="text-center max-w-md space-y-8">
        <div
          className="alpha-display text-9xl md:text-[10rem] font-bold leading-none"
          style={{ color: "var(--accent-ink)", opacity: 0.85 }}
        >
          α<span style={{ color: "var(--ink-soft)" }}>?</span>
        </div>
        <h1 className="alpha-display text-3xl md:text-4xl font-bold tracking-tight">
          That page doesn&apos;t exist.
        </h1>
        <p
          className="alpha-display text-lg leading-relaxed"
          style={{ color: "var(--ink-soft)" }}
        >
          Maybe a stale link, or maybe a typo. Either way — come on home.
        </p>
        <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link href="/welcome" className="alpha-button">
            Start fresh →
          </Link>
          <Link
            href="/inbox"
            className="alpha-ui text-sm underline underline-offset-4"
            style={{ color: "var(--ink-soft)" }}
          >
            Or open your inbox
          </Link>
        </div>
      </div>
    </main>
  );
}
