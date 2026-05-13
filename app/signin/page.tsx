"use client";

import Link from "next/link";
import { useState, useEffect, FormEvent } from "react";
import { Footer } from "@/components/Footer";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { confirm as audioConfirm } from "@/lib/audio";

const REMEMBERED_EMAIL_KEY = "alpha-signin-email";

export default function SigninPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Pre-fill remembered email + onboarding email
  useEffect(() => {
    try {
      const remembered = localStorage.getItem(REMEMBERED_EMAIL_KEY);
      if (remembered) {
        setEmail(remembered);
        return;
      }
      const onboarding = localStorage.getItem("alpha-onboarding");
      if (onboarding) {
        const parsed = JSON.parse(onboarding) as { email?: string };
        if (parsed.email) setEmail(parsed.email);
      }
    } catch {
      // ignore
    }
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return;
    setBusy(true);
    setErr(null);

    if (!supabaseConfigured()) {
      // V0 stub path — show success without actually sending. Used when env
      // isn't wired in a given environment (e.g., a stale local checkout).
      setTimeout(() => {
        audioConfirm();
        setSent(true);
        setBusy(false);
      }, 600);
      return;
    }

    try {
      const sb = supabaseClient();
      const redirectTo = `${window.location.origin}/alpha/auth/callback?next=/inbox`;
      const { error } = await sb.auth.signInWithOtp({
        email: addr,
        options: {
          emailRedirectTo: redirectTo,
          shouldCreateUser: true,
        },
      });
      if (error) throw error;
      audioConfirm();
      try {
        localStorage.setItem(REMEMBERED_EMAIL_KEY, addr);
      } catch {
        // ignore
      }
      setSent(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't send the link. Try again?");
    } finally {
      setBusy(false);
    }
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
                  disabled={busy}
                  className="w-full text-center alpha-display text-2xl bg-transparent border-b py-3 focus:outline-none placeholder:opacity-40"
                  style={{ color: "var(--ink)", borderColor: "var(--rule)" }}
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="alpha-button"
                  style={{ opacity: busy ? 0.6 : 1 }}
                >
                  {busy ? "Sending…" : "Send magic link →"}
                </button>
              </form>
              {err && (
                <p
                  className="alpha-ui text-sm mt-6"
                  style={{ color: "var(--accent-ink)" }}
                >
                  {err}
                </p>
              )}
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
              <div
                className="alpha-display text-6xl font-bold mb-6"
                style={{ color: "var(--accent-ink)", opacity: 0.8 }}
              >
                ✉
              </div>
              <h1 className="alpha-display text-4xl font-bold tracking-tight mb-3">
                Check your email.
              </h1>
              <p
                className="alpha-display text-lg"
                style={{ color: "var(--ink-soft)" }}
              >
                We sent a sign-in link to <strong>{email}</strong>. It expires in
                an hour.
              </p>
              <p
                className="alpha-ui text-sm mt-12"
                style={{ color: "var(--ink-soft)" }}
              >
                Didn&apos;t get it? Check spam, or{" "}
                <button
                  type="button"
                  onClick={() => setSent(false)}
                  className="underline underline-offset-4"
                  style={{ color: "var(--accent-ink)" }}
                >
                  try a different address
                </button>
                .
              </p>
            </>
          )}
        </div>
      </section>
      <Footer />
    </main>
  );
}
