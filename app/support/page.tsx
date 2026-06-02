import Link from "next/link";
import { Footer } from "@/components/Footer";
import { SupportForm } from "./SupportForm";

export const metadata = { title: "Support" };

export default function SupportPage() {
  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 max-w-5xl mx-auto w-full">
        <Link
          href="/welcome"
          className="alpha-display text-2xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          alpha<span style={{ color: "var(--accent)" }}>.</span>
        </Link>
      </nav>
      <section className="flex-1 max-w-xl mx-auto px-6 py-12 md:py-20 w-full">
        <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight mb-3">
          Support
        </h1>
        <p
          className="alpha-display text-lg md:text-xl mb-12"
          style={{ color: "var(--ink-soft)" }}
        >
          We read every one. Reply within 24 hours.
        </p>
        <SupportForm />
        <p
          className="alpha-ui text-sm mt-8"
          style={{ color: "var(--ink-soft)" }}
        >
          Prefer email? Reach us at{" "}
          <a
            href="mailto:youngalgy@gmail.com"
            className="underline underline-offset-4"
            style={{ color: "var(--accent-ink)" }}
          >
            youngalgy@gmail.com
          </a>
          .
        </p>
      </section>
      <Footer />
    </main>
  );
}
