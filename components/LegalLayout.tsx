import Link from "next/link";
import { Footer } from "./Footer";
import { Wordmark } from "./Wordmark";

interface LegalLayoutProps {
  title: string;
  effectiveDate?: string;
  children: React.ReactNode;
}

export function LegalLayout({ title, effectiveDate, children }: LegalLayoutProps) {
  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 max-w-5xl mx-auto w-full">
        <Link
          href="/welcome"
          className="alpha-display text-2xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          <Wordmark />
        </Link>
      </nav>
      <article className="flex-1 max-w-2xl mx-auto px-6 py-12 md:py-20 alpha-body">
        <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight mb-3">
          {title}
        </h1>
        {effectiveDate && (
          <p
            className="alpha-mono mb-12"
            style={{ color: "var(--ink-soft)" }}
          >
            EFFECTIVE {effectiveDate.toUpperCase()}
          </p>
        )}
        <div className="legal-prose space-y-6 text-base md:text-lg leading-relaxed">
          {children}
        </div>
      </article>
      <Footer />
    </main>
  );
}
