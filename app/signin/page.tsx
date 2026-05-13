"use client";

import Link from "next/link";
import { useState, FormEvent } from "react";
import { Footer } from "@/components/Footer";

export default function SigninPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    // V0 stub: real magic-link flow lands with Supabase Auth wiring.
    setSent(true);
  }

  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 max-w-3xl mx-auto w-full">
        <Link
          href="/welcome"
          className="alpha-display text-2xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          alpha<span style={{ color: "var(--accent)" }}>.</span>
        </Link>
      </nav>

      <section className="flex-1 flex items-center justify-center px-6 pb-16">
        <div className="w-full max-w-md text-center">
          {!sent ? (
            <>
              <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight mb-3">
                Welcome back.
              </h1>
              <p
                className="alpha-display text-lg mb-10"
                style={{ color: "var(--ink-soft)" }}
              >
                We&apos;ll send a sign-in link to your email.
              </p>
              <form onSubmit={submit} className="space-y-5">
                <input
                  autoFocus
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full text-center alpha-display text-2xl bg-transparent border-b py-3 focus:outline-none placeholder:opacity-40"
                  style={{ color: "var(--ink)", borderColor: "var(--rule)" }}
                />
                <button type="submit" className="alpha-button">
                  Send magic link →
                </button>
              </form>
              <p
                className="alpha-ui text-sm mt-12"
                style={{ color: "var(--ink-soft)" }}
              >
                New here?{" "}
                <Link
                  href="/welcome"
                  className="underline underline-offset-4"
                  style={{ color: "var(--accent-ink)" }}
                >
                  Start fresh →
                </Link>
              </p>
            </>
          ) : (
            <>
              <h1 className="alpha-display text-4xl font-bold tracking-tight mb-3">
                Check your email.
              </h1>
              <p
                className="alpha-display text-lg"
                style={{ color: "var(--ink-soft)" }}
              >
                We sent a sign-in link to <strong>{email}</strong>. It expires in 15
                minutes.
              </p>
            </>
          )}
        </div>
      </section>
      <Footer />
    </main>
  );
}
